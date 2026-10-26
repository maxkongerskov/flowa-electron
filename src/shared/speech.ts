// Speech-model catalog, hardware backends, and the pure decisions behind
// Home → Speech model / Hardware.
//
// Both models are whisper.cpp ggml files (see model.ts). Turbo is the default.
//   whisper-turbo   ggml-large-v3-turbo.bin   OpenAI whisper-large-v3-turbo
//   whisper-small   ggml-small.bin            OpenAI whisper small (multilingual)
// GPU backends are compile-time ggml backends, selected at runtime with
// the binary we launch and whisper.cpp's `-ng` (no-gpu) flag:
//   macOS            Apple Metal     (default setup:whisper build)
//   Windows/Linux    NVIDIA CUDA     (FLOWA_WHISPER_VARIANT=cuda)
//   Windows/Linux    Vulkan          (FLOWA_WHISPER_VARIANT=vulkan)
//   anywhere         CPU             (-ng, or a CPU-only binary)
// The selected model only changes the `-m` weights file. The same server
// binary and the same Metal / CUDA / Vulkan / CPU plan run either one.

export const whisperTurboId = 'whisper-turbo' as const
export const whisperSmallId = 'whisper-small' as const

export type SpeechModelId = typeof whisperTurboId | typeof whisperSmallId

/** `gpu` picks Metal, CUDA, or Vulkan from the machine and the staged build. */
export type HardwarePref = 'gpu' | 'metal' | 'cuda' | 'vulkan' | 'cpu'
export type GpuBackend = 'metal' | 'cuda' | 'vulkan'
export type RuntimeBackend = 'cpu' | GpuBackend
export type WhisperBinaryKind = 'default' | 'cuda' | 'vulkan'

export const hardwareChoices: ReadonlyArray<{ id: HardwarePref; label: string }> = [
  { id: 'gpu', label: 'GPU (automatic)' },
  { id: 'metal', label: 'Apple Metal' },
  { id: 'cuda', label: 'NVIDIA CUDA' },
  { id: 'vulkan', label: 'Vulkan' },
  { id: 'cpu', label: 'CPU' }
]

export const speechModelChoices: ReadonlyArray<{ id: SpeechModelId; label: string }> = [
  { id: whisperTurboId, label: 'Whisper Turbo' },
  { id: whisperSmallId, label: 'Whisper Small' }
]

export function isSpeechModelId(value: unknown): value is SpeechModelId {
  return value === whisperTurboId || value === whisperSmallId
}

export function isHardwarePref(value: unknown): value is HardwarePref {
  return value === 'gpu' || value === 'metal' || value === 'cuda' || value === 'vulkan' || value === 'cpu'
}

export function speechModelById(id: SpeechModelId): { id: SpeechModelId; label: string } {
  return speechModelChoices.find((m) => m.id === id) ?? speechModelChoices[0]
}

export function speechModelHint(id: SpeechModelId): string {
  if (id === whisperSmallId) {
    return 'OpenAI Whisper Small, on this computer, via whisper.cpp. Lighter than Turbo, and multilingual.'
  }
  return 'OpenAI Whisper large-v3-turbo, on this computer, via whisper.cpp.'
}

export function hardwareHint(platform: string): string {
  if (platform === 'darwin') return 'Automatic uses Apple Metal on this Mac.'
  return 'Automatic uses NVIDIA CUDA when an NVIDIA driver is present, and Vulkan only when a real GPU is present. Software Vulkan stays on the CPU.'
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
  kind: 'gpu-fallback'
  message: string
}

/** Quiet in-app copy when a chosen GPU backend cannot run. */
export function gpuFallbackNote(modelLabel: string, requested: 'gpu' | GpuBackend): string {
  const what = requested === 'gpu' ? 'GPU' : backendLabel(requested)
  return `${what} isn't available for ${modelLabel} on this computer, so Flowa is using the CPU.`
}

export function collectEngineNotices(runtime: EngineNotice | null): EngineNotice[] {
  return runtime ? [runtime] : []
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

export interface BackendPlan {
  backend: RuntimeBackend
  whisperUseGpu: boolean
  whisperBinary: WhisperBinaryKind
  fellBack: boolean
  note: string | null
}

function automaticBackend(
  platform: string,
  probe: GpuProbe,
  gpu: readonly GpuBackend[],
  skipRememberedVulkan: boolean
): GpuBackend | null {
  // macOS stays on Metal. CUDA and Vulkan are explicit choices there.
  if (platform === 'darwin') return probe.metal && gpu.includes('metal') ? 'metal' : null
  // Windows and Linux: NVIDIA → CUDA when that backend is actually staged.
  if (probe.nvidia && gpu.includes('cuda')) return 'cuda'
  // Vulkan only for a real GPU. A remembered failure stays on CPU until the
  // hardware preference is changed. NVIDIA without a CUDA binary still uses Vulkan.
  if (skipRememberedVulkan) return null
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
    whisperUseGpu: backend !== 'cpu',
    whisperBinary: whisperBinaryKind(backend, builds),
    fellBack,
    note: fellBack ? gpuFallbackNote(modelLabel, requested) : null
  }
}

/**
 * Pick the backend we will actually launch.
 * `gpu` (the default) is automatic: Metal on macOS, CUDA when NVIDIA is
 * present and staged, otherwise Vulkan when a real GPU is present.
 * `skipRememberedVulkan` is set after a Vulkan server failed or ran past its
 * time budget. An explicit Vulkan choice still tries it. An explicit backend
 * that isn't staged falls back to CPU with `note` set.
 */
export function selectBackend(
  pref: HardwarePref,
  platform: string,
  probe: GpuProbe,
  gpu: readonly GpuBackend[],
  builds: WhisperManifest,
  modelLabel: string,
  skipRememberedVulkan = false
): BackendPlan {
  if (pref === 'cpu') return planFor('cpu', builds, modelLabel, false, 'gpu')
  if (pref === 'gpu') {
    const chosen = automaticBackend(platform, probe, gpu, skipRememberedVulkan)
    if (!chosen) return planFor('cpu', builds, modelLabel, true, 'gpu')
    return planFor(chosen, builds, modelLabel, false, 'gpu')
  }
  if (gpu.includes(pref)) return planFor(pref, builds, modelLabel, false, pref)
  return planFor('cpu', builds, modelLabel, true, pref)
}

/** Folder that holds one Vulkan or CUDA engine, isolated from the CPU shared libraries. */
export function whisperVariantDir(kind: WhisperBinaryKind): string | null {
  if (kind === 'vulkan' || kind === 'cuda') return `whisper-server-${kind}`
  return null
}

export function whisperServerFile(kind: WhisperBinaryKind, windows: boolean): string {
  const stem = kind === 'default' ? 'whisper-server' : `whisper-server-${kind}`
  return windows ? `${stem}.exe` : stem
}

export function whisperCliFile(kind: WhisperBinaryKind, windows: boolean): string {
  const stem = kind === 'default' ? 'whisper-cli' : `whisper-cli-${kind}`
  return windows ? `${stem}.exe` : stem
}

/** Name inside whisper-server-vulkan/: the executable keeps upstream's name. */
export function whisperNestedExecutable(role: 'server' | 'cli', windows: boolean): string {
  const stem = role === 'server' ? 'whisper-server' : 'whisper-cli'
  return windows ? `${stem}.exe` : stem
}

/**
 * Cold Turbo load on a real GPU fits in this window. A software Vulkan device
 * loading Turbo does not, and neither does a server that never opens its port.
 */
export const VULKAN_READY_MS = 60_000
/** Prewarm is one second of silence, including the first shader compile. */
export const VULKAN_FIRST_INFER_MS = 30_000

export type VulkanSkipReason = 'start-failed' | 'ready-timeout' | 'transcription-timeout'

export const vulkanAutoSkipFile = 'vulkan-auto-skip.json'

const SOFTWARE_VULKAN = /lavapipe|llvmpipe|swiftshader|basic\s*render|\bwarp\b/i

/** lavapipe, llvmpipe, SwiftShader, Microsoft Basic Render, and WARP. */
export function vulkanDeviceIsSoftware(name: string): boolean {
  return SOFTWARE_VULKAN.test(name)
}

interface VulkanSummaryDevice {
  type: string | null
  label: string
}

/** One vulkaninfo device. Names come from deviceName and driverName only. */
export function vulkanSummaryDevices(summary: string): VulkanSummaryDevice[] {
  const chunks = summary.split(/\n(?=[ \t]*GPU\d+[ \t]*:)/)
  const devices: VulkanSummaryDevice[] = []
  for (const chunk of chunks) {
    const type = /PHYSICAL_DEVICE_TYPE_([A-Z0-9_]+)/.exec(chunk)?.[1] ?? null
    const labels = [...chunk.matchAll(/^[ \t]*(?:deviceName|driverName)[ \t]*=[ \t]*(.+)$/gim)].map((match) => match[1].trim())
    const label = labels.join(' ')
    if (!type && !label) continue
    devices.push({ type, label })
  }
  return devices
}

/**
 * `true` when any device is a real GPU. `false` when every device is a CPU
 * type or a software implementation. `null` when the summary names no device
 * (unknown, so the caller may still try Vulkan).
 */
export function vulkanSummaryHasGpu(summary: string): boolean | null {
  const devices = vulkanSummaryDevices(summary)
  if (devices.length === 0) return null
  const usable = devices.some((device) => {
    if (vulkanDeviceIsSoftware(device.label)) return false
    if (!device.type || device.type === 'CPU') return false
    return true
  })
  if (usable) return true
  const classified = devices.some((device) => device.type !== null || vulkanDeviceIsSoftware(device.label))
  return classified ? false : null
}

/** Loader is present. A missing summary means try Vulkan. Software-only does not. */
export function vulkanSummaryIsUsable(summary: string | null): boolean {
  if (summary == null) return true
  return vulkanSummaryHasGpu(summary) !== false
}

export interface VulkanAutoSkipRecord {
  reason: VulkanSkipReason
  version: string
  at: string
}

export function encodeVulkanAutoSkip(reason: VulkanSkipReason, version: string, at = new Date().toISOString()): string {
  return `${JSON.stringify({ reason, version, at })}\n`
}

export function parseVulkanAutoSkip(raw: string | null | undefined): VulkanAutoSkipRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown; version?: unknown; at?: unknown }
    if (parsed.reason !== 'start-failed' && parsed.reason !== 'ready-timeout' && parsed.reason !== 'transcription-timeout') return null
    if (typeof parsed.version !== 'string' || parsed.version.trim() === '') return null
    return { reason: parsed.reason, version: parsed.version, at: typeof parsed.at === 'string' ? parsed.at : '' }
  } catch {
    return null
  }
}

/** Active only for the app version that wrote the file. A newer build retries Vulkan. */
export function vulkanAutoSkipReason(raw: string | null | undefined, appVersion: string): VulkanSkipReason | null {
  const parsed = parseVulkanAutoSkip(raw)
  if (!parsed || parsed.version !== appVersion) return null
  return parsed.reason
}

/** Why a Vulkan attempt is not worth retrying until the user changes Hardware. */
export function vulkanSkipReason(phase: 'ready' | 'transcribe', error: unknown): VulkanSkipReason {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  const timedOut = name === 'TimeoutError' || message.includes('did not start in time')
  if (!timedOut) return 'start-failed'
  return phase === 'ready' ? 'ready-timeout' : 'transcription-timeout'
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

