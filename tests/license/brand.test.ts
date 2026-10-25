import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadBundledProductProfile, uiCopy } from '../../src/license/brand'
import { PRODUCTION_LICENSE_BASE_URL } from '../../src/license/locations'
import { PRODUCT_ID } from '../../src/license/productId'
import { licenseStoragePaths } from '../../src/license/userDataFiles'
import { assertLegacyRehearsal, legacyAfterBoot } from '../../scripts/e2e-update.mjs'

describe('catalog and rehearsal', () => {
  it('v0.4.3 products.json carries device_limit 3 and the dialog copy', () => {
    const profile = loadBundledProductProfile()
    expect(profile.productId).toBe(PRODUCT_ID)
    expect(profile.productId).toBe('flowa')
    expect(profile.deviceLimit).toBe(3)
    expect(profile.licenseBaseUrl).toBe(PRODUCTION_LICENSE_BASE_URL)
    expect(profile.licenseDomain).toBe('license.reddocklabs.com')
    const copy = uiCopy(profile)
    expect(copy.buyButton).toBe('Køb Flowa (€29, én gang)')
    expect(copy.deviceLimit(profile.portalUrl)).toContain('3 enheder')
    expect(copy.deviceLimit(profile.portalUrl)).toContain(profile.portalUrl)
    expect(copy.reactivateOffer).toContain('Dine data er i sikkerhed')
    const card = readFileSync('src/renderer/src/components/LicenseCard.tsx', 'utf8')
    expect(card.includes('€29')).toBe(false)
    expect(card.includes('Køb')).toBe(false)
  })

  it('license files stay in the frozen userData directory', () => {
    const paths = licenseStoragePaths('/tmp/Flowa-Electron')
    expect(paths.directory).toBe('/tmp/Flowa-Electron')
    expect(paths.legacy.endsWith('legacy-unlimited.bin')).toBe(true)
    expect(paths.bridge.endsWith('legacy-bridge.json')).toBe(true)
    expect(paths.key.endsWith('license-key.bin')).toBe(true)
    expect(paths.updaterId.endsWith('.updaterId')).toBe(true)
  })

  it('e2e update rehearsal distinguishes an in-place update from a fresh install', () => {
    const updated = 'booted 9.9.0 pid=1 license legacy=free\ninstalling 9.9.1\nbooted 9.9.1 pid=2 license legacy=unlimited\n'
    const fresh = 'booted 9.9.1 pid=3 license legacy=free\n'
    expect(legacyAfterBoot(updated, '9.9.1')).toBe('unlimited')
    expect(legacyAfterBoot(fresh, '9.9.1')).toBe('free')
    expect(() => assertLegacyRehearsal(updated, fresh, '9.9.0', '9.9.1')).not.toThrow()
    expect(() => assertLegacyRehearsal(fresh, fresh, '9.9.0', '9.9.1')).toThrow(/unlimited/)
    expect(() => assertLegacyRehearsal(updated, updated, '9.9.0', '9.9.1')).toThrow(/free/)
  })
})
