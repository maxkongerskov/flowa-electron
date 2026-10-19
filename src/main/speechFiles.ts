// Locate staged Whisper / Parakeet files. Weights stay out of git; release
// builds copy models/ next to Resources, dev builds also look in app data.

import fs from 'node:fs'
import path from 'node:path'
import {
  assumedWhisperManifest, normalizeProviders, normalizeWhisperManifest, parakeetDirName, parakeetWeights,
  whisperCliFile, whisperServerFile, withDetectedBinaries,
  type ParakeetPaths, type ParakeetProvider, type WhisperBinaryKind, type WhisperManifest
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

export function parakeetDirCandidates(bundledModels: string, downloadedModels: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.FLOWA_PARAKEET_DIR?.trim() || '', path.join(bundledModels, parakeetDirName), path.join(downloadedModels, parakeetDirName)].filter(Boolean)
}

export function parakeetDirComplete(dir: string): boolean {
  return parakeetWeights.every((w) => {
    try {
      const st = fs.statSync(path.join(dir, w.name))
      return st.isFile() && st.size >= w.minBytes
    } catch {
      return false
    }
  })
}

export function resolveParakeetDir(candidates: string[]): string | null {
  for (const dir of candidates) if (parakeetDirComplete(dir)) return dir
  return null
}

export function parakeetPaths(dir: string): ParakeetPaths {
  return {
    encoder: path.join(dir, 'encoder.int8.onnx'),
    decoder: path.join(dir, 'decoder.int8.onnx'),
    joiner: path.join(dir, 'joiner.int8.onnx'),
    tokens: path.join(dir, 'tokens.txt')
  }
}

function readProvidersFile(file: string): string[] | null {
  try {
    return normalizeProviders(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** Union of providers advertised by the staged sherpa-onnx builds. */
export function readParakeetProviders(binDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const lists: string[][] = []
  const fromEnv = env.FLOWA_SHERPA_PROVIDERS?.split(',').map((s) => s.trim()).filter(Boolean)
  if (fromEnv && fromEnv.length) lists.push(normalizeProviders({ providers: fromEnv }))
  for (const sub of ['sherpa', 'sherpa-cuda']) {
    const dir = path.join(binDir, sub)
    const parsed = readProvidersFile(path.join(dir, 'providers.json'))
    if (parsed) lists.push(parsed)
    else if (sub === 'sherpa-cuda' && findSherpaBinary([dir], env, false)) lists.push(['cpu', 'cuda'])
  }
  if (!lists.length) return ['cpu']
  return [...new Set(lists.flat())]
}

export function findSherpaBinary(dirs: string[], env: NodeJS.ProcessEnv = process.env, useOverride = true): string | null {
  const override = useOverride ? env.FLOWA_SHERPA_BIN?.trim() : ''
  const name = process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline'
  const candidates = [override || '', ...dirs.map((dir) => path.join(dir, name))].filter(Boolean)
  for (const file of candidates) if (canRun(file)) return file
  return null
}

/** CUDA prefers the sherpa-cuda tree; every other provider uses the default tree. */
export function sherpaSearchDirs(binDir: string, provider: ParakeetProvider): string[] {
  const cpu = path.join(binDir, 'sherpa')
  if (provider === 'cuda') return [path.join(binDir, 'sherpa-cuda'), cpu]
  return [cpu]
}

export function sherpaProcessEnv(bin: string): NodeJS.ProcessEnv {
  const dir = path.dirname(bin)
  const lib = path.join(dir, 'lib')
  const extra = [dir, fs.existsSync(lib) ? lib : ''].filter(Boolean)
  const merge = (key: string): string => [...extra, process.env[key] || ''].filter(Boolean).join(path.delimiter)
  return { ...process.env, PATH: merge('PATH'), LD_LIBRARY_PATH: merge('LD_LIBRARY_PATH'), DYLD_LIBRARY_PATH: merge('DYLD_LIBRARY_PATH') }
}
