/** Backup name for a prefs.json that did not parse. The original bytes are copied here before defaults are written. */
export function corruptPrefsBackupName(when: Date = new Date()): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-')
  return `prefs.json.corrupt-${stamp}`
}

export function corruptPrefsMessage(backupFileName: string): string {
  return `Preferences were damaged and have been reset. A copy was saved as ${backupFileName}.`
}
