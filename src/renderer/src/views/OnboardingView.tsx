// Port of Flowa/Onboarding/OnboardingView.swift.
import { AudioWaveform, Check, Command, Mic, ShieldCheck } from 'lucide-react'
import type { AppState } from '@shared/types'

interface Step {
  key: 'microphone' | 'inputMonitoring' | 'accessibility'
  icon: typeof Mic
  title: string
  detail: string
  actionTitle: string
  action: string
}

function steps(s: AppState): Step[] {
  const linux = s.platform === 'linux'
  const all: Step[] = [
    {
      key: 'microphone',
      icon: Mic,
      title: 'Microphone',
      detail: `Captures your voice so Whisper can transcribe it locally on your ${s.machineNoun}.`,
      actionTitle: 'Allow microphone',
      action: 'requestMicrophone'
    },
    {
      key: 'inputMonitoring',
      icon: Command,
      title: 'Input Monitoring',
      detail: 'Lets Flowa see when you press the Fn key. Doesn\u2019t read what you type.',
      actionTitle: 'Open Settings',
      action: 'requestInputMonitoring'
    },
    {
      key: 'accessibility',
      icon: ShieldCheck,
      title: linux ? 'Auto-paste' : 'Accessibility',
      detail: linux
        ? 'Lets Flowa paste your transcripts into the focused app with xdotool or wtype. Ctrl+V only — nothing else.'
        : 'Lets Flowa paste your transcripts into the focused app. Cmd+V only — nothing else.',
      actionTitle: linux ? 'How to install' : 'Allow accessibility',
      action: 'requestAccessibility'
    }
  ]
  return all.filter((st) => s.permissions.applicable[st.key])
}

export function OnboardingView({ state: s, onComplete }: { state: AppState; onComplete: () => void }) {
  const list = steps(s)
  const count = list.length
  const countWord = ['zero', 'one', 'two', 'three'][count] ?? String(count)
  const granted = s.allGranted
  const intro =
    count === 0
      ? `Voice dictation that runs entirely on your ${s.machineNoun}.`
      : `Voice dictation that runs entirely on your ${s.machineNoun}. ${count === 1 ? 'One quick permission' : `${countWord[0].toUpperCase()}${countWord.slice(1)} quick permissions`} and you're set.`
  return (
    <div className="screen">
      <div style={{ padding: '28px 28px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AudioWaveform size={21} strokeWidth={2.4} />
          <span style={{ fontSize: 19, fontWeight: 600 }}>Welcome to Flowa</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>{intro}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 22px' }}>
        {list.map((st, i) => {
          const ok = s.permissions[st.key]
          const Icon = st.icon
          return (
            <div
              key={st.key}
              className="card"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: 12,
                boxShadow: `inset 0 0 0 0.5px ${ok ? 'color-mix(in srgb, var(--success) 40%, transparent)' : 'var(--divider)'}`
              }}
            >
              <div
                style={{
                  width: 26, height: 26, borderRadius: 13, marginTop: 2, flex: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: ok ? 'var(--success)' : 'var(--surface-muted)'
                }}
              >
                {ok ? (
                  <Check size={13} strokeWidth={3.5} color="var(--card-bg)" />
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{i + 1}</span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon size={12} strokeWidth={2.2} color="var(--text-tertiary)" />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{st.title}</span>
                </div>
                <div style={{ marginTop: 3, fontSize: 12, color: 'var(--text-secondary)' }}>{st.detail}</div>
              </div>
              {!ok && (
                <button className="btn-bordered" onClick={() => void window.flowa.action(st.action)}>
                  {st.actionTitle}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ flex: 1, minHeight: 12 }} />
      <div style={{ padding: '0 22px 22px' }}>
        <button className="btn-primary" disabled={!granted} onClick={onComplete}>
          {granted ? 'Get started' : count === 3 ? 'Waiting for all three\u2026' : 'Waiting for permissions\u2026'}
        </button>
      </div>
    </div>
  )
}
