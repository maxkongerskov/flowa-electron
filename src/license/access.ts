// free vs licensed. An active license ignores the clock.
// revoked / refunded / deactivated become free only at restrict_after,
// when max(trusted server time, local clock) has reached that instant.

import type { AccessMode, LicenseFields } from './types'
import { DEFAULT_DAILY_SECONDS } from './usage'

const RESTRICTING = new Set(['revoked', 'refunded', 'deactivated'])

export function isRestrictingState(state: string): boolean {
  return RESTRICTING.has(state)
}

export function effectiveQuota(fields: LicenseFields | null): number {
  if (fields?.freeDailySeconds != null && fields.freeDailySeconds > 0) return fields.freeDailySeconds
  return DEFAULT_DAILY_SECONDS
}

/**
 * Trusted time is the highest server_time already accepted. It does not tick
 * while offline. Local time can only make max() larger, so it can shorten a
 * grace period and can never expire an active license.
 */
export function pastRestrictAfter(fields: LicenseFields, nowMs: number, trustedServerTimeMs: number): boolean {
  if (!isRestrictingState(fields.state)) return false
  if (fields.restrictAfterMs == null) return false
  const trusted = Number.isFinite(trustedServerTimeMs) ? trustedServerTimeMs : 0
  return Math.max(trusted, nowMs) >= fields.restrictAfterMs
}

export function accessMode(fields: LicenseFields | null, nowMs: number, trustedServerTimeMs: number): AccessMode {
  if (!fields) return 'free'
  if (fields.state === 'active') return 'licensed'
  if (isRestrictingState(fields.state)) {
    return pastRestrictAfter(fields, nowMs, trustedServerTimeMs) ? 'free' : 'licensed'
  }
  // Unknown state: no change, and never a restriction.
  return 'licensed'
}
