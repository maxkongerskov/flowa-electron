// Port of Flowa/Onboarding/InstallingView.swift.
import { useEffect, useRef, useState } from 'react'
import { AudioWaveform, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { AppState } from '@shared/types'
import { countdownText, formatBytes } from '@shared/status'

export function tips(noun: string, key: string, mac: boolean): string[] {
  return [
    `Press ${key} to start listening, speak, then press ${key} again — your words land where the cursor is.`,
    `Everything runs on this ${noun}. Your audio never leaves the machine.`,
    'Works in Notes, Mail, chat apps, browsers, and code editors.',
    mac && key === 'fn'
      ? 'In Keyboard settings, set \u201CPress \uD83C\uDF10 key to\u201D to Do Nothing so fn stays free for Flowa.'
      : 'You can change the shortcut anytime from Home.',
    'You can switch languages anytime from Home — Flowa keeps up mid-sentence.',
    `Recent dictations stay on this ${noun} so you can copy them later.`
  ]
}

export function InstallingView({ state: s }: { state: AppState }) {
  const t = s.transcriber
  const [tipIndex, setTipIndex] = useState(0)
  const all = tips(s.machineNoun, s.shortcut.label, s.platform === 'darwin')
  const kicked = useRef(false)

  useEffect(() => {
    const id = setInterval(() => {
      if (t.kind !== 'error') setTipIndex((i) => (i + 1) % all.length)
    }, 5500)
    return () => clearInterval(id)
  }, [t.kind, all.length])

  // onAppear: .idle → retry()
  useEffect(() => {
    if (!kicked.current && t.kind === 'idle') {
      kicked.current = true
      void window.flowa.action('retryInstall')
    }
  }, [t.kind])

  const title = t.kind === 'error' ? 'Finish setup' : 'Installing Flowa'

  return (
    <div className="screen">
      <div style={{ padding: '28px 28px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AudioWaveform size={21} strokeWidth={2.4} />
          <span style={{ fontSize: 19, fontWeight: 600 }}>{title}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          Flowa is setting up speech recognition for this {s.machineNoun}. This only happens once.
        </div>
      </div>

      <div style={{ padding: '0 22px' }}>
        {t.kind === 'error' ? (
          <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TriangleAlert size={14} color="var(--warning)" fill="var(--warning)" stroke="var(--card-bg)" />
              <span style={{ fontSize: 13, fontWeight: 600 }}>Installation couldn't finish</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t.message}</div>
            <div>
              <button
                onClick={() => void window.flowa.action('retryInstall')}
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--card-bg)', background: 'var(--accent)', padding: '8px 16px', borderRadius: 8, marginTop: 2 }}
              >
                Try again
              </button>
            </div>
          </div>
        ) : t.kind === 'downloading' ? (
          <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="progress"><div style={{ width: `${t.total ? (100 * t.received) / t.total : 0}%` }} /></div>
            <div style={{ display: 'flex', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Downloading the speech engine (one time)</span>
              <span style={{ flex: 1 }} />
              <span className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>
                {formatBytes(t.received)} / {formatBytes(t.total)}
              </span>
            </div>
          </div>
        ) : (
          <InstallingCard progress={t.kind === 'preparing' ? t.progress : t.kind === 'idle' ? 0 : 0.95} />
        )}
      </div>

      <div style={{ padding: '14px 22px 0' }}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>While you wait</div>
          <div key={tipIndex} className="tip" style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            {all[tipIndex % all.length]}
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <div style={{ padding: '0 28px 22px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}>
        <ShieldCheck size={12} color="var(--text-tertiary)" />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          Works offline. No audio leaves your {s.machineNoun}.
        </span>
      </div>
    </div>
  )
}

function InstallingCard({ progress }: { progress: number }) {
  const clamped = Math.min(1, Math.max(0, progress))
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="progress"><div style={{ width: `${clamped * 100}%` }} /></div>
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Approximately 2 minutes to install</span>
        <span style={{ flex: 1 }} />
        <span className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>{countdownText(clamped)}</span>
      </div>
    </div>
  )
}
