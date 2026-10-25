#!/usr/bin/env node
// Stage the official whisper.cpp b5454 CPU engine (the 1.2.2 Windows / Linux
// binaries) into resources/bin. Does not remove whisper-server-vulkan/.
// Release builds on the Mac already have this tree; CI uses this script so the
// packaged smoke test contains the same CPU files the installer ships.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Official whisper-bin-x64.zip also ships SDL2, llama, wchess, talk-llama,
 * and the upstream example executables. whisper-server.exe loads whisper.dll,
 * ggml.dll, and ggml-base.dll. ggml then loads the ggml-cpu-*.dll variants
 * from the same directory. Nothing else in that zip is used.
 */
export function windowsWhisperServerFile(name) {
  const base = path.basename(name).toLowerCase()
  if (base === 'whisper-server.exe' || base === 'whisper.dll') return true
  return base.startsWith('ggml') && base.endsWith('.dll')
}

const COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
const BASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const jobs = [
  {
    url: `${BASE}/whisper-bin-x64.zip`,
    archive: 'win.zip',
    dest: path.join(root, 'resources', 'bin', 'win32-x64'),
    flatten: 'Release'
  },
  {
    url: `${BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    archive: 'linux.tar.gz',
    dest: path.join(root, 'resources', 'bin', 'linux-x64'),
    flatten: 'whisper-bin-ubuntu-x64'
  }
]

function stage() {
const only = process.argv.includes('--linux') ? 'linux-x64' : process.argv.includes('--windows') ? 'win32-x64' : ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-cpu-engine-'))

for (const job of jobs) {
  if (only && !job.dest.endsWith(only)) continue
  const windows = path.basename(job.dest) === 'win32-x64'
  const archive = path.join(tmp, job.archive)
  execFileSync('curl', ['-fsSL', '-o', archive, job.url], { stdio: 'inherit' })
  const extract = path.join(tmp, path.basename(job.dest))
  fs.mkdirSync(extract, { recursive: true })
  if (process.platform === 'win32') execFileSync('tar', ['-xf', archive, '-C', extract], { stdio: 'inherit' })
  else if (archive.endsWith('.zip')) execFileSync('unzip', ['-q', archive, '-d', extract], { stdio: 'inherit' })
  else execFileSync('tar', ['-xzf', archive, '-C', extract], { stdio: 'inherit' })
  const source = path.join(extract, job.flatten)
  fs.mkdirSync(job.dest, { recursive: true })
  const kept = []
  const dropped = []
  for (const name of fs.readdirSync(source)) {
    if (name === 'whisper-server-vulkan') continue
    if (windows && !windowsWhisperServerFile(name)) {
      dropped.push(name)
      continue
    }
    copyPreservingLinks(path.join(source, name), path.join(job.dest, name))
    kept.push(name)
  }
  if (windows) {
    for (const name of fs.readdirSync(job.dest)) {
      if (name === 'whisper-server-vulkan' || name === 'whisper-backends.json' || name === 'CPU-VERSION') continue
      const full = path.join(job.dest, name)
      if (fs.statSync(full).isDirectory()) continue
      if (!windowsWhisperServerFile(name)) {
        fs.rmSync(full, { force: true })
        if (!dropped.includes(name)) dropped.push(name)
      }
    }
    for (const name of ['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll']) {
      if (!fs.existsSync(path.join(job.dest, name))) throw new Error(`Windows CPU engine missing ${name}`)
    }
    console.log(`Windows CPU kept: ${kept.sort().join(', ')}`)
    console.log(`Windows CPU dropped: ${dropped.sort().join(', ')}`)
  }
  const manifestPath = path.join(job.dest, 'whisper-backends.json')
  let manifest = { default: ['cpu'], binaries: { cuda: false, vulkan: false } }
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { /* keep default */ }
  }
  manifest.default = Array.isArray(manifest.default) && manifest.default.includes('cpu') ? manifest.default : ['cpu']
  manifest.binaries = { cuda: !!manifest.binaries?.cuda, vulkan: !!manifest.binaries?.vulkan }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(job.dest, 'CPU-VERSION'), `whisper.cpp v1.9.5 ${COMMIT} b5454 cpu\n`)
  if (process.platform !== 'win32') {
    for (const name of ['whisper-server', 'whisper-cli']) {
      const file = path.join(job.dest, name)
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755)
    }
  }
  console.log(`CPU engine → ${job.dest}`)
}
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) stage()

// fs.cpSync rewrites a relative symlink (libggml.so.0 -> libggml.so.0.26.0)
// into an absolute path under the temp extract directory. The installed engine
// then cannot open its own libraries.
function copyPreservingLinks(src, dest) {
  const stat = fs.lstatSync(src)
  fs.rmSync(dest, { force: true, recursive: true })
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(src)
    if (path.isAbsolute(link)) throw new Error(`${src} symlink target ${link} is absolute`)
    fs.symlinkSync(link, dest)
    return
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const name of fs.readdirSync(src)) copyPreservingLinks(path.join(src, name), path.join(dest, name))
    return
  }
  fs.copyFileSync(src, dest)
}
