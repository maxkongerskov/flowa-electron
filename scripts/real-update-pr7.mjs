#!/usr/bin/env node
// Install the published Flowa 1.2.3 and update it to the 1.2.4 built from
// this checkout (PR #7 plus a test-only version bump). The feed is a local
// HTTP server. The installed 1.2.3 copy is pointed at that server by editing
// its app-update.yml and the setFeedURL call inside that install's app.asar.
// The feed is signed with a throwaway key generated in this process. The
// release update private key is not read.
//
// The published installers include the speech model (~1.6 GB). Their sha256
// is checked before anything is modified. The model and engine are removed
// from the copy that performs the update so startup does not load them. The
// 1.2.4 package is the default electron-builder config: no speech model.
//
// On Windows, the same job also transcribes an 8-minute looped speech WAV
// through the packaged app (FLOWA_SELFTEST) on the published 1.2.3 build and
// on this 1.2.4 build, both forced onto the CPU engine.
//
//   node scripts/real-update-pr7.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliInvocation, passwordlessPkexecDir, windowsInstallerArgs, windowsInstalledExe } from './e2e-update.mjs'
import { patchInstalledResources, squashfsOffset } from './patch-installed-feed.mjs'
import { writeUpdateFeeds } from './update-feed.mjs'
import { generateUpdateKeyPair } from './update-trust.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FROM_TAG = 'v1.2.3'
export const TO = '1.2.4'
const RELEASE_BASE = `https://github.com/maxkongerskov/flowa-electron/releases/download/${FROM_TAG}`
const HISTORY_TEXT = 'bridge-history-1.2.3-token'
/** Looped speech sent through the packaged transcriber. 8 minutes is the long clip. */
export const LONG_DICTATION_SECONDS = 8 * 60
const MIN_TIMEOUT_DECODE_SECONDS = 295
// Home rewrites a saved microphone id that is not a visible audio device to
// "default". CI runners enumerate no devices, so an unknown id survives there
// and is rewritten on a real Mac. Seed the sentinel the app already stores.
const MIC = 'default'
const LANG = 'da'

const ASSETS = {
  appimage: {
    name: 'Flowa-1.2.3.AppImage',
    sha256: '82552d6d80fbb71f397454ea96393bdb35ad4a2fb46c0f9d9bba8f56fa1babd9'
  },
  deb: {
    name: 'flowa_1.2.3_amd64.deb',
    sha256: '8afbdd1038eacc974f1be150f0b45a6e609ce8c8b7401f54b493fcd0e30eb6a5'
  },
  nsis: {
    name: 'Flowa-Setup-1.2.3-x64.exe',
    sha256: '9af23ee0ec40bee4628cf28e3982677a2be8e3502dbc9eb365b67ae64a95e56d'
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `1.2.3` matches the Windows resource form `1.2.3.0`. `1.2.30` does not. */
export function versionMatches(actual, expected) {
  return actual === expected || actual.startsWith(`${expected}.`)
}

/**
 * NSIS quitAndInstall exits the old app as soon as the installer is spawned.
 * Poll until the installed executable reports the new version. A read can fail
 * while the installer is replacing the file.
 */
export async function readVersionWhenReady(readVersion, expected, timeoutMs, pauseMs = 1000) {
  const started = Date.now()
  let last = 'unread'
  while (Date.now() - started < timeoutMs) {
    try {
      const version = await readVersion()
      if (versionMatches(version, expected)) return
      last = `version ${version}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) break
    await delay(Math.min(pauseMs, remaining))
  }
  throw new Error(`installed version did not become ${expected}: ${last}`)
}

function windowsProductVersion(exe) {
  const literal = `'${exe.replace(/'/g, "''")}'`
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `[System.Diagnostics.FileVersionInfo]::GetVersionInfo(${literal}).ProductVersion`
  ], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || 'version query failed').trim())
  }
  const version = String(result.stdout ?? '').trim()
  if (!version) throw new Error('product version is empty')
  return version
}

function run(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
  })
}

function runNodeCli(name, args, env = process.env) {
  const invoked = cliInvocation(name, args)
  return run(invoked.command, invoked.args, env)
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function copyPrefix(src, dest, bytes) {
  return new Promise((resolve, reject) => {
    const input = createReadStream(src, { start: 0, end: bytes - 1 })
    const output = createWriteStream(dest)
    input.on('error', reject)
    output.on('error', reject)
    output.on('finish', resolve)
    input.pipe(output)
  })
}

function concatFiles(parts, dest) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(dest)
    output.on('error', reject)
    output.on('finish', resolve)
    const next = (index) => {
      if (index >= parts.length) {
        output.end()
        return
      }
      const input = createReadStream(parts[index])
      input.on('error', reject)
      input.on('end', () => next(index + 1))
      input.pipe(output, { end: false })
    }
    next(0)
  })
}

function serve(dir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = path.resolve(dir, name)
    if (!file.startsWith(path.resolve(dir)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Length': statSync(file).size, 'Content-Type': 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/` })
    })
  })
}

async function downloadAsset(spec, dest) {
  const url = `${RELEASE_BASE}/${spec.name}`
  console.log(`▶ download ${url}`)
  await run('curl', ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '-o', dest, url])
  const got = await sha256File(dest)
  if (got !== spec.sha256) throw new Error(`${spec.name} sha256 ${got} != published ${spec.sha256}`)
  console.log(`✓ ${spec.name} matches the published sha256`)
}

function findFile(dir, predicate, label) {
  const names = readdirSync(dir).filter((item) => {
    const full = path.join(dir, item)
    return statSync(full).isFile() && predicate(item)
  })
  if (names.length !== 1) throw new Error(`expected one ${label} in ${dir}, found ${names.join(', ') || 'none'}`)
  return path.join(dir, names[0])
}

function ensureEmptyEngineDir() {
  const name = process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? `darwin-${process.arch}` : 'linux-x64'
  const bin = path.join(root, 'resources', 'bin', name)
  if (!existsSync(bin)) {
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, '.keep'), '')
  }
  const mac = path.join(root, 'resources', 'mac')
  if (!existsSync(mac)) {
    mkdirSync(mac, { recursive: true })
    writeFileSync(path.join(mac, '.keep'), '')
  }
}

async function buildSlim(outDir, builderArgs) {
  ensureEmptyEngineDir()
  const env = { ...process.env }
  delete env.FLOWA_E2E_UPDATES
  console.log(`▶ build slim ${TO} ${builderArgs.join(' ')}`)
  // The slim package is the app under test. It is not published.
  await runNodeCli('electron-vite', ['build'], env)
  rmSync(outDir, { recursive: true, force: true })
  await runNodeCli('electron-builder', [
    '--config', 'electron-builder.yml',
    `--config.directories.output=${outDir}`,
    '--publish', 'never',
    ...builderArgs
  ], env)
}

function userDataDir(home) {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Flowa-Electron')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Flowa-Electron')
  return path.join(home, '.config', 'Flowa-Electron')
}

function seedUserData(dir) {
  mkdirSync(dir, { recursive: true })
  const prefs = {
    'flowa.language': LANG,
    'flowa.microphone': MIC,
    'flowa.colorScheme.dark': true,
    'flowa.onboardingComplete': true,
    'flowa.firstRunComplete': true,
    'flowa.maxDurationMinutes': 60,
    'flowa.shortcut': 'Alt+Space',
    'flowa.hardware': 'gpu',
    'flowa.speechModel': 'whisper-turbo'
  }
  writeFileSync(path.join(dir, 'prefs.json'), `${JSON.stringify(prefs, null, 2)}\n`)
  const recent = [{
    date: '2026-10-20T12:00:00Z',
    id: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    targetAppName: 'Notes',
    text: HISTORY_TEXT
  }]
  writeFileSync(path.join(dir, 'recent.json'), `${JSON.stringify(recent, null, 2)}\n`)
}

function assertUserData(dir) {
  const prefs = JSON.parse(readFileSync(path.join(dir, 'prefs.json'), 'utf8'))
  if (prefs['flowa.language'] !== LANG) throw new Error(`language changed to ${prefs['flowa.language']}`)
  if (prefs['flowa.microphone'] !== MIC) throw new Error(`microphone changed to ${prefs['flowa.microphone']}`)
  if (prefs['flowa.hardware'] !== 'gpu') throw new Error(`hardware changed to ${prefs['flowa.hardware']}`)
  const recent = JSON.parse(readFileSync(path.join(dir, 'recent.json'), 'utf8'))
  if (!Array.isArray(recent) || !recent.some((item) => item && item.text === HISTORY_TEXT)) {
    throw new Error(`${FROM_TAG} history text is missing after the update`)
  }
  console.log(`prefs preserved language=${prefs['flowa.language']} microphone=${prefs['flowa.microphone']} hardware=${prefs['flowa.hardware']} history=${HISTORY_TEXT}`)
}

function launchEnv(home, display) {
  const env = { ...process.env, HOME: home }
  delete env.FLOWA_UPDATE_FEED
  delete env.FLOWA_UPDATE_PUBLIC_KEY
  delete env.FLOWA_E2E_UPDATES
  delete env.FLOWA_E2E_AUTO_UPDATE
  delete env.XAUTHORITY
  // A inherited DISPLAY often points at a server this process cannot use.
  if (display) env.DISPLAY = display
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
    env.USERPROFILE = home
  } else {
    env.XDG_CONFIG_HOME = path.join(home, '.config')
    env.XDG_CACHE_HOME = path.join(home, '.cache')
  }
  return env
}

function spawnLogged(command, args, env, logFile) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const log = createWriteStream(logFile)
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const state = { child, exitCode: null }
  child.on('exit', (code) => {
    state.exitCode = code ?? 0
  })
  return state
}

function stopTree(state) {
  const pid = state?.child?.pid
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

function killProduct() {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/IM', 'Flowa.exe'], { stdio: 'ignore' })
    return
  }
  const listed = spawnSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' })
  for (const line of String(listed.stdout ?? '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)/)
    if (!match) continue
    const pid = Number(match[1])
    const comm = match[2]
    if (pid === process.pid) continue
    // The deb executable is `flowa`. The AppImage runtime is `Flowa-1.2.*`.
    if (comm === 'Flowa' || comm === 'flowa' || comm.startsWith('Flowa-1.2.')) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

function readLog(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

async function waitForUpdate(state, logFile, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const text = readLog(logFile)
    if (text.includes('rejected update signature') || text.includes('update download failed')) {
      throw new Error(`update failed\n${text.slice(-4000)}`)
    }
    if (state.exitCode !== null && !text.includes(`update available: ${TO}`)) {
      throw new Error(`${FROM_TAG} exited ${state.exitCode} before offering ${TO}\n${text.slice(-4000)}`)
    }
    if (text.includes(`update available: ${TO}`) && state.exitCode !== null) return text
    await delay(500)
  }
  throw new Error(`timed out waiting for ${FROM_TAG} to install ${TO}\n${readLog(logFile).slice(-4000)}`)
}

async function waitForLines(logFile, lines, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const text = readLog(logFile)
    if (lines.every((line) => text.includes(line))) return text
    await delay(300)
  }
  throw new Error(`timed out waiting for ${lines.join(' and ')}\n${readLog(logFile).slice(-4000)}`)
}

function findResources(tree) {
  const visit = (dir, depth) => {
    if (existsSync(path.join(dir, 'app.asar'))) return dir
    if (depth >= 4) return null
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      let info
      try { info = statSync(full) } catch { continue }
      if (!info.isDirectory()) continue
      const found = visit(full, depth + 1)
      if (found) return found
    }
    return null
  }
  const found = visit(tree, 0)
  if (!found) throw new Error(`app.asar not found under ${tree}`)
  return found
}

function lighten(resourcesDir) {
  for (const name of ['models', 'bin']) {
    const target = path.join(resourcesDir, name)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    console.log(`removed installed ${name} so ${FROM_TAG} does not load the bundled model`)
  }
}

function lightenSudo(resourcesDir) {
  for (const name of ['models', 'bin']) {
    const target = path.join(resourcesDir, name)
    const result = spawnSync('sudo', ['-n', 'rm', '-rf', target], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`could not remove ${target}`)
    console.log(`removed installed ${name} so ${FROM_TAG} does not load the bundled model`)
  }
}

async function patchOwned(resourcesDir, options) {
  try {
    await patchInstalledResources(resourcesDir, options)
    return
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : ''
    if (code !== 'EACCES' && code !== 'EPERM') throw err
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'flowa-root-patch-'))
  copyFileSync(path.join(resourcesDir, 'app.asar'), path.join(tmp, 'app.asar'))
  await patchInstalledResources(tmp, options)
  const asarCopy = spawnSync('sudo', ['-n', 'cp', path.join(tmp, 'app.asar'), path.join(resourcesDir, 'app.asar')], { stdio: 'inherit' })
  const ymlCopy = spawnSync('sudo', ['-n', 'cp', path.join(tmp, 'app-update.yml'), path.join(resourcesDir, 'app-update.yml')], { stdio: 'inherit' })
  rmSync(tmp, { recursive: true, force: true })
  if (asarCopy.status !== 0 || ymlCopy.status !== 0) throw new Error('could not copy the patched asar back into the install')
}

async function repackAppImage(original, dest, mutate) {
  const offset = squashfsOffset(original)
  const dir = path.dirname(dest)
  const prefix = path.join(dir, 'runtime-prefix')
  const tree = path.join(dir, 'squashfs-root')
  const squash = `${dest}.squash`
  await copyPrefix(original, prefix, offset)
  rmSync(tree, { recursive: true, force: true })
  const extracted = spawnSync('unsquashfs', ['-o', String(offset), '-dest', tree, original], { cwd: root, stdio: 'inherit' })
  if (extracted.status !== 0) throw new Error(`unsquashfs exited ${extracted.status}`)
  rmSync(original, { force: true })
  await mutate(tree)
  const packed = spawnSync('mksquashfs', [tree, squash, '-noappend', '-comp', 'gzip'], { cwd: root, stdio: 'inherit' })
  if (packed.status !== 0) throw new Error(`mksquashfs exited ${packed.status}`)
  await concatFiles([prefix, squash], dest)
  chmodSync(dest, 0o755)
  rmSync(tree, { recursive: true, force: true })
  rmSync(squash, { force: true })
  rmSync(prefix, { force: true })
}

async function publishFeed(work, artifact) {
  const feed = path.join(work, 'feed')
  rmSync(feed, { recursive: true, force: true })
  mkdirSync(feed)
  copyFileSync(artifact, path.join(feed, path.basename(artifact)))
  const pair = generateUpdateKeyPair()
  await writeUpdateFeeds(feed, TO, { privateKeyPem: pair.privateKey, blockMaps: false, releaseDate: '2026-10-25T00:00:00.000Z' })
  const served = await serve(feed)
  return { ...served, publicKey: pair.publicKey }
}

function startXvfb(work) {
  const display = ':99'
  const log = createWriteStream(path.join(work, 'xvfb.log'))
  const child = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-ac'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY: display }
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const state = {
    display,
    child,
    stop() {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }
  return state
}

async function exercise(label, spec) {
  const home = path.join(spec.work, 'home')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const data = userDataDir(home)
  seedUserData(data)
  const base = launchEnv(home, spec.display)
  const env = { ...base, ...(spec.envExtra ?? {}) }
  killProduct()
  const logFile = path.join(spec.work, 'update.log')
  rmSync(logFile, { force: true })
  console.log(`version before: ${FROM_TAG}`)
  console.log(`▶ ${label}: launch installed ${FROM_TAG}`)
  const state = spawnLogged(spec.command, spec.args, env, logFile)
  try {
    await waitForUpdate(state, logFile, 12 * 60 * 1000)
  } finally {
    stopTree(state)
  }
  console.log(`▶ ${label}: check installed ${TO}`)
  await spec.versionCheck()
  killProduct()
  await delay(1000)
  const observeLog = path.join(spec.work, 'observe.log')
  rmSync(observeLog, { force: true })
  const observeEnv = { ...base, ...(spec.observeEnv ?? spec.envExtra ?? {}) }
  console.log(`▶ ${label}: restart ${TO}`)
  const observed = spawnLogged(spec.observeCommand, spec.observeArgs, observeEnv, observeLog)
  try {
    const text = await waitForLines(observeLog, [`[Flowa] version ${TO}`, 'speech plan: backend=cpu'], 90_000)
    const versionLine = text.match(/\[Flowa\] version \S+/)?.[0] ?? ''
    const planLine = text.match(/\[Flowa\] speech plan: [^\n]+/)?.[0] ?? ''
    console.log(`observed ${versionLine}`)
    console.log(`observed ${planLine}`)
    if (/speech plan: backend=(vulkan|cuda|metal)/.test(text)) {
      throw new Error(`runner selected a GPU backend\n${text.slice(-2000)}`)
    }
    assertUserData(data)
  } finally {
    stopTree(observed)
  }
}

function canSudo() {
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0
}

async function runAppImage(work, built, display) {
  const downloaded = path.join(work, ASSETS.appimage.name)
  await downloadAsset(ASSETS.appimage, downloaded)
  const patched = path.join(work, 'Flowa-1.2.3.AppImage')
  const { server, url, publicKey } = await publishFeed(work, built)
  try {
    console.log(`▶ AppImage: repack published ${FROM_TAG} without the model, with the local feed`)
    await repackAppImage(downloaded, patched, async (tree) => {
      const resources = findResources(tree)
      lighten(resources)
      await patchInstalledResources(resources, { feedUrl: url, publicKeyPem: publicKey })
    })
    const updated = path.join(path.dirname(patched), path.basename(built))
    await exercise('AppImage', {
      work,
      display,
      command: patched,
      args: ['--no-sandbox'],
      observeCommand: updated,
      observeArgs: ['--no-sandbox'],
      envExtra: { APPIMAGE_EXTRACT_AND_RUN: '1', APPIMAGE: patched },
      observeEnv: { APPIMAGE_EXTRACT_AND_RUN: '1', APPIMAGE: updated },
      versionCheck: async () => {
        if (!existsSync(updated)) throw new Error(`updater did not write ${updated}`)
        if (statSync(updated).size !== statSync(built).size) {
          throw new Error(`updated AppImage is ${statSync(updated).size} bytes, built artifact is ${statSync(built).size}`)
        }
      }
    })
  } finally {
    server.close()
  }
}

async function runDeb(work, built, display) {
  if (!canSudo()) throw new Error('deb update needs passwordless sudo')
  const downloaded = path.join(work, ASSETS.deb.name)
  await downloadAsset(ASSETS.deb, downloaded)
  const { server, url, publicKey } = await publishFeed(work, built)
  const sudoBin = passwordlessPkexecDir(path.join(work, 'sudo-bin'))
  try {
    spawnSync('sudo', ['-n', 'apt-get', 'remove', '-y', 'flowa'], { stdio: 'inherit' })
    console.log(`▶ deb: install published ${FROM_TAG}`)
    const installed = spawnSync('sudo', ['-n', 'apt-get', 'install', '-y', downloaded], { cwd: root, stdio: 'inherit' })
    if (installed.status !== 0) throw new Error(`apt install exited ${installed.status}`)
    rmSync(downloaded, { force: true })
    const listed = spawnSync('dpkg', ['-L', 'flowa'], { encoding: 'utf8' })
    const lines = String(listed.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    const exe = ['/opt/Flowa/flowa', '/opt/Flowa/Flowa'].find((candidate) => lines.includes(candidate))
      ?? lines.find((line) => {
        if (!line.startsWith('/opt/') || !(line.endsWith('/flowa') || line.endsWith('/Flowa'))) return false
        try { return statSync(line).isFile() } catch { return false }
      })
    if (!exe || !existsSync(exe) || !statSync(exe).isFile()) {
      throw new Error(`deb did not install /opt/Flowa/flowa\n${listed.stdout}`)
    }
    const resources = path.join(path.dirname(exe), 'resources')
    lightenSudo(resources)
    await patchOwned(resources, { feedUrl: url, publicKeyPem: publicKey })
    await exercise('deb', {
      work,
      display,
      command: exe,
      args: ['--no-sandbox'],
      observeCommand: exe,
      observeArgs: ['--no-sandbox'],
      envExtra: { PATH: `${sudoBin}${path.delimiter}${process.env.PATH ?? ''}` },
      versionCheck: async () => {
        const query = spawnSync('dpkg-query', ['-W', '-f', '${Version}', 'flowa'], { encoding: 'utf8' })
        const version = String(query.stdout ?? '').trim()
        console.log(`version after: ${version || '(empty)'}`)
        if (version !== TO) throw new Error(`installed deb version is ${version || '(empty)'}`)
      }
    })
  } finally {
    server.close()
    spawnSync('sudo', ['-n', 'apt-get', 'remove', '-y', 'flowa'], { stdio: 'inherit' })
  }
}

function writeWavHeader(out, dataBytes, sampleRate) {
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)
}

/** PCM 16-bit mono at 16 kHz. Stereo or another rate is mixed and resampled. */
export function readPcm16(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('speech synthesis did not write a WAV file')
  }
  let off = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let data = null
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4)
    const size = wav.readUInt32LE(off + 4)
    const start = off + 8
    if (start + size > wav.length) break
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(start + 2)
      sampleRate = wav.readUInt32LE(start + 4)
      bits = wav.readUInt16LE(start + 14)
    } else if (id === 'data') {
      data = wav.subarray(start, start + size)
    }
    off = start + size + (size % 2)
  }
  if (!data || bits !== 16 || channels < 1 || sampleRate < 1) {
    throw new Error(`unsupported synthesized WAV (rate=${sampleRate} channels=${channels} bits=${bits})`)
  }
  if (channels === 1 && sampleRate === 16000) return Buffer.from(data)
  const frames = Math.floor(data.length / 2 / channels)
  const mono = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < channels; c++) acc += data.readInt16LE((i * channels + c) * 2)
    mono[i] = Math.max(-32768, Math.min(32767, Math.round(acc / channels)))
  }
  const outFrames = Math.max(1, Math.round(frames * 16000 / sampleRate))
  const pcm = Buffer.alloc(outFrames * 2)
  for (let i = 0; i < outFrames; i++) {
    const src = Math.min(frames - 1, Math.floor(i * sampleRate / 16000))
    pcm.writeInt16LE(mono[src], i * 2)
  }
  return pcm
}

/** Repeat 16-bit PCM until `seconds` at 16 kHz and wrap a 44-byte WAV header. */
export function loopPcmToWav(pcm, seconds, sampleRate = 16000) {
  if (pcm.length < 2 || pcm.length % 2 !== 0) throw new Error('synthesized speech PCM is empty')
  const dataBytes = seconds * sampleRate * 2
  const out = Buffer.alloc(44 + dataBytes)
  writeWavHeader(out, dataBytes, sampleRate)
  let offset = 44
  while (offset < out.length) {
    const n = Math.min(pcm.length, out.length - offset)
    pcm.copy(out, offset, 0, n)
    offset += n
  }
  return out
}

/** Pull the packaged self-test lines out of a Flowa log. */
export function parseDictationLog(text) {
  const version = text.match(/\[Flowa\] version (\S+)/)?.[1] ?? null
  const plan = text.match(/\[Flowa\] speech plan: ([^\n]+)/)?.[1] ?? null
  const backend = plan?.match(/backend=(\S+)/)?.[1] ?? null
  const gpu = plan?.match(/\bgpu=(\S+)/)?.[1] ?? null
  const transcript = text.match(/\[selftest\] transcript \(([0-9.]+)s, lang=[^)]*\): (.*)/)
  const decodeSeconds = transcript ? Number(transcript[1]) : null
  const payload = transcript ? transcript[2].trim() : null
  const decodeError = text.match(/\[selftest\] decode error: (.*)/)?.[1]?.trim() ?? null
  const failed = text.includes('[selftest] FAILED:')
  const hasText = !!payload && payload !== 'null' && payload !== '""'
  return { version, plan, backend, gpu, decodeSeconds, payload, decodeError, failed, hasText }
}

/** Published 1.2.3 must die with fetch failed after 300s. The PR build must return text past that. */
export function judgeLongDictation(published, built) {
  const problems = []
  const versionOk = (actual, expected) => actual === expected || actual === `${expected}.0`
  if (!versionOk(published.version, '1.2.3')) problems.push(`published version log is ${published.version}`)
  if (published.backend !== 'cpu' || published.gpu === 'true') problems.push(`published speech plan is not CPU: ${published.plan}`)
  if (!published.decodeError || !published.decodeError.includes('fetch failed')) {
    problems.push(`published decode did not fail with fetch failed (${published.decodeError ?? 'no error'}, hasText=${published.hasText})`)
  }
  if (published.decodeSeconds == null || published.decodeSeconds < MIN_TIMEOUT_DECODE_SECONDS) {
    problems.push(`published decode was ${published.decodeSeconds}s, wanted >= ${MIN_TIMEOUT_DECODE_SECONDS}s`)
  }
  if (!versionOk(built.version, TO)) problems.push(`pr build version log is ${built.version}`)
  if (built.backend !== 'cpu' || built.gpu === 'true') problems.push(`pr build speech plan is not CPU: ${built.plan}`)
  if (!built.hasText || built.decodeError || built.failed) {
    problems.push(`pr build did not return text (${built.decodeError ?? built.payload ?? 'no transcript'})`)
  }
  if (built.decodeSeconds == null || built.decodeSeconds < MIN_TIMEOUT_DECODE_SECONDS) {
    problems.push(`pr build decode was ${built.decodeSeconds}s, wanted >= ${MIN_TIMEOUT_DECODE_SECONDS}s`)
  }
  return problems
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function synthesizeSpeechPcm(work) {
  const raw = path.join(work, 'sapi-speech.wav')
  const ps1 = path.join(work, 'speak.ps1')
  writeFileSync(ps1, [
    'Add-Type -AssemblyName System.Speech',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$synth.SetOutputToWaveFile(${psQuote(raw)}, $fmt)`,
    "$line = 'This is a long dictation test for Flowa. The quick brown fox jumps over the lazy dog. '",
    '$synth.Speak($line * 8)',
    '$synth.Dispose()',
    ''
  ].join('\r\n'))
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' })
  if (result.status !== 0 || !existsSync(raw)) {
    throw new Error(`Windows speech synthesis failed\n${result.stderr || result.stdout}`)
  }
  return readPcm16(readFileSync(raw))
}

function ensureLongSpeechWav(work) {
  const dest = path.join(work, 'long-speech.wav')
  if (existsSync(dest) && statSync(dest).size > 44) return dest
  const wav = loopPcmToWav(synthesizeSpeechPcm(work), LONG_DICTATION_SECONDS)
  writeFileSync(dest, wav)
  console.log(`long speech wav ${dest} bytes=${wav.length} seconds=${LONG_DICTATION_SECONDS}`)
  return dest
}

function pinToOneCpu(pid) {
  if (process.platform !== 'win32' || !pid) return
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).ProcessorAffinity = [IntPtr]1`
  ], { encoding: 'utf8' })
  if (result.status !== 0) console.warn(`could not pin pid ${pid} to one CPU: ${String(result.stderr || result.stdout).trim()}`)
  else console.log(`pinned pid ${pid} to one CPU`)
}

function snapshotEngine(resources, cache) {
  for (const name of ['models', 'bin']) {
    const src = path.join(resources, name)
    if (!existsSync(src)) throw new Error(`published install is missing resources/${name}`)
    cpSync(src, path.join(cache, name), { recursive: true })
  }
  const server = path.join(cache, 'bin', 'whisper-server.exe')
  const model = path.join(cache, 'models', 'ggml-large-v3-turbo.bin')
  if (!existsSync(server)) throw new Error(`published engine is missing ${server}`)
  if (!existsSync(model)) throw new Error(`published model is missing ${model}`)
  console.log(`cached engine modelBytes=${statSync(model).size} server=${server}`)
}

function restoreEngine(resources, cache) {
  for (const name of ['models', 'bin']) {
    cpSync(path.join(cache, name), path.join(resources, name), { recursive: true })
  }
  console.log(`restored model and whisper binaries into ${resources}`)
}

function seedCpuDictation(home) {
  const dir = userDataDir(home)
  mkdirSync(dir, { recursive: true })
  const prefs = {
    'flowa.language': 'en',
    'flowa.microphone': 'default',
    'flowa.colorScheme.dark': true,
    'flowa.onboardingComplete': true,
    'flowa.firstRunComplete': true,
    'flowa.maxDurationMinutes': 60,
    'flowa.shortcut': 'Alt+Space',
    'flowa.hardware': 'cpu',
    'flowa.speechModel': 'whisper-turbo'
  }
  writeFileSync(path.join(dir, 'prefs.json'), `${JSON.stringify(prefs, null, 2)}\n`)
  writeFileSync(path.join(dir, 'recent.json'), '[]\n')
}

async function runPackagedDictation({ exe, work, wav, label, slow }) {
  const home = path.join(work, `dictation-home-${label}`)
  rmSync(home, { recursive: true, force: true })
  seedCpuDictation(home)
  const logFile = path.join(work, `dictation-${label}.log`)
  rmSync(logFile, { force: true })
  const env = launchEnv(home, null)
  env.FLOWA_SELFTEST = `transcribe:${wav}`
  env.FLOWA_SELFTEST_QUIT = '1'
  env.FLOWA_SELFTEST_LANG = 'en'
  env.FLOWA_PACKAGED_SMOKE = '1'
  killProduct()
  console.log(`▶ long dictation ${label}: ${exe}`)
  const state = spawnLogged(exe, ['--no-sandbox'], env, logFile)
  pinToOneCpu(state.child.pid)
  const timeoutMs = slow ? 35 * 60 * 1000 : 20 * 60 * 1000
  try {
    await waitForLines(logFile, ['[selftest] transcript'], timeoutMs)
  } catch (err) {
    console.log(`long-dictation ${label} log tail:\n${readLog(logFile).slice(-4000)}`)
    throw err
  } finally {
    stopTree(state)
    killProduct()
  }
  const parsed = parseDictationLog(readLog(logFile))
  console.log(`long-dictation\t${label}\tversion=${parsed.version}\tbackend=${parsed.backend}\tgpu=${parsed.gpu}\tdecodeSeconds=${parsed.decodeSeconds}\thasText=${parsed.hasText}\terror=${parsed.decodeError ?? ''}`)
  if (parsed.plan) console.log(`long-dictation plan ${label}: ${parsed.plan}`)
  return parsed
}

async function runNsis(work, built) {
  const downloaded = path.join(work, ASSETS.nsis.name)
  await downloadAsset(ASSETS.nsis, downloaded)
  const { server, url, publicKey } = await publishFeed(work, built)
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const perUser = windowsInstalledExe(localAppData, 'Flowa')
  const perMachine = path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'Flowa', 'Flowa.exe')
  try {
    for (const candidate of [perUser, perMachine]) {
      const uninstaller = path.win32.join(path.win32.dirname(candidate), 'Uninstall Flowa.exe')
      if (existsSync(uninstaller)) spawnSync(uninstaller, ['/S'], { stdio: 'inherit' })
    }
    console.log(`▶ NSIS: install published ${FROM_TAG}`)
    const installed = spawnSync(downloaded, windowsInstallerArgs(), { cwd: root, stdio: 'inherit' })
    if (installed.status !== 0) throw new Error(`NSIS install exited ${installed.status}`)
    const started = Date.now()
    let exe = ''
    while (!exe) {
      exe = [perUser, perMachine].find((candidate) => existsSync(candidate)) ?? ''
      if (exe) break
      if (Date.now() - started > 180_000) throw new Error(`installer did not produce ${perUser}`)
      await delay(500)
    }
    rmSync(downloaded, { force: true })
    const resources = path.win32.join(path.win32.dirname(exe), 'resources')
    const wav = ensureLongSpeechWav(work)
    const publishedDictation = await runPackagedDictation({ exe, work, wav, label: 'published-1.2.3', slow: false })
    await delay(1000)
    const engineCache = path.join(work, 'engine-cache')
    snapshotEngine(resources, engineCache)
    lighten(resources)
    await patchInstalledResources(resources, { feedUrl: url, publicKeyPem: publicKey })
    await exercise('NSIS', {
      work,
      display: null,
      command: exe,
      args: ['--no-sandbox'],
      observeCommand: exe,
      observeArgs: ['--no-sandbox'],
      versionCheck: async () => {
        try {
          await readVersionWhenReady(() => windowsProductVersion(exe), TO, 10 * 60 * 1000)
          const version = windowsProductVersion(exe)
          console.log(`version after: ${version}`)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          throw new Error(`${detail}\n${readLog(path.join(work, 'update.log')).slice(-2500)}`)
        }
      }
    })
    restoreEngine(resources, engineCache)
    const builtDictation = await runPackagedDictation({ exe, work, wav, label: 'pr7-1.2.4', slow: true })
    const problems = judgeLongDictation(publishedDictation, builtDictation)
    if (problems.length === 0) console.log('long-dictation\tpass')
    else {
      for (const problem of problems) console.log(`long-dictation\tfail\t${problem}`)
      throw new Error(`long dictation proof failed\n${problems.join('\n')}`)
    }
  } finally {
    server.close()
  }
}

function targetsForPlatform() {
  const override = process.env.REAL_UPDATE_TARGETS?.split(',').map((item) => item.trim()).filter(Boolean)
  if (override && override.length > 0) return override
  if (process.platform === 'linux') return ['appimage', 'deb']
  if (process.platform === 'win32') return ['nsis']
  throw new Error('Mac arm64 and x64 are run on the release Mac. See RELEASING.md.')
}

async function main() {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  if (version !== TO) throw new Error(`package.json is ${version}, expected ${TO}`)
  const targets = targetsForPlatform()
  const work = mkdtempSync(path.join(os.tmpdir(), 'flowa-real-pr7-'))
  console.log(`real ${FROM_TAG} → ${TO} work dir ${work}`)
  const outDir = path.join(work, 'built')
  if (process.platform === 'linux') await buildSlim(outDir, ['--linux', 'AppImage', 'deb', '--x64'])
  else await buildSlim(outDir, ['--win', 'nsis', '--x64'])
  const xvfb = process.platform === 'linux' ? startXvfb(work) : { display: null, child: null, stop() {} }
  if (process.platform === 'linux') {
    await delay(400)
    if (xvfb.child && xvfb.child.exitCode !== null) {
      throw new Error(`Xvfb exited ${xvfb.child.exitCode}\n${readFileSync(path.join(work, 'xvfb.log'), 'utf8')}`)
    }
  }
  const results = []
  try {
    for (const target of targets) {
      const one = path.join(work, target)
      mkdirSync(one, { recursive: true })
      try {
        if (target === 'appimage') {
          await runAppImage(one, findFile(outDir, (name) => name.endsWith('.AppImage'), 'AppImage'), xvfb.display)
        } else if (target === 'deb') {
          await runDeb(one, findFile(outDir, (name) => name.endsWith('.deb'), 'deb'), xvfb.display)
        } else if (target === 'nsis') {
          await runNsis(one, findFile(outDir, (name) => name.startsWith('Flowa-Setup-') && name.endsWith('.exe'), 'NSIS exe'))
        } else {
          throw new Error(`unknown installer ${target}`)
        }
        results.push([target, 'pass'])
        console.log(`✓ ${target} updated ${FROM_TAG} → ${TO}`)
      } catch (err) {
        results.push([target, 'fail'])
        console.error(`✗ ${target} failed`)
        console.error(err instanceof Error ? err.stack ?? err.message : err)
      } finally {
        killProduct()
      }
    }
  } finally {
    xvfb.stop()
  }
  console.log('installer\tresult')
  for (const [name, result] of results) console.log(`${name}\t${result}`)
  if (results.some(([, result]) => result === 'fail')) process.exit(1)
}

const invoked = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err)
    process.exit(1)
  })
}
