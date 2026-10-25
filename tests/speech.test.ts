import fs, { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliArgs, ggmlModel, ggmlSmall, ggmlWeightsFor, modelOverridePath, serverArgs } from '@shared/model'
import { coercePrefs, PrefKey } from '@shared/prefs'
import {
  assumedWhisperManifest, collectEngineNotices, encodeVulkanAutoSkip, gpuFallbackNote, hardwareChoices, isHardwarePref, isSpeechModelId,
  type WhisperManifest,
  normalizeWhisperManifest, selectBackend, speechModelChoices, speechModelHint, VULKAN_FIRST_INFER_MS, VULKAN_READY_MS,
  vulkanAutoSkipReason, vulkanDeviceIsSoftware, vulkanSkipReason, vulkanSummaryHasGpu, vulkanSummaryIsUsable, whisperGpuBackends,
  whisperLogsShowGpuFailure, whisperNestedExecutable, whisperSmallId, whisperTurboId, whisperVariantDir
} from '@shared/speech'
import { clearVulkanAutoSkip, readVulkanAutoSkip, writeVulkanAutoSkip } from '../src/main/vulkanSkip'

const macMetal = assumedWhisperManifest('darwin')
const cpuOnly = assumedWhisperManifest('linux')
const withCuda: WhisperManifest = { default: ['cpu'], binaries: { cuda: true, vulkan: false } }
const withVulkan: WhisperManifest = { default: ['cpu'], binaries: { cuda: false, vulkan: true } }
const none = { metal: false, nvidia: false, vulkan: false }
const nvidia = { metal: false, nvidia: true, vulkan: false }
const vulkanGpu = { metal: false, nvidia: false, vulkan: true }
const macProbe = { metal: true, nvidia: false, vulkan: false }

describe('speech model ids', () => {
  it('accepts Turbo and Small, and rejects Parakeet and anything else', () => {
    expect(isSpeechModelId('whisper-turbo')).toBe(true)
    expect(isSpeechModelId('whisper-small')).toBe(true)
    expect(isSpeechModelId('parakeet-tdt-0.6b-v3')).toBe(false)
    expect(isSpeechModelId('whisper-large')).toBe(false)
    expect(isSpeechModelId(1)).toBe(false)
    expect(speechModelChoices.map((m) => m.id)).toEqual([whisperTurboId, whisperSmallId])
    expect(speechModelChoices.map((m) => m.label)).toEqual(['Whisper Turbo', 'Whisper Small'])
  })
  it('keeps Turbo as the default weights and points Small at ggml-small.bin', () => {
    expect(ggmlWeightsFor('whisper-turbo')).toEqual(ggmlModel)
    expect(ggmlWeightsFor('whisper-small')).toEqual(ggmlSmall)
    expect(ggmlWeightsFor('parakeet-tdt-0.6b-v3').fileName).toBe('ggml-large-v3-turbo.bin')
    expect(ggmlSmall.fileName).toBe('ggml-small.bin')
    expect(ggmlSmall.sha1).toBe('55356645c2b361a969dfd0ef2c5a50d530afd8d5')
    expect(ggmlSmall.approxBytes).toBe(487_601_967)
    expect(ggmlModel.fileName).toBe('ggml-large-v3-turbo.bin')
    expect(serverArgs(ggmlSmall.fileName, 9, 2, true)).toContain('ggml-small.bin')
    expect(serverArgs(ggmlModel.fileName, 9, 2, true)).toContain('ggml-large-v3-turbo.bin')
    expect(speechModelHint('whisper-small')).toContain('Whisper Small')
    expect(speechModelHint('whisper-turbo')).toContain('large-v3-turbo')
  })
  it('pins the fetch script to both ggml files', () => {
    const script = fs.readFileSync('scripts/fetch-model.mjs', 'utf8')
    expect(script).toContain(ggmlModel.sha1)
    expect(script).toContain(ggmlSmall.sha1)
    expect(script).toContain(ggmlSmall.fileName)
    expect(script).toContain(ggmlModel.fileName)
    const hashed = script.indexOf('await sha1(partial)')
    const renamed = script.indexOf('fs.renameSync(partial, dest)')
    expect(hashed).toBeGreaterThan(0)
    expect(hashed).toBeLessThan(renamed)
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
    const ok = coercePrefs({ 'flowa.hardware': 'vulkan', 'flowa.speechModel': 'whisper-small', 'flowa.language': 'en' }, 'linux')
    expect(ok[PrefKey.hardware]).toBe('vulkan')
    expect(ok[PrefKey.speechModel]).toBe('whisper-small')
    const retired = coercePrefs({ 'flowa.speechModel': 'parakeet-tdt-0.6b-v3' }, 'darwin')
    expect(retired[PrefKey.speechModel]).toBe('whisper-turbo')
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
    expect(plan).toMatchObject({ backend: 'cuda', whisperBinary: 'cuda', fellBack: false })
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
    const explicit = selectBackend('cuda', 'darwin', macProbe, ['metal'], macMetal, 'Whisper Small')
    expect(explicit.backend).toBe('cpu')
    expect(explicit.note).toContain('NVIDIA CUDA')
    expect(explicit.note).toContain('Whisper Small')
  })
  it('honours an explicit CPU choice with no fallback note', () => {
    const plan = selectBackend('cpu', 'darwin', macProbe, ['metal'], macMetal, 'Whisper Turbo')
    expect(plan).toMatchObject({ backend: 'cpu', fellBack: false, note: null, whisperUseGpu: false })
  })
  it('uses the same GPU plan for Whisper Small as for Turbo', () => {
    const turbo = selectBackend('gpu', 'darwin', macProbe, whisperGpuBackends(macMetal), macMetal, 'Whisper Turbo')
    const small = selectBackend('gpu', 'darwin', macProbe, whisperGpuBackends(macMetal), macMetal, 'Whisper Small')
    expect(small.backend).toBe(turbo.backend)
    expect(small.whisperBinary).toBe('default')
    expect(small.whisperUseGpu).toBe(true)
  })
})

describe('fallback copy', () => {
  it('keeps a GPU fallback note and drops nothing else onto it', () => {
    const notes = collectEngineNotices({ kind: 'gpu-fallback', message: gpuFallbackNote('Whisper Small', 'gpu') })
    expect(notes.map((n) => n.kind)).toEqual(['gpu-fallback'])
    expect(notes[0].message).toContain('Whisper Small')
    expect(collectEngineNotices(null)).toEqual([])
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
    expect(whisperLogsShowGpuFailure('ggml_vulkan: No devices found.', 'vulkan')).toBe(true)
    expect(whisperLogsShowGpuFailure('ggml_metal_init: using Metal', 'metal')).toBe(false)
    expect(normalizeWhisperManifest({ default: ['metal'], binaries: { cuda: true } }, 'linux').default).toEqual(['cpu', 'metal'])
  })
  it('treats a Vulkan CPU device as not a GPU and keeps discrete and integrated GPUs', () => {
    expect(vulkanSummaryHasGpu('deviceType = PHYSICAL_DEVICE_TYPE_CPU\ndeviceName = llvmpipe')).toBe(false)
    expect(vulkanSummaryHasGpu('deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU')).toBe(true)
    expect(vulkanSummaryHasGpu('deviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU')).toBe(true)
    expect(vulkanSummaryHasGpu('no devices')).toBeNull()
    expect(vulkanSummaryIsUsable(null)).toBe(true)
    expect(whisperVariantDir('vulkan')).toBe('whisper-server-vulkan')
    expect(whisperNestedExecutable('server', false)).toBe('whisper-server')
    expect(whisperNestedExecutable('cli', true)).toBe('whisper-cli.exe')
  })
  it('automatic mode stays on CPU for lavapipe and other software Vulkan devices', () => {
    const lavapipe = [
      'deviceType         = PHYSICAL_DEVICE_TYPE_CPU',
      'deviceName         = llvmpipe (LLVM 20.1.2, 256 bits)',
      'driverName         = llvmpipe'
    ].join('\n')
    const software = [
      lavapipe,
      'GPU0:\n\tdeviceType = PHYSICAL_DEVICE_TYPE_CPU\n\tdeviceName = lavapipe\n\tdriverName = lavapipe',
      'GPU0:\n\tdeviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU\n\tdeviceName = SwiftShader Device (LLVM 16.0.0)\n\tdriverName = SwiftShader',
      'GPU0:\n\tdeviceType = PHYSICAL_DEVICE_TYPE_CPU\n\tdeviceName = Microsoft Basic Render Driver',
      'GPU0:\n\tdeviceType = PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU\n\tdeviceName = WARP'
    ]
    for (const summary of software) {
      expect(vulkanSummaryHasGpu(summary), summary).toBe(false)
      expect(vulkanSummaryIsUsable(summary), summary).toBe(false)
      expect(vulkanDeviceIsSoftware(summary)).toBe(true)
    }
    const probe = { metal: false, nvidia: false, vulkan: false }
    for (const platform of ['linux', 'win32']) {
      const plan = selectBackend('gpu', platform, probe, whisperGpuBackends(withVulkan), withVulkan, 'Whisper Turbo')
      expect(plan.backend, platform).toBe('cpu')
      expect(plan.whisperBinary).toBe('default')
      expect(plan.fellBack).toBe(true)
    }
    const mixed = [
      'GPU0:',
      '\tdeviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU',
      '\tdeviceName = AMD Radeon RX 6800',
      'GPU1:',
      '\tdeviceType = PHYSICAL_DEVICE_TYPE_CPU',
      '\tdeviceName = llvmpipe (LLVM 15.0.7, 256 bits)'
    ].join('\n')
    expect(vulkanSummaryHasGpu(mixed)).toBe(true)
    const gpu = selectBackend('gpu', 'linux', { metal: false, nvidia: false, vulkan: true }, whisperGpuBackends(withVulkan), withVulkan, 'Whisper Turbo')
    expect(gpu.backend).toBe('vulkan')
    const remembered = selectBackend('gpu', 'linux', { metal: false, nvidia: false, vulkan: true }, whisperGpuBackends(withVulkan), withVulkan, 'Whisper Turbo', true)
    expect(remembered.backend).toBe('cpu')
    const explicit = selectBackend('vulkan', 'win32', probe, whisperGpuBackends(withVulkan), withVulkan, 'Whisper Turbo', true)
    expect(explicit.backend).toBe('vulkan')
    const cuda = selectBackend('gpu', 'linux', nvidia, whisperGpuBackends(withCuda), withCuda, 'Whisper Turbo', true)
    expect(cuda.backend).toBe('cuda')
    expect(VULKAN_READY_MS).toBeGreaterThanOrEqual(30_000)
    expect(VULKAN_READY_MS).toBeLessThan(3 * 60 * 1000)
    expect(VULKAN_FIRST_INFER_MS).toBeGreaterThanOrEqual(10_000)
    expect(VULKAN_FIRST_INFER_MS).toBeLessThan(2 * 60 * 1000)
    expect(vulkanSkipReason('ready', new Error('speech engine did not start in time'))).toBe('ready-timeout')
    expect(vulkanSkipReason('ready', new Error('speech engine exited (1)'))).toBe('start-failed')
    expect(vulkanSkipReason('transcribe', Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('transcription-timeout')
    expect(vulkanSkipReason('transcribe', new Error('HTTP 500'))).toBe('start-failed')
    const raw = encodeVulkanAutoSkip('ready-timeout', '2026-10-25T00:00:00.000Z')
    expect(vulkanAutoSkipReason(raw)).toBe('ready-timeout')
    expect(vulkanAutoSkipReason('{"reason":"nope"}')).toBeNull()
    expect(vulkanAutoSkipReason('not json')).toBeNull()
  })
  it('lets a packaged smoke test point at a small model and keeps release overrides strict', () => {
    expect(modelOverridePath({ FLOWA_WHISPER_MODEL: '/tmp/ggml-tiny.en.bin' }, 'ggml-large-v3-turbo.bin')).toBe('')
    expect(modelOverridePath({ FLOWA_WHISPER_MODEL: '/tmp/ggml-large-v3-turbo.bin' }, 'ggml-large-v3-turbo.bin')).toBe('/tmp/ggml-large-v3-turbo.bin')
    expect(modelOverridePath({ FLOWA_PACKAGED_SMOKE: '1', FLOWA_WHISPER_MODEL: '/tmp/ggml-tiny.en.bin' }, 'ggml-large-v3-turbo.bin')).toBe('/tmp/ggml-tiny.en.bin')
  })
  it('remembers a Vulkan give-up until Hardware is changed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-vulkan-skip-'))
    expect(readVulkanAutoSkip(dir)).toBeNull()
    writeVulkanAutoSkip(dir, 'transcription-timeout')
    expect(readVulkanAutoSkip(dir)).toBe('transcription-timeout')
    clearVulkanAutoSkip(dir)
    expect(readVulkanAutoSkip(dir)).toBeNull()
    writeVulkanAutoSkip(dir, 'not-a-reason' as 'start-failed')
    expect(readVulkanAutoSkip(dir)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
