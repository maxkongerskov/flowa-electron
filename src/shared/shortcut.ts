// Dictation shortcut: one canonical string stored in flowa.shortcut.
//
// Two registration mechanisms (see src/main/hotkey.ts):
//   accelerator — Electron globalShortcut. A single non-typing key (F8, media
//     keys) or a modifier plus a key. Works on macOS, Windows, and Linux X11.
//     globalShortcut cannot register a modifier by itself.
//   modifier / fn — a native listen-only hook that toggles when that key is
//     tapped alone (a chord such as AltGr or Ctrl+C does not toggle):
//       macOS  flowa-helper CGEventTap (Input Monitoring), including fn
//       Windows WH_KEYBOARD_LL via resources/win/modifier-hook.ps1
//       Linux  not available — XGrabKey / globalShortcut need a real key
//
// There is no hold-to-talk mode. One press starts, the next press stops.
// Holding the key is one press (fn already worked this way; globalShortcut
// repeats are ignored; a modifier fires once on release).

export const FN_SHORTCUT = 'fn'

/** What 1.1.0 registered on Windows and Linux. Kept for upgrades. */
export const LEGACY_WIN_LINUX_SHORTCUT = 'Control+Shift+Space'

export type ShortcutKind = 'fn' | 'modifier' | 'accelerator'

export type ShortcutVerdict =
  | { ok: true; shortcut: string; kind: ShortcutKind }
  | { ok: false; message: string }

const MODIFIER_ONLY = new Set([
  'fn',
  'RightAlt', 'LeftAlt', 'Alt',
  'RightControl', 'LeftControl', 'Control',
  'RightShift', 'LeftShift', 'Shift',
  'RightMeta', 'LeftMeta', 'Meta', 'Super', 'Command'
])

const SINGLE_KEYS = new Set<string>([
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop',
  'VolumeUp', 'VolumeDown', 'VolumeMute',
  'PrintScreen', 'Scrolllock', 'Numlock'
])

const CHORD_KEYS = new Set<string>([
  ...SINGLE_KEYS,
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  'Space', 'Tab', 'Capslock', 'Backspace', 'Delete', 'Insert', 'Return',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
  'Plus', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`',
  ...Array.from({ length: 10 }, (_, i) => `num${i}`),
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'
])

const RESERVED = new Set([
  // Flowa's own Show / Quit accelerators.
  'Command+Q', 'Control+Q', 'Super+Q',
  'Command+0', 'Control+0', 'Super+0',
  // System chords globalShortcut cannot take, or that would break the OS.
  'Command+Tab', 'Command+Space', 'Command+Alt+Escape',
  'Alt+Tab', 'Alt+F4', 'Alt+Escape',
  'Super+L', 'Control+Escape', 'Control+Alt+Delete'
])

const MOD_ALIAS: Record<string, string> = {
  fn: 'fn',
  cmd: 'command', command: 'command',
  commandorcontrol: 'commandorcontrol', cmdorctrl: 'commandorcontrol',
  ctrl: 'control', control: 'control',
  option: 'alt', alt: 'alt', altgr: 'altgr',
  shift: 'shift',
  super: 'super', meta: 'meta', win: 'super',
  rightalt: 'rightalt', leftalt: 'leftalt',
  rightoption: 'rightalt', leftoption: 'leftalt',
  rightcontrol: 'rightcontrol', leftcontrol: 'leftcontrol',
  rightctrl: 'rightcontrol', leftctrl: 'leftcontrol',
  rightshift: 'rightshift', leftshift: 'leftshift',
  rightmeta: 'rightmeta', leftmeta: 'leftmeta',
  rightsuper: 'rightmeta', leftsuper: 'leftmeta',
  rightcommand: 'rightmeta', leftcommand: 'leftmeta',
  rightcmd: 'rightmeta', leftcmd: 'leftmeta'
}

const KEY_ALIAS: Record<string, string> = {
  space: 'Space', esc: 'Escape', escape: 'Escape',
  return: 'Return', enter: 'Return', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  plus: 'Plus', minus: '-', equal: '=',
  printscreen: 'PrintScreen', scrolllock: 'Scrolllock', numlock: 'Numlock',
  capslock: 'Capslock',
  mediaplaypause: 'MediaPlayPause',
  medianexttrack: 'MediaNextTrack', mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  volumeup: 'VolumeUp', volumedown: 'VolumeDown', volumemute: 'VolumeMute',
  numdec: 'numdec', numadd: 'numadd', numsub: 'numsub', nummult: 'nummult', numdiv: 'numdiv'
}

/** New installs. macOS keeps fn (one key, same as the Swift app). */
export function defaultShortcut(platform: NodeJS.Platform | string): string {
  return platform === 'darwin' ? FN_SHORTCUT : 'F8'
}

/** The shortcut 1.1.0 was already using, for people upgrading. */
export function legacyDefaultShortcut(platform: NodeJS.Platform | string): string {
  return platform === 'darwin' ? FN_SHORTCUT : LEGACY_WIN_LINUX_SHORTCUT
}

export function supportsModifierShortcut(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32'
}

export function shortcutKind(shortcut: string): ShortcutKind {
  if (shortcut === FN_SHORTCUT) return 'fn'
  if (MODIFIER_ONLY.has(shortcut)) return 'modifier'
  return 'accelerator'
}

/** macOS Input Monitoring is required for fn and for a modifier tapped alone. */
export function needsInputMonitoring(shortcut: string, platform: string): boolean {
  if (platform !== 'darwin') return false
  const kind = shortcutKind(shortcut)
  return kind === 'fn' || kind === 'modifier'
}

/**
 * Fill in flowa.shortcut for a prefs blob.
 * A saved valid shortcut is kept. `fn` on Windows/Linux was never registered
 * (1.1.0 silently used Ctrl+Shift+Space) so it migrates to that.
 * A missing shortcut on an otherwise existing file keeps the 1.1.0 default.
 * A brand-new file gets defaultShortcut().
 */
export function migratedShortcut(stored: unknown, hasOtherPrefs: boolean, platform: string): string {
  const fresh = defaultShortcut(platform)
  const legacy = legacyDefaultShortcut(platform)
  const fallback = hasOtherPrefs ? legacy : fresh
  if (typeof stored !== 'string' || !stored.trim()) return fallback
  const trimmed = stored.trim()
  if (trimmed === FN_SHORTCUT && platform !== 'darwin') return legacy
  const verdict = validateShortcut(trimmed, platform)
  return verdict.ok ? verdict.shortcut : fallback
}

export function validateShortcut(raw: string, platform: string): ShortcutVerdict {
  const text = raw.trim()
  if (!text || text.length > 64) return { ok: false, message: 'Press a key to use as the shortcut.' }
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 5) {
    return { ok: false, message: 'Use one key, with or without modifiers.' }
  }

  if (parts.length === 1) {
    const only = parts[0].toLowerCase()
    const mod = MOD_ALIAS[only]
    if (mod) return finishModifier(canonicalModifier(mod, platform), platform)
    const key = canonicalKey(parts[0])
    if (!key) return { ok: false, message: "That key can't be used as a shortcut." }
    if (!SINGLE_KEYS.has(key)) {
      return { ok: false, message: bareKeyMessage(platform) }
    }
    return finishAccelerator(key)
  }

  const key = canonicalKey(parts[parts.length - 1])
  if (!key || !CHORD_KEYS.has(key)) {
    return { ok: false, message: "That key can't be used as a shortcut." }
  }
  const mods: string[] = []
  for (const part of parts.slice(0, -1)) {
    const alias = MOD_ALIAS[part.toLowerCase()]
    if (!alias || alias === 'fn') {
      return {
        ok: false,
        message: alias === 'fn'
          ? "The fn key can't be combined. Tap fn by itself, or use a shortcut without fn."
          : "That key can't be used as a shortcut."
      }
    }
    const generic = genericChordModifier(alias, platform)
    if (!mods.includes(generic)) mods.push(generic)
  }
  const ordered = orderModifiers(mods, platform)
  return finishAccelerator([...ordered, key].join('+'))
}

function finishModifier(token: string, platform: string): ShortcutVerdict {
  if (token === 'fn') {
    if (platform !== 'darwin') return { ok: false, message: 'The fn key only works on macOS.' }
    return { ok: true, shortcut: 'fn', kind: 'fn' }
  }
  if (!supportsModifierShortcut(platform)) {
    return {
      ok: false,
      message: "Linux can't use a modifier by itself. Press F8, or a combination such as Ctrl+Shift+Space."
    }
  }
  return { ok: true, shortcut: token, kind: 'modifier' }
}

function finishAccelerator(shortcut: string): ShortcutVerdict {
  if (RESERVED.has(shortcut)) {
    return { ok: false, message: 'That shortcut is reserved by the system or by Flowa. Choose another key.' }
  }
  return { ok: true, shortcut, kind: 'accelerator' }
}

function bareKeyMessage(platform: string): string {
  if (platform === 'linux') {
    return "That key by itself would block typing. Use F8, or add Ctrl, Alt, or Shift."
  }
  if (platform === 'darwin') {
    return 'That key by itself would block typing. Use F8, Right Option, fn, or add a modifier.'
  }
  return 'That key by itself would block typing. Use F8, Right Alt, or add Ctrl, Alt, or Shift.'
}

function canonicalModifier(alias: string, platform: string): string {
  switch (alias) {
    case 'fn': return 'fn'
    case 'rightalt': return 'RightAlt'
    case 'leftalt': return 'LeftAlt'
    case 'alt':
    case 'altgr': return 'Alt'
    case 'rightcontrol': return 'RightControl'
    case 'leftcontrol': return 'LeftControl'
    case 'control': return 'Control'
    case 'rightshift': return 'RightShift'
    case 'leftshift': return 'LeftShift'
    case 'shift': return 'Shift'
    case 'rightmeta': return 'RightMeta'
    case 'leftmeta': return 'LeftMeta'
    case 'command': return platform === 'darwin' ? 'Command' : 'Super'
    case 'meta':
    case 'super': return platform === 'darwin' ? 'Command' : 'Super'
    case 'commandorcontrol': return platform === 'darwin' ? 'Command' : 'Control'
    default: return 'Alt'
  }
}

function genericChordModifier(alias: string, platform: string): string {
  if (alias === 'rightalt' || alias === 'leftalt' || alias === 'alt' || alias === 'altgr') return 'Alt'
  if (alias === 'rightcontrol' || alias === 'leftcontrol' || alias === 'control') return 'Control'
  if (alias === 'rightshift' || alias === 'leftshift' || alias === 'shift') return 'Shift'
  if (alias === 'commandorcontrol') return platform === 'darwin' ? 'Command' : 'Control'
  return platform === 'darwin' ? 'Command' : 'Super'
}

function orderModifiers(mods: string[], platform: string): string[] {
  const order = platform === 'darwin'
    ? ['Command', 'Control', 'Alt', 'Shift']
    : ['Super', 'Control', 'Alt', 'Shift']
  return order.filter((m) => mods.includes(m))
}

function canonicalKey(token: string): string | null {
  const lower = token.trim().toLowerCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return `F${lower.slice(1)}`
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  if (/^num[0-9]$/.test(lower)) return lower
  if (KEY_ALIAS[lower]) return KEY_ALIAS[lower]
  if (CHORD_KEYS.has(token.trim())) return token.trim()
  if (token.length === 1 && CHORD_KEYS.has(token)) return token
  return null
}

/** Hook names that should toggle `shortcut` (modifier-only tokens). */
export function modifierHookNames(shortcut: string): string[] {
  switch (shortcut) {
    case 'fn': return ['fn']
    case 'RightAlt': return ['RightAlt']
    case 'LeftAlt': return ['LeftAlt']
    case 'Alt': return ['LeftAlt', 'RightAlt']
    case 'RightControl': return ['RightControl']
    case 'LeftControl': return ['LeftControl']
    case 'Control': return ['LeftControl', 'RightControl']
    case 'RightShift': return ['RightShift']
    case 'LeftShift': return ['LeftShift']
    case 'Shift': return ['LeftShift', 'RightShift']
    case 'RightMeta': return ['RightMeta']
    case 'LeftMeta': return ['LeftMeta']
    case 'Meta':
    case 'Super':
    case 'Command': return ['LeftMeta', 'RightMeta']
    default: return []
  }
}

export interface ModWatchState {
  down: string[]
  armed: boolean
  chord: boolean
}

export function initialModWatch(): ModWatchState {
  return { down: [], armed: false, chord: false }
}

/**
 * One line from the native modifier hook.
 * Fires once when the configured modifier is released, and only if it was
 * tapped by itself (no other key, no other modifier).
 */
export function modifierWatchStep(
  state: ModWatchState,
  line: string,
  shortcut: string
): { state: ModWatchState; fire: boolean } {
  const names = modifierHookNames(shortcut)
  if (names.length === 0) return { state, fire: false }
  const trimmed = line.trim()
  if (!trimmed || trimmed === 'ready' || trimmed === 'denied') return { state, fire: false }
  if (trimmed === 'key') {
    if (!state.armed) return { state, fire: false }
    return { state: { ...state, chord: true }, fire: false }
  }
  const down = trimmed.startsWith('mod-down ')
  const up = trimmed.startsWith('mod-up ')
  if (!down && !up) return { state, fire: false }
  const name = trimmed.slice((down ? 'mod-down ' : 'mod-up ').length).trim()
  let nextDown = state.down.filter((n) => n !== name)
  if (down) nextDown = [...nextDown, name]
  const relevant = names.includes(name)
  if (down && relevant) {
    const fresh = !state.armed
    return { state: { down: nextDown, armed: true, chord: fresh ? false : state.chord }, fire: false }
  }
  if (down && state.armed) {
    return { state: { down: nextDown, armed: true, chord: true }, fire: false }
  }
  if (!relevant) return { state: { ...state, down: nextDown }, fire: false }
  const fire = state.armed && !state.chord
  const still = nextDown.some((n) => names.includes(n))
  return {
    state: { down: nextDown, armed: still, chord: still ? state.chord : false },
    fire
  }
}

export function shortcutLabel(shortcut: string, platform: string): string {
  if (shortcut === FN_SHORTCUT) return 'fn'
  const alone = aloneLabel(shortcut, platform)
  if (alone) return alone
  const mac = platform === 'darwin'
  return shortcut
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl' || k === 'CmdOrCtrl') return mac ? '⌘' : 'Ctrl'
      if (k === 'Command' || k === 'Cmd') return '⌘'
      if (k === 'Control' || k === 'Ctrl') return mac ? '⌃' : 'Ctrl'
      if (k === 'Alt' || k === 'Option') return mac ? '⌥' : 'Alt'
      if (k === 'Shift') return mac ? '⇧' : 'Shift'
      if (k === 'Super' || k === 'Meta') return mac ? '⌘' : 'Win'
      if (k === 'RightAlt') return mac ? 'Right ⌥' : 'Right Alt'
      return k
    })
    .join(mac ? '' : '+')
}

function aloneLabel(shortcut: string, platform: string): string | null {
  const mac = platform === 'darwin'
  switch (shortcut) {
    case 'RightAlt': return mac ? 'Right ⌥' : 'Right Alt'
    case 'LeftAlt': return mac ? 'Left ⌥' : 'Left Alt'
    case 'Alt': return mac ? '⌥' : 'Alt'
    case 'RightControl': return mac ? 'Right ⌃' : 'Right Ctrl'
    case 'LeftControl': return mac ? 'Left ⌃' : 'Left Ctrl'
    case 'Control': return mac ? '⌃' : 'Ctrl'
    case 'RightShift': return mac ? 'Right ⇧' : 'Right Shift'
    case 'LeftShift': return mac ? 'Left ⇧' : 'Left Shift'
    case 'Shift': return mac ? '⇧' : 'Shift'
    case 'RightMeta': return mac ? 'Right ⌘' : 'Right Win'
    case 'LeftMeta': return mac ? 'Left ⌘' : 'Left Win'
    case 'Command': return '⌘'
    case 'Meta':
    case 'Super': return mac ? '⌘' : 'Win'
    default: return null
  }
}

/** One sentence under the setting. Platform limits live here and in the README. */
export function shortcutLimitNote(platform: string): string {
  if (platform === 'darwin') {
    return 'One key is enough (fn, F8, or Right Option). A modifier by itself, and fn, need Input Monitoring. Tapping it starts dictation; tapping it again stops. Holding it counts as one press, and a modifier only toggles when tapped alone so Ctrl and AltGr still work.'
  }
  if (platform === 'linux') {
    return 'One key is enough (F8), or use a combination. Linux can’t register a modifier by itself — Electron’s global shortcut needs a real key. On Wayland that shortcut often will not register; an X11 session is the reliable path. One press starts, the next press stops.'
  }
  return 'One key is enough (F8 or Right Alt). A modifier by itself uses a Windows keyboard hook that reports only that modifier, not the characters you type, and it toggles only when tapped alone so AltGr still types. One press starts, the next press stops.'
}

export interface ShortcutPreset {
  shortcut: string
  label: string
}

export function shortcutPresets(platform: string): ShortcutPreset[] {
  const ids = platform === 'darwin'
    ? [FN_SHORTCUT, 'F8', 'F9', 'RightAlt', LEGACY_WIN_LINUX_SHORTCUT]
    : platform === 'linux'
      ? ['F8', 'F9', 'F10', LEGACY_WIN_LINUX_SHORTCUT]
      : ['F8', 'F9', 'F10', 'RightAlt', LEGACY_WIN_LINUX_SHORTCUT]
  return ids.map((shortcut) => ({ shortcut, label: shortcutLabel(shortcut, platform) }))
}

export interface RecorderInput {
  type: 'down' | 'up'
  key: string
  code: string
  location?: number
  repeat?: boolean
}

export interface RecorderState {
  held: string[]
  /** A non-modifier key was pressed during this gesture. */
  chord: boolean
  /** More than one modifier was held. */
  mixed: boolean
}

export interface RecorderStep {
  state: RecorderState
  shortcut?: string
  message?: string
  cancelled?: boolean
}

export function initialRecorder(): RecorderState {
  return { held: [], chord: false, mixed: false }
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Return', NumpadEnter: 'Return',
  Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock', NumLock: 'Numlock', CapsLock: 'Capslock',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
  AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute'
}

function modifierFromInput(input: RecorderInput): string | null {
  const code = input.code || ''
  const key = input.key || ''
  const loc = input.location ?? 0
  if (key === 'Fn' || code === 'Fn' || code === 'Function') return 'fn'
  if (key === 'AltGraph' || code === 'AltRight' || (key === 'Alt' && loc === 2)) return 'RightAlt'
  if (code === 'AltLeft' || (key === 'Alt' && loc === 1)) return 'LeftAlt'
  if (key === 'Alt') return 'Alt'
  if (code === 'ControlRight' || (key === 'Control' && loc === 2)) return 'RightControl'
  if (code === 'ControlLeft' || (key === 'Control' && loc === 1)) return 'LeftControl'
  if (key === 'Control') return 'Control'
  if (code === 'ShiftRight' || (key === 'Shift' && loc === 2)) return 'RightShift'
  if (code === 'ShiftLeft' || (key === 'Shift' && loc === 1)) return 'LeftShift'
  if (key === 'Shift') return 'Shift'
  if (code === 'MetaRight' || (key === 'Meta' && loc === 2)) return 'RightMeta'
  if (code === 'MetaLeft' || (key === 'Meta' && loc === 1)) return 'LeftMeta'
  if (key === 'Meta' || key === 'OS') return 'Meta'
  return null
}

function keyFromRecorder(input: RecorderInput): string | null {
  const code = input.code || ''
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (/^Key([A-Z])$/.test(code)) return code.slice(3)
  if (/^Digit([0-9])$/.test(code)) return code.slice(5)
  if (/^Numpad([0-9])$/.test(code)) return `num${code.slice(6)}`
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(input.key)) return input.key
  return null
}

function isControlToken(token: string): boolean {
  return token === 'Control' || token === 'LeftControl' || token === 'RightControl'
}

/** "Press the keys you want." Escape cancels. A modifier alone is accepted on release. */
export function recorderStep(state: RecorderState, input: RecorderInput, platform: string): RecorderStep {
  if (input.repeat) return { state }
  const mod = modifierFromInput(input)
  if (input.type === 'down') {
    if (!mod && input.key === 'Escape' && state.held.length === 0) {
      return { state: initialRecorder(), cancelled: true }
    }
    if (mod) {
      let held = state.held
      // Windows AltGr is a synthetic Control followed by Right Alt.
      if (mod === 'RightAlt') held = held.filter((h) => !isControlToken(h))
      const mixed = state.mixed || held.length > 0
      if (!held.includes(mod)) held = [...held, mod]
      return { state: { held, chord: state.chord, mixed } }
    }
    if (state.held.includes('fn')) {
      return {
        state: { ...state, chord: true },
        message: "The fn key can't be combined. Tap fn by itself, or use a shortcut without fn."
      }
    }
    const key = keyFromRecorder(input)
    const next: RecorderState = { ...state, chord: true }
    if (!key) return { state: next, message: "That key can't be used as a shortcut." }
    const mods = orderModifiers(chordModifierList(state.held, platform), platform)
    const built = mods.length === 0 ? key : [...mods, key].join('+')
    const verdict = validateShortcut(built, platform)
    if (!verdict.ok) return { state: next, message: verdict.message }
    return { state: initialRecorder(), shortcut: verdict.shortcut }
  }
  if (!mod) return { state }
  const held = state.held.filter((h) => h !== mod)
  if (state.held.length > 0 && held.length === 0 && !state.chord) {
    if (state.mixed || state.held.length !== 1) {
      return { state: initialRecorder(), message: 'Use one modifier by itself, or add a key.' }
    }
    const verdict = validateShortcut(state.held[0], platform)
    if (!verdict.ok) return { state: initialRecorder(), message: verdict.message }
    return { state: initialRecorder(), shortcut: verdict.shortcut }
  }
  return { state: { held, chord: state.chord && held.length > 0, mixed: state.mixed && held.length > 0 } }
}

function chordModifierList(held: string[], platform: string): string[] {
  const out: string[] = []
  for (const h of held) {
    if (h === 'fn') continue
    if (h === 'RightAlt' || h === 'LeftAlt' || h === 'Alt') pushUnique(out, 'Alt')
    else if (isControlToken(h)) pushUnique(out, 'Control')
    else if (h === 'RightShift' || h === 'LeftShift' || h === 'Shift') pushUnique(out, 'Shift')
    else if (h === 'RightMeta' || h === 'LeftMeta' || h === 'Meta' || h === 'Super' || h === 'Command') {
      pushUnique(out, platform === 'darwin' ? 'Command' : 'Super')
    }
  }
  return out
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}
