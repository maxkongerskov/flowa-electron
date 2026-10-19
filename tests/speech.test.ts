import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cliArgs, serverArgs } from '@shared/model'
import { coercePrefs, PrefKey } from '@shared/prefs'
import {
  assumedWhisperManifest, collectEngineNotices, gpuFallbackNote, hardwareChoices, isHardwarePref, isSpeechModelId,
  type WhisperManifest,
  missingRuntimeNote, missingWeightsNote, normalizeProviders, normalizeWhisperManifest, parakeetCliArgs, parakeetGpuBackends,
  parakeetLanguageCodes, parakeetModelId, parakeetWeights, parseSherpaTranscript, selectBackend, sherpaGpuFailed,
  speechModelChoices, whisperGpuBackends, whisperLogsShowGpuFailure, whisperTurboId, sherpaOnnxTag, parakeetArchiveUrl
} from '@shared/speech'

const macMetal = assumedWhisperManifest('darwin')
const cpuOnly = assumedWhisperManifest('linux')
const withCuda: WhisperManifest = { default: ['cpu'], binaries: { cuda: true, vulkan: false } }
const withVulkan: WhisperManifest = { default: ['cpu'], binaries: { cuda: false, vulkan: true } }
const none = { metal: false, nvidia: false, vulkan: false }
const nvidia = { metal: false, nvidia: true, vulkan: false }
const vulkanGpu = { metal: false, nvidia: false, vulkan: true }
const macProbe = { metal: true, nvidia: false, vulkan: false }

describe('speech model ids', () => {
  it('accepts the two shipped models and rejects anything else', () => {
    expect(isSpeechModelId('whisper-turbo')).toBe(true)
    expect(isSpeechModelId('parakeet-tdt-0.6b-v3')).toBe(true)
    expect(isSpeechModelId('whisper-large')).toBe(false)
    expect(isSpeechModelId(1)).toBe(false)
    expect(speechModelChoices.map((m) => m.id)).toEqual([whisperTurboId, parakeetModelId])
  })
  it('lists Parakeet weight files and includes English in the EU set', () => {
    expect(parakeetWeights.map((w) => w.name)).toEqual(['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'])
    expect(parakeetLanguageCodes).toContain('en')
    expect(parakeetLanguageCodes).toHaveLength(25)
  })
  it('pins the fetch scripts to the catalog', () => {
    expect(fs.readFileSync('scripts/fetch-sherpa.mjs', 'utf8')).toContain(`const SHERPA = '${sherpaOnnxTag.slice(1)}'`)
    expect(fs.readFileSync('scripts/fetch-parakeet.mjs', 'utf8')).toContain(parakeetArchiveUrl)
  })
})

describe('hardware prefs', () => {
  it('defaults to GPU automatic and Whisper Turbo', () => {
    const p = coercePrefs(null, 'darwin')
    expect(p[PrefKey.hardware]).toBe('gpu')
    expect(p[PrefKey.speechModel]).toBe('whisper-turbo')
    expect(PrefKey.hardware).toBe('flowa.hardware')
    expect(PrefKey.speechModel).toBe('flowa.speechModel')
  })
  it('keeps valid values and drops garbage', () => {
    const ok = coercePrefs({ 'flowa.hardware': 'vulkan', 'flowa.speechModel': 'parakeet-tdt-0.6b-v3', 'flowa.language': 'en' }, 'linux')
    expect(ok[PrefKey.hardware]).toBe('vulkan')
    expect(ok[PrefKey.speechModel]).toBe('parakeet-tdt-0.6b-v3')
    const bad = coercePrefs({ 'flowa.hardware': 'tpu', 'flowa.speechModel': 'canary' }, 'win32')
    expect(bad[PrefKey.hardware]).toBe('gpu')
    expect(bad[PrefKey.speechModel]).toBe('whisper-turbo')
    expect(isHardwarePref('cuda')).toBe(true)
    expect(isHardwarePref('auto')).toBe(false)
  })
  it('offers Metal, CUDA, Vulkan, and CPU as real dropdown values', () => {
    expect(hardwareChoices.map((c) => c.id)).toEqual(['gpu', 'metal', 'cuda', 'vulkan', 'cpu'])
  })
})

describe('backend selection', () => {
  it('uses Metal on macOS when the whisper build has it', () => {
    const plan = selectBackend('gpu', 'darwin', macProbe, whisperGpuBackends(macMetal), macMetal, 'Whisper Turbo')
    expect(plan).toMatchObject({ backend: 'metal', whisperUseGpu: true, whisperBinary: 'default', fellBack: false, note: null })
  })
  it('uses CUDA on NVIDIA machines when that binary is staged', () => {
    const plan = selectBackend('gpu', 'linux', nvidia, whisperGpuBackends(withCuda), withCuda, 'Whisper Turbo')
    expect(plan).toMatchObject({ backend: 'cuda', whisperBinary: 'cuda', parakeetProvider: 'cuda', fellBack: false })
  })
  it('uses Vulkan when CUDA is not the right fit', () => {
    const onlyVulkan = selectBackend('gpu', 'win32', vulkanGpu, whisperGpuBackends(withVulkan), withVulkan, 'Whisper Turbo')
    expect(onlyVulkan.backend).toBe('vulkan')
    expect(onlyVulkan.whisperBinary).toBe('vulkan')
    const nvidiaWithoutCuda = selectBackend('gpu', 'linux', nvidia, whisperGpuBackends(withVulkan), withVulkan, 'Whisper Turbo')
    expect(nvidiaWithoutCuda.backend).toBe('vulkan')
  })
  it('falls back to CPU with a yellow-note message when the chosen GPU backend cannot run', () => {
    const auto = selectBackend('gpu', 'linux', none, whisperGpuBackends(cpuOnly), cpuOnly, 'Whisper Turbo')
    expect(auto.backend).toBe('cpu')
    expect(auto.fellBack).toBe(true)
    expect(auto.whisperUseGpu).toBe(false)
    expect(auto.note).toBe(gpuFallbackNote('Whisper Turbo', 'gpu'))
    expect(auto.note).toContain('CPU')
    const explicit = selectBackend('cuda', 'darwin', macProbe, ['metal'], macMetal, 'Parakeet 0.6B')
    expect(explicit.backend).toBe('cpu')
    expect(explicit.note).toContain('NVIDIA CUDA')
    expect(explicit.note).toContain('Parakeet 0.6B')
  })
  it('honours an explicit CPU choice with no fallback note', () => {
    const plan = selectBackend('cpu', 'darwin', macProbe, ['metal'], macMetal, 'Whisper Turbo')
    expect(plan).toMatchObject({ backend: 'cpu', fellBack: false, note: null, whisperUseGpu: false })
  })
  it('maps Parakeet Metal to CoreML and Vulkan without a provider to CPU', () => {
    const metal = selectBackend('metal', 'darwin', macProbe, parakeetGpuBackends(['cpu', 'coreml']), macMetal, 'Parakeet 0.6B')
    expect(metal).toMatchObject({ backend: 'metal', parakeetProvider: 'coreml', fellBack: false })
    const vulkan = selectBackend('vulkan', 'linux', vulkanGpu, parakeetGpuBackends(['cpu']), cpuOnly, 'Parakeet 0.6B')
    expect(vulkan.backend).toBe('cpu')
    expect(vulkan.fellBack).toBe(true)
    expect(vulkan.note).toContain('Vulkan')
  })
})

describe('fallback copy and sherpa output', () => {
  it('missing-weight and missing-runtime notes name the install path', () => {
    expect(missingWeightsNote('Parakeet 0.6B', '/tmp/models/parakeet-tdt-0.6b-v3', false)).toContain('encoder.int8.onnx')
    expect(missingWeightsNote('Parakeet 0.6B', '/tmp/models/parakeet-tdt-0.6b-v3', false)).toContain('npm run setup:parakeet')
    expect(missingRuntimeNote('Parakeet 0.6B', true)).toContain('sherpa-onnx')
    const notes = collectEngineNotices(
      { kind: 'gpu-fallback', message: gpuFallbackNote('Whisper Turbo', 'gpu') },
      'parakeet-tdt-0.6b-v3',
      'ja'
    )
    expect(notes.map((n) => n.kind)).toEqual(['gpu-fallback', 'language'])
    expect(collectEngineNotices(null, 'parakeet-tdt-0.6b-v3', 'en')).toEqual([])
    expect(collectEngineNotices(null, 'whisper-turbo', 'ja')).toEqual([])
  })
  it('parses the sherpa JSON transcript and builds CLI args', () => {
    const sample = 'Started\n{"text": " the quick  brown fox ", "tokens": []}\n'
    expect(parseSherpaTranscript(sample)).toBe('the quick brown fox')
    expect(parseSherpaTranscript('no json here')).toBe('')
    const args = parakeetCliArgs(
      { encoder: '/m/encoder.int8.onnx', decoder: '/m/decoder.int8.onnx', joiner: '/m/joiner.int8.onnx', tokens: '/m/tokens.txt' },
      '/tmp/a.wav',
      'coreml',
      4
    )
    expect(args).toContain('--model-type=nemo_transducer')
    expect(args).toContain('--provider=coreml')
    expect(args.at(-1)).toBe('/tmp/a.wav')
    expect(sherpaGpuFailed('provider=cuda failed', 'cuda')).toBe(true)
    expect(sherpaGpuFailed('no such file', 'cuda')).toBe(false)
    expect(sherpaGpuFailed('anything', 'cpu')).toBe(false)
  })
  it('whisper.cpp -ng is the CPU switch and stays a flag the server accepts', () => {
    expect(serverArgs('/m.bin', 9, 2, false)).toContain('-ng')
    expect(serverArgs('/m.bin', 9, 2, true)).not.toContain('-ng')
    expect(cliArgs('/m.bin', '/a.wav', '/o', 'en', 2, false)).toContain('-ng')
    const supported = new Set(['-m', '--host', '--port', '-t', '-bs', '-bo', '-et', '-lpt', '-nth', '-l', '-ng'])
    for (const f of serverArgs('/m.bin', 9, 2, false).filter((x) => /^--?[a-z]/.test(x))) expect(supported.has(f), f).toBe(true)
  })
  it('reads GPU failure out of whisper.cpp logs', () => {
    expect(whisperLogsShowGpuFailure('whisper_init: use gpu    = 0', 'metal')).toBe(true)
    expect(whisperLogsShowGpuFailure('ggml_vulkan: no devices found', 'vulkan')).toBe(true)
    expect(whisperLogsShowGpuFailure('ggml_metal_init: using Metal', 'metal')).toBe(false)
    expect(normalizeWhisperManifest({ default: ['metal'], binaries: { cuda: true } }, 'linux').default).toEqual(['cpu', 'metal'])
    expect(normalizeProviders({ providers: ['coreml', 'nope'] })).toEqual(['cpu', 'coreml'])
  })
})
