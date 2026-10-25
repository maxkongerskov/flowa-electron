import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyMarker, shouldRunLegacyMigration } from '../../src/license/legacy'
import { createKeyStore, type SafeStorageLike } from '../../src/license/keyStore'
import { formatServerTime } from '../../src/license/encoding'
import { activeLicense, genuineWitness, makeEnv, PRODUCT, RAW_ID, UPDATER_ID } from './harness'

const DAY = 24 * 60 * 60 * 1000

describe('legacy grandfathering', () => {
  it('T16 (a) simulated 1.2.2 in-place update to a newer build is unlimited', () => {
    const env = makeEnv()
    const app = env.start({ version: '1.2.3', witness: genuineWitness('1.2.3') })
    const snap = app.snapshot()
    expect(snap.legacyUnlimited).toBe(true)
    expect(snap.mode).toBe('free')
    expect(snap.remainingSeconds).toBeNull()
    expect(snap.dialog).toBeNull()
    expect(app.canStartDictation()).toEqual({ ok: true, meter: false })
    const stored = JSON.parse(env.legacy.read() ?? 'null') as { marker: string }
    expect(stored.marker).toBe(legacyMarker(env.crypto, PRODUCT, RAW_ID))
  })

  it('T-FR1 (b) fresh install is free with a 600 s cap and does not call the license server', async () => {
    const env = makeEnv()
    const app = env.start({ version: '1.2.3' })
    const snap = app.snapshot()
    expect(snap.legacyUnlimited).toBe(false)
    expect(snap.mode).toBe('free')
    expect(snap.remainingSeconds).toBe(600)
    expect(snap.remainingLabel).toBe(env.copy.remaining(600))
    expect(snap.dialog).toBeNull()
    expect(app.canStartDictation()).toEqual({ ok: true, meter: true })
    await app.tick()
    expect(env.transport.calls).toHaveLength(0)
    const refusal = JSON.parse(env.legacy.read() ?? 'null') as { marker: string | null }
    expect(refusal.marker).toBeNull()
  })

  it('(c) fresh install with a copied 1.2.x userData folder from another machine stays free', () => {
    const env = makeEnv('this-machine')
    const foreign = legacyMarker(env.crypto, PRODUCT, 'other-machine')
    env.legacy.write(JSON.stringify({ v: 1, evaluated: true, marker: foreign }))
    const app = env.start({
      version: '1.2.3',
      rawId: 'this-machine',
      witness: { updaterIdRaw: UPDATER_ID, updateInfoRaw: null }
    })
    expect(app.snapshot().legacyUnlimited).toBe(false)
    expect(app.snapshot().remainingSeconds).toBe(600)
    expect(app.canStartDictation()).toEqual({ ok: true, meter: true })
    const stored = JSON.parse(env.legacy.read() ?? 'null') as { marker: string | null }
    expect(stored.marker).toBeNull()
  })

  it('(d) the marker survives a restart and a later update that clears updater signals', () => {
    const env = makeEnv()
    const first = env.start({ version: '1.2.3', witness: genuineWitness('1.2.3') })
    expect(first.snapshot().legacyUnlimited).toBe(true)
    const marker = env.legacy.read()
    const second = env.start({ version: '1.3.0', witness: { updateInfoRaw: null, updaterIdRaw: null } })
    expect(second.snapshot().legacyUnlimited).toBe(true)
    expect(env.legacy.read()).toBe(marker)
    expect(second.canStartDictation()).toEqual({ ok: true, meter: false })
  })

  it('v0.4.3 re-runs the strict check when the safeStorage marker is deleted', () => {
    const env = makeEnv()
    env.start({ version: '1.2.3', witness: genuineWitness('1.2.3') })
    env.legacy.clear()
    const again = env.start({ version: '1.2.3', witness: genuineWitness('1.2.3') })
    expect(again.snapshot().legacyUnlimited).toBe(true)

    env.legacy.clear()
    const gone = env.start({ version: '1.2.3', witness: { updateInfoRaw: null, updaterIdRaw: null } })
    expect(gone.snapshot().legacyUnlimited).toBe(false)
    expect(gone.snapshot().remainingSeconds).toBe(600)
  })

  it('v0.4.3 stores the marker with the same safeStorage path as the license key', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-legacy-'))
    const file = path.join(dir, 'legacy-unlimited.bin')
    const safe: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (plain) => Buffer.from(plain.split('').reverse().join(''), 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').split('').reverse().join('')
    }
    const store = createKeyStore(file, safe)
    const env = makeEnv()
    const plain = JSON.stringify({ v: 1, evaluated: true, marker: legacyMarker(env.crypto, PRODUCT, RAW_ID) })
    store.write(plain)
    const onDisk = readFileSync(file)
    expect(onDisk.toString('utf8')).not.toBe(plain)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(store.read()).toBe(plain)
  })

  it('T-LG5 a legacy install can enter a key, keeps the marker, and falls back to unlimited', async () => {
    const env = makeEnv()
    const app = env.start({ version: '1.2.3', witness: genuineWitness('1.2.3') })
    const marker = env.legacy.read()
    env.transport.handlers.push(
      env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) }))
    )
    await app.activate('FLOWA-KEY')
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.snapshot().legacyUnlimited).toBe(true)
    expect(env.legacy.read()).toBe(marker)
    expect(env.transport.calls).toHaveLength(1)
    env.transport.handlers.push(env.respond('ok', null, { devices_used: 2 }))
    await app.deactivate()
    expect(app.snapshot().mode).toBe('free')
    expect(app.snapshot().legacyUnlimited).toBe(true)
    expect(app.canStartDictation()).toEqual({ ok: true, meter: false })
    expect(env.legacy.read()).toBe(marker)

    env.transport.handlers.push(
      env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) }))
    )
    await app.activate('FLOWA-KEY')
    env.setNow(env.now() + 2000)
    const restrictAt = env.now() + 7 * DAY
    env.transport.handlers.push(
      env.respond('refunded', activeLicense(env, RAW_ID, { state: 'refunded', restrict_after: formatServerTime(restrictAt) }))
    )
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    env.setNow(restrictAt + 1000)
    const after = app.snapshot()
    expect(after.mode).toBe('free')
    expect(after.legacyUnlimited).toBe(true)
    expect(after.remainingSeconds).toBeNull()
    expect(after.dialog?.kind).not.toBe('daily-cap')
    expect(app.canStartDictation()).toEqual({ ok: true, meter: false })
    expect(env.legacy.read()).toBe(marker)
    expect(after.historyAvailable).toBe(true)
    expect(after.settingsAvailable).toBe(true)
    expect(after.exportAvailable).toBe(true)
  })

  it('a 1.2.2 or 9.9.0 build does not record a migration decision', () => {
    expect(shouldRunLegacyMigration('1.2.2')).toBe(false)
    expect(shouldRunLegacyMigration('9.9.0')).toBe(false)
    const env = makeEnv()
    const app = env.start({ version: '1.2.2', witness: genuineWitness('1.2.2') })
    expect(app.snapshot().legacyUnlimited).toBe(false)
    expect(env.legacy.read()).toBeNull()
  })

  it('prefs-shaped files without updater signals do not grant unlimited', () => {
    const env = makeEnv()
    env.storage.writeAtomic('prefs.json', '{"flowa.language":"da"}')
    env.storage.writeAtomic('recent.json', '[]')
    const app = env.start({ version: '1.2.3', witness: { updaterIdRaw: UPDATER_ID, updateInfoRaw: '{"fileName":"Flowa-1.2.2.AppImage"}' } })
    expect(app.snapshot().legacyUnlimited).toBe(false)
  })
})
