#!/usr/bin/env node
// Build whisper.cpp (pinned tag) → resources/bin/<platform>-<arch>/whisper-server(+cli).
// macOS: Metal is embedded (GGML_METAL_EMBED_LIBRARY). Windows/Linux: CPU by default.
//   FLOWA_GGML_VULKAN=1 or FLOWA_WHISPER_VARIANT=vulkan  → Vulkan backend
//   FLOWA_GGML_CUDA=1 or FLOWA_WHISPER_VARIANT=cuda      → CUDA backend
// VARIANT=cuda|vulkan keeps the default whisper-server and adds whisper-server-<variant>
// so one resources/bin folder can hold Metal/CPU plus CUDA and Vulkan.
// Requires: git, cmake, a C++ toolchain (Xcode CLT / MSVC Build Tools / build-essential).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TAG = 'v1.9.5' // keep in sync with src/shared/model.ts → whisperCppTag
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const src = path.join(root, 'vendor', 'whisper.cpp')
const buildDir = path.join(src, 'build-flowa')
const out = path.join(root, 'resources', 'bin', `${process.platform}-${process.arch}`)
const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
  fs.mkdirSync(path.dirname(src), { recursive: true })
  sh('git', ['clone', '--depth', '1', '--branch', TAG, 'https://github.com/ggml-org/whisper.cpp.git', src])
}

// FLOWA_WHISPER_VARIANT=cuda|vulkan writes whisper-server-<variant> beside the
// default binary so a release can ship more than one GPU backend.
const variant = process.env.FLOWA_WHISPER_VARIANT === 'cuda' || process.env.FLOWA_WHISPER_VARIANT === 'vulkan'
  ? process.env.FLOWA_WHISPER_VARIANT
  : ''
const wantCuda = variant === 'cuda' || process.env.FLOWA_GGML_CUDA === '1'
const wantVulkan = variant === 'vulkan' || process.env.FLOWA_GGML_VULKAN === '1'
const wantMetal = process.platform === 'darwin' && !wantCuda && !wantVulkan

const flags = [
  '-S', src, '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF'
]
if (wantMetal) flags.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0')
if (wantVulkan) flags.push('-DGGML_VULKAN=ON')
if (wantCuda) flags.push('-DGGML_CUDA=ON')
if (process.platform !== 'darwin') flags.push('-DGGML_NATIVE=OFF') // portable binaries for distribution

sh('cmake', flags)
sh('cmake', ['--build', buildDir, '--config', 'Release', '-j', String(os.availableParallelism?.() ?? 4), '--target', 'whisper-server', 'whisper-cli'])

fs.mkdirSync(out, { recursive: true })
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n)
const suffix = variant ? `-${variant}` : ''
for (const name of ['whisper-server', 'whisper-cli']) {
  const candidates = [path.join(buildDir, 'bin', exe(name)), path.join(buildDir, 'bin', 'Release', exe(name))]
  const found = candidates.find((c) => fs.existsSync(c))
  if (!found) throw new Error(`build produced no ${name}`)
  const dest = path.join(out, exe(`${name}${suffix}`))
  fs.copyFileSync(found, dest)
  fs.chmodSync(dest, 0o755)
}

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
fs.writeFileSync(path.join(out, 'VERSION'), `whisper.cpp ${TAG}${suffix ? ` (${variant})` : ''}\n`)
console.log(`whisper.cpp ${TAG}${suffix ? ` [${variant}]` : ''} → ${out}`)
