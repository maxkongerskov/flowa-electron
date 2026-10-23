import { useEffect, useState } from 'react'
import type { AppState } from '@shared/types'

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    let alive = true
    let seen = 0
    const apply = (s: AppState): void => {
      if (!alive || s.stateRevision < seen) return
      seen = s.stateRevision
      setState(s)
    }
    // Subscribe before the snapshot so a launch-time update push is not lost,
    // and ignore a snapshot that is older than a push that already arrived.
    const off = window.flowa.onState(apply)
    void window.flowa.getState().then(apply)
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
