// Ports FlowaTests/MicDeviceKindTests.swift (+ ShipGate resolve fallbacks).
import { describe, expect, it } from 'vitest'
import {
  classifyMic, continuityWirelessTransport, inputsForPicker, isEphemeralAggregateUID, micDisplayName, resolveCaptureUID
} from '@shared/micDeviceKind'

describe('MicDeviceKind', () => {
  it('iPhone modelUID → continuity', () => {
    expect(classifyMic('Max’s iPhone Microphone', 'iPhone Mic', 0, '181D41EF-720B-49C2-A1CA-207D00000003')).toBe('continuity')
  })
  it("'ccwd' transport → continuity", () => {
    expect(classifyMic('Some Device', '', continuityWirelessTransport, 'abc')).toBe('continuity')
  })
  it('USB Studio Display → standard', () => {
    expect(classifyMic('Studio Display Microphone', 'Studio Display Audio Control:05AC:1114', 0x75736220, 'AppleUSBAudioEngine:Apple Inc.:Studio Display:xyz')).toBe('standard')
  })
  it('name-only fallback (what Chromium gives us) still detects Continuity', () => {
    expect(classifyMic('Max’s iPhone Microphone', '', 0, 'f00ba4')).toBe('continuity')
  })
  it('display names', () => {
    const label = micDisplayName('Max’s iPhone Microphone', 'continuity')
    expect(label).toContain('speak near phone')
    expect(label).toContain('iPhone')
    expect(micDisplayName('Studio Display Microphone', 'standard')).toBe('Studio Display Microphone')
  })
  it('ephemeral aggregate UID', () => {
    expect(isEphemeralAggregateUID('CADefaultDeviceAggregate-852-0')).toBe(true)
    expect(isEphemeralAggregateUID('AppleUSBAudioEngine:Apple Inc.:Studio Display:00008030:6,7')).toBe(false)
  })
  it('picker hides virtual default entries and labels continuity', () => {
    const list = inputsForPicker([
      { deviceId: 'default', label: 'Default - MacBook Pro Microphone', kind: 'audioinput' },
      { deviceId: 'a1', label: 'Studio Display Microphone', kind: 'audioinput' },
      { deviceId: 'b2', label: 'Max’s iPhone Microphone', kind: 'audioinput' },
      { deviceId: 'c3', label: 'Speakers', kind: 'audiooutput' }
    ])
    expect(list.map((d) => d.uid)).toEqual(['a1', 'b2'])
    expect(list[1].kind).toBe('continuity')
    expect(list[1].displayName).toContain('speak near phone')
  })
  it('resolveCaptureUID falls back for missing and aggregate', () => {
    const live = inputsForPicker([{ deviceId: 'a1', label: 'Mic', kind: 'audioinput' }])
    expect(resolveCaptureUID('default', live)).toBe('default')
    expect(resolveCaptureUID('', live)).toBe('default')
    expect(resolveCaptureUID('CADefaultDeviceAggregate-999-0', live)).toBe('default')
    expect(resolveCaptureUID('totally-missing-device-uid', live)).toBe('default')
    expect(resolveCaptureUID('a1', live)).toBe('a1')
  })
})
