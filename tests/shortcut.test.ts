import { describe, expect, it } from 'vitest'
import {
  defaultShortcut, initialModWatch, initialRecorder, legacyDefaultShortcut, migratedShortcut, modifierWatchStep,
  recorderStep, shortcutKind, shortcutLabel, shortcutLimitNote, shortcutPresets, supportsModifierShortcut, validateShortcut
} from '@shared/shortcut'

const down = (partial: { key: string; code: string; location?: number; repeat?: boolean }) =>
  recorderStep(initialRecorder(), { type: 'down', location: 0, ...partial }, 'win32')

describe('dictation shortcut', () => {
  it('defaults to fn on macOS and F8 elsewhere; 1.1.0 stays Ctrl+Shift+Space', () => {
    expect(defaultShortcut('darwin')).toBe('fn')
    expect(defaultShortcut('win32')).toBe('F8')
    expect(defaultShortcut('linux')).toBe('F8')
    expect(legacyDefaultShortcut('win32')).toBe('Control+Shift+Space')
    expect(legacyDefaultShortcut('darwin')).toBe('fn')
  })

  it('migrates a missing shortcut on an existing file to the 1.1.0 default', () => {
    expect(migratedShortcut(undefined, true, 'win32')).toBe('Control+Shift+Space')
    expect(migratedShortcut(undefined, true, 'linux')).toBe('Control+Shift+Space')
    expect(migratedShortcut(undefined, true, 'darwin')).toBe('fn')
    expect(migratedShortcut(undefined, false, 'win32')).toBe('F8')
    expect(migratedShortcut('fn', true, 'win32')).toBe('Control+Shift+Space')
    expect(migratedShortcut('F10', true, 'linux')).toBe('F10')
    expect(migratedShortcut('ctrl+shift+space', false, 'win32')).toBe('Control+Shift+Space')
    expect(migratedShortcut('nope', true, 'win32')).toBe('Control+Shift+Space')
    expect(migratedShortcut('RightAlt', true, 'linux')).toBe('Control+Shift+Space')
  })

  it('accepts a single function key and rejects a bare letter', () => {
    expect(validateShortcut('F8', 'win32')).toEqual({ ok: true, shortcut: 'F8', kind: 'accelerator' })
    expect(validateShortcut('f8', 'linux')).toMatchObject({ ok: true, shortcut: 'F8' })
    const letter = validateShortcut('A', 'win32')
    expect(letter.ok).toBe(false)
    if (!letter.ok) expect(letter.message).toMatch(/block typing/)
    expect(validateShortcut('Space', 'darwin').ok).toBe(false)
  })

  it('accepts Right Alt on macOS and Windows and explains the Linux limit', () => {
    expect(validateShortcut('RightAlt', 'win32')).toEqual({ ok: true, shortcut: 'RightAlt', kind: 'modifier' })
    expect(validateShortcut('RightAlt', 'darwin')).toMatchObject({ ok: true, kind: 'modifier' })
    const linux = validateShortcut('RightAlt', 'linux')
    expect(linux.ok).toBe(false)
    if (!linux.ok) expect(linux.message).toMatch(/Linux/)
    expect(supportsModifierShortcut('linux')).toBe(false)
    expect(supportsModifierShortcut('win32')).toBe(true)
    expect(shortcutKind('fn')).toBe('fn')
    expect(shortcutKind('RightAlt')).toBe('modifier')
    expect(shortcutKind('F8')).toBe('accelerator')
  })

  it('rejects shortcuts reserved by the system or by Flowa', () => {
    for (const raw of ['Command+Q', 'Control+Q', 'Command+0', 'Alt+Tab', 'Alt+F4', 'Super+L', 'Command+Space']) {
      const platform = raw.startsWith('Command') ? 'darwin' : 'win32'
      const verdict = validateShortcut(raw, platform)
      expect(verdict.ok, raw).toBe(false)
      if (!verdict.ok) expect(verdict.message).toMatch(/reserved/)
    }
    expect(validateShortcut('Control+Shift+Space', 'win32').ok).toBe(true)
    expect(validateShortcut('fn', 'win32').ok).toBe(false)
    expect(validateShortcut('fn', 'darwin')).toEqual({ ok: true, shortcut: 'fn', kind: 'fn' })
  })

  it('labels keys the way the menu and the home row show them', () => {
    expect(shortcutLabel('fn', 'darwin')).toBe('fn')
    expect(shortcutLabel('F8', 'win32')).toBe('F8')
    expect(shortcutLabel('RightAlt', 'win32')).toBe('Right Alt')
    expect(shortcutLabel('RightAlt', 'darwin')).toBe('Right ⌥')
    expect(shortcutLabel('Control+Shift+Space', 'win32')).toBe('Ctrl+Shift+Space')
    expect(shortcutLabel('Control+Shift+Space', 'darwin')).toBe('⌃⇧Space')
    expect(shortcutPresets('linux').some((p) => p.shortcut === 'RightAlt')).toBe(false)
    expect(shortcutPresets('win32').some((p) => p.shortcut === 'RightAlt')).toBe(true)
    expect(shortcutLimitNote('linux')).toMatch(/Wayland/)
    expect(shortcutLimitNote('win32')).toMatch(/Right Alt/)
    expect(shortcutLimitNote('darwin')).toMatch(/Input Monitoring/)
  })

  it('records F8, a chord, and Right Alt, and cancels on Escape', () => {
    const f8 = recorderStep(initialRecorder(), { type: 'down', key: 'F8', code: 'F8' }, 'win32')
    expect(f8.shortcut).toBe('F8')

    let state = initialRecorder()
    state = recorderStep(state, { type: 'down', key: 'Control', code: 'ControlLeft', location: 1 }, 'win32').state
    state = recorderStep(state, { type: 'down', key: 'Shift', code: 'ShiftLeft', location: 1 }, 'win32').state
    const chord = recorderStep(state, { type: 'down', key: ' ', code: 'Space' }, 'win32')
    expect(chord.shortcut).toBe('Control+Shift+Space')

    const altDown = recorderStep(initialRecorder(), { type: 'down', key: 'Alt', code: 'AltRight', location: 2 }, 'win32')
    const altUp = recorderStep(altDown.state, { type: 'up', key: 'Alt', code: 'AltRight', location: 2 }, 'win32')
    expect(altUp.shortcut).toBe('RightAlt')

    const cancel = down({ key: 'Escape', code: 'Escape' })
    expect(cancel.cancelled).toBe(true)
    expect(cancel.shortcut).toBeUndefined()
  })

  it('treats Windows AltGr as Right Alt and does not toggle when another key is held', () => {
    let state = initialRecorder()
    state = recorderStep(state, { type: 'down', key: 'Control', code: 'ControlLeft', location: 1 }, 'win32').state
    state = recorderStep(state, { type: 'down', key: 'AltGraph', code: 'AltRight', location: 2 }, 'win32').state
    const up = recorderStep(state, { type: 'up', key: 'AltGraph', code: 'AltRight', location: 2 }, 'win32')
    expect(up.shortcut).toBe('RightAlt')

    const held = recorderStep(initialRecorder(), { type: 'down', key: 'A', code: 'KeyA' }, 'linux')
    expect(held.shortcut).toBeUndefined()
    expect(held.message).toMatch(/block typing/)

    const two = (() => {
      let s = initialRecorder()
      s = recorderStep(s, { type: 'down', key: 'Control', code: 'ControlLeft', location: 1 }, 'win32').state
      s = recorderStep(s, { type: 'down', key: 'Shift', code: 'ShiftLeft', location: 1 }, 'win32').state
      s = recorderStep(s, { type: 'up', key: 'Control', code: 'ControlLeft', location: 1 }, 'win32').state
      return recorderStep(s, { type: 'up', key: 'Shift', code: 'ShiftLeft', location: 1 }, 'win32')
    })()
    expect(two.shortcut).toBeUndefined()
    expect(two.message).toMatch(/one modifier/)
  })

  it('fires a modifier tap once, and not when it is used in a chord', () => {
    let state = initialModWatch()
    let step = modifierWatchStep(state, 'mod-down RightAlt', 'RightAlt')
    step = modifierWatchStep(step.state, 'mod-up RightAlt', 'RightAlt')
    expect(step.fire).toBe(true)

    state = initialModWatch()
    step = modifierWatchStep(state, 'mod-down RightAlt', 'RightAlt')
    step = modifierWatchStep(step.state, 'key', 'RightAlt')
    step = modifierWatchStep(step.state, 'mod-up RightAlt', 'RightAlt')
    expect(step.fire).toBe(false)

    state = initialModWatch()
    step = modifierWatchStep(state, 'mod-down LeftAlt', 'Alt')
    step = modifierWatchStep(step.state, 'mod-up LeftAlt', 'Alt')
    expect(step.fire).toBe(true)

    state = initialModWatch()
    step = modifierWatchStep(state, 'mod-down RightAlt', 'RightAlt')
    step = modifierWatchStep(step.state, 'mod-down LeftControl', 'RightAlt')
    step = modifierWatchStep(step.state, 'mod-up RightAlt', 'RightAlt')
    expect(step.fire).toBe(false)
  })
})
