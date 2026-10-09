import { spawn, spawnSync } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command with argv (never a shell string). */
export function run(command: string, args: string[], timeoutMs = 8000): Promise<RunResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String(e) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export function commandExists(cmd: string): boolean {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    return spawnSync(locator, [cmd], { encoding: 'utf8' }).status === 0
  } catch {
    return false
  }
}

/** PowerShell -EncodedCommand args (UTF-16LE base64), as in Flowa-Windows. */
export function psArgs(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}
