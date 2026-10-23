// Settings recorder: click Change, press the keys you want. Escape cancels.
// A function key (F8) or a chord is taken on keydown. A modifier by itself
// (Right Alt, Right Option, fn) is taken when it is released alone.
import { useEffect, useRef, useState } from 'react'
import { defaultShortcut, initialRecorder, recorderStep, shortcutLabel } from '@shared/shortcut'

export function ShortcutField(props: {
  label: string
  usesFn: boolean
  platform: string
  recordNonce: number
}) {
  const [recording, setRecording] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const mac = props.platform === 'darwin'
  const seenNonce = useRef(props.recordNonce)
  const recorder = useRef(initialRecorder())
  const saving = useRef(false)

  useEffect(() => {
    const openFromNonce = (): void => {
      if (document.visibilityState === 'hidden') {
        setRecording(false)
        return
      }
      // Ignore the nonce that was already set when this field mounted.
      if (seenNonce.current === props.recordNonce) return
      seenNonce.current = props.recordNonce
      recorder.current = initialRecorder()
      setMessage(null)
      setRecording(true)
    }
    openFromNonce()
    document.addEventListener('visibilitychange', openFromNonce)
    return () => document.removeEventListener('visibilitychange', openFromNonce)
  }, [props.recordNonce])

  useEffect(() => {
    if (!recording) return
    let remove = (): void => {}
    let cancelled = false
    const onKey = (type: 'down' | 'up') => (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (saving.current) return
      const step = recorderStep(
        recorder.current,
        { type, key: e.key, code: e.code, location: e.location, repeat: e.repeat },
        props.platform
      )
      recorder.current = step.state
      if (step.cancelled) {
        setRecording(false)
        return
      }
      if (step.message) setMessage(step.message)
      if (!step.shortcut) return
      const chosen = step.shortcut
      setMessage(null)
      saving.current = true
      void window.flowa.setPref('flowa.shortcut', chosen).then((result) => {
        saving.current = false
        const verdict = result as { ok?: boolean; message?: string } | undefined
        if (verdict && verdict.ok === false) {
          setMessage(verdict.message || 'That shortcut could not be used.')
          recorder.current = initialRecorder()
          return
        }
        setRecording(false)
      })
    }
    const down = onKey('down')
    const up = onKey('up')
    void (async () => {
      await window.flowa.action('suspendShortcut')
      if (cancelled) {
        await window.flowa.action('resumeShortcut')
        return
      }
      window.addEventListener('keydown', down, true)
      window.addEventListener('keyup', up, true)
      remove = () => {
        window.removeEventListener('keydown', down, true)
        window.removeEventListener('keyup', up, true)
      }
    })()
    return () => {
      cancelled = true
      remove()
      void window.flowa.action('resumeShortcut')
    }
  }, [recording, props.platform])

  const reset = (): void => {
    setMessage(null)
    setRecording(false)
    void window.flowa.setPref('flowa.shortcut', defaultShortcut(props.platform))
  }

  if (recording) {
    return (
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, padding: '6px 0' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Press the keys you want…</span>
          {mac && !props.usesFn && (
            <button className="btn-bordered" onClick={() => { setRecording(false); void window.flowa.setPref('flowa.shortcut', 'fn') }}>
              Use fn
            </button>
          )}
          <button className="btn-bordered" onClick={() => setRecording(false)}>Cancel</button>
        </span>
        {message && <span style={{ fontSize: 11, color: 'var(--warning)', textAlign: 'right', maxWidth: 280 }}>{message}</span>}
      </span>
    )
  }

  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button title="Click to change" onClick={() => { recorder.current = initialRecorder(); setMessage(null); setRecording(true) }} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Press {props.label} to toggle
        </button>
        <button className="btn-bordered" onClick={() => { recorder.current = initialRecorder(); setMessage(null); setRecording(true) }}>Change</button>
        <button className="btn-bordered" title={`Reset to ${shortcutLabel(defaultShortcut(props.platform), props.platform)}`} onClick={reset}>Reset</button>
      </span>
      {message && <span style={{ fontSize: 11, color: 'var(--warning)', textAlign: 'right', maxWidth: 280 }}>{message}</span>}
    </span>
  )
}
