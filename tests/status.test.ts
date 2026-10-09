// Copy/state helpers ported from FlowaApp.swift, Transcriber.swift, DictationPipeline.swift, InstallingView.swift.
import { describe, expect, it } from 'vitest'
import {
  countdownText, fnConflictFromRaw, friendlyLoadError, machineNoun, maxDurationStoppedMessage, menuStatusText,
  modelNotReadyMessage, needsSetup, recentMeta, relativeAge, silenceMessage, trayIconName
} from '@shared/status'
import type { PermissionsState } from '@shared/types'

const granted: PermissionsState = { microphone: true, inputMonitoring: true, accessibility: true, applicable: { microphone: true, inputMonitoring: true, accessibility: true } }

describe('Transcriber.needsSetup', () => {
  it('matches Swift', () => {
    expect(needsSetup({ kind: 'ready' }, true)).toBe(false)
    expect(needsSetup({ kind: 'transcribing' }, true)).toBe(false)
    expect(needsSetup({ kind: 'error', message: 'x' }, false)).toBe(true)
    expect(needsSetup({ kind: 'preparing', progress: 0.5 }, false)).toBe(true)
    expect(needsSetup({ kind: 'downloading', received: 1, total: 2 }, false)).toBe(true)
    expect(needsSetup({ kind: 'idle' }, false)).toBe(true)
    expect(needsSetup({ kind: 'idle' }, true)).toBe(false)
  })
})

describe('install countdown', () => {
  it('2:00 → Almost done…', () => {
    expect(countdownText(0)).toBe('2:00')
    expect(countdownText(0.5)).toBe('1:00')
    expect(countdownText(0.99)).toBe('0:02')
    expect(countdownText(1)).toBe('Almost done…')
  })
})

describe('menu bar status / icon', () => {
  const base = { needsSetup: false, permissions: granted, conflict: { kind: 'clean' as const }, isTranscribing: false, keyLabel: 'fn' }
  it('ready text', () => expect(menuStatusText({ ...base, transcriber: { kind: 'ready' } })).toBe('Ready — press fn to dictate'))
  it('error first', () => expect(menuStatusText({ ...base, transcriber: { kind: 'error', message: 'x' } })).toBe('Installation needs attention'))
  it('preparing countdown', () => expect(menuStatusText({ ...base, needsSetup: true, transcriber: { kind: 'preparing', progress: 0.5 } })).toBe('Installing… 1:00'))
  it('permission order', () => {
    expect(menuStatusText({ ...base, transcriber: { kind: 'ready' }, permissions: { ...granted, microphone: false, accessibility: false } })).toBe('Microphone permission missing')
    expect(menuStatusText({ ...base, transcriber: { kind: 'ready' }, permissions: { ...granted, inputMonitoring: false } })).toBe('Input Monitoring permission missing')
  })
  it('fn conflict', () => expect(menuStatusText({ ...base, transcriber: { kind: 'ready' }, conflict: { kind: 'conflict', behavior: 2, displayName: 'Show Emoji & Symbols' } })).toBe('Apple Fn handler is active'))
  it('icons', () => {
    expect(trayIconName({ isTranscribing: true, needsSetup: true, allGranted: false, conflict: { kind: 'clean' } })).toBe('ellipsis')
    expect(trayIconName({ isTranscribing: false, needsSetup: true, allGranted: true, conflict: { kind: 'clean' } })).toBe('download')
    expect(trayIconName({ isTranscribing: false, needsSetup: false, allGranted: false, conflict: { kind: 'clean' } })).toBe('waveformSlash')
    expect(trayIconName({ isTranscribing: false, needsSetup: false, allGranted: true, conflict: { kind: 'clean' } })).toBe('waveform')
  })
})

describe('FnConflictDetector', () => {
  it('maps AppleFnUsageType', () => {
    expect(fnConflictFromRaw('0\n')).toEqual({ kind: 'clean' })
    expect(fnConflictFromRaw(2)).toEqual({ kind: 'conflict', behavior: 2, displayName: 'Show Emoji & Symbols' })
    expect(fnConflictFromRaw('3')).toMatchObject({ displayName: 'Start Dictation' })
    expect(fnConflictFromRaw(null)).toEqual({ kind: 'unknown' })
    expect(fnConflictFromRaw('9')).toEqual({ kind: 'unknown' })
  })
})

describe('copy', () => {
  it('silence messages', () => {
    expect(silenceMessage('standard')).toBe('No speech heard. Check the selected microphone and try again.')
    expect(silenceMessage('continuity')).toContain('Continuity picks up the phone')
  })
  it('max duration label', () => {
    expect(maxDurationStoppedMessage(60)).toBe('Recording stopped at your 1 hour limit. Transcript was still saved.')
    expect(maxDurationStoppedMessage(120)).toContain('2 hours')
    expect(maxDurationStoppedMessage(1)).toContain('1 minute limit')
    expect(maxDurationStoppedMessage(45)).toContain('45 minutes')
  })
  it('model not ready', () => {
    expect(modelNotReadyMessage({ kind: 'preparing', progress: 0 }, 'Mac')).toBe('Still installing Flowa on this Mac. Try again in a moment.')
    expect(modelNotReadyMessage({ kind: 'idle' }, 'Mac')).toBe("Flowa isn't finished installing yet. Check the main window.")
  })
  it('friendly load errors', () => {
    expect(friendlyLoadError('No space left on disk', 'Mac')).toBe("Couldn't finish installation — your Mac may be low on disk space.")
    expect(friendlyLoadError('Speech engine is missing from this app.', 'PC')).toBe('Speech engine is missing from this app.')
    expect(friendlyLoadError('weird', 'PC')).toBe("Couldn't finish installation. Try again, or use Repair Flowa from the menu bar.")
  })
  it('machine noun', () => {
    expect(machineNoun('darwin')).toBe('Mac')
    expect(machineNoun('win32')).toBe('PC')
    expect(machineNoun('linux')).toBe('computer')
  })
  it('relative meta', () => {
    const now = new Date('2026-10-09T10:00:00Z')
    expect(relativeAge(new Date('2026-10-09T09:55:00Z'), now)).toBe('5 min. ago')
    expect(recentMeta(new Date('2026-10-09T08:00:00Z'), 'Notes', now)).toBe('2 hr. ago · Notes')
    expect(recentMeta(new Date('2026-10-08T10:00:00Z'), null, now)).toBe('1 day ago')
  })
})
