import { describe, expect, it, vi } from 'vitest'
import { AudioCapture } from '../src/renderer/src/audio/AudioCapture'

describe('AudioCapture', () => {
  it('cancels a microphone start that has not finished opening', async () => {
    let stopped = 0
    let release: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void = () => {}
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: () => new Promise((resolve) => { release = resolve })
      }
    })
    const audio = new AudioCapture()
    const pending = audio.start('default', null)
    await new Promise((resolve) => setImmediate(resolve))
    audio.cancel()
    release({ getTracks: () => [{ stop: () => { stopped += 1 } }] })
    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(stopped).toBe(1)
    expect(audio.isRecording).toBe(false)
    vi.unstubAllGlobals()
  })
})
