import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveSession, pcm16, type SegmentEngine, type SegmentRequest } from '../src/main/liveSession'
import { decodeWav16, encodeWav16 } from '@shared/wav'

const sr = 16_000
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
function spill(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-live-'))
  dirs.push(d)
  return path.join(d, 'live.wav')
}
/** Each second's first sample encodes its index so the engine can "read" what it got. */
function second(i: number): Float32Array {
  const b = new Float32Array(sr).fill(0.2)
  b[0] = (i % 1000) / 1000
  return b
}
/** Fake engine: returns "s<i>" per second in the clip, records requests. */
function fakeEngine(delayMs = 0, failOn: (n: number) => boolean = () => false) {
  const calls: SegmentRequest[] = []
  let n = 0
  const engine: SegmentEngine = {
    async transcribeSegment(wav, req) {
      const call = n++
      calls.push(req)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (failOn(call)) throw new Error('engine crashed')
      const { samples } = decodeWav16(wav)
      const words: string[] = []
      for (let i = 0; i + sr <= samples.length + 1; i += sr) words.push(`s${Math.round(samples[i] * 1000)}`)
      return { text: words.join(' '), language: req.detectLanguage ? 'danish' : null }
    }
  }
  return { engine, calls }
}
// no pauses: 90 s hard cuts with 1 s overlap
const opts = { segmenter: { minSeconds: 30, hardMaxSeconds: 90 } }

describe('live session', () => {
  it('spills to a WAV identical to the single-pass encoding, then deletes it on success', async () => {
    const { engine } = fakeEngine()
    const p = spill()
    const s = new LiveSession({ engine, spillPath: p, language: null, attempts: 1, ...opts })
    const all: Float32Array[] = []
    for (let i = 0; i < 5; i++) {
      const b = second(i).map((v, k) => (k ? Math.sin(k / 7) * 0.5 : v))
      all.push(b)
      s.pushBlock(b)
    }
    const bytes = fs.readFileSync(p)
    const joined = new Float32Array(5 * sr)
    all.forEach((b, i) => joined.set(b, i * sr))
    expect(bytes.subarray(44)).toEqual(Buffer.from(encodeWav16(joined).subarray(44)))
    expect(pcm16(joined)).toEqual(Buffer.from(encodeWav16(joined).subarray(44)))
    const r = await s.finish()
    expect(r.complete).toBe(true)
    expect(r.audioPath).toBeNull()
    expect(fs.existsSync(p)).toBe(false)
  })

  it('transcribes in the background while recording, stitches with de-dup, locks language', async () => {
    const { engine, calls } = fakeEngine()
    const s = new LiveSession({ engine, spillPath: spill(), language: null, attempts: 1, ...opts })
    for (let i = 0; i < 200; i++) {
      s.pushBlock(second(i))
      if (i === 100) {
        await new Promise((r) => setTimeout(r, 20))
        expect(calls.length).toBeGreaterThanOrEqual(1) // first segment already done mid-recording
      }
    }
    const r = await s.finish()
    expect(r.segments).toBe(3) // 0-90, 89-179, 178-200
    expect(r.text).toBe(Array.from({ length: 200 }, (_, i) => `s${i}`).join(' '))
    expect(calls[0]).toMatchObject({ language: null, detectLanguage: true, prompt: '' })
    expect(calls[1]).toMatchObject({ language: 'danish', detectLanguage: false })
    expect(calls[1].prompt.endsWith('s88 s89')).toBe(true)
  })

  it('a user-chosen language is used from the first segment', async () => {
    const { engine, calls } = fakeEngine()
    const s = new LiveSession({ engine, spillPath: spill(), language: 'da', attempts: 1, ...opts })
    for (let i = 0; i < 100; i++) s.pushBlock(second(i))
    await s.finish()
    expect(calls.every((c) => c.language === 'da' && !c.detectLanguage)).toBe(true)
  })

  it('queues without loss and one at a time under a slow engine', async () => {
    const { engine } = fakeEngine(40)
    const s = new LiveSession({ engine, spillPath: spill(), language: 'en', attempts: 1, segmenter: { minSeconds: 3, hardMaxSeconds: 5, overlapSeconds: 1 } })
    for (let i = 0; i < 120; i++) s.pushBlock(second(i)) // pushes far faster than the engine
    expect(s.maxQueued).toBeGreaterThan(10)
    const r = await s.finish()
    expect(s.maxInFlight).toBe(1)
    expect(r.complete).toBe(true)
    expect(r.text).toBe(Array.from({ length: 120 }, (_, i) => `s${i}`).join(' '))
  })

  it('retries a failed segment, then keeps partial text + audio on failure', async () => {
    // call 1 fails once (retried OK); segment 2 fails on both attempts
    const { engine } = fakeEngine(0, (n) => n === 1 || n === 3 || n === 4)
    const p = spill()
    const s = new LiveSession({ engine, spillPath: p, language: 'en', attempts: 2, ...opts })
    for (let i = 0; i < 200; i++) s.pushBlock(second(i))
    const r = await s.finish()
    expect(r.complete).toBe(false)
    expect(r.failedSegments).toEqual([2])
    expect(r.text.startsWith('s0 s1')).toBe(true)
    expect(r.text).toContain('s177') // segment 1 (89–179 s) succeeded on retry
    expect(r.text).not.toContain('s199')
    expect(r.audioPath).toBe(p)
    const kept = decodeWav16(new Uint8Array(fs.readFileSync(p)))
    expect(kept.sampleRate).toBe(sr)
    expect(kept.samples.length).toBe(200 * sr)
  })

  it('discard deletes the audio and stops work', async () => {
    const { engine, calls } = fakeEngine(30)
    const p = spill()
    const s = new LiveSession({ engine, spillPath: p, language: 'en', attempts: 1, segmenter: { minSeconds: 3, hardMaxSeconds: 5 } })
    for (let i = 0; i < 30; i++) s.pushBlock(second(i))
    s.discard()
    await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(p)).toBe(false)
    expect(calls.length).toBeLessThanOrEqual(1)
  })
})
