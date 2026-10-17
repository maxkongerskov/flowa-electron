// Tray + application menu entries for the dictation shortcut.
// The native menu can't capture an arbitrary chord, so "Record Shortcut…"
// opens the settings recorder. Presets and reset apply immediately.

import type { MenuItemConstructorOptions } from 'electron'
import { defaultShortcut, shortcutLabel, shortcutPresets } from '@shared/shortcut'

export function dictationShortcutMenu(opts: {
  current: string
  platform: string
  onSelect: (shortcut: string) => void
  onRecord: () => void
  onReset: () => void
}): MenuItemConstructorOptions {
  const presets = shortcutPresets(opts.platform)
  const known = new Set(presets.map((p) => p.shortcut))
  const items: MenuItemConstructorOptions[] = []
  if (opts.current && !known.has(opts.current)) {
    items.push({
      label: shortcutLabel(opts.current, opts.platform),
      type: 'radio',
      checked: true,
      click: () => opts.onSelect(opts.current)
    })
  }
  for (const preset of presets) {
    items.push({
      label: preset.label,
      type: 'radio',
      checked: preset.shortcut === opts.current,
      click: () => opts.onSelect(preset.shortcut)
    })
  }
  const fallback = shortcutLabel(defaultShortcut(opts.platform), opts.platform)
  items.push(
    { type: 'separator' },
    { label: 'Record Shortcut…', click: () => opts.onRecord() },
    { label: `Reset to ${fallback}`, click: () => opts.onReset() }
  )
  return { label: 'Dictation Shortcut', submenu: items }
}
