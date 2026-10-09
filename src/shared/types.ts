// Shared state shape broadcast from the main process to every renderer.
// Mirrors the @Published properties of the Swift ObservableObjects:
// DictationPipeline, Transcriber, PermissionChecker, FnConflictDetector, GlobalHotkey.

import type { Dictation } from './recent'
import type { Prefs } from './prefs'

export type TranscriberStatus =
  | { kind: 'idle' }
  /** Engine load / warm-up. progress 0…1 over expectedPrepareSeconds (Swift parity). */
  | { kind: 'preparing'; progress: number }
  /** Electron-only: first-run model download (the Swift app ships the weights inside the bundle). */
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'ready' }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string }

export type AppleFnBehavior = 0 | 1 | 2 | 3

export type ConflictStatus =
  | { kind: 'clean' }
  | { kind: 'unknown' }
  | { kind: 'conflict'; behavior: AppleFnBehavior; displayName: string }
  /** Electron-only: the configured accelerator could not be registered (taken by another app). */
  | { kind: 'shortcutTaken'; accelerator: string }

export interface PermissionsState {
  microphone: boolean
  inputMonitoring: boolean
  accessibility: boolean
  /** Which of the three steps exist on this OS (the rest are implicitly granted). */
  applicable: { microphone: boolean; inputMonitoring: boolean; accessibility: boolean }
  /** Linux: which auto-paste tool was found (xdotool / wtype / ydotool), if any. */
  pasteTool?: string | null
}

export interface ShortcutState {
  /** 'fn' or an Electron accelerator string. */
  accelerator: string
  /** Human label, e.g. "fn" or "Ctrl+Shift+Space". */
  label: string
  usesFn: boolean
  active: boolean
}

export interface EngineInfo {
  modelName: string
  modelFile: string | null
  binary: string | null
  detail: string
}

export interface AppState {
  platform: NodeJS.Platform | string
  /** "Mac" / "PC" / "computer" — used where the Swift copy says "this Mac". */
  machineNoun: string
  version: string
  prefs: Prefs
  permissions: PermissionsState
  allGranted: boolean
  conflict: ConflictStatus
  transcriber: TranscriberStatus
  transcriberReady: boolean
  needsSetup: boolean
  isTranscribing: boolean
  session: 'idle' | 'recording'
  lastErrorMessage: string | null
  recent: Dictation[]
  launchAtLogin: boolean
  shortcut: ShortcutState
  engine: EngineInfo
}

/** Flow Bar window: what main tells the bar renderer. */
export interface CaptureStartRequest {
  deviceId: string
  maxDurationSeconds: number | null
  generation: number
}

export interface CaptureResult {
  generation: number
  /** 16 kHz mono float samples. Empty when nothing was captured. */
  samples: Float32Array
  peak: number
  deviceKind: 'standard' | 'continuity'
  stoppedForMaxDuration: boolean
}
