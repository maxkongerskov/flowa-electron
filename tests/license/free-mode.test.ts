import { describe, expect, it } from 'vitest'
import { CLOCK_CORRECTION_MS, nextLocalMidnight, observeClock, freshUsage } from '../../src/license/usage'
import { formatServerTime } from '../../src/license/encoding'
import { activeLicense, makeEnv, RAW_ID } from './harness'

const DAY = 24 * 60 * 60 * 1000

describe('free mode', () => {
  it('T-FR2 only recorded audio seconds are metered', () => {
    const env = makeEnv()
    const app = env.start()
    const started = app.canStartDictation()
    expect(started).toEqual({ ok: true, meter: true })
    app.noteFinishedDictation(12.5, started.ok && started.meter)
    expect(app.snapshot().remainingSeconds).toBe(587.5)
  })

  it('T-FR3 a take that crosses the cap is saved and the overage is next-day debt', () => {
    const env = makeEnv()
    const app = env.start()
    const first = app.canStartDictation()
    expect(first.ok).toBe(true)
    const crossed = app.noteFinishedDictation(700, true)
    expect(crossed).toBe(true)
    expect(app.snapshot().dialog?.kind).toBe('daily-cap')
    expect(app.snapshot().remainingSeconds).toBe(0)
    expect(app.canStartDictation().ok).toBe(false)
    env.setNow(nextLocalMidnight(env.now()) + 1000)
    expect(app.canStartDictation()).toEqual({ ok: true, meter: true })
    expect(app.snapshot().remainingSeconds).toBe(500)
  })

  it('T-FR3 debt is capped at one quota and a skipped day forgives it', () => {
    const env = makeEnv()
    const app = env.start()
    app.noteFinishedDictation(600 + 900, true)
    env.setNow(nextLocalMidnight(env.now()) + 1000)
    expect(app.snapshot().remainingSeconds).toBe(0)
    env.setNow(nextLocalMidnight(env.now()) + 1000)
    expect(app.snapshot().remainingSeconds).toBe(600)
  })

  it('T-FR4 the cap dialog has the catalog buttons and local midnight refills', async () => {
    const env = makeEnv()
    const app = env.start()
    expect(app.snapshot().dialog).toBeNull()
    app.noteFinishedDictation(600, true)
    const dialog = app.snapshot().dialog
    expect(dialog?.kind).toBe('daily-cap')
    expect(dialog?.primaryLabel).toBe(env.copy.buyButton)
    expect(dialog?.primaryLabel).toContain('€29')
    expect(dialog?.secondaryLabel).toBe(env.copy.enterKeyButton)
    expect(app.snapshot().historyAvailable).toBe(true)
    expect(app.snapshot().settingsAvailable).toBe(true)
    expect(app.snapshot().exportAvailable).toBe(true)
    env.setNow(nextLocalMidnight(env.now()) + 1000)
    await app.tick()
    expect(app.snapshot().dialog).toBeNull()
    expect(app.canStartDictation().ok).toBe(true)
  })

  it('T-FR5 clock movement and a corrupt usage file never lock dictation', () => {
    const state = { ...freshUsage(1_000_000), usedSeconds: 600, debtSeconds: 0 }
    const exactly = observeClock(state, state.highestSeenMs - CLOCK_CORRECTION_MS, 600)
    expect(exactly.usedSeconds).toBe(600)
    expect(exactly.highestSeenMs).toBe(state.highestSeenMs)
    const small = observeClock(state, state.highestSeenMs - CLOCK_CORRECTION_MS + 1, 600)
    expect(small).toEqual(state)
    const forward = observeClock(state, nextLocalMidnight(state.highestSeenMs) + 1000, 600)
    expect(forward.usedSeconds).toBe(0)

    const corrected = observeClock(state, state.highestSeenMs - CLOCK_CORRECTION_MS - 1, 600)
    expect(corrected.highestSeenMs).toBe(state.highestSeenMs - CLOCK_CORRECTION_MS - 1)
    expect(corrected.usedSeconds).toBe(600)
    const refilled = observeClock(corrected, nextLocalMidnight(corrected.highestSeenMs) + 1000, 600)
    expect(refilled.usedSeconds).toBe(0)

    const env = makeEnv()
    env.storage.writeAtomic('usage.json', '{')
    const app = env.start()
    expect(app.canStartDictation()).toEqual({ ok: true, meter: true })
    expect(app.snapshot().remainingSeconds).toBe(600)
  })

  it('T-FR6 a valid key at the cap becomes unlimited immediately', async () => {
    const env = makeEnv()
    const app = env.start()
    app.noteFinishedDictation(600, true)
    expect(app.canStartDictation().ok).toBe(false)
    env.transport.handlers.push(env.respond('active', activeLicense(env)))
    await app.activate('  FLOWA-KEY  ')
    expect(env.transport.calls[0]?.body.license_key).toBe('FLOWA-KEY')
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.canStartDictation()).toEqual({ ok: true, meter: false })
    expect(app.snapshot().dialog).toBeNull()
  })

  it('T-FR7 T11 refunded and revoked follow restrict_after and keep the app usable', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(
      env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) }))
    )
    await app.activate('FLOWA-KEY')
    const restrictAt = env.now() + 7 * DAY
    env.transport.handlers.push(
      env.respond('revoked', activeLicense(env, RAW_ID, { state: 'revoked', restrict_after: formatServerTime(restrictAt) }))
    )
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    expect(app.snapshot().quietNote).toContain('fuldt ud')
    env.setNow(restrictAt)
    expect(app.snapshot().mode).toBe('free')
    expect(app.snapshot().historyAvailable).toBe(true)
    expect(app.snapshot().settingsAvailable).toBe(true)
    expect(app.snapshot().exportAvailable).toBe(true)
    expect(app.snapshot().modelsAvailable).toBe(true)
    expect(app.snapshot().updatesAvailable).toBe(true)
    expect(env.storage.read('usage.json')).toBeTruthy()
  })

  it('v0.4.3 the app follows restrict_after and does not invent a 7 day grace', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(
      env.respond('active', activeLicense(env, RAW_ID, { next_checkin_after: formatServerTime(env.now() + 1000) }))
    )
    await app.activate('FLOWA-KEY')
    env.transport.handlers.push(env.respond('refunded', activeLicense(env, RAW_ID, { state: 'refunded', next_checkin_after: formatServerTime(env.now() + 1000) })))
    env.setNow(env.now() + 2000)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')

    env.setNow(env.now() + 20 * DAY)
    const threeDays = env.now() + 3 * DAY
    env.transport.handlers.push(
      env.respond('refunded', activeLicense(env, RAW_ID, {
        state: 'refunded',
        restrict_after: formatServerTime(threeDays),
        next_checkin_after: formatServerTime(env.now() - 1000)
      }))
    )
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    env.setNow(threeDays + 1000)
    expect(app.snapshot().mode).toBe('free')
  })

  it('T-FR8 a signed free_daily_seconds is used and an invalid one stays 600', async () => {
    const env = makeEnv()
    const app = env.start()
    env.transport.handlers.push(env.respond('active', activeLicense(env, RAW_ID, { state: 'revoked', restrict_after: formatServerTime(env.now() - 1000), free_daily_seconds: 120 })))
    await app.activate('FLOWA-KEY')
    expect(app.snapshot().mode).toBe('free')
    expect(app.snapshot().remainingSeconds).toBe(120)

    const other = makeEnv('other')
    const bad = other.start()
    other.transport.handlers.push(
      other.respond('active', activeLicense(other, 'other', { state: 'revoked', restrict_after: formatServerTime(other.now() - 1000), free_daily_seconds: 0 }))
    )
    await bad.activate('FLOWA-KEY')
    expect(bad.snapshot().remainingSeconds).toBe(600)
  })

  it('T-FR9 T-FR10 T-FR11 the cap applies from day one and a free user does not call the license server', async () => {
    const env = makeEnv()
    env.setUi(true)
    const app = env.start()
    expect(app.snapshot().remainingSeconds).toBe(600)
    expect(app.snapshot().legacyUnlimited).toBe(false)
    expect(app.snapshot().dialog).toBeNull()
    await app.tick()
    expect(env.transport.calls).toHaveLength(0)
    app.noteFinishedDictation(600, true)
    expect(app.snapshot().dialog?.kind).toBe('daily-cap')
    expect(app.snapshot().historyAvailable).toBe(true)
    expect(app.snapshot().canEnterKey).toBe(true)
  })

  it('T15 a dictation that started licensed is finished and not metered when grace ends', async () => {
    const env = makeEnv()
    const app = env.start()
    const restrictAt = env.now() + DAY
    env.transport.handlers.push(
      env.respond('refunded', activeLicense(env, RAW_ID, { state: 'refunded', restrict_after: formatServerTime(restrictAt) }))
    )
    await app.activate('FLOWA-KEY')
    const started = app.canStartDictation()
    expect(started).toEqual({ ok: true, meter: false })
    env.setNow(restrictAt + 1000)
    expect(app.noteFinishedDictation(30, false)).toBe(false)
    expect(app.snapshot().mode).toBe('free')
    expect(app.snapshot().remainingSeconds).toBe(600)
    expect(app.canStartDictation()).toEqual({ ok: true, meter: true })
  })

  it('T29 local clock shortens grace and cannot expire an active license', async () => {
    const env = makeEnv()
    const app = env.start()
    const restrictAt = env.now() + 7 * DAY
    env.transport.handlers.push(
      env.respond('refunded', activeLicense(env, RAW_ID, { state: 'refunded', restrict_after: formatServerTime(restrictAt) }))
    )
    await app.activate('FLOWA-KEY')
    env.transport.handlers.push(async () => ({ kind: 'error', reason: 'network' }))
    env.setNow(restrictAt - DAY)
    await app.tick()
    expect(app.snapshot().mode).toBe('licensed')
    env.setNow(restrictAt + 1000)
    expect(app.snapshot().mode).toBe('free')

    const active = makeEnv('active-clock')
    const licensed = active.start()
    active.transport.handlers.push(active.respond('active', activeLicense(active, 'active-clock')))
    await licensed.activate('FLOWA-KEY')
    active.setNow(active.now() + 365 * DAY)
    expect(licensed.snapshot().mode).toBe('licensed')
    active.setNow(active.now() - 400 * DAY)
    expect(licensed.snapshot().mode).toBe('licensed')
  })
})
