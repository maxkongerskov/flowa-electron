// 1.2.3 pre-license bridge. Copy this file into the 1.2.3 tree and call
// writeLegacyBridge once on every launch. The license build must not call it:
// a fresh install would otherwise grant itself.
//
// File: <frozen userData>/legacy-bridge.json
// Body: {"v":1,"marker":"<64 lowercase hex>"}
// marker = HMAC-SHA256(key = "flowa-legacy-v1", message = fingerprint)
// fingerprint = HMAC-SHA256(key = "flowa-fp-v1", message = trim(lowercase(rawDeviceId)))
// The HMAC key is a public domain separator, not a secret. The file holds no
// raw device id and no key material. Write is mode 0600 via temp, fsync, rename.
//
// rawDeviceId must be the same string the license reader hashes:
// macOS IOPlatformUUID, Windows MachineGuid, Linux /etc/machine-id
// (else /var/lib/dbus/machine-id). If none of those can be read, use the UUID
// in <userData>/device-id.txt, creating that file (mode 0600) only when it is missing.
// Do not import the license module. The fingerprint below is duplicated on purpose.

import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Plaintext file name inside the frozen userData directory. */
export const LEGACY_BRIDGE_FILE = 'legacy-bridge.json'

/** Domain-separated from the fingerprint key. Not a secret. */
export const LEGACY_BRIDGE_HMAC_KEY = 'flowa-legacy-v1'

/** Same key as fingerprintKey('flowa') in the license reader. */
export const FINGERPRINT_HMAC_KEY = 'flowa-fp-v1'

function hmacSha256Hex(keyUtf8: string, messageUtf8: string): string {
  return createHmac('sha256', Buffer.from(keyUtf8, 'utf8')).update(Buffer.from(messageUtf8, 'utf8')).digest('hex')
}

/** Duplicate of the license fingerprint for product id flowa. */
export function bridgeDeviceFingerprint(rawDeviceId: string): string {
  return hmacSha256Hex(FINGERPRINT_HMAC_KEY, rawDeviceId.trim().toLowerCase())
}

/** Marker hex stored in legacy-bridge.json. */
export function legacyBridgeMarker(rawDeviceId: string): string {
  return hmacSha256Hex(LEGACY_BRIDGE_HMAC_KEY, bridgeDeviceFingerprint(rawDeviceId))
}

/**
 * Rewrite the bridge file for this machine. A blank id is skipped so a failed
 * device-id read cannot publish a marker every install would share.
 */
export function writeLegacyBridge(userDataDir: string, rawDeviceId: string): void {
  if (rawDeviceId.trim() === '') return
  const body = JSON.stringify({ v: 1, marker: legacyBridgeMarker(rawDeviceId) })
  writeAtomic(path.join(userDataDir, LEGACY_BRIDGE_FILE), body)
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* some platforms reject chmod */
  }
}
