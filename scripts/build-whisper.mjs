#!/usr/bin/env node
// Build whisper.cpp (pinned tag) → resources/bin/<platform>-<arch>/.
// macOS: Metal is embedded (GGML_METAL_EMBED_LIBRARY). Windows/Linux CPU: flat
// whisper-server next to its shared libraries.
//   FLOWA_WHISPER_VARIANT=vulkan  → resources/bin/<platform>-<arch>/whisper-server-vulkan/
//   FLOWA_WHISPER_VARIANT=cuda    → whisper-server-cuda beside the CPU binary
// The Vulkan tree is a whole engine (whisper-server, whisper-cli, ggml/whisper
// shared libraries). It cannot sit next to the official CPU zip: those builds
// both ship libggml / whisper.dll under the same names. $ORIGIN / the exe
// directory keeps each engine on its own libraries.
// Requires: git, cmake >= 3.24 (Vulkan's glslc component), a C++ toolchain,
// and the Vulkan SDK or distro vulkan headers + glslc + SPIRV-Headers.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TAG = 'v1.9.5' // keep in sync with src/shared/model.ts → whisperCppTag
const COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037' // v1.9.5
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const src = path.join(root, 'vendor', 'whisper.cpp')
const buildDir = path.join(src, 'build-flowa')
const out = path.join(root, 'resources', 'bin', `${process.platform}-${process.arch}`)

function sh(cmd, args, cwd = root, env = process.env) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env })
}

function capture(cmd, args, cwd = root) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
}

if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
  fs.mkdirSync(path.dirname(src), { recursive: true })
  sh('git', ['clone', '--depth', '1', '--branch', TAG, 'https://github.com/ggml-org/whisper.cpp.git', src])
}
let head = ''
try { head = capture('git', ['rev-parse', 'HEAD'], src) } catch { head = '' }
if (head !== COMMIT) {
  sh('git', ['fetch', '--depth', '1', 'origin', COMMIT], src)
  sh('git', ['checkout', '--detach', COMMIT], src)
  head = capture('git', ['rev-parse', 'HEAD'], src)
}
if (head !== COMMIT) throw new Error(`whisper.cpp is ${head}, expected ${COMMIT} (${TAG})`)

// FLOWA_WHISPER_VARIANT=cuda|vulkan writes an extra backend beside the CPU engine.
const variant = process.env.FLOWA_WHISPER_VARIANT === 'cuda' || process.env.FLOWA_WHISPER_VARIANT === 'vulkan'
  ? process.env.FLOWA_WHISPER_VARIANT
  : ''
const wantCuda = variant === 'cuda' || process.env.FLOWA_GGML_CUDA === '1'
const wantVulkan = variant === 'vulkan' || process.env.FLOWA_GGML_VULKAN === '1'
const wantMetal = process.platform === 'darwin' && !wantCuda && !wantVulkan
// Vulkan is a second shared-library tree. A static Vulkan exe would avoid the
// clash, but ggml loads CPU and Vulkan backends as sibling libraries, which is
// also how the official CPU zip is built. Isolate that tree in its own folder.
const sharedVulkan = variant === 'vulkan'

const flags = [
  '-S', src, '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  `-DBUILD_SHARED_LIBS=${sharedVulkan ? 'ON' : 'OFF'}`,
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF'
]
if (wantMetal) flags.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0')
if (wantVulkan) flags.push('-DGGML_VULKAN=ON')
// Ubuntu 22.04's libvulkan-dev headers stop at 1.3.204 and fail to compile
// v1.9.5 (LayerSettingEXT, eMesaDozen, device-fault EXT). When VULKAN_SDK is
// set, force those headers. A stale CMake cache otherwise keeps /usr/include.
if (wantVulkan && process.env.VULKAN_SDK) {
  const include = path.join(process.env.VULKAN_SDK, 'include')
  if (!fs.existsSync(path.join(include, 'vulkan', 'vulkan.hpp'))) {
    throw new Error(`VULKAN_SDK=${process.env.VULKAN_SDK} has no vulkan/vulkan.hpp. whisper.cpp ${TAG} needs the 1.3.296 SDK headers.`)
  }
  flags.push(`-DVulkan_INCLUDE_DIR=${include}`)
  if (process.platform !== 'win32') flags.push(`-DCMAKE_CXX_FLAGS=-I${include}`)
} else if (wantVulkan && process.platform === 'linux') {
  throw new Error('Linux Vulkan builds need VULKAN_SDK (Ubuntu 22.04 libvulkan-dev headers are too old for whisper.cpp v1.9.5).')
}
if (wantCuda) flags.push('-DGGML_CUDA=ON')
if (process.platform !== 'darwin') flags.push('-DGGML_NATIVE=OFF') // portable binaries for distribution
if (sharedVulkan) {
  flags.push('-DGGML_BACKEND_DL=ON')
  if (process.arch === 'x64') flags.push('-DGGML_CPU_ALL_VARIANTS=ON')
  if (process.platform === 'linux') {
    // Literal $ORIGIN. execFile does not expand it. Matches the official CPU zip.
    flags.push('-DCMAKE_INSTALL_RPATH=$ORIGIN', '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON')
  }
}

sh('cmake', flags)
if (wantVulkan && process.env.VULKAN_SDK) {
  const cache = fs.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8')
  const found = cache.match(/^Vulkan_INCLUDE_DIR:[^=]*=(.*)$/m)
  const include = path.resolve(process.env.VULKAN_SDK, 'include')
  const picked = found ? path.resolve(found[1].trim()) : ''
  // The Windows SDK directory is Include. path.resolve does not match that casing.
  if (!sameDirectory(picked, include)) {
    throw new Error(`CMake picked Vulkan headers at ${picked || 'unknown'}; expected ${include}`)
  }
  console.log(`Vulkan headers: ${picked}`)
}
sh('cmake', ['--build', buildDir, '--config', 'Release', '-j', String(os.availableParallelism?.() ?? 4), '--target', 'whisper-server', 'whisper-cli'])

fs.mkdirSync(out, { recursive: true })
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n)
const buildBin = [path.join(buildDir, 'bin', 'Release'), path.join(buildDir, 'bin')].find((dir) => fs.existsSync(path.join(dir, exe('whisper-server'))))
if (!buildBin) throw new Error('build produced no whisper-server')

const stageDir = variant === 'vulkan' ? path.join(out, 'whisper-server-vulkan') : out
fs.mkdirSync(stageDir, { recursive: true })
const suffix = variant === 'vulkan' ? '' : variant ? `-${variant}` : ''

function engineLib(name) {
  if (/^libvulkan/i.test(name) || /^vulkan-1\.dll$/i.test(name) || /^SDL2\.dll$/i.test(name)) return false
  const lib = /\.(dll|so|dylib)$/i.test(name) || /\.so(\.\d+)+$/.test(name)
  if (!lib) return false
  return /ggml|whisper|vcomp140|msvcp140|vcruntime140/i.test(name)
}

function copyInto(name, destName) {
  const from = path.join(buildBin, name)
  const dest = path.join(stageDir, destName)
  fs.rmSync(dest, { force: true })
  // Node's cp keeps a symlink's text only when the destination is the same
  // directory. Copying libggml.so.0 out of the build tree otherwise rewrites
  // it to an absolute path that does not exist in the installed app.
  if (fs.lstatSync(from).isSymbolicLink()) {
    const link = fs.readlinkSync(from)
    if (path.isAbsolute(link) || link.includes('..')) {
      throw new Error(`${name} symlink target ${link} is not a sibling relative path`)
    }
    fs.symlinkSync(link, dest)
    return
  }
  fs.copyFileSync(from, dest)
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
}

for (const name of ['whisper-server', 'whisper-cli']) {
  copyInto(exe(name), exe(`${name}${suffix}`))
}
if (sharedVulkan) {
  for (const ent of fs.readdirSync(buildBin, { withFileTypes: true })) {
    if (!ent.isFile() && !ent.isSymbolicLink()) continue
    if (engineLib(ent.name)) copyInto(ent.name, ent.name)
  }
}

if (process.platform === 'linux' && variant === 'vulkan') pinLinuxRpath(stageDir)

// whisper-backends.json is what the app reads to decide Metal / CUDA / Vulkan.
const manifestPath = path.join(out, 'whisper-backends.json')
let manifest = { default: ['cpu'], binaries: { cuda: false, vulkan: false } }
if (fs.existsSync(manifestPath)) {
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { /* rewrite */ }
}
manifest.binaries = { cuda: !!manifest.binaries?.cuda, vulkan: !!manifest.binaries?.vulkan }
const built = ['cpu']
if (wantMetal) built.push('metal')
if (wantCuda) built.push('cuda')
if (wantVulkan) built.push('vulkan')
if (!variant) manifest.default = built
if (variant === 'cuda') manifest.binaries.cuda = true
if (variant === 'vulkan') manifest.binaries.vulkan = true
if (!variant && wantCuda) manifest.default = [...new Set([...(manifest.default || []), 'cuda', 'cpu'])]
if (!variant && wantVulkan) manifest.default = [...new Set([...(manifest.default || []), 'vulkan', 'cpu'])]
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const versionFile = variant === 'vulkan' ? path.join(stageDir, 'VERSION') : path.join(out, 'VERSION')
fs.writeFileSync(versionFile, `whisper.cpp ${TAG} ${COMMIT}${variant ? ` (${variant})` : ''}\n`)
if (process.env.FLOWA_GLIBC_MAX || process.env.FLOWA_GLIBCXX_MAX) assertLibc(stageDir)
console.log(`whisper.cpp ${TAG} ${COMMIT}${suffix || variant ? ` [${variant || 'default'}]` : ''} → ${variant === 'vulkan' ? stageDir : out}`)

function sameDirectory(left, right) {
  const normalize = (dir) => {
    if (!dir) return ''
    const resolved = path.resolve(dir)
    try { return fs.realpathSync.native(resolved) } catch { return resolved }
  }
  const a = normalize(left)
  const b = normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function pinLinuxRpath(dir) {
  let patchelf = true
  try { execFileSync('patchelf', ['--version'], { stdio: 'ignore' }) } catch { patchelf = false }
  const files = fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((file) => {
    try { return fs.lstatSync(file).isFile() } catch { return false }
  })
  for (const file of files) {
    let elf = false
    try {
      elf = execFileSync('readelf', ['-d', file], { encoding: 'utf8' }).includes('NEEDED')
    } catch { elf = false }
    if (!elf) continue
    if (patchelf) execFileSync('patchelf', ['--set-rpath', '$ORIGIN', file], { stdio: 'inherit' })
    const dumped = execFileSync('readelf', ['-d', file], { encoding: 'utf8' })
    const runpath = dumped.match(/R(?:UN)?PATH\)\s+Library runpath: \[([^\]]*)\]/)
    if (!runpath || runpath[1].split(':').some((entry) => entry !== '$ORIGIN')) {
      throw new Error(`${path.basename(file)} RUNPATH is ${runpath ? runpath[1] : 'missing'}; expected $ORIGIN`)
    }
  }
}

function parseVersions(text, prefix) {
  let max = null
  // GLIBCXX_3.4.30 is three components. A two-component match would treat
  // 3.4.31 as 3.4 and miss the FLOWA_GLIBCXX_MAX ceiling.
  for (const match of text.matchAll(new RegExp(`${prefix}_(\\d+(?:\\.\\d+)*)`, 'g'))) {
    const next = match[1].split('.').map(Number)
    if (!max || newerThan(next, max.join('.'))) max = next
  }
  return max
}

function newerThan(found, limit) {
  if (!found) return false
  const cap = limit.split('.').map(Number)
  for (let i = 0; i < Math.max(found.length, cap.length); i++) {
    const a = found[i] ?? 0
    const b = cap[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

function assertLibc(dir) {
  const files = fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((file) => {
    try { return fs.lstatSync(file).isFile() } catch { return false }
  })
  let glibc = null
  let glibcxx = null
  for (const file of files) {
    let dumped = ''
    try { dumped = execFileSync('objdump', ['-T', file], { encoding: 'utf8' }) } catch { continue }
    const g = parseVersions(dumped, 'GLIBC')
    const x = parseVersions(dumped, 'GLIBCXX')
    if (g && (!glibc || newerThan(g, glibc.join('.')))) glibc = g
    if (x && (!glibcxx || newerThan(x, glibcxx.join('.')))) glibcxx = x
  }
  const glibcText = glibc ? glibc.join('.') : 'none'
  const glibcxxText = glibcxx ? glibcxx.join('.') : 'none'
  console.log(`libc requirement: GLIBC_${glibcText} GLIBCXX_${glibcxxText}`)
  if (process.env.FLOWA_GLIBC_MAX && newerThan(glibc, process.env.FLOWA_GLIBC_MAX)) {
    throw new Error(`GLIBC_${glibcText} exceeds FLOWA_GLIBC_MAX=${process.env.FLOWA_GLIBC_MAX}`)
  }
  if (process.env.FLOWA_GLIBCXX_MAX && newerThan(glibcxx, process.env.FLOWA_GLIBCXX_MAX)) {
    throw new Error(`GLIBCXX_${glibcxxText} exceeds FLOWA_GLIBCXX_MAX=${process.env.FLOWA_GLIBCXX_MAX}`)
  }
}
