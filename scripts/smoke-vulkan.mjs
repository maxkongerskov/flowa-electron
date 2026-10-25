#!/usr/bin/env node
// Transcribe one wav with the staged CPU engine and the Vulkan engine.
// Prints both transcripts and wall times. With --require-vulkan the texts
// must match and the Vulkan run must finish. A Vulkan process with no usable
// loader must exit on its own; this script does not leave that process running.
//
//   node scripts/smoke-vulkan.mjs \
//     --bin resources/bin/linux-x64 \
//     --model models/ggml-tiny.en.bin \
//     --wav tests/fixtures/quick_brown_fox.wav \
//     --require-vulkan
//
// GGML_VK_VISIBLE_DEVICES=0 makes ggml use device 0 even when that device is
// lavapipe (VK_PHYSICAL_DEVICE_TYPE_CPU), which the automatic picker skips.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT_MS = 180_000
const FAIL_FAST_MS = 30_000

function flag(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) {
    console.error(`missing ${name}`)
    process.exit(2)
  }
  return process.argv[index + 1]
}

const binDir = path.resolve(flag('--bin'))
const model = path.resolve(flag('--model'))
const wav = path.resolve(flag('--wav'))
const requireVulkan = process.argv.includes('--require-vulkan')
const windows = process.platform === 'win32'
const exe = (name) => (windows ? `${name}.exe` : name)

function exists(file) {
  return fs.existsSync(file)
}

const cpuCli = path.join(binDir, exe('whisper-cli'))
const vulkanDir = path.join(binDir, 'whisper-server-vulkan')
const vulkanCli = path.join(vulkanDir, exe('whisper-cli'))
const cpuServer = path.join(binDir, exe('whisper-server'))
const vulkanServer = path.join(vulkanDir, exe('whisper-server'))

for (const file of [cpuServer, vulkanServer, model, wav]) {
  if (!exists(file)) {
    console.error(`missing ${file}`)
    process.exit(1)
  }
}

function libraryEnv(dir, extra = {}) {
  const env = { ...process.env, ...extra }
  if (windows) env.PATH = [dir, env.PATH].filter(Boolean).join(';')
  else env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  return env
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function runServer(bin, gpu, env, timeoutMs) {
  const port = await freePort()
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', '4', '-l', 'en']
  if (!gpu) args.push('-ng')
  const started = Date.now()
  const child = spawn(bin, args, { cwd: path.dirname(bin), env, windowsHide: true })
  let log = ''
  child.stdout?.on('data', (chunk) => { log += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk) => { log += chunk.toString('utf8') })
  const deadline = Date.now() + timeoutMs
  let ready = false
  let error = ''
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        error = `exited ${child.exitCode} before listening`
        break
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        /* model still loading */
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready && !error) error = `did not listen within ${timeoutMs}ms`
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('close', () => resolve()))
    }
  }
  return { ready, ms: Date.now() - started, error, tail: log.trim().split(/\r?\n/).slice(-12).join('\n') }
}

function cliArgs(gpu) {
  const outBase = path.join(os.tmpdir(), `flowa-smoke-${process.pid}-${Date.now()}`)
  const args = [
    '-m', model,
    '-f', wav,
    '-l', 'en',
    '-t', '4',
    '-bs', '1',
    '-bo', '1',
    '-tp', '0',
    '-tpi', '0.2',
    '-et', '2.4',
    '-lpt', '-1',
    '-nth', '0.6',
    '-np',
    '-otxt',
    '-of', outBase
  ]
  if (!gpu) args.push('-ng')
  return { args, textFile: `${outBase}.txt` }
}

function runCli(bin, gpu, env, timeoutMs) {
  const { args, textFile } = cliArgs(gpu)
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: path.dirname(bin), env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, stdout, stderr: `${stderr}\n(timeout ${timeoutMs}ms)`, ms: Date.now() - started, text: '', timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, ms: Date.now() - started, text: '', timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let text = ''
      try { text = fs.readFileSync(textFile, 'utf8') } catch { text = '' }
      fs.rmSync(textFile, { force: true })
      resolve({ code, stdout, stderr, ms: Date.now() - started, text: text.trim(), timedOut: false })
    })
  })
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function tail(result) {
  return `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-12).join('\n')
}

const report = { cpuServer: null, vulkanServer: null, cpu: null, vulkan: null, missingLoader: null }

const cpuServerResult = await runServer(cpuServer, false, libraryEnv(binDir), 120_000)
report.cpuServer = { ms: cpuServerResult.ms, ready: cpuServerResult.ready }
console.log(`CPU-SERVER ${cpuServerResult.ms}ms ready=${cpuServerResult.ready}`)
if (!cpuServerResult.ready) {
  console.error(cpuServerResult.tail)
  console.error(`CPU whisper-server ${cpuServerResult.error}`)
  process.exit(1)
}

const lvpIcd = [
  '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
  '/usr/share/vulkan/icd.d/lvp_icd.json'
].find((file) => exists(file))
const vulkanServerEnv = libraryEnv(vulkanDir, { GGML_VK_VISIBLE_DEVICES: '0' })
if (lvpIcd) {
  vulkanServerEnv.VK_DRIVER_FILES = lvpIcd
  vulkanServerEnv.VK_ICD_FILENAMES = lvpIcd
}
const vulkanServerResult = await runServer(vulkanServer, true, vulkanServerEnv, TIMEOUT_MS)
report.vulkanServer = { ms: vulkanServerResult.ms, ready: vulkanServerResult.ready, lavapipe: lvpIcd ?? null }
console.log(`VULKAN-SERVER ${vulkanServerResult.ms}ms ready=${vulkanServerResult.ready}`)
if (!vulkanServerResult.ready) {
  console.error(vulkanServerResult.tail)
  console.error(`Vulkan whisper-server ${vulkanServerResult.error}`)
  process.exit(1)
}

if (!exists(cpuCli) || !exists(vulkanCli)) {
  if (requireVulkan) {
    console.error('whisper-cli is required for --require-vulkan transcript comparison')
    process.exit(1)
  }
  console.log('whisper-cli is not staged; transcript comparison skipped')
  console.log(JSON.stringify(report))
  process.exit(0)
}

const cpu = await runCli(cpuCli, false, libraryEnv(binDir), TIMEOUT_MS)
report.cpu = { ms: cpu.ms, code: cpu.code, text: cpu.text, timedOut: cpu.timedOut }
console.log(`CPU  ${cpu.ms}ms code=${cpu.code} text=${JSON.stringify(cpu.text)}`)
if (cpu.timedOut || cpu.code !== 0 || !cpu.text) {
  console.error(tail(cpu))
  console.error('CPU transcription did not produce text')
  process.exit(1)
}

const fakeLoader = path.join(vulkanDir, windows ? 'vulkan-1.dll' : 'libvulkan.so.1')
const planted = !exists(fakeLoader)
if (planted) fs.writeFileSync(fakeLoader, 'not a vulkan loader\n')
let missing
try {
  missing = await runCli(vulkanCli, true, libraryEnv(vulkanDir, {
    VK_DRIVER_FILES: path.join(os.tmpdir(), 'flowa-no-vulkan-icd'),
    VK_ICD_FILENAMES: path.join(os.tmpdir(), 'flowa-no-vulkan-icd')
  }), FAIL_FAST_MS)
} finally {
  if (planted) fs.rmSync(fakeLoader, { force: true })
}
report.missingLoader = { ms: missing.ms, code: missing.code, timedOut: missing.timedOut }
console.log(`NO-LOADER ${missing.ms}ms code=${missing.code} timedOut=${missing.timedOut}`)
if (missing.timedOut) {
  console.error(tail(missing))
  console.error('Vulkan process hung when no Vulkan loader was available')
  process.exit(1)
}

const lvp = lvpIcd
const vulkanEnv = vulkanServerEnv
const vulkan = await runCli(vulkanCli, true, vulkanEnv, TIMEOUT_MS)
report.vulkan = { ms: vulkan.ms, code: vulkan.code, text: vulkan.text, timedOut: vulkan.timedOut, lavapipe: lvp ?? null }
console.log(`VULKAN ${vulkan.ms}ms code=${vulkan.code} text=${JSON.stringify(vulkan.text)}`)
console.log(tail(vulkan))

const same = normalize(cpu.text) === normalize(vulkan.text) && vulkan.text.length > 0
console.log(`MATCH ${same}`)
console.log(`TIMING cpu=${cpu.ms}ms vulkan=${vulkan.ms}ms`)
console.log(JSON.stringify(report))

if (vulkan.timedOut) {
  console.error('Vulkan process hung')
  process.exit(1)
}
if (requireVulkan) {
  if (vulkan.code !== 0 || !vulkan.text) {
    console.error('Vulkan transcription did not produce text')
    process.exit(1)
  }
  if (!same) {
    console.error('Vulkan transcript does not match CPU')
    process.exit(1)
  }
}
