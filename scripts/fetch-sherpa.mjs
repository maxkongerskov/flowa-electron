#!/usr/bin/env node
// Stage the sherpa-onnx offline CLI (Apache-2.0) used to run Parakeet.
//   npm run setup:sherpa            → CPU build (CoreML recorded on macOS)
//   npm run setup:sherpa -- --cuda  → CUDA 12.x build (Linux/Windows x64)
//
// Binaries land in resources/bin/<platform>-<arch>/sherpa/ (or sherpa-cuda/)
// next to whisper-server. They are gitignored with the rest of resources/bin/.
// Keep SHERPA in sync with src/shared/speech.ts → sherpaOnnxTag.
//
// Vulkan: sherpa-onnx publishes no Vulkan execution provider. Whisper's
// Vulkan path is scripts/build-whisper.mjs (FLOWA_WHISPER_VARIANT=vulkan).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const SHERPA = '1.13.8'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const cuda = process.argv.includes('--cuda')
const platform = process.env.FLOWA_SHERPA_PLATFORM || process.platform
const arch = process.env.FLOWA_SHERPA_ARCH || process.arch
const key = `${platform}-${arch}`

const cpuAssets = {
  'darwin-arm64': `sherpa-onnx-v${SHERPA}-osx-arm64-shared.tar.bz2`,
  'darwin-x64': `sherpa-onnx-v${SHERPA}-osx-x64-shared.tar.bz2`,
  'linux-x64': `sherpa-onnx-v${SHERPA}-linux-x64-shared.tar.bz2`,
  'win32-x64': `sherpa-onnx-v${SHERPA}-win-x64-shared-MT-Release.tar.bz2`
}
const cudaAssets = {
  'linux-x64': `sherpa-onnx-v${SHERPA}-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu.tar.bz2`,
  'win32-x64': `sherpa-onnx-v${SHERPA}-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2`
}

const asset = (cuda ? cudaAssets : cpuAssets)[key]
if (!asset) {
  const supported = Object.keys(cuda ? cudaAssets : cpuAssets).join(', ')
  console.error(`No sherpa-onnx ${cuda ? 'CUDA' : 'CPU'} build for ${key}. Supported: ${supported}`)
  process.exit(1)
}

const folder = cuda ? 'sherpa-cuda' : 'sherpa'
const dest = path.join(root, 'resources', 'bin', key, folder)
const providers = cuda ? ['cpu', 'cuda'] : platform === 'darwin' ? ['cpu', 'coreml'] : ['cpu']
const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA}/${asset}`

console.log(`Downloading ${url}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-sherpa-'))
const archive = path.join(tmp, asset)
const res = await fetch(url)
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive))
execFileSync('tar', ['-xjf', archive, '-C', tmp], { stdio: 'inherit' })

function walk(dir, found = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, found)
    else found.push(p)
  }
  return found
}

const binaryName = platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline'
const files = walk(tmp)
const binary = files.find((f) => path.basename(f) === binaryName)
if (!binary) throw new Error(`archive has no ${binaryName}`)

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
const binDir = path.dirname(binary)
// The offline binary needs the shared libraries that ship beside it (or in lib/).
for (const file of files) {
  const rel = path.relative(binDir, file)
  if (rel.startsWith('..')) {
    // lib/ next to bin/
    const parent = path.dirname(binDir)
    const fromRoot = path.relative(parent, file)
    if (fromRoot.startsWith('..')) continue
    const target = path.join(dest, fromRoot)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
  } else {
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
  }
}
const exe = path.join(dest, binaryName)
fs.chmodSync(exe, 0o755)
fs.writeFileSync(path.join(dest, 'providers.json'), JSON.stringify({ providers, sherpa: `v${SHERPA}`, asset }, null, 2) + '\n')
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`OK ${exe}`)
console.log(`providers: ${providers.join(', ')}`)
