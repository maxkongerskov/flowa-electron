import { useEffect, useState } from 'react'
import type { AppState } from '@shared/types'

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    let alive = true
    void window.flowa.getState().then((s) => alive && setState(s))
    const off = window.flowa.onState((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  useEffect(() => {
    if (state) document.documentElement.classList.toggle('dark', state.prefs['flowa.colorScheme.dark'])
  }, [state?.prefs['flowa.colorScheme.dark']])
  return state
}
