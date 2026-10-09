// Port of Flowa/Permissions/PermissionChecker.swift.
//
// macOS: the same three TCC permissions (Microphone, Input Monitoring, Accessibility).
// Windows: only the microphone privacy switch exists; the other two are implicitly granted.
// Linux: no TCC; "Accessibility" maps to "an auto-paste tool is installed"
//        (xdotool on X11, wtype or ydotool on Wayland).

import { shell, systemPreferences } from 'electron'
import { EventEmitter } from 'node:events'
import type { PermissionsState } from '@shared/types'
import { helper, macHelperAvailable } from './macHelper'
import { commandExists } from './proc'
import { prefs } from './store'
import { PrefKey, FN_SHORTCUT } from '@shared/prefs'

export function linuxPasteTool(): string | null {
  const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland'
  const order = wayland ? ['wtype', 'ydotool', 'xdotool'] : ['xdotool', 'ydotool']
  for (const t of order) if (commandExists(t)) return t
  return null
}

class PermissionChecker extends EventEmitter {
  state: PermissionsState = {
    microphone: false,
    inputMonitoring: false,
    accessibility: false,
    applicable: { microphone: true, inputMonitoring: false, accessibility: false },
    pasteTool: null
  }
  private timer: NodeJS.Timeout | null = null
  private linuxToolCheckedAt = 0

  start(): void {
    void this.check()
    this.timer = setInterval(() => void this.check(), 2000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get allGranted(): boolean {
    return this.state.microphone && this.state.inputMonitoring && this.state.accessibility
  }

  async check(): Promise<void> {
    const next: PermissionsState = { ...this.state, applicable: { ...this.state.applicable } }
    if (process.platform === 'darwin') {
      next.microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted'
      next.accessibility = systemPreferences.isTrustedAccessibilityClient(false)
      const usesFn = prefs.get(PrefKey.shortcut) === FN_SHORTCUT
      next.applicable = { microphone: true, inputMonitoring: usesFn, accessibility: true }
      if (usesFn && macHelperAvailable()) {
        const r = await helper(['check-im'])
        next.inputMonitoring = r.out === 'granted'
      } else {
        // A plain accelerator (globalShortcut) needs no Input Monitoring.
        next.inputMonitoring = !usesFn
      }
    } else if (process.platform === 'win32') {
      const s = systemPreferences.getMediaAccessStatus('microphone')
      next.microphone = s === 'granted' || s === 'not-determined' || s === 'unknown'
      next.inputMonitoring = true
      next.accessibility = true
      next.applicable = { microphone: true, inputMonitoring: false, accessibility: false }
    } else {
      next.microphone = true
      next.inputMonitoring = true
      const now = Date.now()
      if (now - this.linuxToolCheckedAt > 10_000) {
        next.pasteTool = linuxPasteTool()
        this.linuxToolCheckedAt = now
      }
      next.accessibility = !!next.pasteTool
      next.applicable = { microphone: false, inputMonitoring: false, accessibility: true }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.state)
    this.state = next
    if (changed) this.emit('change')
  }

  /** Microphone — system prompt when not determined; otherwise Settings. */
  async requestMicrophone(): Promise<void> {
    if (process.platform === 'darwin') {
      const s = systemPreferences.getMediaAccessStatus('microphone')
      if (s === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
      else openPrivacy('Privacy_Microphone')
    } else if (process.platform === 'win32') {
      void shell.openExternal('ms-settings:privacy-microphone')
    }
    await this.check()
  }

  /** Input Monitoring — IOHIDRequestAccess prompt once, then open Settings. */
  async requestInputMonitoring(): Promise<void> {
    if (process.platform !== 'darwin') return
    if (macHelperAvailable()) await helper(['request-im'])
    openPrivacy('Privacy_ListenEvent')
    await this.check()
  }

  /** Accessibility — prompt once, then open Settings as a reliable path. */
  async requestAccessibility(): Promise<void> {
    if (process.platform === 'darwin') {
      systemPreferences.isTrustedAccessibilityClient(true)
      openPrivacy('Privacy_Accessibility')
    }
    this.linuxToolCheckedAt = 0
    await this.check()
  }
}

export function openPrivacy(section: string): void {
  void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${section}`)
}

export function openKeyboardSettings(): void {
  if (process.platform === 'darwin') {
    void shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')
  }
}

export const permissions = new PermissionChecker()
