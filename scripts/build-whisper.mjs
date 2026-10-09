#!/usr/bin/env node
// Build whisper.cpp (pinned tag) → resources/bin/<platform>-<arch>/whisper-server(+cli).
// macOS: Metal is embedded (GGML_METAL_EMBED_LIBRARY). Windows/Linux: CPU by default;
// set FLOWA_GGML_VULKAN=1 or FLOWA_GGML_CUDA=1 to enable a GPU backend.
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
if (process.platform === 'darwin') flags.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0')
if (process.env.FLOWA_GGML_VULKAN === '1') flags.push('-DGGML_VULKAN=ON')
if (process.env.FLOWA_GGML_CUDA === '1') flags.push('-DGGML_CUDA=ON')
if (process.platform !== 'darwin') flags.push('-DGGML_NATIVE=OFF') // portable binaries for distribution

sh('cmake', flags)
sh('cmake', ['--build', buildDir, '--config', 'Release', '-j', String(os.availableParallelism?.() ?? 4), '--target', 'whisper-server', 'whisper-cli'])

fs.mkdirSync(out, { recursive: true })
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n)
for (const name of ['whisper-server', 'whisper-cli']) {
  const candidates = [path.join(buildDir, 'bin', exe(name)), path.join(buildDir, 'bin', 'Release', exe(name))]
  const found = candidates.find((c) => fs.existsSync(c))
  if (!found) throw new Error(`build produced no ${name}`)
  fs.copyFileSync(found, path.join(out, exe(name)))
  fs.chmodSync(path.join(out, exe(name)), 0o755)
}
fs.writeFileSync(path.join(out, 'VERSION'), `whisper.cpp ${TAG}\n`)
console.log(`whisper.cpp ${TAG} → ${out}`)
