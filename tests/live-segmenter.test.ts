import { describe, expect, it } from 'vitest'
import { Segmenter, type SegmentRange } from '@shared/liveSegmenter'

const sr = 16_000
let seed = 1
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
/** speech-ish noise (amp 0.3) for `speech` s, then near-silence (amp 0.001) for `pause` s */
function talk(pattern: [number, number][]): Float32Array {
  const n = pattern.reduce((a, [s, p]) => a + Math.round((s + p) * sr), 0)
  const out = new Float32Array(n)
  let o = 0
  for (const [s, p] of pattern) {
    for (let i = 0; i < Math.round(s * sr); i++) out[o++] = rnd() * 0.3
    for (let i = 0; i < Math.round(p * sr); i++) out[o++] = rnd() * 0.001
  }
  return out
}
function feed(seg: Segmenter, audio: Float32Array, block = sr): SegmentRange[] {
  const out: SegmentRange[] = []
  for (let i = 0; i < audio.length; i += block) out.push(...seg.push(audio.subarray(i, i + block)))
  const last = seg.flush()
  if (last) out.push(last)
  return out
}
function expectContiguous(segs: SegmentRange[], total: number): void {
  expect(segs[0].start).toBe(0)
  for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end - segs[i].overlap)
  expect(segs.at(-1)!.end).toBe(total)
  segs.forEach((s, i) => expect(s.index).toBe(i))
}

describe('live segmenter', () => {
  it('cuts on pauses between 30 and 60 s, inside the pause', () => {
    // 8 s phrases with 0.6 s pauses, 10 min
    const audio = talk(Array.from({ length: 70 }, () => [8, 0.6] as [number, number]))
    const segs = feed(new Segmenter(), audio)
    expectContiguous(segs, audio.length)
    for (const s of segs.slice(0, -1)) {
      expect(s.cut).toBe('silence')
      expect(s.overlap).toBe(0)
      const len = (s.end - s.start) / sr
      expect(len).toBeGreaterThanOrEqual(30)
      expect(len).toBeLessThanOrEqual(60)
      // cut point lies in a pause: the 8 s phrase grid is 8.6 s
      const t = (s.end / sr) % 8.6
      expect(t).toBeGreaterThanOrEqual(8)
    }
    expect(segs.at(-1)!.cut).toBe('final')
  })

  it('hard-cuts at 90 s with 1 s overlap when nobody pauses', () => {
    const audio = talk([[200, 0]])
    const segs = feed(new Segmenter(), audio)
    expectContiguous(segs, audio.length)
    expect(segs[0]).toMatchObject({ start: 0, end: 90 * sr, overlap: 0, cut: 'hard' })
    expect(segs[1]).toMatchObject({ start: 89 * sr, overlap: sr, cut: 'hard' })
    expect(segs[1].end - segs[1].start).toBe(90 * sr)
    expect(segs[2].cut).toBe('final')
  })

  it('accepts a shorter pause after 60 s', () => {
    // 65 s of speech, 0.2 s pause (below the 300 ms early rule), more speech
    const audio = talk([[65, 0.2], [20, 0]])
    const segs = feed(new Segmenter(), audio)
    expect(segs[0].cut).toBe('silence')
    expect(segs[0].end / sr).toBeGreaterThan(65)
    expect(segs[0].end / sr).toBeLessThan(65.2)
  })

  it('short takes are one final segment; empty flush is null', () => {
    const seg = new Segmenter()
    const segs = feed(seg, talk([[12, 0.5]]))
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ start: 0, cut: 'final' })
    expect(seg.flush()).toBeNull()
  })

  it('does not depend on block size', () => {
    const audio = talk(Array.from({ length: 20 }, () => [7, 0.5] as [number, number]))
    const a = feed(new Segmenter(), audio, 16_000).map((s) => s.end)
    const b = feed(new Segmenter(), audio, 512).map((s) => s.end)
    expect(b).toEqual(a)
  })
})
