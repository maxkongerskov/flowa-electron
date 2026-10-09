// Port of Flowa/Support/MicDeviceKind.swift — classifies audio inputs so
// Continuity / iPhone mics can be labeled and messaged correctly.
//
// Platform note: Chromium's MediaDeviceInfo exposes only a label + opaque
// deviceId, not Core Audio's modelUID / transport. The classifier keeps the
// Swift signature (so the same tests pass) and callers pass '' / 0 for the
// fields the web platform cannot see; the name-based fallback then applies.

export type MicDeviceKind = 'standard' | 'continuity'

/** Continuity Camera wireless device transport fourcc: 'ccwd'. */
export const continuityWirelessTransport = 0x63637764

export function classifyMic(name: string, modelUID: string, transport: number, uid: string): MicDeviceKind {
  const model = modelUID.toLowerCase()
  const n = name.toLowerCase()
  const u = uid.toLowerCase()
  if (transport === continuityWirelessTransport) return 'continuity'
  if (model === 'iphone mic' || model.includes('iphone mic')) return 'continuity'
  if (model.includes('continuity')) return 'continuity'
  if (n.includes('iphone') && (n.includes('microphone') || n.includes('mic'))) return 'continuity'
  if (u.includes('iphone') && u.includes('mic')) return 'continuity'
  return 'standard'
}

/** User-facing label for the microphone picker / current-value row. */
export function micDisplayName(name: string, kind: MicDeviceKind): string {
  if (kind === 'continuity') {
    if (name.toLowerCase().includes('speak')) return name
    return `${name} · speak near phone`
  }
  return name
}

/** Ephemeral Core Audio aggregates should not be persisted as a preference. */
export function isEphemeralAggregateUID(uid: string): boolean {
  return uid.startsWith('CADefaultDeviceAggregate')
}

export interface AudioInputDevice {
  /** Chromium deviceId (stable per app profile). Plays the role of Core Audio's UID. */
  uid: string
  name: string
  kind: MicDeviceKind
  displayName: string
}

/** Chromium labels the virtual default entries "Default - X" / "Communications - X" (Windows). */
export function isVirtualAliasDevice(deviceId: string): boolean {
  return deviceId === 'default' || deviceId === 'communications'
}

/** Build the picker list from raw enumerateDevices() output. */
export function inputsForPicker(raw: Array<{ deviceId: string; label: string; kind: string }>): AudioInputDevice[] {
  const out: AudioInputDevice[] = []
  for (const d of raw) {
    if (d.kind !== 'audioinput') continue
    if (!d.deviceId || isVirtualAliasDevice(d.deviceId)) continue
    if (isEphemeralAggregateUID(d.deviceId) || isEphemeralAggregateUID(d.label)) continue
    const name = d.label || 'Microphone'
    const kind = classifyMic(name, '', 0, d.deviceId)
    out.push({ uid: d.deviceId, name, kind, displayName: micDisplayName(name, kind) })
  }
  return out
}

/** Port of AudioDeviceManager.resolveCaptureUID: stale / missing → "default". */
export function resolveCaptureUID(preferred: string, live: AudioInputDevice[]): string {
  if (preferred === 'default' || preferred === '') return 'default'
  if (isEphemeralAggregateUID(preferred)) return 'default'
  if (live.some((d) => d.uid === preferred)) return preferred
  return 'default'
}
