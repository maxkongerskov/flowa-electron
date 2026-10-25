// HMAC-SHA256(key = "<product_id>-fp-v1", message = trimmed lowercase raw id) as lowercase hex.
// The key is a public constant, so this is a hash. The raw id never leaves the device.

import type { LicenseCrypto } from './types'

export function fingerprintKey(productId: string): string {
  return `${productId}-fp-v1`
}

export function deviceFingerprint(crypto: LicenseCrypto, productId: string, rawDeviceId: string): string {
  const message = rawDeviceId.trim().toLowerCase()
  return crypto.hmacSha256Hex(fingerprintKey(productId), message)
}
