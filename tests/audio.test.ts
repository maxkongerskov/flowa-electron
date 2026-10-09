// AudioCapture.swift math + hand-rolled WAV writer.
import { describe, expect, it } from 'vitest'
import { appearsSilent, barHeight, levelForBuffer, pushHistory, resample, silencePeakThreshold, smoothLevel } from '@shared/audioMath'
import { decodeWav16, encodeWav16 } from '@shared/wav'

describe('levels', () => {
  it('rms × 6.5 capped at 1', () => {
    expect(levelForBuffer(new Float32Array(1024))).toBe(0)
    expect(levelForBuffer(new Float32Array(1024).fill(0.1))).toBeCloseTo(0.65, 5)
    expect(levelForBuffer(new Float32Array(1024).fill(0.9))).toBe(1)
  })
  it('smoothing 0.5/0.5', () => expect(smoothLevel(0.2, 0.6)).toBeCloseTo(0.4))
  it('silence threshold 0.008', () => {
    expect(silencePeakThreshold).toBe(0.008)
    expect(appearsSilent(0.0079)).toBe(true)
    expect(appearsSilent(0.05)).toBe(false)
  })
  it('flow bar heights 4…22 and rolling history', () => {
    expect(barHeight(0)).toBe(4)
    expect(barHeight(1)).toBe(22)
    expect(pushHistory([1, 2, 3], 4)).toEqual([2, 3, 4])
  })
})

describe('resample', () => {
  it('48k → 16k keeps duration and DC', () => {
    const out = resample(new Float32Array(48000).fill(0.5), 48000, 16000)
    expect(out.length).toBe(16000)
    expect(out[100]).toBeCloseTo(0.5)
  })
  it('identity', () => {
    const a = new Float32Array([1, 2, 3])
    expect(resample(a, 16000, 16000)).toBe(a)
  })
})

describe('WAV writer (Swift writeWAV parity)', () => {
  it('44-byte header, 16 kHz mono 16-bit', () => {
    const bytes = encodeWav16(new Float32Array([0, 0.5, -0.5, 1, -1, 2]))
    const v = new DataView(bytes.buffer)
    const tag = (o: number): string => String.fromCharCode(...bytes.slice(o, o + 4))
    expect(bytes.length).toBe(44 + 12)
    expect(tag(0)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 12)
    expect(tag(8)).toBe('WAVE')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(32, true)).toBe(2)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(12)
    expect([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 16383, -16383, 32767, -32767, 32767])
  })
  it('round-trips through the decoder', () => {
    const src = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5)
    const { sampleRate, samples } = decodeWav16(encodeWav16(src))
    expect(sampleRate).toBe(16000)
    expect(samples.length).toBe(1600)
    expect(samples[37]).toBeCloseTo(src[37], 3)
  })
})
