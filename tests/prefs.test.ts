// Ports FlowaTests/PreferencesTests.swift.
import { describe, expect, it } from 'vitest'
import {
  PrefKey, coercePrefs, defaultShortcut, isSystemDefaultMicrophone, languageForWhisper, maxDurationMinutesFromField,
  maxDurationSeconds, normalizedMicrophoneUID, readMaxDurationMinutes, recommendedMaxDurationMinutes, sanitizedMaxDurationMinutes
} from '@shared/prefs'
import { isEphemeralAggregateUID } from '@shared/micDeviceKind'

describe('Preferences (Swift parity)', () => {
  it('maps auto to nil / passes codes', () => {
    expect(languageForWhisper('auto')).toBeNull()
    expect(languageForWhisper('en')).toBe('en')
    expect(languageForWhisper('da')).toBe('da')
  })
  it('keeps Swift UserDefaults key names', () => {
    expect(PrefKey.language).toBe('flowa.language')
    expect(PrefKey.microphone).toBe('flowa.microphone')
    expect(PrefKey.colorSchemeDark).toBe('flowa.colorScheme.dark')
    expect(PrefKey.onboardingComplete).toBe('flowa.onboardingComplete')
    expect(PrefKey.firstRunComplete).toBe('flowa.firstRunComplete')
    expect(PrefKey.maxDurationMinutes).toBe('flowa.maxDurationMinutes')
  })
  it('system default microphone sentinel', () => {
    expect(isSystemDefaultMicrophone('default')).toBe(true)
    expect(isSystemDefaultMicrophone('')).toBe(true)
    expect(isSystemDefaultMicrophone('BuiltInMicrophoneDevice')).toBe(false)
  })
  it('max duration sanitization', () => {
    expect(sanitizedMaxDurationMinutes(60)).toBe(60)
    expect(sanitizedMaxDurationMinutes(0)).toBe(0)
    expect(sanitizedMaxDurationMinutes(-5)).toBe(0)
    expect(sanitizedMaxDurationMinutes(99999)).toBe(24 * 60)
    expect(maxDurationMinutesFromField('60')).toBe(60)
    expect(maxDurationMinutesFromField(' 0 ')).toBe(0)
    expect(maxDurationMinutesFromField('')).toBe(recommendedMaxDurationMinutes)
    expect(maxDurationMinutesFromField('abc')).toBe(recommendedMaxDurationMinutes)
  })
  it('max duration seconds nil when unlimited', () => {
    expect(maxDurationSeconds(0)).toBeNull()
    expect(maxDurationSeconds(60)).toBe(3600)
  })
  it('missing stored max duration → recommended 60', () => {
    expect(readMaxDurationMinutes(undefined)).toBe(60)
    expect(readMaxDurationMinutes(15)).toBe(15)
  })
  it('defaults match Swift (@AppStorage defaults): en, default mic, dark on', () => {
    const p = coercePrefs(null, 'darwin')
    expect(p['flowa.language']).toBe('en')
    expect(p['flowa.microphone']).toBe('default')
    expect(p['flowa.colorScheme.dark']).toBe(true)
    expect(p['flowa.maxDurationMinutes']).toBe(60)
    expect(p['flowa.shortcut']).toBe('fn')
    expect(defaultShortcut('win32')).toBe('Control+Shift+Space')
  })
  it('rewrites ephemeral aggregates to default (setMicrophoneUID)', () => {
    expect(normalizedMicrophoneUID('CADefaultDeviceAggregate-852-0', isEphemeralAggregateUID)).toBe('default')
    expect(normalizedMicrophoneUID('', isEphemeralAggregateUID)).toBe('default')
    expect(normalizedMicrophoneUID('abc', isEphemeralAggregateUID)).toBe('abc')
  })
  it('coerces garbage safely', () => {
    const p = coercePrefs({ 'flowa.language': 5, 'flowa.colorScheme.dark': 'yes', 'flowa.maxDurationMinutes': 99999 }, 'linux')
    expect(p['flowa.language']).toBe('en')
    expect(p['flowa.colorScheme.dark']).toBe(true)
    expect(p['flowa.maxDurationMinutes']).toBe(1440)
  })
})
