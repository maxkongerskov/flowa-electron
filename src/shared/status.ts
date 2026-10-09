// User-facing copy and pure state helpers ported from the Swift views:
// FlowaApp.swift (menu bar status/icon), Transcriber.swift (friendly errors,
// needsSetup), DictationPipeline.swift (silence / max-duration messages),
// InstallingView.swift (countdown).

import type { ConflictStatus, PermissionsState, TranscriberStatus } from './types'

/** Install countdown length shown to the user (~2 minutes). */
export const expectedPrepareSeconds = 120

export function machineNoun(platform: string): string {
  if (platform === 'darwin') return 'Mac'
  if (platform === 'win32') return 'PC'
  return 'computer'
}

export function needsSetup(status: TranscriberStatus, isLoaded: boolean): boolean {
  switch (status.kind) {
    case 'ready':
    case 'transcribing':
      return false
    case 'error':
    case 'preparing':
    case 'downloading':
      return true
    case 'idle':
      return !isLoaded
  }
}

export function isReady(status: TranscriberStatus, isLoaded: boolean): boolean {
  return isLoaded && (status.kind === 'ready' || status.kind === 'transcribing')
}

/** "1:59" countdown, or "Almost done…" once past the estimate. */
export function countdownText(progress: number): string {
  const clamped = Math.min(1, Math.max(0, progress))
  const remaining = Math.ceil(expectedPrepareSeconds * (1 - clamped))
  if (remaining <= 0) return 'Almost done…'
  const m = Math.floor(remaining / 60)
  const s = remaining % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.round(n / 1024)} KB`
}

export function allGranted(p: PermissionsState): boolean {
  return p.microphone && p.inputMonitoring && p.accessibility
}

/** Port of MenuBarMenu.statusText. `keyLabel` is "fn" on macOS. */
export function menuStatusText(args: {
  transcriber: TranscriberStatus
  needsSetup: boolean
  permissions: PermissionsState
  conflict: ConflictStatus
  isTranscribing: boolean
  keyLabel: string
}): string {
  const { transcriber: t, permissions: p } = args
  if (t.kind === 'error') return 'Installation needs attention'
  if (t.kind === 'downloading') {
    const pct = t.total > 0 ? Math.floor((t.received / t.total) * 100) : 0
    return `Installing… downloading ${pct}%`
  }
  if (t.kind === 'preparing') {
    const remaining = Math.ceil(expectedPrepareSeconds * (1 - Math.min(1, Math.max(0, t.progress))))
    if (remaining <= 0) return 'Installing… almost done'
    return `Installing… ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
  }
  if (args.needsSetup) return 'Installing… ~2 min'
  if (!p.microphone) return 'Microphone permission missing'
  if (!p.inputMonitoring) return 'Input Monitoring permission missing'
  if (!p.accessibility) return 'Accessibility permission missing'
  if (args.conflict.kind === 'conflict') return 'Apple Fn handler is active'
  if (args.conflict.kind === 'shortcutTaken') return 'Shortcut is in use by another app'
  if (args.isTranscribing) return 'Transcribing…'
  return `Ready — press ${args.keyLabel} to dictate`
}

export type TrayIconName = 'waveform' | 'ellipsis' | 'download' | 'waveformSlash'

/** Port of FlowaApp.menuBarSymbolName. */
export function trayIconName(args: {
  isTranscribing: boolean
  needsSetup: boolean
  allGranted: boolean
  conflict: ConflictStatus
}): TrayIconName {
  if (args.isTranscribing) return 'ellipsis'
  if (args.needsSetup) return 'download'
  const clean = args.conflict.kind === 'clean' || args.conflict.kind === 'unknown'
  // Swift: `conflict.status != .clean` also counts .unknown as not clean. On macOS
  // with fn, unknown means the HIToolbox key was never written (= default
  // "Show Emoji" on recent macOS), so we keep Swift's strictness there via caller.
  if (!args.allGranted || !clean) return 'waveformSlash'
  return 'waveform'
}

export function silenceMessage(kind: 'standard' | 'continuity'): string {
  if (kind === 'continuity') {
    return 'No speech heard from the iPhone mic. Hold the phone near your mouth and try again — Continuity picks up the phone, not the Mac.'
  }
  return 'No speech heard. Check the selected microphone and try again.'
}

export function maxDurationStoppedMessage(maxMinutes: number): string {
  const label =
    maxMinutes >= 60 && maxMinutes % 60 === 0
      ? `${maxMinutes / 60} hour${maxMinutes === 60 ? '' : 's'}`
      : `${maxMinutes} minute${maxMinutes === 1 ? '' : 's'}`
  return `Recording stopped at your ${label} limit. Transcript was still saved.`
}

export function modelNotReadyMessage(status: TranscriberStatus, noun: string): string {
  if (status.kind === 'error') return status.message
  if (status.kind === 'preparing' || status.kind === 'downloading') {
    return `Still installing Flowa on this ${noun}. Try again in a moment.`
  }
  return "Flowa isn't finished installing yet. Check the main window."
}

/** Port of Transcriber.friendlyLoadError. */
export function friendlyLoadError(message: string, noun: string): string {
  const text = message.toLowerCase()
  if (text.includes('space') || text.includes('disk') || text.includes('enospc')) {
    return `Couldn't finish installation — your ${noun} may be low on disk space.`
  }
  if (text.includes('missing')) return message
  if (text.includes('download') || text.includes('network') || text.includes('enotfound') || text.includes('fetch')) {
    return "Couldn't download the speech engine. Check your internet connection and try again."
  }
  return "Couldn't finish installation. Try again, or use Repair Flowa from the menu bar."
}

export const appleFnBehaviorNames: Record<number, string> = {
  0: 'Do Nothing',
  1: 'Change Input Source',
  2: 'Show Emoji & Symbols',
  3: 'Start Dictation'
}

/** Port of FnConflictDetector.check() given the raw AppleFnUsageType value. */
export function fnConflictFromRaw(raw: string | number | null | undefined): ConflictStatus {
  if (raw === null || raw === undefined || raw === '') return { kind: 'unknown' }
  const v = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10)
  if (!Number.isInteger(v) || !(v in appleFnBehaviorNames)) return { kind: 'unknown' }
  if (v === 0) return { kind: 'clean' }
  return { kind: 'conflict', behavior: v as 0 | 1 | 2 | 3, displayName: appleFnBehaviorNames[v] }
}

/** Port of HomeView.meta(for:) using an abbreviated relative formatter. */
export function relativeAge(date: Date, now: Date): string {
  const diff = Math.round((date.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(diff)
  const past = diff <= 0
  const fmt = (n: number, unit: string): string => (past ? `${n} ${unit} ago` : `in ${n} ${unit}`)
  if (abs < 1) return 'now'
  if (abs < 60) return fmt(abs, 'sec.')
  if (abs < 3600) return fmt(Math.floor(abs / 60), 'min.')
  if (abs < 86400) return fmt(Math.floor(abs / 3600), 'hr.')
  if (abs < 7 * 86400) {
    const d = Math.floor(abs / 86400)
    return fmt(d, d === 1 ? 'day' : 'days')
  }
  if (abs < 30 * 86400) return fmt(Math.floor(abs / (7 * 86400)), 'wk.')
  if (abs < 365 * 86400) return fmt(Math.floor(abs / (30 * 86400)), 'mo.')
  return fmt(Math.floor(abs / (365 * 86400)), 'yr.')
}

export function recentMeta(date: Date, targetAppName: string | null, now: Date): string {
  const age = relativeAge(date, now)
  return targetAppName ? `${age} · ${targetAppName}` : age
}
