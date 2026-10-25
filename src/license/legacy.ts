// In-place update from a build that had no license module.
// The marker is an HMAC of this machine's license fingerprint, stored with the
// same safeStorage path as the license key. A copied userData folder does not
// validate. A missing or unreadable marker is checked again against the updater
// signals; if those signals are gone, the install is free mode.

import { deviceFingerprint, fingerprintKey } from './fingerprint'
import type { LicenseCrypto } from './types'

/** Last shipped version that does not contain this module. */
export const LAST_PRE_LICENSE_VERSION = '1.2.2'

/** Rehearsal build that stands in for 1.2.2. It must not record a migration decision. */
export const E2E_PRE_LICENSE_VERSION = '9.9.0'

/** Encrypted with safeStorage when a keyring exists, otherwise mode 0600. Same as the license key. */
export const LEGACY_FILE = 'legacy-unlimited.bin'

/** Same cache folder name as app-update.yml `updaterCacheDirName`. */
export const UPDATER_CACHE_DIR_NAME = 'flowa-updater'

const UPDATER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LegacyFile {
  v: 1
  evaluated: true
  marker: string | null
}

export interface UpdateWitness {
  /** Raw `pending/update-info.json` from the updater cache, or null. */
  updateInfoRaw: string | null
  /** Raw `.updaterId` from userData, or null. */
  updaterIdRaw: string | null
}

export function shouldRunLegacyMigration(version: string): boolean {
  if (version === '1.2.0' || version === '1.2.1' || version === LAST_PRE_LICENSE_VERSION) return false
  if (version === E2E_PRE_LICENSE_VERSION) return false
  return true
}

export function legacyMarker(crypto: LicenseCrypto, productId: string, rawDeviceId: string): string {
  const fingerprint = deviceFingerprint(crypto, productId, rawDeviceId)
  return crypto.hmacSha256Hex(fingerprintKey(productId), fingerprint)
}

export function versionFromInstallerName(fileName: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(fileName)
  return match?.[1] ?? null
}

export function compareSemver(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part))
  const right = b.split('.').map((part) => Number(part))
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

/**
 * True only for the first boot after electron-updater has installed a build
 * newer than 1.2.2 over an existing userData that already has the updater id
 * 1.2.x wrote. Prefs and history alone are not enough: a fresh install and a
 * copied folder both have those.
 */
export function isGenuineInPlaceUpdate(args: {
  runningVersion: string
  witness: UpdateWitness
}): boolean {
  const info = parseUpdateInfo(args.witness.updateInfoRaw)
  if (!info) return false
  const installed = versionFromInstallerName(info.fileName)
  if (!installed) return false
  if (compareSemver(installed, LAST_PRE_LICENSE_VERSION) <= 0) return false
  if (installed !== args.runningVersion) return false
  if (!isUpdaterId(args.witness.updaterIdRaw)) return false
  return true
}

export function parseLegacyFile(raw: string | null): LegacyFile | null {
  if (raw == null || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (record.v !== 1 || record.evaluated !== true) return null
    if (record.marker == null) return { v: 1, evaluated: true, marker: null }
    if (typeof record.marker !== 'string' || !/^[0-9a-f]{64}$/.test(record.marker)) return null
    return { v: 1, evaluated: true, marker: record.marker }
  } catch {
    return null
  }
}

export function evaluateLegacy(args: {
  crypto: LicenseCrypto
  productId: string
  rawDeviceId: string
  runningVersion: string
  storedRaw: string | null
  witness: UpdateWitness
  runMigration: boolean
}): { unlimited: boolean; write: LegacyFile | null } {
  const expected = legacyMarker(args.crypto, args.productId, args.rawDeviceId)
  const existing = parseLegacyFile(args.storedRaw)
  if (existing?.marker && existing.marker === expected) return { unlimited: true, write: null }
  if (existing?.evaluated) {
    // Invalid (other machine) or an explicit refusal. Do not grant later.
    if (existing.marker) return { unlimited: false, write: { v: 1, evaluated: true, marker: null } }
    return { unlimited: false, write: null }
  }
  if (!args.runMigration || !shouldRunLegacyMigration(args.runningVersion)) return { unlimited: false, write: null }
  const grant = isGenuineInPlaceUpdate({ runningVersion: args.runningVersion, witness: args.witness })
  return {
    unlimited: grant,
    write: { v: 1, evaluated: true, marker: grant ? expected : null }
  }
}

export function parseUpdateInfo(raw: string | null): { fileName: string } | null {
  if (raw == null || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const fileName = (value as Record<string, unknown>).fileName
    if (typeof fileName !== 'string' || fileName.trim() === '') return null
    return { fileName }
  } catch {
    return null
  }
}

export function isUpdaterId(raw: string | null): boolean {
  if (raw == null) return false
  return UPDATER_ID.test(raw.trim())
}
