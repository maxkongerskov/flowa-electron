// Persistence: the Swift app used UserDefaults (prefs) and
// Application Support/Flowa/recent.json. Here: prefs.json + recent.json in userData.

import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { coercePrefs, type Prefs } from '@shared/prefs'
import { decodeRecent, encodeRecent, type Dictation } from '@shared/recent'
import { paths, writeFileAtomic } from './paths'

class PrefsStore extends EventEmitter {
  private data: Prefs | null = null

  get all(): Prefs {
    if (!this.data) {
      let raw: unknown = null
      try {
        raw = JSON.parse(fs.readFileSync(paths.prefs, 'utf8'))
      } catch {
        raw = null
      }
      this.data = coercePrefs(raw, process.platform)
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
    writeFileAtomic(paths.recent, encodeRecent(items))
  } catch (e) {
    console.error('[Flowa] recent write failed', e)
  }
}
