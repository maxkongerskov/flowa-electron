// Electron-only: the Swift app is fixed to fn. Here the row still reads
// "Press fn to toggle" on macOS, and on every OS you can click it to record
// another shortcut (needed on Windows/Linux where there is no fn key).
import { useEffect, useState } from 'react'

const named: Record<string, string> = {
  ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Return', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete'
}

export function acceleratorFromEvent(e: KeyboardEvent, mac: boolean): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'Fn', 'CapsLock'].includes(e.key)) return null
  const mods: string[] = []
  if (e.metaKey) mods.push(mac ? 'Command' : 'Super')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let key = named[e.key] ?? ''
  if (!key) {
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
    else if (/^F\d{1,2}$/.test(e.key)) key = e.key
    else return null
  }
  // Require a modifier unless it's a function key (avoid hijacking normal typing).
  if (mods.length === 0 && !/^F\d{1,2}$/.test(key)) return null
  return [...mods, key].join('+')
}

export function ShortcutField(props: { label: string; usesFn: boolean; platform: string }) {
  const [recording, setRecording] = useState(false)
  const mac = props.platform === 'darwin'
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      if (e.key === 'Escape') return setRecording(false)
      const acc = acceleratorFromEvent(e, mac)
      if (acc) {
        setRecording(false)
        void window.flowa.setPref('flowa.shortcut', acc)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, mac])

  if (recording) {
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Type a shortcut…</span>
        {mac && !props.usesFn && (
          <button className="btn-bordered" onClick={() => { setRecording(false); void window.flowa.setPref('flowa.shortcut', 'fn') }}>
            Use fn
          </button>
        )}
        <button className="btn-bordered" onClick={() => setRecording(false)}>Cancel</button>
      </span>
    )
  }
  return (
    <button title="Click to change" onClick={() => setRecording(true)} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
      Press {props.label} to toggle
    </button>
  )
}
