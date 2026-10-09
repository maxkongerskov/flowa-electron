// Port of LoginItem (SMAppService.mainApp) from FlowaApp.swift.
// macOS / Windows: app.setLoginItemSettings. Linux: XDG autostart .desktop file.

import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const linuxFile = (): string => path.join(os.homedir(), '.config', 'autostart', 'flowa.desktop')

export function isLoginItemEnabled(): boolean {
  if (process.platform === 'linux') return fs.existsSync(linuxFile())
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

export function setLoginItemEnabled(enabled: boolean): void {
  try {
    if (process.platform === 'linux') {
      if (enabled) {
        const exec = process.env.APPIMAGE || process.execPath
        fs.mkdirSync(path.dirname(linuxFile()), { recursive: true })
        fs.writeFileSync(
          linuxFile(),
          `[Desktop Entry]\nType=Application\nName=Flowa\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`
        )
      } else if (fs.existsSync(linuxFile())) {
        fs.unlinkSync(linuxFile())
      }
      return
    }
    app.setLoginItemSettings({ openAtLogin: enabled })
  } catch (e) {
    console.error('[Flowa] Launch-at-login toggle failed:', e)
  }
}
