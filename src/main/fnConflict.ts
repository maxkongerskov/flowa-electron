// Port of Flowa/Hotkey/FnConflictDetector.swift: reads
// com.apple.HIToolbox AppleFnUsageType every 2 s ("Press 🌐 key to").
// Only meaningful on macOS while the fn key is the shortcut.

import { EventEmitter } from 'node:events'
import type { ConflictStatus } from '@shared/types'
import { fnConflictFromRaw } from '@shared/status'
import { run } from './proc'
import { prefs } from './store'
import { FN_SHORTCUT, PrefKey } from '@shared/prefs'

class FnConflictDetector extends EventEmitter {
  status: ConflictStatus = { kind: 'unknown' }
  private timer: NodeJS.Timeout | null = null

  start(): void {
    void this.check()
    this.timer = setInterval(() => void this.check(), 2000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async check(): Promise<void> {
    let next: ConflictStatus
    if (process.platform !== 'darwin' || prefs.get(PrefKey.shortcut) !== FN_SHORTCUT) {
      next = { kind: 'clean' }
    } else {
      const r = await run('/usr/bin/defaults', ['read', 'com.apple.HIToolbox', 'AppleFnUsageType'], 3000)
      next = r.code === 0 ? fnConflictFromRaw(r.stdout) : { kind: 'unknown' }
    }
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next
      this.emit('change')
    }
  }
}

export const fnConflict = new FnConflictDetector()
