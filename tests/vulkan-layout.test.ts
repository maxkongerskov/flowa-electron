import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWhisperManifest, resolveWhisperBin, whisperBinaryCandidates, whisperLibraryEnv } from '../src/main/speechFiles'

const dirs: string[] = []

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  fs.chmodSync(file, 0o755)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('vulkan engine layout', () => {
  it('uses the isolated Vulkan directory and still accepts a flat binary', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-bin-'))
    dirs.push(bin)
    touch(path.join(bin, 'whisper-server'))
    touch(path.join(bin, 'whisper-server-vulkan', 'whisper-server'))
    touch(path.join(bin, 'whisper-server-vulkan', 'whisper-cli'))
    expect(resolveWhisperBin(bin, 'vulkan', 'server', {}, 'linux')).toBe(path.join(bin, 'whisper-server-vulkan', 'whisper-server'))
    expect(resolveWhisperBin(bin, 'vulkan', 'cli', {}, 'linux')).toBe(path.join(bin, 'whisper-server-vulkan', 'whisper-cli'))
    expect(resolveWhisperBin(bin, 'default', 'server', {}, 'linux')).toBe(path.join(bin, 'whisper-server'))
    const manifest = readWhisperManifest(bin, 'linux', 'linux')
    expect(manifest.binaries.vulkan).toBe(true)
    expect(manifest.default).toEqual(['cpu'])

    const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-bin-'))
    dirs.push(flat)
    touch(path.join(flat, 'whisper-server-vulkan'))
    expect(resolveWhisperBin(flat, 'vulkan', 'server', {}, 'linux')).toBe(path.join(flat, 'whisper-server-vulkan'))
  })

  it('sees a Windows Vulkan folder without treating it as the CPU engine', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-bin-'))
    dirs.push(bin)
    const nested = path.join(bin, 'whisper-server-vulkan', 'whisper-server.exe')
    expect(whisperBinaryCandidates(bin, 'vulkan', 'server', true)[0]).toBe(nested)
    touch(nested)
    expect(readWhisperManifest(bin, 'win32', 'win32').binaries.vulkan).toBe(true)
    const env = whisperLibraryEnv(nested, { PATH: 'C:\\Windows', LD_LIBRARY_PATH: '/cpu' }, 'win32')
    expect(env.PATH?.startsWith(`${path.dirname(nested)};`)).toBe(true)
    expect(env.LD_LIBRARY_PATH).toBe('/cpu')
    const linux = whisperLibraryEnv('/opt/flowa/bin/whisper-server-vulkan/whisper-server', { LD_LIBRARY_PATH: '/usr/lib' }, 'linux')
    expect(linux.LD_LIBRARY_PATH).toBe('/opt/flowa/bin/whisper-server-vulkan:/usr/lib')
  })
})
