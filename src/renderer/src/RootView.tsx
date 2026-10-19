// Port of Flowa/RootView.swift — routes between three top-level views:
//   ① OnboardingView — until all permissions are granted
//   ② InstallingView — one-time engine prepare (+ first-run download here)
//   ③ HomeView       — main app; banners surface revoked permissions.

import { parakeetModelId } from '@shared/speech'
import { useAppState } from './useAppState'
import { OnboardingView } from './views/OnboardingView'
import { InstallingView } from './views/InstallingView'
import { HomeView } from './views/HomeView'

export function RootView() {
  const s = useAppState()
  if (!s) return null
  const shouldShowOnboarding = !s.prefs['flowa.onboardingComplete'] && !s.allGranted
  // Parakeet can be missing while Whisper Turbo is one dropdown away, so that
  // setup stays on Home (yellow note + Download) instead of the install screen.
  const shouldShowInstalling = s.needsSetup && s.prefs['flowa.speechModel'] !== parakeetModelId
  if (shouldShowOnboarding) {
    return <OnboardingView key="onboarding" state={s} onComplete={() => window.flowa.setPref('flowa.onboardingComplete', true)} />
  }
  if (shouldShowInstalling) return <InstallingView key="installing" state={s} />
  return <HomeView key="home" state={s} />
}
