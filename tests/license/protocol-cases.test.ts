import { describe, expect, it } from 'vitest'
import { decodeBase64Url, encodeBase64Url } from '../../src/license/encoding'
import { deviceFingerprint } from '../../src/license/fingerprint'
import { accessMode } from '../../src/license/access'
import { readLicenseFields } from '../../src/license/protocol'
import { activeLicense, makeEnv, PRODUCT, RAW_ID, testKeys, signEnvelope } from './harness'
import { formatServerTime } from '../../src/license/encoding'
import { createKeyStore } from '../../src/license/keyStore'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DAY = 24 * 60 * 60 * 1000

describe('license protocol cases', () => {
  it('T1 T5 T20 activation stores the key and ignores unknown fields', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', { ...activeLicense(env), future_field: true }, { extra_field: { nested: true } }))
    await app.activate('  FLOWA KEY  ')
    expect(env.transport.calls[0]?.body.license_key).toBe('FLOWAKEY')
    expect(env.transport.calls[0]?.body.product_id).toBe(PRODUCT)
    expect(env.transport.calls[0]?.headers['Flowa-Api-Version']).toBe('1')
    expect(env.transport.calls[0]?.headers['User-Agent']).toContain('Flowa/')
    expect(app.snapshot().mode).toBe('licensed')
    expect(env.keys.read()).toBe('FLOWAKEY')
    expect(app.snapshot().keyHint).toBe('····ABCD')
    env.transport.handlers.push(env.respond('invalid_key'))
    await app.activate('nope')
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.snapshot().dialog?.error).toBe(env.copy.invalidKey)
  })

  it('T2 T26 the same machine repeats one fingerprint and a new install id is different', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    expect(env.transport.calls[0]?.body.fingerprint).toBe(env.transport.calls[1]?.body.fingerprint)
    const other = deviceFingerprint(env.crypto, PRODUCT, 'reinstalled-os')
    expect(other).not.toBe(env.transport.calls[0]?.body.fingerprint)
  })

  it('T6 T10 T13 T17 an active license survives offline time, a failed check-in, and a newer build', async () => {
    const env = makeEnv()
    const app = env.start({ version: '1.2.3' })
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    env.setNow(env.now() + 60 * DAY)
    env.transport.handlers.push(async () => ({ kind: 'error', reason: 'network' }))
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    const later = env.start({ version: '3.0.0', witness: { updateInfoRaw: null, updaterIdRaw: null } })
    expect(later.snapshot().mode).toBe('licensed')
    expect(env.keys.read()).toBe('KEY')
  })

  it('T7 T22 a damaged license falls back and then re-activates quietly', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    const good = env.storage.read('license.json') ?? ''
    env.storage.writeAtomic('license.prev.json', good)
    env.storage.writeAtomic('license.json', `${good.slice(0, -5)}XXXXX`)
    const restarted = env.start()
    expect(restarted.snapshot().mode).toBe('licensed')
    env.storage.writeAtomic('license.json', '')
    env.storage.writeAtomic('license.prev.json', '')
    const empty = env.start()
    expect(empty.snapshot().mode).toBe('free')
    expect(empty.canStartDictation().ok).toBe(true)
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await empty.tick()
    expect(empty.snapshot().mode).toBe('licensed')
  })

  it('T8 T19 T27 a copied license and a wrong channel are rejected', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    const copied = makeEnv('other-machine')
    copied.storage.writeAtomic('license.json', env.storage.read('license.json') ?? '')
    const foreign = copied.start({ rawId: 'other-machine', publicKeys: [env.pair.entry] })
    expect(foreign.snapshot().mode).toBe('free')
    expect(foreign.snapshot().quietNote).toBe(copied.copy.fingerprintMismatch)

    const sbx = testKeys('lic-sbx-test')
    const prodApp = env.start({ publicKeys: [env.pair.entry, sbx.entry] })
    env.transport.handlers.push(async (req) => ({
      kind: 'response',
      httpStatus: 200,
      raw: signEnvelope(sbx.privateKeyPem, sbx.entry.kid, {
        api_version: 1,
        product_id: PRODUCT,
        request_id: req.body.request_id,
        server_time: formatServerTime(env.now()),
        status: 'active',
        license: activeLicense(env)
      })
    }))
    const before = prodApp.snapshot().mode
    await prodApp.activate('KEY')
    expect(prodApp.snapshot().mode).toBe(before)

    const sbxApp = env.start({ channel: 'sbx', publicKeys: [env.pair.entry, sbx.entry] })
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await sbxApp.activate('KEY')
    expect(sbxApp.snapshot().mode).toBe('free')
  })

  it('T9 T24 T25 a bad signature, the wrong device, or HTML does not change the license', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) })))
    await app.activate('KEY')
    const stored = env.storage.read('license.json')
    const wrong = testKeys('lic-prod-other')
    env.transport.handlers.push(async (req) => ({
      kind: 'response',
      httpStatus: 200,
      raw: signEnvelope(wrong.privateKeyPem, wrong.entry.kid, {
        api_version: 1,
        product_id: PRODUCT,
        request_id: req.body.request_id,
        server_time: formatServerTime(env.now()),
        status: 'revoked',
        license: activeLicense(env, RAW_ID, { state: 'revoked', restrict_after: formatServerTime(env.now() - 1000) })
      })
    }))
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(env.storage.read('license.json')).toBe(stored)
    expect(app.snapshot().mode).toBe('licensed')

    env.advance(2 * 60 * 60 * 1000)
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { license_id: 'other', device_id: 'other' })))
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    expect(env.storage.read('license.json')).toBe(stored)

    env.transport.handlers.push(async () => ({ kind: 'response', httpStatus: 200, raw: '<html>portal</html>' }))
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
  })

  it('T12 repeated request ids are rejected and the clock does not expire an active license', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) })))
    await app.activate('KEY')
    const first = env.transport.calls[0]?.body.request_id
    env.transport.handlers.push(async () => ({
      kind: 'response',
      httpStatus: 200,
      raw: env.envelope({
        api_version: 1,
        product_id: PRODUCT,
        request_id: first,
        server_time: formatServerTime(env.now()),
        status: 'revoked',
        license: activeLicense(env, RAW_ID, { state: 'revoked', restrict_after: formatServerTime(env.now() - DAY) })
      })
    }))
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    env.setNow(env.now() + 400 * DAY)
    expect(app.snapshot().mode).toBe('licensed')
    env.setNow(env.now() - 500 * DAY)
    expect(app.snapshot().mode).toBe('licensed')
  })

  it('T14 rate_limited waits for retry_after', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('rate_limited', null, { retry_after: 30 }))
    await app.activate('KEY')
    expect(app.snapshot().dialog?.error).toBe(env.copy.rateLimit)
    const calls = env.transport.calls.length
    await app.activate('KEY')
    expect(env.transport.calls).toHaveLength(calls)
    env.advance(31_000)
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    expect(app.snapshot().mode).toBe('licensed')
  })

  it('T18 Linux without a keyring stores the key as mode 0600', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-key-'))
    const file = path.join(dir, 'license-key.bin')
    const store = createKeyStore(file, null)
    store.write('SECRET')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(store.read()).toBe('SECRET')
  })

  it('T21 an unreadable key still leaves a valid license active', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    env.keys.clear()
    const restarted = env.start()
    expect(restarted.snapshot().mode).toBe('licensed')
    expect(restarted.canStartDictation()).toEqual({ ok: true, meter: false })
  })

  it('T28 T30 an older reader keeps unknown fields and an unknown state does not restrict', () => {
    const fields = readLicenseFields({
      product_id: PRODUCT,
      license: {
        product_id: PRODUCT,
        license_id: 'lic_1',
        device_id: 'dev_1',
        fingerprint: 'abc',
        state: 'complimentary',
        platform: 'toaster',
        plan: 'future',
        future_field: 1
      }
    })
    expect(fields?.platform).toBe('toaster')
    expect(fields?.state).toBe('complimentary')
    expect(accessMode(fields, Date.now(), Date.now())).toBe('licensed')
  })

  it('T31 encoding is unpadded base64url and the fingerprint ignores id case', () => {
    const bytes = new Uint8Array([0xff, 0xef, 0x00])
    const encoded = encodeBase64Url(bytes)
    expect(encoded.includes('=')).toBe(false)
    expect(decodeBase64Url(encoded)).toEqual(bytes)
    const env = makeEnv()
    expect(env.fingerprint('AbC')).toBe(env.fingerprint('abc'))
    const payload = env.envelope({
      api_version: 1,
      product_id: PRODUCT,
      server_time: '2026-06-15T10:00:00Z',
      status: 'active',
      license: activeLicense(env)
    })
    const parsed = JSON.parse(payload) as { payload: string; sig: string }
    expect(parsed.payload.includes('=')).toBe(false)
    expect(parsed.sig.includes('=')).toBe(false)
  })

  it('T-MP1 T-MP2 T-MP3 T-MP4 product ids do not cross', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(async (req) => ({
      kind: 'response',
      httpStatus: 200,
      raw: env.envelope({
        api_version: 1,
        product_id: 'other-app',
        request_id: req.body.request_id,
        server_time: formatServerTime(env.now()),
        status: 'active',
        license: { ...activeLicense(env), product_id: 'other-app' }
      })
    }))
    await app.activate('KEY')
    expect(app.snapshot().mode).toBe('free')
    expect(app.snapshot().dialog?.error).toBe(env.copy.networkError)

    const otherId = deviceFingerprint(env.crypto, 'other-app', RAW_ID)
    expect(otherId).not.toBe(env.fingerprint())

    const a = makeEnv('shared-machine')
    const bStore = a.storage
    const appA = a.start({ rawId: 'shared-machine' })
    a.transport.handlers.push(a.respond('active', activeLicense(a, 'shared-machine')))
    await appA.activate('KEY-A')
    const saved = bStore.read('license.json')
    const isolated = makeEnv('shared-machine')
    isolated.storage.writeAtomic('license.json', saved ?? '')
    isolated.keys.write('KEY-A')
    const appB = isolated.start({ rawId: 'shared-machine', publicKeys: [a.pair.entry] })
    expect(appB.snapshot().mode).toBe('licensed')
    a.transport.handlers.push(a.respond('ok', null, { license_id: 'lic_1', device_id: 'dev_1', devices_used: 0 }))
    await appA.deactivate()
    expect(appA.snapshot().mode).toBe('free')
    expect(isolated.storage.read('license.json')).toBe(saved)

    const wrongKey = makeEnv()
    const wrong = wrongKey.start()
    wrongKey.transport.handlers.push(wrongKey.respond('invalid_key'))
    await wrong.activate('PRODUCT-B-KEY')
    expect(wrong.snapshot().dialog?.kind).toBe('key-entry')
    expect(wrong.snapshot().dialog?.error).toBe(wrongKey.copy.invalidKey)
    expect(wrong.snapshot().dialog?.kind).not.toBe('device-limit')
  })

  it('does not call the license server before the UI is ready', async () => {
    const env = makeEnv()
    env.setUi(false)
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('KEY')
    await app.tick()
    expect(env.transport.calls).toHaveLength(0)
    expect(app.canStartDictation().ok).toBe(true)
  })
})
