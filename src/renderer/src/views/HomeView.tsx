// Port of Flowa/Sections/HomeView.swift — settings + recent dictations.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AudioWaveform, ChevronDown, ChevronRight, CircleX, Command, Globe, Info, Mic, Power, Search, Timer } from 'lucide-react'
import type { AppState } from '@shared/types'
import { languageDisplayName } from '@shared/languages'
import { inputsForPicker, type AudioInputDevice } from '@shared/micDeviceKind'
import { filterRecent } from '@shared/recent'
import { recentMeta } from '@shared/status'
import { maxDurationMinutesFromField, recommendedMaxDurationMinutes } from '@shared/prefs'
import { ConflictBanner, ErrorBanner, PermissionBanner, StatusBanner } from '../components/Banners'
import { DarkModeToggle, LanguagePicker, RecentRow, StatusPill } from '../components/HomeChrome'
import { ShortcutField } from '../components/ShortcutField'
import { AcknowledgementsView } from './AcknowledgementsView'

const f = window.flowa

function useInputDevices(current: string): [AudioInputDevice[], () => Promise<AudioInputDevice[]>] {
  const [devices, setDevices] = useState<AudioInputDevice[]>([])
  const refresh = useCallback(async () => {
    try {
      const list = inputsForPicker(await navigator.mediaDevices.enumerateDevices())
      setDevices(list)
      // Migrate stale prefs to system default (only when we can actually see devices).
      if (list.length > 0 && current !== 'default' && current !== '' && !list.some((d) => d.uid === current)) {
        void f.setPref('flowa.microphone', 'default')
      }
      return list
    } catch {
      return []
    }
  }, [current])
  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])
  return [devices, refresh]
}

export function HomeView({ state: s }: { state: AppState }) {
  const p = s.prefs
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false)
  const [ackOpen, setAckOpen] = useState(false)
  const [recentQuery, setRecentQuery] = useState('')
  const [maxField, setMaxField] = useState(String(p['flowa.maxDurationMinutes']))
  const [devices, refreshDevices] = useInputDevices(p['flowa.microphone'])
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => setMaxField(String(p['flowa.maxDurationMinutes'])), [p['flowa.maxDurationMinutes']])

  const commitMaxField = (): void => {
    const minutes = maxDurationMinutesFromField(maxField)
    void f.setPref('flowa.maxDurationMinutes', minutes)
    setMaxField(String(minutes))
  }

  const micName = useMemo(() => {
    const uid = p['flowa.microphone']
    if (uid === 'default' || uid === '') return 'System default'
    return devices.find((d) => d.uid === uid)?.displayName ?? 'System default'
  }, [devices, p['flowa.microphone']])

  const openMicMenu = async (): Promise<void> => {
    const list = await refreshDevices()
    const chosen = (await f.action('popupMicMenu', list.map((d) => ({ uid: d.uid, displayName: d.displayName })), p['flowa.microphone'])) as string | null
    if (chosen) void f.setPref('flowa.microphone', chosen)
  }

  const filtered = filterRecent(s.recent, recentQuery)
  const perms = s.permissions
  const linux = s.platform === 'linux'

  return (
    <div className="screen">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <AudioWaveform size={18} strokeWidth={2.4} />
          <span style={{ fontSize: 17, fontWeight: 600 }}>Flowa</span>
        </div>
        <div style={{ flex: 1 }} />
        <StatusPill isReady={s.allGranted} />
        <DarkModeToggle isOn={p['flowa.colorScheme.dark']} onChange={(v) => void f.setPref('flowa.colorScheme.dark', v)} />
      </div>

      <div className="scroll" style={{ flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 22px 22px' }}>
          {s.lastErrorMessage && <ErrorBanner message={s.lastErrorMessage} onDismiss={() => void f.action('dismissError')} />}
          {s.transcriber.kind === 'error' && (
            <StatusBanner
              severity="danger"
              title="Installation needs attention"
              detail={s.transcriber.message}
              actionTitle="Install again"
              action={() => void f.action('reinstallSpeechModel')}
            />
          )}
          {s.conflict.kind === 'conflict' && (
            <ConflictBanner behavior={s.conflict.displayName} onFix={() => void f.action('openKeyboardSettings')} />
          )}
          {s.conflict.kind === 'shortcutTaken' && (
            <StatusBanner
              severity="warning"
              title="Shortcut is in use by another app"
              detail={`Flowa couldn't register ${s.shortcut.label}. Click the Shortcut row below and choose another one.`}
            />
          )}
          {perms.applicable.microphone && !perms.microphone && (
            <PermissionBanner title="Microphone access needed" detail="Without it, Flowa can't capture your voice." actionTitle="Grant" action={() => void f.action('requestMicrophone')} />
          )}
          {perms.applicable.inputMonitoring && !perms.inputMonitoring && (
            <PermissionBanner title="Input Monitoring needed for the Fn key" detail="Without it, Flowa can't see when you press Fn." actionTitle="Open" action={() => void f.action('requestInputMonitoring')} />
          )}
          {s.shortcut.usesFn && perms.inputMonitoring && !s.shortcut.active && (
            <PermissionBanner
              title="The Fn key isn't active yet"
              detail="Input Monitoring is on, but Flowa hasn't started listening for Fn. Try again, or quit and reopen Flowa."
              actionTitle="Try again"
              action={() => void f.action('reloadShortcut')}
            />
          )}
          {perms.applicable.accessibility && !perms.accessibility && (
            <PermissionBanner
              title={linux ? 'xdotool or wtype needed for auto-paste' : 'Accessibility needed for auto-paste'}
              detail="Without it, dictations only land on the clipboard."
              actionTitle={linux ? 'How to' : 'Grant'}
              action={() => void f.action('requestAccessibility')}
            />
          )}

          {/* Settings card */}
          <div className="card" style={{ padding: '0 16px', position: 'relative' }}>
            <Row icon={Command} label="Shortcut">
              <ShortcutField label={s.shortcut.label} usesFn={s.shortcut.usesFn} platform={s.platform} />
            </Row>
            <div className="hairline" />
            <Row icon={Globe} label="Language">
              <button onClick={() => setLanguagePickerOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{languageDisplayName(p['flowa.language'])}</span>
                <ChevronDown size={10} strokeWidth={3} color="var(--text-tertiary)" />
              </button>
            </Row>
            {languagePickerOpen && (
              <LanguagePicker
                style={{ right: 6, top: 82 }}
                selected={p['flowa.language']}
                onClose={() => setLanguagePickerOpen(false)}
                onSelect={(code) => {
                  void f.setPref('flowa.language', code)
                  setLanguagePickerOpen(false)
                }}
              />
            )}
            <div className="hairline" />
            <Row icon={Mic} label="Microphone">
              <button onClick={() => void openMicMenu()} style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 300 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{micName}</span>
                <ChevronDown size={10} strokeWidth={3} color="var(--text-tertiary)" style={{ flex: 'none' }} />
              </button>
            </Row>
            <div className="hairline" />
            <Row icon={Power} label="Launch at login">
              <button className={`switch${s.launchAtLogin ? ' on' : ''}`} role="switch" aria-checked={s.launchAtLogin} onClick={() => void f.action('setLaunchAtLogin', !s.launchAtLogin)} />
            </Row>
            <div className="hairline" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, padding: '4px 0' }}>
              <Timer size={14} strokeWidth={2} color="var(--text-tertiary)" style={{ width: 16, flex: 'none' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13 }}>Max duration</span>
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>Recommended {recommendedMaxDurationMinutes} min · 0 = no limit</span>
              </div>
              <div style={{ flex: 1, minWidth: 8 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input
                  className="plain-input muted-field tabular"
                  style={{ width: 44, textAlign: 'right', fontSize: 13, padding: '3px 6px' }}
                  placeholder="60"
                  value={maxField}
                  onChange={(e) => setMaxField(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && commitMaxField()}
                  onBlur={commitMaxField}
                />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>min</span>
              </div>
            </div>
            <div className="hairline" />
            <Row icon={Info} label="Acknowledgements">
              <button className="icon-btn" onClick={() => setAckOpen(true)} style={{ color: 'var(--text-tertiary)' }}>
                <ChevronRight size={12} strokeWidth={3} />
              </button>
            </Row>
          </div>

          {/* Recent */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 2px 0' }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--text-tertiary)' }}>RECENT</span>
              <div style={{ flex: 1 }} />
              {s.recent.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="muted-field" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px' }}>
                    <Search size={10} color="var(--text-tertiary)" />
                    <input className="plain-input" style={{ width: 80, fontSize: 11 }} value={recentQuery} onChange={(e) => setRecentQuery(e.target.value)} />
                    {recentQuery && (
                      <button className="icon-btn" onClick={() => setRecentQuery('')}>
                        <CircleX size={10} fill="var(--text-tertiary)" stroke="var(--surface-muted)" />
                      </button>
                    )}
                  </div>
                  <button onClick={() => void f.action('clearRecent')} style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)' }}>
                    Clear
                  </button>
                </div>
              )}
            </div>

            {s.recent.length === 0 ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '32px 0' }}>
                <AudioWaveform size={22} color="var(--text-tertiary)" />
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>No dictations yet</span>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Press {s.shortcut.label} anywhere and speak.</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="card" style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '24px 0', textAlign: 'center' }}>
                No results for "{recentQuery}"
              </div>
            ) : (
              <div className="card" style={{ padding: '0 12px' }}>
                {filtered.map((d, i) => (
                  <div key={d.id}>
                    {i > 0 && <div className="hairline" />}
                    <RecentRow dictation={d} metaText={recentMeta(new Date(d.date), d.targetAppName, now)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {ackOpen && <AcknowledgementsView onClose={() => setAckOpen(false)} />}
    </div>
  )
}

function Row({ icon: Icon, label, children }: { icon: typeof Mic; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 40 }}>
      <Icon size={14} strokeWidth={2} color="var(--text-tertiary)" style={{ width: 16, flex: 'none' }} />
      <span style={{ fontSize: 13 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 8 }} />
      {children}
    </div>
  )
}
