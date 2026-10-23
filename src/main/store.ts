// Persistence: the Swift app used UserDefaults (prefs) and
// Application Support/Flowa/recent.json. Here: prefs.json + recent.json in userData.

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { coercePrefs, PrefKey, type Prefs } from '@shared/prefs'
import { corruptPrefsBackupName, corruptPrefsMessage } from '@shared/prefsRecovery'
import { decodeRecent, encodeRecent, type Dictation } from '@shared/recent'
import { paths, writeFileAtomic } from './paths'

class PrefsStore extends EventEmitter {
  private data: Prefs | null = null
  /** Set when an existing prefs.json could not be parsed. Cleared only by process restart. */
  warning: string | null = null

  get all(): Prefs {
    if (!this.data) {
      let raw: unknown = null
      let hadFile = false
      if (fs.existsSync(paths.prefs)) {
        hadFile = true
        let text = ''
        try {
          text = fs.readFileSync(paths.prefs, 'utf8')
          raw = JSON.parse(text)
        } catch (err) {
          raw = null
          const backup = corruptPrefsBackupName()
          const backupPath = path.join(path.dirname(paths.prefs), backup)
          try {
            fs.copyFileSync(paths.prefs, backupPath)
          } catch (copyErr) {
            console.error('[Flowa] prefs backup failed', copyErr)
          }
          this.warning = corruptPrefsMessage(backup)
          console.error('[Flowa] prefs.json did not parse; reset to defaults', err instanceof Error ? err.message : err)
          try {
            writeFileAtomic(paths.prefs, JSON.stringify(coercePrefs(null, process.platform), null, 2))
          } catch (writeErr) {
            console.error('[Flowa] prefs reset failed', writeErr)
          }
        }
      }
      this.data = coercePrefs(raw, process.platform)
      // Persist a migrated shortcut so an upgrade doesn't keep re-deriving it,
      // and so the 1.1.0 default stays put when the new-install default changes.
      if (hadFile && raw && typeof raw === 'object' && !this.warning) {
        const stored = (raw as Record<string, unknown>)[PrefKey.shortcut]
        if (stored !== this.data[PrefKey.shortcut]) {
          try {
            writeFileAtomic(paths.prefs, JSON.stringify(this.data, null, 2))
          } catch (e) {
            console.error('[Flowa] prefs migrate failed', e)
          }
        }
      }
    }
    return this.data
  }

  get<K extends keyof Prefs>(key: K): Prefs[K] {
    return this.all[key]
  }

  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    const next = { ...this.all, [key]: value }
    this.data = coercePrefs(next, process.platform)
    try {
      writeFileAtomic(paths.prefs, JSON.stringify(this.data, null, 2))
    } catch (e) {
      console.error('[Flowa] prefs write failed', e)
    }
    this.emit('change', key)
  }
}

export const prefs = new PrefsStore()

export function loadRecent(): Dictation[] {
  try {
    return decodeRecent(fs.readFileSync(paths.recent, 'utf8'))
  } catch {
    return []
  }
}

export function saveRecent(items: Dictation[]): void {
  try {
    // Rewrites recent.json. This does not erase copies already in APFS snapshots
    // or Time Machine. Clear is not a secure wipe.
    writeFileAtomic(paths.recent, encodeRecent(items))
  } catch (e) {
    console.error('[Flowa] recent write failed', e)
  }
}
