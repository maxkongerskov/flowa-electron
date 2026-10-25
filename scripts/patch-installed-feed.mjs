// Test-only edits to an already installed Flowa 1.2.2.
// Shipped source is not changed. 1.2.2's prepare() always calls setFeedURL for
// GitHub, so electron-updater never reads app-update.yml until that call is
// removed from the installed bundle. CI also replaces the baked update public
// key so a locally signed 1.2.3 verifies. The release Mac keeps the real key.
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** Body of the update public key baked into published 1.2.2. */
export const RELEASE_122_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAnXjojLpFurr7/cVuY7h8+6FStGHqyfkzSmb6S1Xgmi8='

const GITHUB_FEED = `    } else {
      updater.setFeedURL({
        provider: "github",
        owner: UPDATE_REPOSITORY.owner,
        repo: UPDATE_REPOSITORY.repo
      });
    }`

const YML_FEED = `    } else {
      updater.logger.info("using app-update.yml");
    }`

const DOWNLOAD_GATE = 'if (next.kind === "available" && next.autoInstall && e2eAutoUpdate()) void this.download();'
const DOWNLOAD_ALWAYS = 'if (next.kind === "available" && next.autoInstall) void this.download();'

export function publicKeyBody(pem) {
  const body = String(pem)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('PUBLIC KEY'))
    .join('')
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('public key PEM has no base64 body')
  return body
}

export function renderGenericAppUpdateYml(feedUrl) {
  let url
  try {
    url = new URL(feedUrl)
  } catch {
    throw new Error('feed url is not a URL')
  }
  if (url.protocol !== 'http:') throw new Error('test feed must be http')
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('test feed must be localhost')
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
  return `provider: generic\nurl: ${base}\nupdaterCacheDirName: flowa-updater\n`
}

function replaceOnce(source, needle, replacement, label) {
  const crlf = needle.replace(/\n/g, '\r\n')
  const variants = needle === crlf ? [needle] : [needle, crlf]
  for (const item of variants) {
    const count = source.split(item).length - 1
    if (count === 0) continue
    if (count !== 1) throw new Error(`${label} matched ${count} times`)
    const next = item.includes('\r\n') ? replacement.replace(/\n/g, '\r\n') : replacement
    return source.replace(item, next)
  }
  throw new Error(`${label} was not found in the installed 1.2.2 bundle`)
}

/**
 * Patch the installed main bundle.
 * keepPublicKey: Mac, where 1.2.3 is signed with the real update key.
 * manualDownload: leave the click-to-download gate (a person clicks Download).
 */
export function patchInstalledMainBundle(source, options) {
  let next = source
  if (!options.keepPublicKey) {
    const body = publicKeyBody(options.publicKeyPem)
    if (body.length !== RELEASE_122_PUBLIC_KEY_B64.length) {
      throw new Error(`replacement public key is ${body.length} chars; 1.2.2's key is ${RELEASE_122_PUBLIC_KEY_B64.length}`)
    }
    const count = next.split(RELEASE_122_PUBLIC_KEY_B64).length - 1
    if (count !== 1) throw new Error(`expected the 1.2.2 update public key once, found ${count}`)
    next = next.replace(RELEASE_122_PUBLIC_KEY_B64, body)
  }
  next = replaceOnce(next, GITHUB_FEED, YML_FEED, 'GitHub setFeedURL')
  if (!options.manualDownload) next = replaceOnce(next, DOWNLOAD_GATE, DOWNLOAD_ALWAYS, 'download gate')
  return next
}

/**
 * Byte offset of the squashfs payload.
 * The runtime's `--appimage-offset` is authoritative. The first `hsqs` in the
 * file can sit inside the runtime itself, so it is only a fallback.
 */
export function squashfsOffset(file) {
  try {
    chmodSync(file, 0o755)
    const result = spawnSync(file, ['--appimage-offset'], { encoding: 'utf8', timeout: 15000 })
    const text = `${result.stdout ?? ''}`.trim()
    if (!result.error && result.status === 0 && /^\d+$/.test(text)) {
      const offset = Number(text)
      if (offset > 0) return offset
    }
  } catch {
    /* not an AppImage runtime */
  }
  const fd = openSync(file, 'r')
  try {
    const size = Math.min(statSync(file).size, 4 * 1024 * 1024)
    const buf = Buffer.alloc(size)
    const n = readSync(fd, buf, 0, size, 0)
    const at = buf.subarray(0, n).indexOf(Buffer.from('hsqs'))
    if (at < 0) throw new Error(`no squashfs header in ${file}`)
    return at
  } finally {
    closeSync(fd)
  }
}

export async function patchInstalledResources(resourcesDir, options) {
  const yml = path.join(resourcesDir, 'app-update.yml')
  writeFileSync(yml, renderGenericAppUpdateYml(options.feedUrl))
  const asarPath = path.join(resourcesDir, 'app.asar')
  const extracted = mkdtempSync(path.join(os.tmpdir(), 'flowa-asar-'))
  const asar = require('@electron/asar')
  try {
    asar.extractAll(asarPath, extracted)
    const main = path.join(extracted, 'out', 'main', 'index.js')
    writeFileSync(main, patchInstalledMainBundle(readFileSync(main, 'utf8'), options))
    rmSync(asarPath, { force: true })
    await asar.createPackage(extracted, asarPath)
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
  return { yml, asarPath }
}

function flag(name) {
  return process.argv.includes(name)
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) return null
  return process.argv[index + 1]
}

async function main() {
  const resources = option('--resources')
  const feedUrl = option('--feed-url')
  if (!resources || !feedUrl) {
    console.error('usage: node scripts/patch-installed-feed.mjs --resources <Resources-dir> --feed-url http://127.0.0.1:<port>/ [--keep-public-key] [--manual-download] [--public-key-file <pem>]')
    process.exit(1)
  }
  const keepPublicKey = flag('--keep-public-key')
  let publicKeyPem = null
  if (!keepPublicKey) {
    const file = option('--public-key-file')
    if (!file) throw new Error('--public-key-file is required unless --keep-public-key is set')
    publicKeyPem = readFileSync(file, 'utf8')
  }
  const patched = await patchInstalledResources(resources, {
    feedUrl,
    publicKeyPem,
    keepPublicKey,
    manualDownload: flag('--manual-download')
  })
  console.log(`patched ${patched.yml}`)
  console.log(`patched ${patched.asarPath}`)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
