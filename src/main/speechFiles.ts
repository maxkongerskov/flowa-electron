// Locate staged whisper.cpp binaries. Weights stay out of git; release builds
// copy models/ next to Resources, dev builds also look in app data.
//
// The CPU engine is the official whisper.cpp zip, flat in binDir. Vulkan (and
// an optional CUDA build laid out the same way) lives in binDir/whisper-server-vulkan/
// because its libggml / whisper.dll names would overwrite the CPU engine.
// A flat whisper-server-vulkan binary from an older local build is still accepted.

import fs from 'node:fs'
import path from 'node:path'
import {
  assumedWhisperManifest, normalizeWhisperManifest, whisperCliFile, whisperNestedExecutable, whisperServerFile,
  whisperVariantDir, withDetectedBinaries,
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

export function whisperBinaryCandidates(binDir: string, kind: WhisperBinaryKind, role: 'server' | 'cli', windows: boolean): string[] {
  const flat = path.join(binDir, role === 'server' ? whisperServerFile(kind, windows) : whisperCliFile(kind, windows))
  const folder = whisperVariantDir(kind)
  if (!folder) return [flat]
  // The isolated tree wins. Its libraries are not the CPU engine's libraries.
  const nested = path.join(binDir, folder, whisperNestedExecutable(role, windows))
  return [nested, flat]
}

export function readWhisperManifest(binDir: string, platform: string, hostPlatform: string = process.platform): WhisperManifest {
  const file = path.join(binDir, 'whisper-backends.json')
  let manifest = assumedWhisperManifest(platform)
  if (fs.existsSync(file)) {
    try {
      manifest = normalizeWhisperManifest(JSON.parse(fs.readFileSync(file, 'utf8')), platform)
    } catch {
      manifest = assumedWhisperManifest(platform)
    }
  }
  const windows = hostPlatform === 'win32'
  return withDetectedBinaries(manifest, {
    cuda: whisperBinaryCandidates(binDir, 'cuda', 'server', windows).some((candidate) => fs.existsSync(candidate)),
    vulkan: whisperBinaryCandidates(binDir, 'vulkan', 'server', windows).some((candidate) => fs.existsSync(candidate))
  })
}

/** Library search path for one engine. The directory of the binary comes first. */
export function whisperLibraryEnv(bin: string, base: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
  const dir = path.dirname(bin)
  const env = { ...base }
  if (platform === 'win32') env.PATH = [dir, env.PATH].filter(Boolean).join(';')
  else env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  return env
}

export function resolveWhisperBin(
  binDir: string,
  kind: WhisperBinaryKind,
  role: 'server' | 'cli',
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: string = process.platform
): string | null {
  const windows = hostPlatform === 'win32'
  const fromEnv =
    kind === 'default' ? (role === 'server' ? env.FLOWA_WHISPER_SERVER_BIN : env.FLOWA_WHISPER_BIN) : undefined
  const candidates = [fromEnv?.trim() || '', ...whisperBinaryCandidates(binDir, kind, role, windows)].filter(Boolean)
  for (const candidate of candidates) {
    if (canRun(candidate)) return candidate
  }
  return null
}
