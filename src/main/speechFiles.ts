// Locate staged whisper.cpp binaries. Weights stay out of git; release builds
// copy models/ next to Resources, dev builds also look in app data.

import fs from 'node:fs'
import path from 'node:path'
import {
  assumedWhisperManifest, normalizeWhisperManifest, whisperCliFile, whisperServerFile, withDetectedBinaries,
  type WhisperBinaryKind, type WhisperManifest
} from '@shared/speech'

function canRun(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function readWhisperManifest(binDir: string, platform: string): WhisperManifest {
  const file = path.join(binDir, 'whisper-backends.json')
  let manifest = assumedWhisperManifest(platform)
  if (fs.existsSync(file)) {
    try {
      manifest = normalizeWhisperManifest(JSON.parse(fs.readFileSync(file, 'utf8')), platform)
    } catch {
      manifest = assumedWhisperManifest(platform)
    }
  }
  const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)
  return withDetectedBinaries(manifest, {
    cuda: fs.existsSync(path.join(binDir, exe('whisper-server-cuda'))),
    vulkan: fs.existsSync(path.join(binDir, exe('whisper-server-vulkan')))
  })
}

export function resolveWhisperBin(
  binDir: string,
  kind: WhisperBinaryKind,
  role: 'server' | 'cli',
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const windows = process.platform === 'win32'
  const file = role === 'server' ? whisperServerFile(kind, windows) : whisperCliFile(kind, windows)
  const fromEnv =
    kind === 'default' ? (role === 'server' ? env.FLOWA_WHISPER_SERVER_BIN : env.FLOWA_WHISPER_BIN) : undefined
  for (const candidate of [fromEnv?.trim() || '', path.join(binDir, file)].filter(Boolean)) {
    if (canRun(candidate)) return candidate
  }
  return null
}
