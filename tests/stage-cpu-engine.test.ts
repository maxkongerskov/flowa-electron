import { describe, expect, it } from 'vitest'
import { windowsWhisperServerFile } from '../scripts/stage-cpu-engine.mjs'

/** Names inside whisper.cpp b5454 whisper-bin-x64.zip (Release/). */
const ZIP = [
  'bench.exe',
  'command.exe',
  'ggml-base.dll',
  'ggml-cpu-alderlake.dll',
  'ggml-cpu-cannonlake.dll',
  'ggml-cpu-cascadelake.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll',
  'ggml-cpu-sandybridge.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-x64.dll',
  'ggml.dll',
  'llama.dll',
  'main.exe',
  'parakeet-cli.exe',
  'parakeet-quantize.exe',
  'parakeet.dll',
  'SDL2.dll',
  'stream.exe',
  'test-common-utf8.exe',
  'test-parakeet-full-diffusion.exe',
  'test-parakeet-full-gb1.exe',
  'test-parakeet-full-jfk.exe',
  'test-parakeet.exe',
  'test-vad-full.exe',
  'test-vad.exe',
  'test-whisper-buffer-loader.exe',
  'test-whisper-lang-detect-abort.exe',
  'test-whisper-zero-samples.exe',
  'wchess.exe',
  'whisper-bench.exe',
  'whisper-cli.exe',
  'whisper-command.exe',
  'whisper-lsp.exe',
  'whisper-quantize.exe',
  'whisper-server.exe',
  'whisper-stream.exe',
  'whisper-talk-llama.exe',
  'whisper-vad-speech-segments.exe',
  'whisper.dll'
]

const KEEP = [
  'ggml-base.dll',
  'ggml-cpu-alderlake.dll',
  'ggml-cpu-cannonlake.dll',
  'ggml-cpu-cascadelake.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll',
  'ggml-cpu-sandybridge.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-x64.dll',
  'ggml.dll',
  'whisper-server.exe',
  'whisper.dll'
]

describe('windows CPU engine files', () => {
  it('keeps the libraries whisper-server loads and drops the upstream examples', () => {
    expect(ZIP.filter((name) => windowsWhisperServerFile(name)).sort()).toEqual([...KEEP].sort())
    for (const name of ['SDL2.dll', 'llama.dll', 'wchess.exe', 'whisper-talk-llama.exe', 'whisper-cli.exe', 'test-vad.exe', 'parakeet.dll']) {
      expect(windowsWhisperServerFile(name)).toBe(false)
    }
  })
})
