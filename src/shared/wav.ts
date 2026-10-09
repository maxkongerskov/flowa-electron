// Port of AudioCapture.writeWAV(): hand-rolled 44-byte header,
// 16 kHz mono 16-bit PCM, Float → Int16 via clamp * 32767 (truncation like Swift's Int16()).

export const targetSampleRate = 16_000

export function encodeWav16(samples: Float32Array, sampleRate = targetSampleRate): Uint8Array {
  const dataSize = samples.length * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM format
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, dataSize, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const clamped = Number.isNaN(s) ? 0 : Math.max(-1, Math.min(1, s))
    v.setInt16(off, Math.trunc(clamped * 32767), true)
    off += 2
  }
  return new Uint8Array(buf)
}

/** Decode a 16-bit PCM mono/stereo WAV to Float32 (tests + fixtures). */
export function decodeWav16(bytes: Uint8Array): { sampleRate: number; channels: number; samples: Float32Array } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')
  let off = 12
  let sampleRate = 0
  let channels = 1
  let bits = 16
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off)
    const size = v.getUint32(off + 4, true)
    if (id === 'fmt ') {
      channels = v.getUint16(off + 10, true)
      sampleRate = v.getUint32(off + 12, true)
      bits = v.getUint16(off + 22, true)
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`Unsupported bits per sample: ${bits}`)
      const frames = Math.floor(size / 2 / channels)
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < channels; c++) acc += v.getInt16(off + 8 + (i * channels + c) * 2, true) / 32768
        out[i] = acc / channels
      }
      return { sampleRate, channels, samples: out }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}
