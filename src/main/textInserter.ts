// Port of Flowa/Dictation/TextInserter.swift + the frontmost-app capture in
// GlobalHotkey.frontmostTargetApp().
//
// Contract kept from Swift: the transcript ALWAYS lands on the clipboard
// first (no clipboard restore). Then, if there is a target and auto-paste is
// allowed, re-activate the target, wait ~120 ms and synthesize the paste chord.
//
//   macOS  : flowa-helper (NSRunningApplication.activate + CGEvent ⌘V, same
//            keycodes 0x37/0x09 as Swift). Fallback: osascript System Events.
//   Windows: PowerShell SetForegroundWindow + keybd_event Ctrl+V (from Flowa-Windows).
//   Linux  : xdotool (X11) windowactivate + ctrl+v; wtype / ydotool on Wayland.

import { clipboard, systemPreferences } from 'electron'
import { frontmostApp, helper, macHelperAvailable } from './macHelper'
import { psArgs, run } from './proc'
import { linuxPasteTool } from './permissions'

export interface TargetApp {
  platform: string
  /** Display name for the Recent list ("Notes", window title on Windows/Linux). */
  name: string | null
  pid?: number
  bundleId?: string | null
  hwnd?: string
  windowId?: string
}

export type PasteOutcome =
  | { kind: 'pasted'; appName: string | null }
  | { kind: 'clipboardOnly'; reason?: string }
  | { kind: 'accessibilityMissing' }
  | { kind: 'failed' }

const ownBundleIds = new Set(['com.maxkongerskov.FlowaElectron', 'com.github.Electron'])

/** Frontmost app at recording start, or null if it is Flowa itself. */
export async function captureTarget(): Promise<TargetApp | null> {
  try {
    if (process.platform === 'darwin') return await captureMac()
    if (process.platform === 'win32') return await captureWindows()
    return await captureLinux()
  } catch (e) {
    console.error('[Flowa] focus capture failed', e)
    return null
  }
}

async function captureMac(): Promise<TargetApp | null> {
  const f = await frontmostApp()
  if (f) {
    if (f.pid === process.pid || (f.bundleId && ownBundleIds.has(f.bundleId))) return null
    return { platform: 'darwin', name: f.name, pid: f.pid, bundleId: f.bundleId }
  }
  // Helper not built: lsappinfo needs no permission.
  const front = await run('/usr/bin/lsappinfo', ['front'])
  if (front.code !== 0) return null
  const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'name', front.stdout.trim()])
  const m = /"LSDisplayName"="([^"]*)"/.exec(info.stdout) || /"?name"?="([^"]*)"/i.exec(info.stdout)
  const name = m ? m[1] : null
  if (!name || name === 'Flowa' || name === 'Electron') return null
  return { platform: 'darwin', name }
}

async function captureWindows(): Promise<TargetApp | null> {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FlowaFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [FlowaFocus]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FlowaFocus]::GetWindowText($h, $sb, 512)
$p = 0
[void][FlowaFocus]::GetWindowThreadProcessId($h, [ref]$p)
$name = ""
try { $name = (Get-Process -Id $p).ProcessName } catch {}
Write-Output ("{0}\`t{1}\`t{2}\`t{3}" -f $h.ToInt64(), $p, $name, $sb.ToString())
`
  const { code, stdout } = await run('powershell.exe', psArgs(script), 6000)
  if (code !== 0) return null
  const [hwnd, pid, proc, title] = stdout.trim().split('\t')
  if (!/^\d+$/.test(hwnd ?? '') || hwnd === '0') return null
  if (Number(pid) === process.pid) return null
  return { platform: 'win32', hwnd, pid: Number(pid), name: title?.trim() || proc || null }
}

async function captureLinux(): Promise<TargetApp | null> {
  if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    // Wayland gives no global "active window" API; paste goes to whatever has focus.
    return { platform: 'linux', name: null }
  }
  const id = await run('xdotool', ['getactivewindow'])
  if (id.code !== 0) return { platform: 'linux', name: null }
  const windowId = id.stdout.trim()
  if (!/^\d+$/.test(windowId)) return { platform: 'linux', name: null }
  const pid = await run('xdotool', ['getwindowpid', windowId])
  if (pid.code === 0 && Number(pid.stdout.trim()) === process.pid) return null
  const name = await run('xdotool', ['getwindowname', windowId])
  return { platform: 'linux', windowId, name: name.code === 0 ? name.stdout.trim() || null : null }
}

function accessibilityGranted(): boolean {
  if (process.platform === 'darwin') return systemPreferences.isTrustedAccessibilityClient(false)
  if (process.platform === 'linux') return !!linuxPasteTool()
  return true
}

/** Write `text` to the clipboard and, if possible, paste it into `target`. */
export async function paste(text: string, target: TargetApp | null): Promise<PasteOutcome> {
  if (!text) return { kind: 'failed' }
  try {
    clipboard.writeText(text)
  } catch {
    return { kind: 'failed' }
  }
  if (!target) return { kind: 'clipboardOnly' }
  if (!accessibilityGranted()) return { kind: 'accessibilityMissing' }

  if (process.platform === 'darwin') return pasteMac(target)
  const ok = process.platform === 'win32' ? await pasteWindows(target) : await pasteLinux(target)
  return ok ? { kind: 'pasted', appName: target.name } : { kind: 'clipboardOnly' }
}

/** Map flowa-helper `paste` exit code + output to an outcome (exported for tests). */
export function helperPasteOutcome(code: number, out: string, appName: string | null): PasteOutcome {
  if (code === 0 && out.startsWith('pasted')) return { kind: 'pasted', appName }
  if (code === 4 || out.startsWith('accessibility-missing')) return { kind: 'accessibilityMissing' }
  if (out.startsWith('not-frontmost') || out.startsWith('target-gone')) return { kind: 'clipboardOnly', reason: 'targetNotFrontmost' }
  return { kind: 'clipboardOnly', reason: 'pasteFailed' }
}

async function pasteMac(t: TargetApp): Promise<PasteOutcome> {
  if (macHelperAvailable()) {
    const r = await helper(t.pid ? ['paste', String(t.pid)] : ['paste'], 6000)
    console.log(`[Flowa][paste] helper code=${r.code} out=${JSON.stringify(r.out)} target=${t.name ?? '?'} pid=${t.pid ?? '-'}`)
    return helperPasteOutcome(r.code, r.out, t.name)
  }
  const lines: string[] = []
  if (t.name) {
    lines.push(`tell application "${t.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" to activate`, 'delay 0.12')
  }
  lines.push('tell application "System Events" to keystroke "v" using command down')
  const r = await run('/usr/bin/osascript', ['-e', lines.join('\n')])
  return r.code === 0 ? { kind: 'pasted', appName: t.name } : { kind: 'clipboardOnly', reason: 'pasteFailed' }
}

async function pasteWindows(t: TargetApp): Promise<boolean> {
  const hwnd = t.hwnd && /^\d+$/.test(t.hwnd) ? t.hwnd : '0'
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FlowaPaste {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$hwnd = New-Object IntPtr ([int64]${hwnd})
if ($hwnd -ne [IntPtr]::Zero) { [void][FlowaPaste]::SetForegroundWindow($hwnd) }
Start-Sleep -Milliseconds 120
[FlowaPaste]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[FlowaPaste]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[FlowaPaste]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[FlowaPaste]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
`
  const r = await run('powershell.exe', psArgs(script), 8000)
  return r.code === 0
}

async function pasteLinux(t: TargetApp): Promise<boolean> {
  const tool = linuxPasteTool()
  if (!tool) return false
  if (tool === 'xdotool') {
    if (t.windowId) await run('xdotool', ['windowactivate', '--sync', t.windowId])
    else await new Promise((r) => setTimeout(r, 120))
    return (await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])).code === 0
  }
  await new Promise((r) => setTimeout(r, 120))
  if (tool === 'wtype') return (await run('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl'])).code === 0
  // ydotool: KEY_LEFTCTRL=29, KEY_V=47
  return (await run('ydotool', ['key', '29:1', '47:1', '47:0', '29:0'])).code === 0
}
