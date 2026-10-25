import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeBase64Url, formatServerTime, newRequestId } from '../../src/license/encoding'
import { genuineWitness, activeLicense, makeEnv, PRODUCT, RAW_ID } from './harness'
import { interpretPayload, licenseHttpBody, readDevices, readLicenseFields } from '../../src/license/protocol'
import { PRODUCTION_LICENSE_BASE_URL, resolveLicenseBaseUrl } from '../../src/license/locations'

const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/

describe('license spec v0.4.4', () => {
  it('locks the production base URL and leaves the sandbox host configurable', () => {
    expect(PRODUCTION_LICENSE_BASE_URL).toBe('https://license.reddocklabs.com/v1')
    const override = { FLOWA_LICENSE_BASE_URL: 'https://evil.example/v1' }
    expect(resolveLicenseBaseUrl({ channel: 'prod', env: override, allowSandboxOverride: true })).toBe(PRODUCTION_LICENSE_BASE_URL)
    expect(resolveLicenseBaseUrl({ channel: 'prod', env: override, allowSandboxOverride: false })).toBe(PRODUCTION_LICENSE_BASE_URL)
    expect(resolveLicenseBaseUrl({ channel: 'sbx', env: override, allowSandboxOverride: false })).toBe(PRODUCTION_LICENSE_BASE_URL)
    expect(
      resolveLicenseBaseUrl({
        channel: 'sbx',
        env: { FLOWA_LICENSE_BASE_URL: 'http://127.0.0.1:8787/v1' },
        allowSandboxOverride: true
      })
    ).toBe('http://127.0.0.1:8787/v1')
    expect(resolveLicenseBaseUrl({ channel: 'sbx', env: {}, allowSandboxOverride: true })).toBe(PRODUCTION_LICENSE_BASE_URL)
    expect(
      resolveLicenseBaseUrl({
        channel: 'sbx',
        env: { FLOWA_LICENSE_BASE_URL: 'http://evil.example/v1' },
        allowSandboxOverride: true
      })
    ).toBe(PRODUCTION_LICENSE_BASE_URL)
    const host = readFileSync('src/main/licenseHost.ts', 'utf8')
    expect(host).toContain('licenseHttpBody')
    expect(host).not.toMatch(/status\s*<\s*200/)
  })

  it('sends a 22-character request id and Flowa-Api-Version on every call', () => {
    const id = newRequestId((n) => new Uint8Array(n))
    expect(id).toHaveLength(22)
    expect(REQUEST_ID.test(id)).toBe(true)
    expect(decodeBase64Url(id)?.length).toBe(16)
  })

  it('v0.4.4 status while licensed sends the device binding, and invalid_key does not drop the seat', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) })))
    await app.activate('STORED-KEY')
    const stored = env.storage.read('license.json')
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 86_400_000) })))
    env.transport.handlers.push(env.respond('invalid_key'))
    env.setNow(env.now() + 2000)
    await app.tick()
    const status = env.transport.calls.find((call) => call.url.endsWith('/status'))
    const checkin = env.transport.calls.find((call) => call.url.endsWith('/checkin'))
    expect(status?.body).toMatchObject({
      product_id: PRODUCT,
      license_key: 'STORED-KEY',
      license_id: 'lic_1',
      device_id: 'dev_1',
      fingerprint: env.fingerprint()
    })
    expect(checkin?.body.license_key).toBeUndefined()
    for (const call of env.transport.calls) {
      expect(call.headers['Flowa-Api-Version']).toBe('1')
      expect(call.body.request_id).toMatch(REQUEST_ID)
    }
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.snapshot().dialog).toBeNull()
    expect(env.storage.read('license.json')).not.toBe(stored)
    expect((env.storedLicense(app) as { license: { state: string } }).license.state).toBe('active')
  })

  it('updates the shown key hint from status and does not replace the bound license file', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(
      env.respond('active', activeLicense(env, RAW_ID, { key_hint: 'FLOWA-****-OLD1', next_checkin_after: formatServerTime(env.now() + 1000) }))
    )
    await app.activate('STORED-KEY')
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { key_hint: 'FLOWA-****-OLD1' })))
    env.transport.handlers.push(
      env.respond('ok', activeLicense(env, RAW_ID, { key_hint: 'FLOWA-****-NEW9', device_id: undefined, fingerprint: undefined }), {
        devices: [{ device_id: 'dev_1', device_name: 'Mac', platform: 'macos', last_seen: '2026-11-01T10:00:00Z' }]
      })
    )
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().keyHint).toBe('FLOWA-****-NEW9')
    expect(app.snapshot().mode).toBe('licensed')
    expect((env.storedLicense(app) as { license: { key_hint: string } }).license.key_hint).toBe('FLOWA-****-OLD1')
  })

  it('reads the license object from payload.license and deactivate ids from the top level', async () => {
    const env = makeEnv()
    const flat = env.start()
    env.transport.handlers.push(async (req) => ({
      kind: 'response' as const,
      httpStatus: 200,
      raw: env.envelope({
        api_version: 1,
        product_id: PRODUCT,
        request_id: req.body.request_id,
        server_time: formatServerTime(env.now()),
        status: 'ok',
        ...activeLicense(env)
      })
    }))
    await flat.activate('KEY')
    expect(flat.snapshot().mode).toBe('free')

    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    env.transport.handlers.push(env.respond('ok', { license_id: 'lic_1', device_id: 'dev_1', devices_used: 1, state: 'active' }))
    await app.deactivate()
    expect(app.snapshot().mode).toBe('licensed')
    env.transport.handlers.push(env.respond('ok', null, { license_id: 'lic_1', device_id: 'dev_1', devices_used: 1 }))
    await app.deactivate()
    expect(app.snapshot().mode).toBe('free')

    const payload = {
      api_version: 1,
      product_id: PRODUCT,
      status: 'device_limit_reached',
      license: { product_id: PRODUCT, license_id: 'lic_1', state: 'active', device_limit: 3, devices_used: 3 },
      devices: [{ device_id: 'phone', device_name: 'Pixel', platform: 'android', last_seen: '2026-11-01T10:00:00Z' }]
    }
    const interpreted = interpretPayload(
      payload,
      { context: 'activate', productId: PRODUCT, requestId: null, fingerprint: env.fingerprint(), boundLicenseId: null, boundDeviceId: null },
      env.now()
    )
    expect(interpreted.kind).toBe('device_limit')
    if (interpreted.kind === 'device_limit') {
      expect(interpreted.fields?.devicesUsed).toBe(3)
      expect(interpreted.devices).toEqual([{ id: 'phone', name: 'Pixel', platform: 'android', lastSeen: '2026-11-01T10:00:00Z' }])
    }
    expect(readLicenseFields({ ...activeLicense(env), status: 'ok' })).toBeNull()
    expect(readDevices({ devices: [{ id: 'mac', name: 'Mac', platform: 'macos', last_seen: null }] })).toEqual([
      { id: 'mac', name: 'Mac', platform: 'macos', lastSeen: null }
    ])
  })

  it('decides on the signed status and treats an unsigned 503 as a network error', async () => {
    expect(licenseHttpBody(503, '').kind).toBe('error')
    expect(licenseHttpBody(503, '  ').kind).toBe('error')
    expect(licenseHttpBody(503, '{"payload":"e30","sig":"YQ","kid":"lic-prod-1"}').kind).toBe('response')
    expect(licenseHttpBody(400, 'not-an-envelope').kind).toBe('response')

    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) })))
    await app.activate('KEY')
    const activeFile = env.storage.read('license.json')
    env.transport.handlers.push(async () => ({ kind: 'response', httpStatus: 503, raw: '' }))
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    expect(env.storage.read('license.json')).toBe(activeFile)

    env.transport.handlers.push(async (req) => ({
      kind: 'response' as const,
      httpStatus: 400,
      raw: env.signed(req.body, {
        status: 'revoked',
        license: activeLicense(env, RAW_ID, { state: 'revoked', restrict_after: formatServerTime(env.now() - 1000) })
      })
    }))
    env.setNow(env.now() + 86_400_000)
    await app.tick()
    expect((env.storedLicense(app) as { license: { state: string } }).license.state).toBe('revoked')
    expect(app.snapshot().mode).toBe('free')
  })

  it('T-DV8 after key rotation, device_not_found re-activates with the stored key and invalid_key offers a new one', async () => {
    const env = makeEnv()
    const app = env.start({ version: '1.2.4' })
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) })))
    await app.activate('OLD-KEY')
    env.transport.handlers.push(env.respond('device_not_found'))
    env.transport.handlers.push(env.respond('invalid_key'))
    env.setNow(env.now() + 2000)
    await app.tick()
    const secondActivate = env.transport.calls.filter((call) => call.url.endsWith('/activate'))[1]
    expect(secondActivate?.body.license_key).toBe('OLD-KEY')
    expect(app.snapshot().mode).toBe('free')
    expect(app.snapshot().legacyUnlimited).toBe(false)
    expect(app.snapshot().dialog?.kind).toBe('reactivate')
    expect(app.snapshot().dialog?.error).toBe(env.copy.invalidKey)
    expect(app.snapshot().remainingSeconds).toBe(600)
    expect(app.canStartDictation()).toEqual({ ok: true, meter: true })
    expect(env.keys.read()).toBe('OLD-KEY')
    expect(env.storage.read('license.json')).toBeNull()
  })

  it('T-DV8 a legacy install falls back to legacy_unlimited when the rotated key is rejected', async () => {
    const env = makeEnv()
    const app = env.start({ version: '1.2.4', witness: genuineWitness('1.2.4') })
    expect(app.snapshot().legacyUnlimited).toBe(true)
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) })))
    await app.activate('OLD-KEY')
    expect(app.snapshot().mode).toBe('licensed')
    const marker = env.legacy.read()
    env.transport.handlers.push(env.respond('device_not_found'))
    env.transport.handlers.push(env.respond('invalid_key'))
    env.setNow(env.now() + 2000)
    await app.tick()
    const snap = app.snapshot()
    expect(snap.legacyUnlimited).toBe(true)
    expect(snap.mode).toBe('free')
    expect(snap.remainingSeconds).toBeNull()
    expect(snap.dialog?.kind).toBe('reactivate')
    expect(snap.dialog?.error).toBe(env.copy.invalidKey)
    expect(app.canStartDictation()).toEqual({ ok: true, meter: false })
    expect(env.legacy.read()).toBe(marker)
    expect(env.keys.read()).toBe('OLD-KEY')
    expect(snap.historyAvailable).toBe(true)
  })
})
