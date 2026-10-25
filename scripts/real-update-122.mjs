#!/usr/bin/env node
// Install the published Flowa 1.2.2 and update it to the 1.2.3 built in this
// checkout. The feed is a local HTTP server. The installed 1.2.2 copy is
// pointed at that server by editing its app-update.yml and the setFeedURL
// call inside that install's app.asar. Shipped source is not changed.
//
// The published installers include the speech model (~2 GB). Their sha256 is
// checked before anything is modified. The model and engine are then removed
// from the installed copy so startup does not load or re-download them. The
// 1.2.3 package is the default electron-builder config: no speech model.
//
//   node scripts/real-update-122.mjs
//   FLOWA_UPDATE_KEY=~/.config/flowa/update-private.pem node scripts/real-update-122.mjs serve-mac --dir feed --arch arm64
//
// serve-mac writes latest-mac.yml for one architecture and serves the
// directory. It reads the private key and does not print it.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const FROM_TAG = 'v1.2.2'
const TO = '1.2.3'
const RELEASE_BASE = `https://github.com/maxkongerskov/flowa-electron/releases/download/${FROM_TAG}`
const HISTORY_TEXT = 'bridge-history-1.2.2-token'
const MIC = 'bridge-mic-122'
const LANG = 'da'

const ASSETS = {
  appimage: {
    name: 'Flowa-1.2.2.AppImage',
    sha256: 'bf0d3ce4c50e2e81309009bb9fd115b8ffade702ccce6f5266bdf647b5cce254'
  },
  deb: {
    name: 'flowa_1.2.2_amd64.deb',
    sha256: '5d6063e0b8dd45a91a186888bbf30b9d188919265c9cb1eff51b2b37167bd3b4'
  },
  nsis: {
    name: 'Flowa-Setup-1.2.2-x64.exe',
    sha256: '2b66f1562896650a61294a40f9a6806b2d106478ce8c131012128564c9667749'
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * NSIS quitAndInstall exits the old app as soon as the installer is spawned.
 * The new app.asar is still being written then, so a single read can return a
 * torn package.json. Poll until the installed version matches.
 */
export async function readVersionWhenReady(readVersion, expected, timeoutMs, pauseMs = 1000) {
  const started = Date.now()
  let last = 'unread'
  while (Date.now() - started < timeoutMs) {
    try {
      const version = await readVersion()
      if (version === expected) return
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
    throw new Error('1.2.2 history text is missing after the update')
  }
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
    if (state.exitCode !== null && !text.includes('update available: 1.2.3')) {
      throw new Error(`1.2.2 exited ${state.exitCode} before offering 1.2.3\n${text.slice(-4000)}`)
    }
    if (text.includes('update available: 1.2.3') && state.exitCode !== null) return text
    await delay(500)
  }
  throw new Error(`timed out waiting for 1.2.2 to install 1.2.3\n${readLog(logFile).slice(-4000)}`)
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
    console.log(`removed installed ${name} so 1.2.2 does not load the bundled model`)
  }
}

function lightenSudo(resourcesDir) {
  for (const name of ['models', 'bin']) {
    const target = path.join(resourcesDir, name)
    const result = spawnSync('sudo', ['-n', 'rm', '-rf', target], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`could not remove ${target}`)
    console.log(`removed installed ${name} so 1.2.2 does not load the bundled model`)
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
  console.log(`▶ ${label}: launch installed 1.2.2`)
  const state = spawnLogged(spec.command, spec.args, env, logFile)
  try {
    await waitForUpdate(state, logFile, 12 * 60 * 1000)
  } finally {
    stopTree(state)
  }
  console.log(`▶ ${label}: check installed 1.2.3`)
  await spec.versionCheck()
  killProduct()
  await delay(1000)
  const observeLog = path.join(spec.work, 'observe.log')
  rmSync(observeLog, { force: true })
  const observeEnv = { ...base, ...(spec.observeEnv ?? spec.envExtra ?? {}) }
  console.log(`▶ ${label}: restart 1.2.3`)
  const observed = spawnLogged(spec.observeCommand, spec.observeArgs, observeEnv, observeLog)
  try {
    const text = await waitForLines(observeLog, ['[Flowa] version 1.2.3', 'speech plan: backend=cpu'], 90_000)
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
  const patched = path.join(work, 'Flowa-1.2.2.AppImage')
  const { server, url, publicKey } = await publishFeed(work, built)
  try {
    console.log('▶ AppImage: repack published 1.2.2 without the model, with the local feed')
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
    console.log('▶ deb: install published 1.2.2')
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
        if (version !== TO) throw new Error(`installed deb version is ${version || '(empty)'}`)
      }
    })
  } finally {
    server.close()
    spawnSync('sudo', ['-n', 'apt-get', 'remove', '-y', 'flowa'], { stdio: 'inherit' })
  }
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
    console.log('▶ NSIS: install published 1.2.2')
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
        const asarPath = path.join(resources, 'app.asar')
        await readVersionWhenReady(async () => {
          const raw = require('@electron/asar').extractFile(asarPath, 'package.json')
          const pkg = JSON.parse(Buffer.from(raw).toString('utf8'))
          if (!pkg || typeof pkg.version !== 'string') throw new Error('package.json has no version')
          return pkg.version
        }, TO, 10 * 60 * 1000)
      }
    })
  } finally {
    server.close()
  }
}

async function serveMac() {
  const dirFlag = process.argv.indexOf('--dir')
  const archFlag = process.argv.indexOf('--arch')
  const dir = dirFlag >= 0 ? process.argv[dirFlag + 1] : ''
  const arch = archFlag >= 0 ? process.argv[archFlag + 1] : ''
  if (!dir || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error('usage: node scripts/real-update-122.mjs serve-mac --dir <feed-dir> --arch arm64|x64')
  }
  const keyFile = process.env.FLOWA_UPDATE_KEY
  if (!keyFile) throw new Error('Set FLOWA_UPDATE_KEY to the update private key file. The key is not printed.')
  if (!existsSync(keyFile)) throw new Error(`FLOWA_UPDATE_KEY was not found: ${keyFile}`)
  const privateKeyPem = readFileSync(keyFile, 'utf8')
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  await writeUpdateFeeds(path.resolve(dir), version, {
    privateKeyPem,
    blockMaps: false,
    macArch: arch,
    releaseDate: '2026-10-25T00:00:00.000Z'
  })
  const { url } = await serve(path.resolve(dir))
  console.log(`feed ${url}`)
  console.log('Leave this process running until the Mac update finishes.')
  await new Promise(() => {})
}

function targetsForPlatform() {
  const override = process.env.REAL_UPDATE_TARGETS?.split(',').map((item) => item.trim()).filter(Boolean)
  if (override && override.length > 0) return override
  if (process.platform === 'linux') return ['appimage', 'deb']
  if (process.platform === 'win32') return ['nsis']
  throw new Error('Mac arm64 and x64 are run on the release Mac. See RELEASING.md.')
}

async function main() {
  if (process.argv[2] === 'serve-mac') {
    await serveMac()
    return
  }
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  if (version !== TO) throw new Error(`package.json is ${version}, expected ${TO}`)
  const targets = targetsForPlatform()
  const work = mkdtempSync(path.join(os.tmpdir(), 'flowa-real-122-'))
  console.log(`real 1.2.2 work dir ${work}`)
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
