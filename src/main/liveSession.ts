// Beta live transcription (flowa.experimental.liveTranscription).
//
// While recording: 1 s audio blocks from the Flow Bar are appended to a spill
// WAV on disk (memory stays constant), cut into 30–90 s segments by
// shared/liveSegmenter.ts, and transcribed one at a time in the background on
// the resident whisper-server. Pending segments are only sample ranges into the
// spill file, so a slow engine just lets the queue grow; nothing is dropped.
// On stop only the last segment is left. No electron imports: unit-testable.
import fs from 'node:fs'
import path from 'node:path'
import { Segmenter, type SegmentRange, type SegmenterOptions } from '@shared/liveSegmenter'
import { promptTail, stitch, type StitchPart } from '@shared/stitch'

export interface SegmentRequest {
  /** Locked language (code or whisper full name) or null = auto-detect. */
  language: string | null
  /** Tail of the transcript so far (whisper initial prompt). */
  prompt: string
  /** Ask the engine to report the language it detected. */
  detectLanguage: boolean
}

export interface SegmentReply {
  text: string
  language: string | null
}

export interface SegmentEngine {
  transcribeSegment(wav: Uint8Array, req: SegmentRequest): Promise<SegmentReply>
}

export interface LiveResult {
  /** Stitched, cleaned transcript of every segment that succeeded. */
  text: string
  /** False if any segment failed after retries (text is partial). */
  complete: boolean
  segments: number
  failedSegments: number[]
  /** Spill WAV kept for a retry when incomplete; null once deleted. */
  audioPath: string | null
  audioSeconds: number
}

export interface LiveSessionOptions {
  engine: SegmentEngine
  spillPath: string
  /** User-chosen language (null = auto, locked from the first segment). */
  language: string | null
  segmenter?: Partial<SegmenterOptions>
  /** Attempts per segment (engine-level GPU→CPU fallback happens inside one attempt). */
  attempts?: number
  log?: (msg: string) => void
}

const sampleRate = 16_000

export function wavHeader(dataBytes: number, rate = sampleRate): Buffer {
  const h = Buffer.alloc(44)
  const size = Math.min(dataBytes, 0xffffffff - 36)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + size, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(size, 40)
  return h
}

/** Float → Int16 exactly like shared/wav.ts encodeWav16 (clamp, ×32767, truncate). */
export function pcm16(samples: Float32Array): Buffer {
  const b = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const c = Number.isNaN(s) ? 0 : Math.max(-1, Math.min(1, s))
    b.writeInt16LE(Math.trunc(c * 32767), i * 2)
  }
  return b
}

export class LiveSession {
  private fd: number | null
  private segmenter: Segmenter
  private pending: SegmentRange[] = []
  private parts: (StitchPart | null)[] = []
  private failed: number[] = []
  private language: string | null
  private languageLocked: boolean
  private worker: Promise<void> | null = null
  private finished = false
  private discarded = false
  private attempts: number
  private log: (m: string) => void
  /** For tests: the largest number of segments waiting at once. */
  maxQueued = 0
  inFlight = 0
  maxInFlight = 0

  constructor(private opts: LiveSessionOptions) {
    this.segmenter = new Segmenter(opts.segmenter)
    this.language = opts.language
    this.languageLocked = opts.language !== null
    this.attempts = Math.max(1, opts.attempts ?? 2)
    this.log = opts.log ?? ((m) => console.log(`[Flowa][live] ${m}`))
    fs.mkdirSync(path.dirname(opts.spillPath), { recursive: true })
    this.fd = fs.openSync(opts.spillPath, 'w+')
    fs.writeSync(this.fd, wavHeader(0), 0, 44, 0)
  }

  get spillPath(): string {
    return this.opts.spillPath
  }

  get samples(): number {
    return this.segmenter.samplesSeen
  }

  /** Append one block (sync, so blocks stay in IPC order). */
  pushBlock(block: Float32Array): void {
    if (this.finished || this.discarded || this.fd === null || block.length === 0) return
    const pcm = pcm16(block)
    fs.writeSync(this.fd, pcm, 0, pcm.length, 44 + this.segmenter.samplesSeen * 2)
    for (const seg of this.segmenter.push(block)) this.enqueue(seg)
  }

  /** Flush the last segment, wait for the queue, stitch. */
  async finish(): Promise<LiveResult> {
    if (!this.finished) {
      this.finished = true
      const last = this.segmenter.flush()
      if (last) this.enqueue(last)
    }
    while (this.worker) await this.worker
    const total = this.segmenter.samplesSeen
    this.patchHeader(total)
    this.closeFd()
    const text = stitch(this.parts.filter((p): p is StitchPart => p !== null))
    const complete = this.failed.length === 0
    let audioPath: string | null = this.opts.spillPath
    if (complete) {
      fs.rmSync(this.opts.spillPath, { force: true })
      audioPath = null
    }
    return { text, complete, segments: this.parts.length, failedSegments: [...this.failed], audioPath, audioSeconds: total / sampleRate }
  }

  /** Cancel: stop work and delete the audio. */
  discard(): void {
    this.discarded = true
    this.pending = []
    this.closeFd()
    fs.rmSync(this.opts.spillPath, { force: true })
  }

  private enqueue(seg: SegmentRange): void {
    this.pending.push(seg)
    this.parts[seg.index] = null
    this.maxQueued = Math.max(this.maxQueued, this.pending.length)
    this.startWorker()
  }

  private startWorker(): void {
    if (this.worker) return
    this.worker = this.drain().finally(() => {
      this.worker = null
      // a block may have queued a segment after drain() saw an empty queue
      if (this.pending.length && !this.discarded) this.startWorker()
    })
  }

  private async drain(): Promise<void> {
    while (this.pending.length && !this.discarded) {
      const seg = this.pending.shift()!
      await this.runSegment(seg)
    }
  }

  private readRange(seg: SegmentRange): Uint8Array {
    const bytes = (seg.end - seg.start) * 2
    const out = Buffer.alloc(44 + bytes)
    wavHeader(bytes).copy(out, 0)
    if (this.fd !== null) fs.readSync(this.fd, out, 44, bytes, 44 + seg.start * 2)
    return out
  }

  private async runSegment(seg: SegmentRange): Promise<void> {
    const wav = this.readRange(seg)
    const sofar = stitch(this.parts.filter((p): p is StitchPart => p !== null))
    const req: SegmentRequest = { language: this.language, prompt: promptTail(sofar), detectLanguage: !this.languageLocked }
    const t0 = Date.now()
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (this.discarded) return
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      try {
        const r = await this.opts.engine.transcribeSegment(wav, req)
        this.inFlight--
        if (!this.languageLocked && r.language) {
          this.language = r.language
          this.languageLocked = true
          this.log(`language locked to ${r.language}`)
        }
        this.parts[seg.index] = { text: r.text, overlapped: seg.overlap > 0 }
        this.log(`segment ${seg.index} (${((seg.end - seg.start) / sampleRate).toFixed(1)} s, ${seg.cut}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        return
      } catch (e) {
        this.inFlight--
        this.log(`segment ${seg.index} attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.failed.push(seg.index)
  }

  private patchHeader(total: number): void {
    if (this.fd === null) return
    fs.writeSync(this.fd, wavHeader(total * 2), 0, 44, 0)
  }

  private closeFd(): void {
    if (this.fd === null) return
    try {
      fs.closeSync(this.fd)
    } catch {
      /* ignore */
    }
    this.fd = null
  }
}
