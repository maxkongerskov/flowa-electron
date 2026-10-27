// Shared state shape broadcast from the main process to every renderer.
// Mirrors the @Published properties of the Swift ObservableObjects:
// DictationPipeline, Transcriber, PermissionChecker, FnConflictDetector, GlobalHotkey.

import type { Dictation } from './recent'
import type { Prefs } from './prefs'
import type { UpdateState } from './updates'
import type { EngineNotice } from './speech'

export type { UpdateState }

export type TranscriberStatus =
  | { kind: 'idle' }
  /** Engine load / warm-up. progress 0…1 over expectedPrepareSeconds (Swift parity). */
  | { kind: 'preparing'; progress: number }
  /** Electron-only: first-run model download (the Swift app ships the weights inside the bundle). */
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'ready' }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string }
  /** Weights or the Parakeet runtime are absent. Home stays open; the yellow note explains it. */
  | { kind: 'unavailable'; message: string }

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
  /** 'fn', a modifier token such as 'RightAlt', or an Electron accelerator. */
  accelerator: string
  /** Human label, e.g. "fn", "F8", or "Ctrl+Shift+Space". */
  label: string
  usesFn: boolean
  /** How the shortcut is registered. */
  kind: 'fn' | 'modifier' | 'accelerator'
  active: boolean
  /** Bumped when the tray/app menu asks the settings UI to record a shortcut. */
  recordNonce: number
}

export interface EngineInfo {
  modelName: string
  modelFile: string | null
  binary: string | null
  detail: string
}

export interface AppState {
  /** Bumped on every snapshot so a late `getState` cannot overwrite a newer push. */
  stateRevision: number
  platform: NodeJS.Platform | string
  /** "Mac" / "PC" / "computer" — used where the Swift copy says "this Mac". */
  machineNoun: string
  version: string
  prefs: Prefs
  /** Set when prefs.json could not be parsed and was replaced with defaults. */
  prefsWarning: string | null
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
  /** Quiet in-app notes: GPU→CPU fallback, missing Parakeet files, language coverage. */
  engineNotices: EngineNotice[]
  /** GitHub release check. Idle unless a newer version, or a manual check, has something to say. */
  update: UpdateState
}

/** Flow Bar window: what main tells the bar renderer. */
export interface CaptureStartRequest {
  deviceId: string
  maxDurationSeconds: number | null
  generation: number
  /** Beta live transcription: send 1 s blocks over capture:block instead of buffering. */
  stream?: boolean
}

export interface CaptureResult {
  generation: number
  /** 16 kHz mono float samples. Empty when nothing was captured. */
  samples: Float32Array
  peak: number
  deviceKind: 'standard' | 'continuity'
  stoppedForMaxDuration: boolean
}
