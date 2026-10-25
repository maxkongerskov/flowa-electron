/**
 * PLACEHOLDER public keys. Not production and not sandbox secrets.
 * The matching private keys were discarded and are not in this repository.
 * Tests generate their own key pair in memory. Replace these with the
 * adapter's lic-prod-* / lic-sbx-* keys before a license server is used.
 */

import type { PublicKeyEntry } from './types'

export const PLACEHOLDER_PROD_KEY: PublicKeyEntry = {
  kid: 'lic-prod-placeholder',
  spkiPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAy7Ejkouwsw8KmfU9BMsmGgelHBEVx1dyF4uIwXBXMoE=
-----END PUBLIC KEY-----`,
  rawBase64Url: 'y7Ejkouwsw8KmfU9BMsmGgelHBEVx1dyF4uIwXBXMoE'
}

export const PLACEHOLDER_SBX_KEY: PublicKeyEntry = {
  kid: 'lic-sbx-placeholder',
  spkiPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3LonCKNdsLagA5IEkfmkDiYPyuQokXuULbzJCCLpnwE=
-----END PUBLIC KEY-----`,
  rawBase64Url: '3LonCKNdsLagA5IEkfmkDiYPyuQokXuULbzJCCLpnwE'
}

export const PLACEHOLDER_KEYS: readonly PublicKeyEntry[] = [PLACEHOLDER_PROD_KEY, PLACEHOLDER_SBX_KEY]
