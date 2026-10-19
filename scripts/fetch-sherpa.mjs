#!/usr/bin/env node
// Stage the sherpa-onnx offline CLI (Apache-2.0) used to run Parakeet.
//   npm run setup:sherpa            → CPU build (CoreML recorded on macOS)
//   npm run setup:sherpa -- --cuda  → CUDA 12.x build (Linux/Windows x64)
//
// Layout (flat — do not nest shared libraries in sherpa/lib/):
//   resources/bin/<platform>-<arch>/sherpa/sherpa-onnx-offline
//   resources/bin/<platform>-<arch>/sherpa/libonnxruntime.dylib   (macOS)
//   resources/bin/<platform>-<arch>/sherpa/libsherpa-onnx-c-api.dylib
//   resources/bin/<platform>-<arch>/sherpa/libsherpa-onnx-cxx-api.dylib
// electron-builder copies that directory to Contents/Resources/bin/sherpa/.
// The signed app resolves @rpath/libonnxruntime.dylib via @loader_path, which
// is the directory containing sherpa-onnx-offline. DYLD_LIBRARY_PATH is ignored.
//
// On macOS, install names are rewritten to @rpath/<basename> and @loader_path
// is added when the upstream binary does not already have it. Each rewritten
// Mach-O is ad-hoc signed so a local run works; scripts/sign-mac.sh re-signs
// the packaged app with the Developer ID.
//
// Keep SHERPA in sync with src/shared/speech.ts → sherpaOnnxTag.
// FLOWA_SHERPA_ARCHIVE=/path/to.tar.bz2 skips the download.
// Vulkan: sherpa-onnx publishes no Vulkan execution provider. Whisper's
// Vulkan path is scripts/build-whisper.mjs (FLOWA_WHISPER_VARIANT=vulkan).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  isOnnxRuntimeLibrary, macSherpaDylibs, parseOtoolId, parseOtoolLibraries, parseOtoolRpaths,
  planDarwinRewrite, planSherpaStage, preferRealLibraries, sherpaOfflineName, siblingSymlink
} from './sherpa-stage.mjs'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-sherpa-'))
const archive = await fetchArchive(url, asset, tmp)
execFileSync('tar', ['-xjf', archive, '-C', tmp], { stdio: 'inherit' })

function walk(dir, found = []) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    const st = fs.lstatSync(file)
    if (st.isDirectory()) walk(file, found)
    else if (st.isFile() || st.isSymbolicLink()) found.push(file)
  }
  return found
}

const binaryName = platform === 'win32' ? `${sherpaOfflineName}.exe` : sherpaOfflineName
const files = preferRealLibraries(walk(tmp), (file) => fs.lstatSync(file).isSymbolicLink())
const plan = planSherpaStage(files, binaryName)
if (!plan.some((entry) => entry.dest === binaryName)) throw new Error(`archive has no ${binaryName}`)

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
const stagedNames = new Set(plan.map((entry) => entry.dest))
for (const entry of plan) {
  const target = path.join(dest, entry.dest)
  const st = fs.lstatSync(entry.src)
  if (st.isSymbolicLink()) {
    const link = siblingSymlink(entry.dest, fs.readlinkSync(entry.src), stagedNames)
    if (link) {
      fs.symlinkSync(link, target)
      continue
    }
  }
  fs.copyFileSync(entry.src, target)
}
fs.chmodSync(path.join(dest, binaryName), 0o755)

if (files.some(isOnnxRuntimeLibrary) && ![...stagedNames].some(isOnnxRuntimeLibrary)) {
  throw new Error('onnxruntime shared library was in the archive but was not staged beside sherpa-onnx-offline')
}
if (platform === 'darwin') {
  for (const name of [binaryName, ...macSherpaDylibs]) {
    if (!stagedNames.has(name)) throw new Error(`missing ${path.join(dest, name)}`)
  }
}

rewriteDarwinInstallNames(plan.map((entry) => path.join(dest, entry.dest)))
fs.writeFileSync(path.join(dest, 'providers.json'), JSON.stringify({ providers, sherpa: `v${SHERPA}`, asset }, null, 2) + '\n')
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`OK ${path.join(dest, binaryName)}`)
console.log(`providers: ${providers.join(', ')}`)
for (const name of fs.readdirSync(dest)) console.log(`  ${name}`)

async function fetchArchive(remote, name, dir) {
  const override = process.env.FLOWA_SHERPA_ARCHIVE
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`FLOWA_SHERPA_ARCHIVE not found: ${override}`)
    console.log(`Using ${override}`)
    return override
  }
  console.log(`Downloading ${remote}`)
  const file = path.join(dir, name)
  const res = await fetch(remote)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
  return file
}

function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function rewriteDarwinInstallNames(machos) {
  if (platform !== 'darwin') return
  const present = machos.filter((file) => fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink())
  if (process.platform !== 'darwin' || !commandExists('install_name_tool') || !commandExists('otool')) {
    console.log(`install_name_tool unavailable; leaving upstream install names. Sibling dylibs still match @loader_path for sherpa-onnx v${SHERPA}.`)
    return
  }
  const shipped = present.map((file) => path.basename(file))
  for (const file of present) {
    const id = parseOtoolId(execFileSync('otool', ['-D', file], { encoding: 'utf8' }))
    const loads = parseOtoolLibraries(execFileSync('otool', ['-L', file], { encoding: 'utf8' })).filter((dep) => dep !== id)
    const rpaths = parseOtoolRpaths(execFileSync('otool', ['-l', file], { encoding: 'utf8' }))
    const rewrite = planDarwinRewrite({
      id, loads, rpaths, basename: path.basename(file), isDylib: file.endsWith('.dylib')
    }, shipped)
    for (const change of rewrite.changes) {
      execFileSync('install_name_tool', ['-change', change.from, change.to, file], { stdio: 'inherit' })
    }
    if (rewrite.id) execFileSync('install_name_tool', ['-id', rewrite.id, file], { stdio: 'inherit' })
    if (rewrite.addRpath) {
      try {
        execFileSync('install_name_tool', ['-add_rpath', rewrite.addRpath, file], { stdio: 'pipe' })
      } catch (err) {
        const msg = `${err.stderr || ''} ${err.message || ''}`
        if (!/already exists|no room/i.test(msg)) throw err
        console.warn(`could not add @loader_path to ${path.basename(file)}: ${msg.trim()}`)
      }
    }
    if ((rewrite.changes.length || rewrite.id || rewrite.addRpath) && commandExists('codesign')) {
      execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' })
    }
  }
}
