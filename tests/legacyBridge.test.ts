import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeMarker, LEGACY_BRIDGE_FILE as readerFile, LEGACY_BRIDGE_HMAC_KEY as readerKey } from '../src/license/legacy'
import { deviceFingerprint } from '../src/license/fingerprint'
import { nodeLicenseCrypto } from '../src/license/nodeCrypto'
import {
  bridgeDeviceFingerprint,
  FINGERPRINT_HMAC_KEY,
  LEGACY_BRIDGE_FILE,
  LEGACY_BRIDGE_HMAC_KEY,
  legacyBridgeMarker,
  writeLegacyBridge
} from '../src/legacyBridge/writeLegacyBridge'

const RAW_ID = 'IOPlatformUUID-ABC-123'

describe('legacy bridge writer', () => {
  it('writes an atomic marker the license reader accepts and stores no secrets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-bridge-'))
    const nested = path.join(dir, 'userData')
    writeLegacyBridge(nested, `  ${RAW_ID.toLowerCase()}  `)
    const file = path.join(nested, LEGACY_BRIDGE_FILE)
    expect(LEGACY_BRIDGE_FILE).toBe(readerFile)
    expect(LEGACY_BRIDGE_HMAC_KEY).toBe(readerKey)
    expect(FINGERPRINT_HMAC_KEY).toBe('flowa-fp-v1')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, 'utf8')
    expect(text.toLowerCase()).not.toContain(RAW_ID.toLowerCase())
    expect(text).not.toContain(LEGACY_BRIDGE_HMAC_KEY)
    expect(text).not.toContain(FINGERPRINT_HMAC_KEY)
    const parsed = JSON.parse(text) as { v: number; marker: string }
    expect(parsed).toEqual({ v: 1, marker: legacyBridgeMarker(RAW_ID) })
    expect(parsed.marker).toBe(bridgeMarker(nodeLicenseCrypto(), 'flowa', RAW_ID))
    expect(parsed.marker).not.toBe(bridgeDeviceFingerprint(RAW_ID))
    expect(bridgeDeviceFingerprint(RAW_ID)).toBe(deviceFingerprint(nodeLicenseCrypto(), 'flowa', RAW_ID))
    expect(readdirSync(nested).filter((name) => name.endsWith('.tmp'))).toEqual([])

    writeLegacyBridge(nested, RAW_ID)
    expect(readFileSync(file, 'utf8')).toBe(text)
    writeLegacyBridge(nested, '   ')
    expect(readFileSync(file, 'utf8')).toBe(text)
    writeLegacyBridge(nested, 'other-machine')
    const replaced = JSON.parse(readFileSync(file, 'utf8')) as { marker: string }
    expect(replaced.marker).toBe(legacyBridgeMarker('other-machine'))
    expect(replaced.marker).not.toBe(parsed.marker)
  })

  it('does not import the license module, and the license build does not call it', () => {
    const source = readFileSync(path.join('src/legacyBridge/writeLegacyBridge.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"][^'"]*license/)
    expect(source).not.toMatch(/require\(\s*['"][^'"]*license/)
    expect(source).toMatch(/fsyncSync/)
    expect(source).toMatch(/renameSync/)
    for (const file of ['src/main/index.ts', 'src/main/licenseHost.ts', 'src/license/controller.ts', 'src/license/legacy.ts']) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/writeLegacyBridge|legacyBridge\//)
    }
  })
})
