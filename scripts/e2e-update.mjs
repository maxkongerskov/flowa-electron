#!/usr/bin/env node
// Packaged update rehearsal.
// Builds version N and N+1 with FLOWA_E2E_UPDATES=1 (a compile-time flag;
// production binaries ignore the test environment variables), serves N+1 from
// a localhost feed, and checks that N downloads it, verifies the ed25519
// signature, and restarts as N+1. A second run tampers the file and rewrites
// the feed checksum while keeping the old signature; that install must be
// rejected and the app must stay on N. The Mac run cannot succeed unless
// both of those cases complete.
//
// Linux runs the AppImage here. macOS is started from scripts/e2e-update-mac.sh
// so the app is Developer ID signed. Windows is the same script on windows-latest.
// This does not use the release config, so the Whisper models stay out of the
// test package. Release installers still bundle them.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { generateUpdateKeyPair, sha256File, signSha256 } from './update-trust.mjs'
import { writeUpdateFeeds } from './update-feed.mjs'
import { writeAppUpdateYml } from './app-update-yml.mjs'
import {
  E2E_PRODUCT_NAME,
  e2eSessionPath,
  installQuitFailure,
  installRelaunchReady,
  installRelaunchTimeoutMessage,
  noteInstalling,
  shipItCleanupPlan
} from './update-install.mjs'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FROM = '9.9.0'
const TO = '9.9.1'

const NODE_CLIS = {
  'electron-vite': path.join('electron-vite', 'bin', 'electron-vite.js'),
  'electron-builder': path.join('electron-builder', 'cli.js')
}

// Windows throws EINVAL when spawn() is given a cmd shim without a shell.
// Both CLIs are plain JavaScript, so every platform starts them with node.
export function cliInvocation(name, args, nodePath = process.execPath, modulesDir = path.join(root, 'node_modules')) {
  const relative = NODE_CLIS[name]
  if (!relative) throw new Error(`unknown cli ${name}`)
  return { command: nodePath, args: [path.join(modulesDir, relative), ...args] }
}

function run(cmd, args, env = process.env) {
  return spawnAndWait(cmd, args, env, `${cmd} ${args.join(' ')}`)
}

function runNodeCli(name, args, env = process.env) {
  const invoked = cliInvocation(name, args)
  return spawnAndWait(invoked.command, invoked.args, env, `${name} ${args.join(' ')}`)
}

function spawnAndWait(cmd, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} exited ${code}`))
    })
  })
}

function hashFileSha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve({ sha512: hash.digest('base64'), size: statSync(file).size }))
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

function waitForStatus(file, predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (predicate(text)) {
        clearInterval(timer)
        resolve(text)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for status\n${text || '(no status file)'}`))
      }
    }, 500)
  })
}

function pidsIn(text) {
  return [...text.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForPositiveUpdate(file, timeoutMs) {
  const started = Date.now()
  let watch = { installingAt: null, fromPid: null }
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const now = Date.now()
      watch = noteInstalling(text, FROM, TO, now, watch)
      const failure = installQuitFailure({ text, to: TO, now, watch, pidAlive })
      if (failure) {
        clearInterval(timer)
        reject(new Error(failure))
        return
      }
      if (installRelaunchReady(text, FROM, TO, watch.fromPid, pidAlive)) {
        clearInterval(timer)
        resolve(text)
        return
      }
      if (now - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`${installRelaunchTimeoutMessage(text, TO, watch.fromPid, pidAlive)}\n${text || '(no status file)'}`))
      }
    }, 500)
  })
}

function killPid(pid) {
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

function killNamed(name, force) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/IM', `${name}.exe`], { stdio: 'ignore' })
    return
  }
  spawnSync('pkill', [force ? '-KILL' : '-TERM', '-x', name], { stdio: 'ignore' })
}

function killMatching(fragment) {
  const listed = spawnSync('pgrep', ['-f', fragment], { encoding: 'utf8' })
  const pids = String(listed.stdout ?? '')
    .split(/\s+/)
    .map((item) => Number(item))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

async function waitForPidsToExit(pids, timeoutMs) {
  const started = Date.now()
  while (pids.some((pid) => pidAlive(pid))) {
    if (Date.now() - started >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

/**
 * Deletes a tree that ShipIt may still be filling. A file that appears
 * mid-walk makes Node's rm throw ENOTEMPTY; that must not abort the next
 * arch or the tamper case. Returns false when the path is still there.
 */
export async function removeTreeRetrying(target, options = {}) {
  const attempts = options.attempts ?? 8
  const delayMs = options.delayMs ?? 250
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const exists = options.exists ?? ((dir) => existsSync(dir))
  const remove = options.remove ?? ((dir) => {
    if (process.platform === 'darwin') {
      const result = spawnSync('/bin/rm', ['-rf', dir], { stdio: 'ignore' })
      if (result.status !== 0 && exists(dir)) throw new Error(`rm -rf exited ${result.status}`)
      return
    }
    rmSync(dir, { recursive: true, force: true })
  })
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      remove(target)
    } catch {
      /* The directory can gain a file while it is being removed. */
    }
    if (!exists(target)) return true
    if (attempt < attempts - 1) await wait(delayMs)
  }
  return !exists(target)
}

/** The relaunched app is not a child of the rehearsal. Stop it, then drop the e2e ShipIt job and e2e.json. */
export async function cleanupE2ERehearsal(statusText = '') {
  const home = os.userInfo().homedir
  const pids = pidsIn(statusText)
  for (const pid of pids) killPid(pid)
  killNamed(E2E_PRODUCT_NAME, false)
  await waitForPidsToExit(pids, 5_000)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  killNamed(E2E_PRODUCT_NAME, true)
  await waitForPidsToExit(pids, 2_000)
  if (process.platform === 'darwin') {
    const plan = shipItCleanupPlan(home, typeof process.getuid === 'function' ? process.getuid() : 0)
    spawnSync(plan.bootout[0], plan.bootout.slice(1), { stdio: 'ignore' })
    spawnSync(plan.remove[0], plan.remove.slice(1), { stdio: 'ignore' })
    killMatching(plan.cacheDir)
    rmSync(plan.plist, { force: true })
    const removed = await removeTreeRetrying(plan.cacheDir)
    if (!removed) console.warn(`ShipIt cache still present at ${plan.cacheDir}`)
  }
  try {
    rmSync(e2eSessionPath(process.platform, home, process.env), { force: true })
  } catch (err) {
    console.warn(`e2e session file was not removed: ${err instanceof Error ? err.message : err}`)
  }
}

async function finishLaunch(pending) {
  let text = ''
  let child = null
  try {
    const result = await pending
    text = result.text
    child = result.child
    return text
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* group already gone */ }
    }
    await cleanupE2ERehearsal(text)
  }
}

/** Silent per-user install, matching the assisted NSIS the release ships. */
export function windowsInstallerArgs() {
  return ['/S', '/currentuser']
}

export function windowsInstalledExe(localAppData, productName = E2E_PRODUCT_NAME) {
  return path.win32.join(localAppData, 'Programs', productName, `${productName}.exe`)
}

async function buildVite() {
  await runNodeCli('electron-vite', ['build'], { ...process.env, FLOWA_E2E_UPDATES: '1' })
}

async function buildPackage(version, outDir, args) {
  rmSync(outDir, { recursive: true, force: true })
  await runNodeCli('electron-builder', [
    '--config', 'electron-builder.e2e.cjs',
    `--config.directories.output=${outDir}`,
    `--config.extraMetadata.version=${version}`,
    '--config.extraMetadata.name=flowa-e2e',
    '--publish', 'never',
    ...args
  ])
}

function findFile(dir, suffix) {
  const names = existsSync(dir) ? require('node:fs').readdirSync(dir) : []
  const found = names.find((name) => name.endsWith(suffix))
  if (!found) throw new Error(`no ${suffix} in ${dir} (${names.join(', ')})`)
  return path.join(dir, found)
}

export function rewriteChecksumKeepSignature(ymlPath, filePath) {
  const doc = yaml.load(readFileSync(ymlPath, 'utf8'))
  return hashFileSha512(filePath).then((hashed) => {
    const name = path.basename(filePath)
    for (const file of doc.files ?? []) {
      if (file.url === name) {
        file.sha512 = hashed.sha512
        file.size = hashed.size
      }
    }
    if (doc.path === name) doc.sha512 = hashed.sha512
    writeFileSync(ymlPath, yaml.dump(doc, { lineWidth: -1 }))
  })
}

function flipLastByte(file) {
  const data = readFileSync(file)
  data[data.length - 1] = data[data.length - 1] ^ 0xff
  writeFileSync(file, data)
}

function startXvfb() {
  const display = `:${90 + (process.pid % 9)}`
  const child = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  return { display, child }
}

async function launchAndWait(command, args, env, statusFile, predicate, timeoutMs, logFile) {
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = require('node:fs').createWriteStream(logFile, { flags: 'a' })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const wait = predicate === 'positive' ? waitForPositiveUpdate(statusFile, timeoutMs) : waitForStatus(statusFile, predicate, timeoutMs)
  try {
    const text = await wait
    return { text, child }
  } catch (err) {
    const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-4000) : ''
    throw new Error(`${err instanceof Error ? err.message : err}\n--- app log ---\n${tail}`)
  }
}

function appEnv(base, feedUrl, publicKey, statusFile, home) {
  return {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    FLOWA_UPDATE_FEED: feedUrl,
    FLOWA_UPDATE_PUBLIC_KEY: publicKey,
    FLOWA_E2E_AUTO_UPDATE: '1',
    FLOWA_E2E_NO_SANDBOX: '1',
    FLOWA_E2E_STATUS: statusFile
  }
}

async function linuxAppImage(work, publicKey, privateKey) {
  await cleanupE2ERehearsal()
  console.log('▶ linux AppImage packages')
  await buildPackage(FROM, path.join(work, 'from'), ['--linux', 'AppImage', '--x64'])
  await buildPackage(TO, path.join(work, 'to'), ['--linux', 'AppImage', '--x64'])
  const fromImage = findFile(path.join(work, 'from'), '.AppImage')
  const toImage = findFile(path.join(work, 'to'), '.AppImage')
  chmodSync(fromImage, 0o755)
  chmodSync(toImage, 0o755)
  const resources = path.join(work, 'from', 'linux-unpacked', 'resources', 'app-update.yml')
  if (!existsSync(resources)) throw new Error(`AppImage bundle is missing app-update.yml (${resources})`)

  const feed = path.join(work, 'feed')
  require('node:fs').mkdirSync(feed)
  const published = path.join(feed, path.basename(toImage))
  copyFileSync(toImage, published)
  chmodSync(published, 0o755)
  await writeUpdateFeeds(feed, TO, { privateKeyPem: privateKey, blockMaps: false, releaseDate: '2026-10-20T00:00:00.000Z' })
  const { server, url } = await serve(feed)
  const pristine = path.join(work, 'Flowa.AppImage')
  copyFileSync(fromImage, pristine)
  chmodSync(pristine, 0o755)

  const launch = async (label, image, predicate, timeoutMs) => {
    const home = path.join(work, `home-${label}`)
    const status = path.join(work, `status-${label}.txt`)
    const log = path.join(work, `log-${label}.txt`)
    require('node:fs').mkdirSync(home, { recursive: true })
    console.log(`▶ launch ${label}`)
    const xvfb = startXvfb()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const env = appEnv(process.env, url, publicKey, status, home)
    env.DISPLAY = xvfb.display
    env.APPIMAGE = image
    try {
      return await finishLaunch(launchAndWait(image, ['--no-sandbox'], env, status, predicate, timeoutMs, log))
    } finally {
      xvfb.child.kill('SIGTERM')
    }
  }

  try {
    const positive = await launch('positive', pristine, 'positive', 180_000)
    console.log('--- positive status ---')
    console.log(positive.trim())

    const negativeImage = path.join(work, 'Flowa-negative.AppImage')
    copyFileSync(fromImage, negativeImage)
    chmodSync(negativeImage, 0o755)
    flipLastByte(published)
    await rewriteChecksumKeepSignature(path.join(feed, 'latest-linux.yml'), published)
    const negative = await launch('negative', negativeImage, (text) => text.includes(`booted ${FROM}`) && text.includes('rejected'), 180_000)
    console.log('--- negative status ---')
    console.log(negative.trim())
    assertTamperRehearsal(positive, negative, 'AppImage')
    console.log('✓ AppImage updated 9.9.0 → 9.9.1 and rejected a tampered file')
  } finally {
    server.close()
    await cleanupE2ERehearsal()
  }
}

function canSudo() {
  const result = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' })
  return result.status === 0
}

async function linuxDeb(work, publicKey, privateKey) {
  await cleanupE2ERehearsal()
  if (!canSudo()) {
    console.log('Deb update test skipped: sudo is not available without a password.')
    return
  }
  console.log('▶ linux deb packages')
  await buildPackage(FROM, path.join(work, 'deb-from'), ['--linux', 'deb', '--x64'])
  await buildPackage(TO, path.join(work, 'deb-to'), ['--linux', 'deb', '--x64'])
  const fromDeb = findFile(path.join(work, 'deb-from'), '.deb')
  const toDeb = findFile(path.join(work, 'deb-to'), '.deb')
  const feed = path.join(work, 'deb-feed')
  require('node:fs').mkdirSync(feed)
  copyFileSync(toDeb, path.join(feed, path.basename(toDeb)))
  await writeUpdateFeeds(feed, TO, { privateKeyPem: privateKey, blockMaps: false, releaseDate: '2026-10-20T00:00:00.000Z' })
  const { server, url } = await serve(feed)
  try {
    // A previous rehearsal leaves flowa-e2e 9.9.1 installed. apt refuses to
    // replace it with 9.9.0 unless that package is removed first.
    spawnSync('sudo', ['-n', 'apt-get', 'remove', '-y', 'flowa-e2e'], { stdio: 'inherit' })
    const installed = spawnSync('sudo', ['-n', 'apt-get', 'install', '-y', fromDeb], { stdio: 'inherit' })
    if (installed.status !== 0) {
      console.log('Deb update test skipped: apt could not install the package.')
      return
    }
    const exe = `/opt/${E2E_PRODUCT_NAME}/${E2E_PRODUCT_NAME}`
    if (!existsSync(exe)) {
      console.log(`Deb update test skipped: ${exe} was not installed.`)
      return
    }
    const launchDeb = async (label, predicate) => {
      const home = path.join(work, `home-deb-${label}`)
      const status = path.join(work, `status-deb-${label}.txt`)
      const log = path.join(work, `log-deb-${label}.txt`)
      require('node:fs').mkdirSync(home, { recursive: true })
      const xvfb = startXvfb()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const env = appEnv(process.env, url, publicKey, status, home)
      env.DISPLAY = xvfb.display
      try {
        return await finishLaunch(launchAndWait(exe, ['--no-sandbox'], env, status, predicate, 180_000, log))
      } finally {
        xvfb.child.kill('SIGTERM')
      }
    }
    const positive = await launchDeb('positive', 'positive')
    console.log('--- deb status ---')
    console.log(positive.trim())
    const published = path.join(feed, path.basename(toDeb))
    flipLastByte(published)
    await rewriteChecksumKeepSignature(path.join(feed, 'latest-linux.yml'), published)
    spawnSync('sudo', ['-n', 'apt-get', 'remove', '-y', 'flowa-e2e'], { stdio: 'inherit' })
    const reinstalled = spawnSync('sudo', ['-n', 'apt-get', 'install', '-y', fromDeb], { stdio: 'inherit' })
    if (reinstalled.status !== 0 || !existsSync(exe)) {
      throw new Error('could not reinstall 9.9.0 for the deb tamper case')
    }
    const negative = await launchDeb('negative', (text) => text.includes(`booted ${FROM}`) && text.includes('rejected'))
    console.log('--- deb negative status ---')
    console.log(negative.trim())
    assertTamperRehearsal(positive, negative, 'deb')
    console.log('✓ deb updated 9.9.0 → 9.9.1, quit, relaunched, and rejected a tampered package')
  } finally {
    server.close()
    await cleanupE2ERehearsal()
  }
}

export function macFeedOptions(arch, privateKeyPem) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`unsupported mac arch ${arch}`)
  return {
    privateKeyPem,
    blockMaps: false,
    releaseDate: '2026-10-20T00:00:00.000Z',
    macArch: arch
  }
}

/** Both cases are required. A missing tamper run, or a tampered file that installs, throws. */
export function assertTamperRehearsal(positive, negative, label = 'update', from = FROM, to = TO) {
  const errors = []
  if (typeof positive !== 'string' || !positive.includes(`booted ${from}`) || !positive.includes(`installing ${to}`) || !positive.includes(`booted ${to}`)) {
    errors.push(`positive ${label} update did not install`)
  }
  if (typeof negative !== 'string' || !negative.includes(`booted ${from}`) || !negative.includes('rejected')) {
    errors.push(`tampered ${label} update was not rejected`)
  }
  if (typeof negative === 'string' && negative.includes(`booted ${to}`)) {
    errors.push(`tampered ${label} update was installed`)
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
}

export function assertMacRehearsal(positive, negative, from = FROM, to = TO) {
  assertTamperRehearsal(positive, negative, 'Mac', from, to)
}

async function mac(work, publicKey, privateKey, arch) {
  await cleanupE2ERehearsal()
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`unsupported mac arch ${arch}`)
  if (process.env.FLOWA_E2E_ALLOW_UNSIGNED === '1') {
    throw new Error('The Mac update test uses Developer ID. Unset FLOWA_E2E_ALLOW_UNSIGNED.')
  }
  const signId = process.env.FLOWA_SIGN_ID
  if (!signId) throw new Error('Set FLOWA_SIGN_ID to the Developer ID Application identity.')
  const archFlag = arch === 'arm64' ? '--arm64' : '--x64'
  if (!existsSync(path.join(root, 'build', 'icon.icns'))) {
    await run('bash', ['scripts/build-mac-icons.sh'])
  }
  console.log(`▶ macOS ${arch} packages`)
  await buildPackage(FROM, path.join(work, 'from'), ['--mac', 'dir', archFlag])
  await buildPackage(TO, path.join(work, 'to'), ['--mac', 'dir', archFlag])
  const appFor = (dir) => path.join(dir, arch === 'arm64' ? 'mac-arm64' : 'mac', `${E2E_PRODUCT_NAME}.app`)
  const fromApp = appFor(path.join(work, 'from'))
  const toApp = appFor(path.join(work, 'to'))
  writeAppUpdateYml(path.join(fromApp, 'Contents', 'Resources'))
  writeAppUpdateYml(path.join(toApp, 'Contents', 'Resources'))
  const signEnv = { ...process.env, IDENTITY: signId, NOTARY_PROFILE: '' }
  await run('bash', ['scripts/sign-mac.sh', fromApp], signEnv)
  await run('bash', ['scripts/sign-mac.sh', toApp], signEnv)
  const zipName = `Flowa-${TO}-${arch}-mac.zip`
  const feed = path.join(work, 'feed')
  require('node:fs').mkdirSync(feed)
  const zip = path.join(feed, zipName)
  await run('ditto', ['-c', '-k', '--keepParent', toApp, zip])
  await writeUpdateFeeds(feed, TO, macFeedOptions(arch, privateKey))
  // quitAndInstall replaces the running bundle. Keep a signed copy of N, and
  // give the tamper run its own HOME so it cannot reuse the good download.
  const stayApp = path.join(work, 'stay', `${E2E_PRODUCT_NAME}.app`)
  require('node:fs').mkdirSync(path.dirname(stayApp))
  await run('ditto', [fromApp, stayApp])
  const { server, url } = await serve(feed)
  const launch = async (label, appPath, predicate) => {
    const home = path.join(work, `home-${label}`)
    const status = path.join(work, `status-${label}.txt`)
    const log = path.join(work, `log-${label}.txt`)
    require('node:fs').mkdirSync(home, { recursive: true })
    console.log(`▶ launch ${label}`)
    const env = appEnv(process.env, url, publicKey, status, home)
    const bin = path.join(appPath, 'Contents', 'MacOS', E2E_PRODUCT_NAME)
    return finishLaunch(launchAndWait(bin, ['--no-sandbox'], env, status, predicate, 180_000, log))
  }
  try {
    const positive = await launch('positive', fromApp, 'positive')
    console.log('--- positive status ---')
    console.log(positive.trim())
    flipLastByte(zip)
    await rewriteChecksumKeepSignature(path.join(feed, 'latest-mac.yml'), zip)
    const negative = await launch('negative', stayApp, (text) => text.includes(`booted ${FROM}`) && text.includes('rejected'))
    console.log('--- negative status ---')
    console.log(negative.trim())
    assertMacRehearsal(positive, negative)
    console.log(`✓ Mac ${arch} zip updated 9.9.0 → 9.9.1, quit, relaunched, and rejected a tampered zip`)
  } finally {
    server.close()
    await cleanupE2ERehearsal()
  }
}

async function windows(work, publicKey, privateKey) {
  await cleanupE2ERehearsal()
  console.log('▶ Windows NSIS packages')
  await buildPackage(FROM, path.join(work, 'from'), ['--win', 'nsis', '--x64'])
  await buildPackage(TO, path.join(work, 'to'), ['--win', 'nsis', '--x64'])
  const fromExe = findFile(path.join(work, 'from'), '.exe')
  const toExe = findFile(path.join(work, 'to'), '.exe')
  const feed = path.join(work, 'feed')
  require('node:fs').mkdirSync(feed)
  copyFileSync(toExe, path.join(feed, path.basename(toExe)))
  await writeUpdateFeeds(feed, TO, { privateKeyPem: privateKey, blockMaps: false, releaseDate: '2026-10-20T00:00:00.000Z' })
  const { server, url } = await serve(feed)
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const exe = windowsInstalledExe(localAppData)
  const installFresh = async () => {
    const uninstaller = path.win32.join(path.win32.dirname(exe), `Uninstall ${E2E_PRODUCT_NAME}.exe`)
    if (existsSync(uninstaller)) spawnSync(uninstaller, ['/S'], { stdio: 'inherit' })
    rmSync(path.win32.join(localAppData, 'flowa-e2e-updater'), { recursive: true, force: true })
    const installed = spawnSync(fromExe, windowsInstallerArgs(), { stdio: 'inherit' })
    if (installed.status !== 0) throw new Error(`NSIS install exited ${installed.status}`)
    const started = Date.now()
    while (!existsSync(exe)) {
      if (Date.now() - started > 60_000) throw new Error(`installer did not produce ${exe}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const launchWin = async (label, predicate) => {
    const home = path.join(work, `home-win-${label}`)
    const status = path.join(work, `status-win-${label}.txt`)
    const log = path.join(work, `log-win-${label}.txt`)
    require('node:fs').mkdirSync(home, { recursive: true })
    const env = appEnv(process.env, url, publicKey, status, home)
    return finishLaunch(launchAndWait(exe, ['--no-sandbox'], env, status, predicate, 180_000, log))
  }
  try {
    await installFresh()
    const positive = await launchWin('positive', 'positive')
    console.log('--- windows status ---')
    console.log(positive.trim())
    const published = path.join(feed, path.basename(toExe))
    flipLastByte(published)
    await rewriteChecksumKeepSignature(path.join(feed, 'latest.yml'), published)
    await installFresh()
    const negative = await launchWin('negative', (text) => text.includes(`booted ${FROM}`) && text.includes('rejected'))
    console.log('--- windows negative status ---')
    console.log(negative.trim())
    assertTamperRehearsal(positive, negative, 'Windows')
    console.log('✓ Windows NSIS updated 9.9.0 → 9.9.1, quit, relaunched, and rejected a tampered exe')
  } finally {
    server.close()
    await cleanupE2ERehearsal()
  }
}

async function main() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'flowa-e2e-'))
  console.log(`e2e work dir ${work}`)
  const pair = generateUpdateKeyPair()
  // Touch the digest so a signature round-trip is real before the packages exist.
  signSha256(pair.privateKey, await sha256File(path.join(root, 'package.json')))
  await buildVite()
  if (process.platform === 'linux') {
    await linuxAppImage(work, pair.publicKey, pair.privateKey)
    if (process.env.FLOWA_E2E_SKIP_DEB === '1') console.log('Deb update test skipped (FLOWA_E2E_SKIP_DEB=1).')
    else await linuxDeb(work, pair.publicKey, pair.privateKey)
  } else if (process.platform === 'darwin') {
    const arches = (process.env.FLOWA_E2E_MAC_ARCHES ?? 'arm64,x64').split(',').map((item) => item.trim()).filter(Boolean)
    if (arches.length === 0) throw new Error('FLOWA_E2E_MAC_ARCHES did not name an architecture')
    for (const arch of arches) await mac(path.join(work, arch), pair.publicKey, pair.privateKey, arch)
  } else if (process.platform === 'win32') {
    await windows(work, pair.publicKey, pair.privateKey)
  } else {
    throw new Error(`no packaged update test for ${process.platform}`)
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err)
    process.exit(1)
  })
}
