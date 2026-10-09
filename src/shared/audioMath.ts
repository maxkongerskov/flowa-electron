// Port of the signal math in AudioCapture.swift (processBuffer / append / appearsSilent).

/** Below this peak, commit treats the take as "no speech heard" (Swift: 0.008). */
export const silencePeakThreshold = 0.008

/** RMS of a buffer → 0…1 level for the Flow Bar waveform (Swift: min(1, rms * 6.5)). */
export function levelForBuffer(samples: Float32Array): number {
  const n = samples.length
  let sumSq = 0
  for (let i = 0; i < n; i++) sumSq += samples[i] * samples[i]
  const rms = Math.sqrt(sumSq / Math.max(n, 1))
  return Math.min(1, rms * 6.5)
}

/** Light smoothing so the waveform isn't jittery (Swift: level * 0.5 + new * 0.5). */
export function smoothLevel(previous: number, next: number): number {
  return previous * 0.5 + next * 0.5
}

export function appearsSilent(peak: number): boolean {
  return peak < silencePeakThreshold
}

/**
 * Fallback resampler when the AudioContext can't run at 16 kHz natively.
 * Box-filter (averaging) decimation for downsampling, which doubles as a
 * crude anti-alias filter; linear interpolation for upsampling.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(input.length, Math.floor((i + 1) * ratio))
      let acc = 0
      for (let j = start; j < end; j++) acc += input[j]
      out[i] = acc / Math.max(1, end - start)
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(input.length - 1, i0 + 1)
      const t = pos - i0
      out[i] = input[i0] * (1 - t) + input[i1] * t
    }
  }
  return out
}

/** Flow Bar: map 0…1 level to a bar height between 4 and 22 px. */
export function barHeight(level: number): number {
  return 4 + level * 18
}

/** Rolling 14-bar history: newest on the right, oldest dropped on the left. */
export function pushHistory(history: number[], level: number): number[] {
  return [...history.slice(1), level]
}
