// Port of Flowa/Sections/HomeChrome.swift (RecentRow, LanguagePicker, StatusPill, DarkModeToggle).
import { useEffect, useRef, useState } from 'react'
import { Check, CircleX, Copy, Moon, Search, Sun } from 'lucide-react'
import type { Dictation } from '@shared/recent'
import { filterLanguages } from '@shared/languages'

export function RecentRow({ dictation, metaText }: { dictation: Dictation; metaText: string }) {
  const [copied, setCopied] = useState(false)
  const [hovering, setHovering] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 0' }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontSize: 13, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', userSelect: 'text' }}>
          {'\u201C'}{dictation.text}{'\u201D'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{metaText}</div>
      </div>
      <button
        className="icon-btn"
        title={copied ? 'Copied' : 'Copy to clipboard'}
        onClick={() => {
          void window.flowa.action('copyText', dictation.text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}
        style={{
          width: 24, height: 24, borderRadius: 6, flex: 'none',
          background: hovering || copied ? 'var(--surface-muted)' : 'transparent',
          color: copied ? 'var(--success)' : 'var(--text-tertiary)'
        }}
      >
        {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
      </button>
    </div>
  )
}

export function LanguagePicker(props: { selected: string; onSelect: (code: string) => void; onClose: () => void; style?: React.CSSProperties }) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const matches = filterLanguages(query)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) props.onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [props])
  return (
    <div className="popover" ref={box} style={props.style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--card-bg)' }}>
        <Search size={12} strokeWidth={2.6} color="var(--text-tertiary)" />
        <input
          ref={input}
          className="plain-input"
          style={{ flex: 1, fontSize: 13 }}
          placeholder="Search languages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) props.onSelect(matches[0].code)
          }}
        />
        {query && (
          <button className="icon-btn" onClick={() => setQuery('')} style={{ color: 'var(--text-tertiary)' }}>
            <CircleX size={12} fill="var(--text-tertiary)" stroke="var(--card-bg)" />
          </button>
        )}
      </div>
      <div className="hairline" />
      <div className="scroll" style={{ maxHeight: 320, background: 'var(--card-bg)' }}>
        {matches.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '18px 0', textAlign: 'center' }}>No matches</div>
        ) : (
          matches.map((opt) => (
            <button
              key={opt.code}
              className="lang-row"
              onClick={() => props.onSelect(opt.code)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', textAlign: 'left' }}
            >
              <span style={{ fontSize: 13, flex: 1 }}>{opt.displayName}</span>
              {opt.code === props.selected && <Check size={12} strokeWidth={3} color="var(--accent)" />}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export function StatusPill({ isReady }: { isReady: boolean }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999,
        background: 'var(--card-bg)', boxShadow: 'inset 0 0 0 0.5px var(--divider)'
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: isReady ? 'var(--success)' : 'var(--warning)' }} />
      <span style={{ fontSize: 12, fontWeight: 500 }}>{isReady ? 'Ready' : 'Setup needed'}</span>
    </div>
  )
}

export function DarkModeToggle({ isOn, onChange }: { isOn: boolean; onChange: (v: boolean) => void }) {
  const seg = (active: boolean, Icon: typeof Sun, v: boolean) => (
    <button
      className="icon-btn"
      onClick={() => onChange(v)}
      style={{
        width: 20, height: 16, borderRadius: 8,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? 'var(--card-bg)' : 'var(--text-tertiary)'
      }}
    >
      <Icon size={10} strokeWidth={2.5} fill="currentColor" />
    </button>
  )
  return (
    <div style={{ display: 'flex', padding: 2, borderRadius: 999, background: 'var(--card-bg)', boxShadow: 'inset 0 0 0 0.5px var(--divider)' }}>
      {seg(!isOn, Sun, false)}
      {seg(isOn, Moon, true)}
    </div>
  )
}
