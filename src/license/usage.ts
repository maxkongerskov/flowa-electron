// Free-mode meter. Local only. Nothing here is sent anywhere.
// A missing or corrupt file starts the counter over and never locks the app.

export const DEFAULT_DAILY_SECONDS = 600

/** Strictly more than 36 hours behind the highest time seen is a clock correction. */
export const CLOCK_CORRECTION_MS = 36 * 60 * 60 * 1000

export interface UsageState {
  highestSeenMs: number
  /** Local calendar day the counter belongs to, YYYY-MM-DD. */
  day: string
  usedSeconds: number
  /** Overage applied to the next local day only, already capped at one quota. */
  debtSeconds: number
}

export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/** Whole local calendar days from `fromDay` to `toDay`. */
export function calendarDaysBetween(fromDay: string, toDay: string): number {
  const a = fromDay.split('-').map(Number)
  const b = toDay.split('-').map(Number)
  const utcA = Date.UTC(a[0] ?? 0, (a[1] ?? 1) - 1, a[2] ?? 1)
  const utcB = Date.UTC(b[0] ?? 0, (b[1] ?? 1) - 1, b[2] ?? 1)
  return Math.round((utcB - utcA) / 86_400_000)
}

export function freshUsage(nowMs: number): UsageState {
  return { highestSeenMs: nowMs, day: localDayKey(nowMs), usedSeconds: 0, debtSeconds: 0 }
}

export function remainingSeconds(state: UsageState, quotaSeconds: number): number {
  return Math.max(0, quotaSeconds - state.usedSeconds)
}

/**
 * Advance the meter to `nowMs`.
 * Clock forward across local midnight starts a day (accepted).
 * Clock back by 36 hours or less does not grant minutes.
 * Clock back by more than 36 hours is a correction: highest-seen becomes now,
 * today's usage is kept, and the next grant is the following local midnight.
 */
export function observeClock(state: UsageState, nowMs: number, quotaSeconds: number): UsageState {
  if (!Number.isFinite(nowMs)) return state
  const quota = positiveQuota(quotaSeconds)
  const behind = state.highestSeenMs - nowMs
  if (behind > CLOCK_CORRECTION_MS) {
    return {
      highestSeenMs: nowMs,
      day: localDayKey(nowMs),
      usedSeconds: clampUsed(state.usedSeconds, quota),
      debtSeconds: clampDebt(state.debtSeconds, quota)
    }
  }
  if (nowMs < state.highestSeenMs) return state
  const day = localDayKey(nowMs)
  if (day === state.day) {
    return {
      highestSeenMs: nowMs,
      day,
      usedSeconds: clampUsed(state.usedSeconds, quota),
      debtSeconds: clampDebt(state.debtSeconds, quota)
    }
  }
  const days = calendarDaysBetween(state.day, day)
  let used = 0
  let debt = 0
  if (days === 1) {
    // Debt applies to the immediate next day only, and only up to one quota.
    used = clampDebt(state.debtSeconds, quota)
    debt = 0
  } else if (days > 1) {
    // The next day has already passed, so the debt is not carried further.
    used = 0
    debt = 0
  } else {
    // Day key moved backwards while the timestamp did not. Keep the usage.
    used = clampUsed(state.usedSeconds, quota)
    debt = clampDebt(state.debtSeconds, quota)
  }
  return { highestSeenMs: nowMs, day, usedSeconds: used, debtSeconds: debt }
}

/**
 * Add the recorded-audio seconds of a finished dictation.
 * The take is never shortened here. Overage becomes next-day debt, capped
 * at one daily quota. Anything beyond that is forgiven.
 */
export function applyRecorded(state: UsageState, recordedSeconds: number, quotaSeconds: number): UsageState {
  if (!Number.isFinite(recordedSeconds) || recordedSeconds <= 0) return state
  const quota = positiveQuota(quotaSeconds)
  const used = clampUsed(state.usedSeconds, quota)
  const room = Math.max(0, quota - used)
  const over = Math.max(0, recordedSeconds - room)
  return {
    ...state,
    usedSeconds: Math.min(quota, used + recordedSeconds),
    debtSeconds: over > 0 ? Math.min(quota, clampDebt(state.debtSeconds, quota) + over) : clampDebt(state.debtSeconds, quota)
  }
}

export function parseUsage(text: string | null, nowMs: number): { state: UsageState; reset: boolean } {
  if (text == null) return { state: freshUsage(nowMs), reset: false }
  if (text.trim() === '') return { state: freshUsage(nowMs), reset: true }
  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object') throw new Error('shape')
    const o = raw as Record<string, unknown>
    const highestSeenMs = o.highestSeenMs
    const day = o.day
    const usedSeconds = o.usedSeconds
    const debtSeconds = o.debtSeconds
    if (typeof highestSeenMs !== 'number' || !Number.isFinite(highestSeenMs)) throw new Error('time')
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day')
    if (typeof usedSeconds !== 'number' || !Number.isFinite(usedSeconds) || usedSeconds < 0) throw new Error('used')
    if (typeof debtSeconds !== 'number' || !Number.isFinite(debtSeconds) || debtSeconds < 0) throw new Error('debt')
    return { state: { highestSeenMs, day, usedSeconds, debtSeconds }, reset: false }
  } catch {
    return { state: freshUsage(nowMs), reset: true }
  }
}

export function serializeUsage(state: UsageState): string {
  return JSON.stringify({
    v: 1,
    highestSeenMs: state.highestSeenMs,
    day: state.day,
    usedSeconds: state.usedSeconds,
    debtSeconds: state.debtSeconds
  })
}

/** Sample length of a finished take. Post-processing time is not included. */
export function recordedAudioSeconds(sampleCount: number, sampleRate = 16_000): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0
  return sampleCount / sampleRate
}

function positiveQuota(quotaSeconds: number): number {
  if (!Number.isFinite(quotaSeconds) || quotaSeconds <= 0) return DEFAULT_DAILY_SECONDS
  return quotaSeconds
}

function clampUsed(used: number, quota: number): number {
  if (!Number.isFinite(used) || used < 0) return 0
  return Math.min(quota, used)
}

function clampDebt(debt: number, quota: number): number {
  if (!Number.isFinite(debt) || debt < 0) return 0
  return Math.min(quota, debt)
}
