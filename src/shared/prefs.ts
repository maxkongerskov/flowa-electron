// Port of Flowa/Support/Preferences.swift — single source of truth for
// preference keys and pure helpers. Keys are kept identical to the Swift
// app's UserDefaults keys so settings could be migrated 1:1.

export const PrefKey = {
  language: 'flowa.language',
  microphone: 'flowa.microphone',
  colorSchemeDark: 'flowa.colorScheme.dark',
  onboardingComplete: 'flowa.onboardingComplete',
  firstRunComplete: 'flowa.firstRunComplete',
  /** Integer minutes. Default / recommended hard limit: 60. 0 = no limit. */
  maxDurationMinutes: 'flowa.maxDurationMinutes',
  /** Electron-only: global shortcut accelerator used where fn is unavailable. */
  shortcut: 'flowa.shortcut'
} as const

export interface Prefs {
  [PrefKey.language]: string
  [PrefKey.microphone]: string
  [PrefKey.colorSchemeDark]: boolean
  [PrefKey.onboardingComplete]: boolean
  [PrefKey.firstRunComplete]: boolean
  [PrefKey.maxDurationMinutes]: number
  [PrefKey.shortcut]: string
}

/** Recommended hard limit for stability (minutes). Used as the default. */
export const recommendedMaxDurationMinutes = 60

/** Sentinel meaning "use the platform's fn key" (macOS helper). */
export const FN_SHORTCUT = 'fn'

export function defaultShortcut(platform: NodeJS.Platform | string): string {
  return platform === 'darwin' ? FN_SHORTCUT : 'Control+Shift+Space'
}

export function defaultPrefs(platform: NodeJS.Platform | string): Prefs {
  return {
    [PrefKey.language]: 'en',
    [PrefKey.microphone]: 'default',
    [PrefKey.colorSchemeDark]: true,
    [PrefKey.onboardingComplete]: false,
    [PrefKey.firstRunComplete]: false,
    [PrefKey.maxDurationMinutes]: recommendedMaxDurationMinutes,
    [PrefKey.shortcut]: defaultShortcut(platform)
  }
}

/** Whisper language parameter: null means auto-detect. */
export function languageForWhisper(code: string): string | null {
  return code === 'auto' ? null : code
}

/** Whether the id means "use system default" (no device override). */
export function isSystemDefaultMicrophone(uid: string): boolean {
  return uid === 'default' || uid === ''
}

/** Clamp user input: 0 (unlimited) or 1…24h in minutes. */
export function sanitizedMaxDurationMinutes(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.trunc(raw), 24 * 60)
}

/** Parse a typed field; invalid / empty → recommended default. */
export function maxDurationMinutesFromField(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '' || !/^[-+]?\d+$/.test(trimmed)) return recommendedMaxDurationMinutes
  return sanitizedMaxDurationMinutes(parseInt(trimmed, 10))
}

/** Seconds for capture timers. null = no hard limit. */
export function maxDurationSeconds(minutes: number): number | null {
  const m = sanitizedMaxDurationMinutes(minutes)
  return m > 0 ? m * 60 : null
}

/** Stored value → minutes (missing key → recommended). */
export function readMaxDurationMinutes(stored: unknown): number {
  if (stored === undefined || stored === null) return recommendedMaxDurationMinutes
  return sanitizedMaxDurationMinutes(Number(stored))
}

/** Persist a mic choice, rewriting ephemeral aggregates to default. */
export function normalizedMicrophoneUID(uid: string, isEphemeral: (u: string) => boolean): string {
  if (isSystemDefaultMicrophone(uid) || isEphemeral(uid)) return 'default'
  return uid
}

/** Coerce a raw JSON prefs blob into a full, typed Prefs object. */
export function coercePrefs(raw: unknown, platform: NodeJS.Platform | string): Prefs {
  const d = defaultPrefs(platform)
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  const str = (k: keyof Prefs, fb: string): string => (typeof r[k] === 'string' ? (r[k] as string) : fb)
  const bool = (k: keyof Prefs, fb: boolean): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : fb)
  return {
    [PrefKey.language]: str(PrefKey.language, d[PrefKey.language]),
    [PrefKey.microphone]: str(PrefKey.microphone, d[PrefKey.microphone]),
    [PrefKey.colorSchemeDark]: bool(PrefKey.colorSchemeDark, d[PrefKey.colorSchemeDark]),
    [PrefKey.onboardingComplete]: bool(PrefKey.onboardingComplete, d[PrefKey.onboardingComplete]),
    [PrefKey.firstRunComplete]: bool(PrefKey.firstRunComplete, d[PrefKey.firstRunComplete]),
    [PrefKey.maxDurationMinutes]: readMaxDurationMinutes(r[PrefKey.maxDurationMinutes]),
    [PrefKey.shortcut]: str(PrefKey.shortcut, d[PrefKey.shortcut])
  }
}
