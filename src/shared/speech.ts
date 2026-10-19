// Speech-model catalog, hardware backends, and the pure decisions behind
// Home → Speech model / Hardware.
//
// Whisper Turbo (default) is the existing whisper.cpp path:
//   ggml-large-v3-turbo.bin  ·  OpenAI whisper-large-v3-turbo  ·  see model.ts
//   GPU backends are compile-time ggml backends, selected at runtime with
//   the binary we launch and whisper.cpp's `-ng` (no-gpu) flag:
//     macOS            Apple Metal     (default setup:whisper build)
//     Windows/Linux    NVIDIA CUDA     (FLOWA_WHISPER_VARIANT=cuda)
//     Windows/Linux    Vulkan          (FLOWA_WHISPER_VARIANT=vulkan)
//     anywhere         CPU             (-ng, or a CPU-only binary)
//
// Parakeet 0.6B is NVIDIA Parakeet TDT 0.6B v3, the multilingual European
// checkpoint (English included). Upstream weights:
//   https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
//   License: CC-BY-4.0 (NVIDIA). 600M params. 25 European languages.
//   It detects the spoken language; there is no language prompt.
// We run the sherpa-onnx int8 ONNX export (Apache-2.0 runtime), not the
// .nemo archive — NeMo itself is a Python stack and a poor fit for the
// Electron main process. Files, kept next to the Whisper ggml bin:
//   models/parakeet-tdt-0.6b-v3/encoder.int8.onnx
//   models/parakeet-tdt-0.6b-v3/decoder.int8.onnx
//   models/parakeet-tdt-0.6b-v3/joiner.int8.onnx
//   models/parakeet-tdt-0.6b-v3/tokens.txt
// Official packed export (same files):
//   https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
// Per-file mirror used for the in-app download:
//   https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
// sherpa-onnx has no Vulkan execution provider. Parakeet's Apple GPU path
// is ONNX Runtime CoreML (the GPU / Neural Engine), reported in the UI as
// Apple Metal. CUDA uses a sherpa GPU build (`npm run setup:sherpa -- --cuda`).
// A Vulkan preference with Parakeet falls back to the CPU.

import { cleanTranscript } from './model'
import { languageDisplayName } from './languages'

export const whisperTurboId = 'whisper-turbo' as const
export const parakeetModelId = 'parakeet-tdt-0.6b-v3' as const

export type SpeechModelId = typeof whisperTurboId | typeof parakeetModelId

/** `gpu` picks Metal, CUDA, or Vulkan from the machine and the staged build. */
export type HardwarePref = 'gpu' | 'metal' | 'cuda' | 'vulkan' | 'cpu'
export type GpuBackend = 'metal' | 'cuda' | 'vulkan'
export type RuntimeBackend = 'cpu' | GpuBackend
export type ParakeetProvider = 'cpu' | 'coreml' | 'cuda' | 'vulkan'
export type WhisperBinaryKind = 'default' | 'cuda' | 'vulkan'

export const parakeetDirName = 'parakeet-tdt-0.6b-v3'
export const parakeetUpstreamRepo = 'nvidia/parakeet-tdt-0.6b-v3'
export const parakeetExportRepo = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
/** sherpa-onnx release whose offline CLI we stage. Keep in sync with scripts/fetch-sherpa.mjs. */
export const sherpaOnnxTag = 'v1.13.8'

export const parakeetArchiveUrl =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'

const parakeetFileBase = `https://huggingface.co/${parakeetExportRepo}/resolve/main`

export interface ParakeetWeight {
  name: string
  url: string
  minBytes: number
  approxBytes: number
}

export const parakeetWeights: readonly ParakeetWeight[] = [
  { name: 'encoder.int8.onnx', url: `${parakeetFileBase}/encoder.int8.onnx`, minBytes: 600 * 1024 * 1024, approxBytes: 652 * 1024 * 1024 },
  { name: 'decoder.int8.onnx', url: `${parakeetFileBase}/decoder.int8.onnx`, minBytes: 8 * 1024 * 1024, approxBytes: 12 * 1024 * 1024 },
  { name: 'joiner.int8.onnx', url: `${parakeetFileBase}/joiner.int8.onnx`, minBytes: 4 * 1024 * 1024, approxBytes: 7 * 1024 * 1024 },
  { name: 'tokens.txt', url: `${parakeetFileBase}/tokens.txt`, minBytes: 1024, approxBytes: 100 * 1024 }
]

/**
 * Languages Parakeet TDT 0.6B v3 actually transcribes (NVIDIA model card).
 * English is included. The model auto-detects; sherpa-onnx is not given a language code.
 */
export const parakeetLanguageCodes = [
  'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'
] as const

export const hardwareChoices: ReadonlyArray<{ id: HardwarePref; label: string }> = [
  { id: 'gpu', label: 'GPU (automatic)' },
  { id: 'metal', label: 'Apple Metal' },
  { id: 'cuda', label: 'NVIDIA CUDA' },
  { id: 'vulkan', label: 'Vulkan' },
  { id: 'cpu', label: 'CPU' }
]

export const speechModelChoices: ReadonlyArray<{ id: SpeechModelId; label: string }> = [
  { id: whisperTurboId, label: 'Whisper Turbo' },
  { id: parakeetModelId, label: 'Parakeet 0.6B' }
]

export function isSpeechModelId(value: unknown): value is SpeechModelId {
  return value === whisperTurboId || value === parakeetModelId
}

export function isHardwarePref(value: unknown): value is HardwarePref {
  return value === 'gpu' || value === 'metal' || value === 'cuda' || value === 'vulkan' || value === 'cpu'
}

export function speechModelById(id: SpeechModelId): { id: SpeechModelId; label: string } {
  return speechModelChoices.find((m) => m.id === id) ?? speechModelChoices[0]
}

export function speechModelHint(id: SpeechModelId): string {
  if (id === parakeetModelId) {
    return 'NVIDIA Parakeet TDT 0.6B v3. 25 European languages, including English. It detects the language from your voice.'
  }
  return 'OpenAI Whisper large-v3-turbo, on this computer, via whisper.cpp.'
}

export function hardwareHint(platform: string): string {
  if (platform === 'darwin') return 'Automatic uses Apple Metal on this Mac.'
  return 'Automatic uses NVIDIA CUDA when an NVIDIA driver is present, and Vulkan for other graphics chips.'
}

export function backendLabel(backend: RuntimeBackend): string {
  switch (backend) {
    case 'metal':
      return 'Apple Metal'
    case 'cuda':
      return 'NVIDIA CUDA'
    case 'vulkan':
      return 'Vulkan'
    case 'cpu':
      return 'CPU'
  }
}

export interface EngineNotice {
  kind: 'gpu-fallback' | 'missing-model' | 'missing-runtime' | 'language'
  message: string
}

/** Quiet in-app copy when a chosen GPU backend cannot run. */
export function gpuFallbackNote(modelLabel: string, requested: 'gpu' | GpuBackend): string {
  const what = requested === 'gpu' ? 'GPU' : backendLabel(requested)
  return `${what} isn't available for ${modelLabel} on this computer, so Flowa is using the CPU.`
}

export function missingWeightsNote(modelLabel: string, dir: string, packaged: boolean): string {
  const where = `Place encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, and tokens.txt in ${dir}.`
  if (packaged) return `${modelLabel} weights aren't installed. ${where}`
  return `${modelLabel} weights aren't installed. ${where} Or run npm run setup:parakeet.`
}

export function missingRuntimeNote(modelLabel: string, packaged: boolean): string {
  if (packaged) return `${modelLabel} needs the sherpa-onnx engine, and this install doesn't include it.`
  return `${modelLabel} needs sherpa-onnx. Run npm run setup:sherpa, then try again.`
}

export function languageNotice(modelId: SpeechModelId, languageCode: string): EngineNotice | null {
  if (modelId !== parakeetModelId) return null
  if (languageCode === 'auto' || (parakeetLanguageCodes as readonly string[]).includes(languageCode)) return null
  const name = languageDisplayName(languageCode)
  return {
    kind: 'language',
    message: `Parakeet 0.6B transcribes 25 European languages and detects which one you're speaking. For ${name}, choose Whisper Turbo.`
  }
}

export function collectEngineNotices(runtime: EngineNotice | null, modelId: SpeechModelId, languageCode: string): EngineNotice[] {
  const notes: EngineNotice[] = []
  if (runtime) notes.push(runtime)
  const lang = languageNotice(modelId, languageCode)
  if (lang) notes.push(lang)
  return notes
}

export interface GpuProbe {
  /** macOS Metal is usable. */
  metal: boolean
  /** An NVIDIA driver is visible (nvidia-smi or the Linux proc node). */
  nvidia: boolean
  /** A Vulkan loader or vulkaninfo is visible. */
  vulkan: boolean
}

export interface WhisperManifest {
  /** Backends compiled into the primary whisper-server / whisper-cli. */
  default: Array<'cpu' | GpuBackend>
  /** Dedicated whisper-server-cuda / whisper-server-vulkan binaries on disk. */
  binaries: { cuda: boolean; vulkan: boolean }
}

export function assumedWhisperManifest(platform: string): WhisperManifest {
  // Matches scripts/build-whisper.mjs with no FLOWA_WHISPER_VARIANT:
  // Metal on macOS, CPU everywhere else.
  if (platform === 'darwin') return { default: ['cpu', 'metal'], binaries: { cuda: false, vulkan: false } }
  return { default: ['cpu'], binaries: { cuda: false, vulkan: false } }
}

export function normalizeWhisperManifest(raw: unknown, platform: string): WhisperManifest {
  const fallback = assumedWhisperManifest(platform)
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  const isBackend = (x: unknown): x is 'cpu' | GpuBackend => x === 'cpu' || x === 'metal' || x === 'cuda' || x === 'vulkan'
  const defaults = Array.isArray(r.default) ? r.default.filter(isBackend) : fallback.default
  const binaries = r.binaries && typeof r.binaries === 'object' ? (r.binaries as Record<string, unknown>) : {}
  return {
    default: defaults.includes('cpu') ? defaults : ['cpu', ...defaults],
    binaries: { cuda: binaries.cuda === true, vulkan: binaries.vulkan === true }
  }
}

export function withDetectedBinaries(manifest: WhisperManifest, present: { cuda: boolean; vulkan: boolean }): WhisperManifest {
  return {
    ...manifest,
    binaries: {
      cuda: manifest.binaries.cuda || present.cuda,
      vulkan: manifest.binaries.vulkan || present.vulkan
    }
  }
}

export function whisperGpuBackends(manifest: WhisperManifest): GpuBackend[] {
  const set = new Set<GpuBackend>()
  for (const b of manifest.default) if (b !== 'cpu') set.add(b)
  if (manifest.binaries.cuda) set.add('cuda')
  if (manifest.binaries.vulkan) set.add('vulkan')
  return (['metal', 'cuda', 'vulkan'] as const).filter((b) => set.has(b))
}

export function parakeetGpuBackends(providers: readonly string[]): GpuBackend[] {
  const set = new Set(providers)
  const out: GpuBackend[] = []
  if (set.has('coreml')) out.push('metal')
  if (set.has('cuda')) out.push('cuda')
  if (set.has('vulkan')) out.push('vulkan')
  return out
}

export function normalizeProviders(raw: unknown): string[] {
  const known = new Set(['cpu', 'coreml', 'cuda', 'vulkan'])
  if (!raw || typeof raw !== 'object') return ['cpu']
  const list = (raw as { providers?: unknown }).providers
  if (!Array.isArray(list)) return ['cpu']
  const out = list.filter((x): x is string => typeof x === 'string' && known.has(x))
  if (!out.includes('cpu')) out.unshift('cpu')
  return out
}

export interface BackendPlan {
  backend: RuntimeBackend
  parakeetProvider: ParakeetProvider
  whisperUseGpu: boolean
  whisperBinary: WhisperBinaryKind
  fellBack: boolean
  note: string | null
}

function automaticBackend(platform: string, probe: GpuProbe, gpu: readonly GpuBackend[]): GpuBackend | null {
  // macOS stays on Metal. CUDA and Vulkan are explicit choices there.
  if (platform === 'darwin') return probe.metal && gpu.includes('metal') ? 'metal' : null
  // Windows and Linux: NVIDIA → CUDA when that backend is actually staged.
  if (probe.nvidia && gpu.includes('cuda')) return 'cuda'
  // Vulkan when CUDA (or Metal) isn't the right fit: other GPUs, and NVIDIA
  // machines whose build shipped Vulkan instead of CUDA.
  if (gpu.includes('vulkan') && (probe.vulkan || probe.nvidia)) return 'vulkan'
  return null
}

export function whisperBinaryKind(backend: RuntimeBackend, builds: WhisperManifest): WhisperBinaryKind {
  if (backend === 'cuda' && builds.binaries.cuda) return 'cuda'
  if (backend === 'vulkan' && builds.binaries.vulkan) return 'vulkan'
  return 'default'
}

function planFor(
  backend: RuntimeBackend,
  builds: WhisperManifest,
  modelLabel: string,
  fellBack: boolean,
  requested: 'gpu' | GpuBackend
): BackendPlan {
  return {
    backend,
    parakeetProvider: backend === 'metal' ? 'coreml' : backend,
    whisperUseGpu: backend !== 'cpu',
    whisperBinary: whisperBinaryKind(backend, builds),
    fellBack,
    note: fellBack ? gpuFallbackNote(modelLabel, requested) : null
  }
}

/**
 * Pick the backend we will actually launch.
 * `gpu` (the default) is automatic: Metal on macOS, CUDA when NVIDIA is
 * present and staged, otherwise Vulkan when that backend can run.
 * An explicit backend that isn't staged falls back to CPU with `note` set.
 */
export function selectBackend(
  pref: HardwarePref,
  platform: string,
  probe: GpuProbe,
  gpu: readonly GpuBackend[],
  builds: WhisperManifest,
  modelLabel: string
): BackendPlan {
  if (pref === 'cpu') return planFor('cpu', builds, modelLabel, false, 'gpu')
  if (pref === 'gpu') {
    const chosen = automaticBackend(platform, probe, gpu)
    if (!chosen) return planFor('cpu', builds, modelLabel, true, 'gpu')
    return planFor(chosen, builds, modelLabel, false, 'gpu')
  }
  if (gpu.includes(pref)) return planFor(pref, builds, modelLabel, false, pref)
  return planFor('cpu', builds, modelLabel, true, pref)
}

export function whisperServerFile(kind: WhisperBinaryKind, windows: boolean): string {
  const stem = kind === 'default' ? 'whisper-server' : `whisper-server-${kind}`
  return windows ? `${stem}.exe` : stem
}

export function whisperCliFile(kind: WhisperBinaryKind, windows: boolean): string {
  const stem = kind === 'default' ? 'whisper-cli' : `whisper-cli-${kind}`
  return windows ? `${stem}.exe` : stem
}

/** True when a whisper.cpp log shows the requested GPU backend did not come up. */
export function whisperLogsShowGpuFailure(logs: string, backend: GpuBackend): boolean {
  const blob = logs.toLowerCase()
  if (/use gpu\s*=\s*0/.test(blob)) return true
  if (backend === 'metal' && /metal[^\n]{0,60}(error|failed)|no metal device/.test(blob)) return true
  if (backend === 'cuda' && /cuda[^\n]{0,80}(error|failed|not available|no device)|no cuda/.test(blob)) return true
  if (backend === 'vulkan' && /vulkan[^\n]{0,80}(error|failed|not available|no device)/.test(blob)) return true
  return false
}

export interface ParakeetPaths {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

/** argv for sherpa-onnx-offline. Provider is cpu, coreml (Apple GPU), cuda, or vulkan. */
export function parakeetCliArgs(files: ParakeetPaths, wavPath: string, provider: ParakeetProvider, threads: number): string[] {
  return [
    `--encoder=${files.encoder}`,
    `--decoder=${files.decoder}`,
    `--joiner=${files.joiner}`,
    `--tokens=${files.tokens}`,
    '--model-type=nemo_transducer',
    `--provider=${provider}`,
    `--num-threads=${String(threads)}`,
    '--decoding-method=greedy_search',
    wavPath
  ]
}

/** Pull the transcript out of sherpa-onnx-offline's JSON line. */
export function parseSherpaTranscript(output: string): string {
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as { text?: unknown }
      if (typeof parsed.text === 'string') return cleanTranscript(parsed.text)
    } catch {
      /* a log line that merely starts with a brace */
    }
  }
  return ''
}

/**
 * A non-zero sherpa exit while a GPU provider was requested.
 * The CLI prints its config (including the provider) before most failures,
 * so a GPU-provider run that exits is retried on CPU.
 */
export function sherpaGpuFailed(output: string, provider: ParakeetProvider): boolean {
  if (provider === 'cpu') return false
  const t = output.toLowerCase()
  if (/no such file|invalid wav|failed to read|expected 1 channel/.test(t)) return false
  return true
}
