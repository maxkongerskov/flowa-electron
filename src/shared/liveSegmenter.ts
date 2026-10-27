// Live transcription: cut a running 16 kHz mono stream into segments.
//
// Cut on a pause once a segment is >= 30 s (preferred window 30–60 s; after
// 60 s a shorter pause is accepted). With no pause by 90 s: hard cut at 90 s and
// start the next segment 1 s earlier (overlap), stitch.ts removes the repeat.
// Only sample positions are emitted; the audio itself lives in the spill file.

export interface SegmenterOptions {
  sampleRate: number
  minSeconds: number
  preferredMaxSeconds: number
  hardMaxSeconds: number
  overlapSeconds: number
  frameMs: number
  minSilenceMs: number
  lateSilenceMs: number
}

export const defaultSegmenterOptions: SegmenterOptions = {
  sampleRate: 16_000,
  minSeconds: 30,
  preferredMaxSeconds: 60,
  hardMaxSeconds: 90,
  overlapSeconds: 1,
  frameMs: 30,
  minSilenceMs: 300,
  lateSilenceMs: 120
}

export interface SegmentRange {
  index: number
  /** Absolute sample offsets in the session, [start, end). */
  start: number
  end: number
  /** Samples at the start that repeat the previous segment's tail (hard cut only). */
  overlap: number
  cut: 'silence' | 'hard' | 'final'
}

const absFloor = 0.002
const relThreshold = 0.15
const maxThreshold = 0.02

export class Segmenter {
  readonly opts: SegmenterOptions
  private segStart = 0
  private segOverlap = 0
  private total = 0
  private index = 0
  private frameLen: number
  private frameAcc = 0
  private frameFill = 0
  /** Silent flag per completed frame since segStart. */
  private frames: boolean[] = []
  private speechLevel = 0
  private decay: number

  constructor(opts: Partial<SegmenterOptions> = {}) {
    this.opts = { ...defaultSegmenterOptions, ...opts }
    this.frameLen = Math.max(1, Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000))
    // speech level halves in ~3 s, so quiet speech after a loud stretch is not
    // mistaken for a pause (a 20 s half-life cut mid-sentence in quiet takes)
    this.decay = Math.pow(0.5, this.opts.frameMs / 3_000)
  }

  get samplesSeen(): number {
    return this.total
  }

  /** Feed samples; returns any segments completed by them. */
  push(block: Float32Array): SegmentRange[] {
    const out: SegmentRange[] = []
    for (let i = 0; i < block.length; i++) {
      const s = block[i]
      this.frameAcc += s * s
      this.frameFill++
      this.total++
      if (this.frameFill === this.frameLen) {
        this.endFrame()
        const seg = this.maybeCut()
        if (seg) out.push(seg)
      }
    }
    return out
  }

  /** Remaining audio as the last segment (null if nothing left). */
  flush(): SegmentRange | null {
    if (this.total <= this.segStart + this.segOverlap) return null
    const seg: SegmentRange = { index: this.index++, start: this.segStart, end: this.total, overlap: this.segOverlap, cut: 'final' }
    this.segStart = this.total
    this.segOverlap = 0
    this.frames = []
    return seg
  }

  private endFrame(): void {
    const rms = Math.sqrt(this.frameAcc / this.frameFill)
    this.frameAcc = 0
    this.frameFill = 0
    this.speechLevel = Math.max(rms, this.speechLevel * this.decay)
    const threshold = Math.min(maxThreshold, Math.max(absFloor, relThreshold * this.speechLevel))
    this.frames.push(rms < threshold)
  }

  private maybeCut(): SegmentRange | null {
    const { sampleRate: sr } = this.opts
    const len = this.total - this.segStart
    const minS = this.opts.minSeconds * sr
    if (len < minS) return null
    const late = len >= this.opts.preferredMaxSeconds * sr
    const needFrames = Math.ceil((late ? this.opts.lateSilenceMs : this.opts.minSilenceMs) / this.opts.frameMs)
    // trailing silent run ending at the newest frame
    let run = 0
    for (let f = this.frames.length - 1; f >= 0 && this.frames[f]; f--) run++
    const runStartSample = this.segStart + (this.frames.length - run) * this.frameLen
    if (run >= needFrames) {
      // cut in the middle of the pause so neither side clips a word (never before minSeconds)
      const cutAt = Math.max(this.segStart + minS, runStartSample + Math.floor((run * this.frameLen) / 2))
      return this.cutAt(cutAt, 0, 'silence')
    }
    if (len >= this.opts.hardMaxSeconds * sr) {
      return this.cutAt(this.segStart + this.opts.hardMaxSeconds * sr, Math.round(this.opts.overlapSeconds * sr), 'hard')
    }
    return null
  }

  private cutAt(cutAt: number, overlap: number, cut: 'silence' | 'hard'): SegmentRange {
    const seg: SegmentRange = { index: this.index++, start: this.segStart, end: cutAt, overlap: this.segOverlap, cut }
    this.segStart = cutAt - overlap
    this.segOverlap = overlap
    // frames after the cut point (silence cut keeps the rest of the pause)
    const keepFrom = Math.floor((cutAt - seg.start) / this.frameLen)
    const kept = this.frames.slice(keepFrom)
    const overlapFrames = Math.ceil(overlap / this.frameLen)
    this.frames = [...Array<boolean>(overlapFrames).fill(false), ...kept]
    return seg
  }
}
