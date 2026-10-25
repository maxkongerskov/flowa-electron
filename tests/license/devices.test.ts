import { describe, expect, it } from 'vitest'
import { formatServerTime } from '../../src/license/encoding'
import { activeLicense, makeEnv, RAW_ID } from './harness'

const DAY = 24 * 60 * 60 * 1000

function soon(env: ReturnType<typeof makeEnv>): string {
  return formatServerTime(env.now() + 1000)
}

describe('devices', () => {
  it('T-DV1 T-DV5 three devices activate and the same fingerprint keeps its device id', async () => {
    const ids = ['a', 'b', 'c']
    const fingerprints = new Set<string>()
    for (const id of ids) {
      const env = makeEnv(id)
      const app = env.start({ rawId: id })
      env.transport.handlers.push(env.respond('active', activeLicense(env, id, { device_id: `dev-${id}` })))
      await app.activate('SHARED')
      expect(app.snapshot().mode).toBe('licensed')
      fingerprints.add(String(env.transport.calls[0]?.body.fingerprint))
      env.transport.handlers.push(env.respond('active', activeLicense(env, id, { device_id: `dev-${id}` })))
      await app.activate('SHARED')
      expect(env.transport.calls[1]?.body.fingerprint).toBe(env.transport.calls[0]?.body.fingerprint)
      const payload = env.storedLicense(app) as { license: { device_id: string } }
      expect(payload.license.device_id).toBe(`dev-${id}`)
    }
    expect(fingerprints.size).toBe(3)
  })

  it('T-DV2 T3 a fourth device, including a phone, gets device_limit_reached and stays free', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(
      env.respond('device_limit_reached', null, {
        devices: [
          { id: 'phone', name: 'iPhone', platform: 'ios', last_seen: '2026-06-01T00:00:00Z' },
          { id: 'mac', name: 'Mac', platform: 'macos', last_seen: '2026-06-02T00:00:00Z' },
          { id: 'pc', name: 'PC', platform: 'windows', last_seen: '2026-06-03T00:00:00Z' }
        ]
      })
    )
    await app.activate('SHARED')
    const snap = app.snapshot()
    expect(snap.mode).toBe('free')
    expect(snap.dialog?.kind).toBe('device-limit')
    expect(snap.dialog?.body).toContain('3')
    expect(snap.dialog?.linkUrl).toBe(env.profile.portalUrl)
    expect(snap.remainingSeconds).toBe(600)
    expect(snap.historyAvailable).toBe(true)
    expect(env.keys.read()).toBeNull()
  })

  it('T-DV3 a seat freed in the portal lets the next activate succeed', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('device_limit_reached', null, { devices: [] }))
    await app.activate('SHARED')
    expect(app.snapshot().mode).toBe('free')
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('SHARED')
    expect(app.snapshot().mode).toBe('licensed')
  })

  it('T-DV4 a removed device follows signed deactivated restrict_after and keeps its data', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: soon(env) })))
    await app.activate('SHARED')
    env.storage.writeAtomic('usage.json', '{"v":1,"sentinel":"keep"}')
    const restrictAt = env.now() + 7 * DAY
    env.transport.handlers.push(
      env.respond('deactivated', activeLicense(env, RAW_ID, { state: 'deactivated', restrict_after: formatServerTime(restrictAt) }))
    )
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    env.setNow(restrictAt)
    expect(app.snapshot().mode).toBe('free')
    expect(env.storage.read('usage.json')).toBeTruthy()
    expect(app.snapshot().historyAvailable).toBe(true)
    expect(app.snapshot().exportAvailable).toBe(true)
    expect(app.canStartDictation().ok).toBe(true)
  })

  it('v0.4.3 copies catalog device_limit only when the signed field is missing', async () => {
    const env = makeEnv()
    const app = env.start()
    expect(env.profile.deviceLimit).toBe(3)
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('SHARED')
    expect(app.snapshot().deviceLimit).toBe(3)
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { device_limit: 5 })))
    await app.activate('SHARED')
    expect(app.snapshot().deviceLimit).toBe(5)
  })

  it('T-DV8 signed device_not_found re-activates once and stays licensed', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: soon(env) })))
    await app.activate('SECRET')
    env.transport.handlers.push(env.respond('device_not_found'))
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { device_id: 'dev_new' })))
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.snapshot().dialog).toBeNull()
    const payload = env.storedLicense(app) as { license: { device_id: string } }
    expect(payload.license.device_id).toBe('dev_new')
    expect(env.transport.calls.filter((call) => call.url.endsWith('/activate'))).toHaveLength(2)
    expect(env.transport.calls.filter((call) => call.url.endsWith('/checkin'))).toHaveLength(1)
  })

  it('T-DV8 device_limit, invalid key, or revoked drops to free with a re-activation offer and keeps data', async () => {
    const limit = makeEnv('limit')
    const limited = limit.start({ rawId: 'limit' })
    limit.transport.handlers.push(limit.respond('active', activeLicense(limit, 'limit', { next_checkin_after: soon(limit) })))
    await limited.activate('SECRET')
    limit.storage.writeAtomic('usage.json', '{"v":1,"sentinel":"keep"}')
    limit.transport.handlers.push(limit.respond('device_not_found'))
    limit.transport.handlers.push(
      limit.respond('device_limit_reached', null, { devices: [{ id: 'phone', name: null, platform: 'ios', last_seen: null }] })
    )
    limit.setNow(limit.now() + 2000)
    await limited.tick()
    expect(limited.snapshot().mode).toBe('free')
    expect(limited.snapshot().dialog?.kind).toBe('device-limit')
    expect(limited.snapshot().dialog?.linkUrl).toBe(limit.profile.portalUrl)
    expect(limit.keys.read()).toBe('SECRET')
    expect(limit.storage.read('usage.json')).toBeTruthy()
    expect(limited.snapshot().historyAvailable).toBe(true)
    expect(limited.canStartDictation().ok).toBe(true)
    expect(limit.transport.calls.filter((call) => call.url.endsWith('/activate'))).toHaveLength(2)

    const invalid = makeEnv('invalid')
    const bad = invalid.start({ rawId: 'invalid' })
    invalid.transport.handlers.push(invalid.respond('active', activeLicense(invalid, 'invalid', { next_checkin_after: soon(invalid) })))
    await bad.activate('SECRET')
    invalid.transport.handlers.push(invalid.respond('device_not_found'))
    invalid.transport.handlers.push(invalid.respond('invalid_key'))
    invalid.setNow(invalid.now() + 2000)
    await bad.tick()
    expect(bad.snapshot().mode).toBe('free')
    expect(bad.snapshot().dialog?.kind).toBe('reactivate')
    expect(bad.snapshot().dialog?.error).toBe(invalid.copy.invalidKey)
    expect(bad.snapshot().historyAvailable).toBe(true)

    const revoked = makeEnv('revoked')
    const dead = revoked.start({ rawId: 'revoked' })
    revoked.transport.handlers.push(revoked.respond('active', activeLicense(revoked, 'revoked', { next_checkin_after: soon(revoked) })))
    await dead.activate('SECRET')
    revoked.transport.handlers.push(revoked.respond('device_not_found'))
    revoked.transport.handlers.push(revoked.respond('revoked', activeLicense(revoked, 'revoked', { state: 'revoked', restrict_after: formatServerTime(revoked.now() + 7 * DAY) })))
    revoked.setNow(revoked.now() + 2000)
    await dead.tick()
    expect(dead.snapshot().mode).toBe('free')
    expect(dead.snapshot().dialog?.kind).toBe('reactivate')
    expect(dead.snapshot().remainingSeconds).toBe(600)
    expect(revoked.storage.read('license.json')).toBeNull()
  })

  it('T-DV8 a network error on the silent re-activation leaves the license unchanged', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: soon(env) })))
    await app.activate('SECRET')
    const before = env.storage.read('license.json')
    env.transport.handlers.push(env.respond('device_not_found'))
    env.transport.handlers.push(async () => ({ kind: 'error', reason: 'network' }))
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.snapshot().dialog).toBeNull()
    expect(env.storage.read('license.json')).toBe(before)
    const calls = env.transport.calls.length
    await app.tick()
    expect(env.transport.calls).toHaveLength(calls)
  })
})
