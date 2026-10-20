#!/usr/bin/env node
// Rewrite latest-mac.yml / latest.yml / latest-linux.yml from the files on disk.
// Run after signing, notarizing, and stapling. electron-builder's own channel
// files are hashed too early (the stapler changes the dmg) and a per-arch
// --prepackaged build overwrites latest-mac.yml with one architecture.
//
//   node scripts/update-feed.mjs release 1.2.1
//   node scripts/update-feed.mjs --verify release 1.2.1
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicKeyFromPrivate, sha256File, signSha256, verifySha256 } from './update-trust.mjs'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

/** Updater zip names. x64 must not contain "arm64" — MacUpdater drops those on Intel. */
export function macZipName(version, arch) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`unsupported mac arch ${arch}`)
  return `Flowa-${version}-${arch}-mac.zip`
}

export function channelForArtifact(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.yml') || lower.endsWith('.yaml') || lower.endsWith('.blockmap')) return null
  if (lower.endsWith('.zip') && lower.endsWith('-mac.zip')) return 'latest-mac.yml'
  if (lower.endsWith('.dmg')) return 'latest-mac.yml'
  if (lower.endsWith('.exe')) return 'latest.yml'
  if (lower.endsWith('.appimage') || lower.endsWith('.deb')) {
    return /arm64|aarch64/.test(lower) ? 'latest-linux-arm64.yml' : 'latest-linux.yml'
  }
  return null
}

export function wantsBlockMap(name) {
  const lower = name.toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.exe') || lower.endsWith('.appimage')
}

/** Zips, exe, and AppImage first (legacy path/sha512). x64 before arm64. */
export function sortFeedFiles(names) {
  const rank = (name) => {
    const lower = name.toLowerCase()
    const primary = lower.endsWith('.zip') || lower.endsWith('.exe') || lower.endsWith('.appimage') ? 0 : 1
    const arch = lower.includes('arm64') || lower.includes('aarch64') ? 1 : 0
    return [primary, arch, name]
  }
  return [...names].sort((a, b) => {
    const left = rank(a)
    const right = rank(b)
    for (let i = 0; i < left.length; i++) {
      if (left[i] < right[i]) return -1
      if (left[i] > right[i]) return 1
    }
    return 0
  })
}

function yamlScalar(value) {
  const text = String(value)
  if (/^[A-Za-z0-9._+-]+$/.test(text)) return text
  return `'${text.replace(/'/g, "''")}'`
}

export function renderUpdateYaml({ version, files, releaseDate }) {
  if (!files.length) throw new Error('no files')
  const lines = [`version: ${yamlScalar(version)}`, 'files:']
  for (const file of files) {
    lines.push(`  - url: ${yamlScalar(file.url)}`)
    lines.push(`    sha512: ${yamlScalar(file.sha512)}`)
    lines.push(`    size: ${file.size}`)
    if (file.ed25519) lines.push(`    ed25519: ${yamlScalar(file.ed25519)}`)
  }
  lines.push(`path: ${yamlScalar(files[0].url)}`)
  lines.push(`sha512: ${yamlScalar(files[0].sha512)}`)
  lines.push(`releaseDate: '${String(releaseDate).replace(/'/g, "''")}'`)
  lines.push('')
  return lines.join('\n')
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve({ sha512: hash.digest('base64'), size: statSync(file).size }))
  })
}

export async function ensureBlockMap(filePath) {
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
  const before = await hashFile(filePath)
  await buildBlockMap(filePath, 'gzip', `${filePath}.blockmap`)
  const after = await hashFile(filePath)
  if (before.sha512 !== after.sha512 || before.size !== after.size) {
    throw new Error(`block map generation changed ${path.basename(filePath)}`)
  }
}

function artifactNames(dir) {
  return readdirSync(dir).filter((name) => {
    const full = path.join(dir, name)
    return statSync(full).isFile() && channelForArtifact(name)
  })
}

export async function verifyUpdateFeeds(dir, version, options = {}) {
  const errors = []
  const names = artifactNames(dir)
  const channels = [...new Set(names.map((name) => channelForArtifact(name)))]
  for (const channel of channels) {
    const ymlPath = path.join(dir, channel)
    if (!existsSync(ymlPath)) {
      errors.push(`missing ${channel}`)
      continue
    }
    const doc = yaml.load(readFileSync(ymlPath, 'utf8'))
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.files) || doc.files.length === 0) {
      errors.push(`${channel}: no files`)
      continue
    }
    if (String(doc.version) !== String(version)) errors.push(`${channel}: version ${doc.version} != ${version}`)
    const listed = new Set()
    for (const file of doc.files) {
      if (typeof file?.url !== 'string' || typeof file.sha512 !== 'string' || typeof file.size !== 'number') {
        errors.push(`${channel}: a file entry is missing url, sha512, or size`)
        continue
      }
      listed.add(file.url)
      const full = path.join(dir, file.url)
      if (!existsSync(full)) {
        errors.push(`${channel}: missing ${file.url}`)
        continue
      }
      const hashed = await hashFile(full)
      if (hashed.size !== file.size) errors.push(`${file.url}: size ${file.size} != ${hashed.size}`)
      if (hashed.sha512 !== file.sha512) errors.push(`${file.url}: sha512 mismatch`)
      if (options.requireSignatures && typeof file.ed25519 !== 'string') errors.push(`${file.url}: missing ed25519`)
      if (typeof file.ed25519 === 'string') {
        if (!options.publicKeyPem) errors.push(`${file.url}: ed25519 present but no public key was provided`)
        else {
          const digest = await sha256File(full)
          if (!verifySha256(options.publicKeyPem, digest, file.ed25519)) errors.push(`${file.url}: ed25519 mismatch`)
        }
      }
    }
    for (const name of names.filter((item) => channelForArtifact(item) === channel)) {
      if (!listed.has(name)) errors.push(`${channel}: omitted ${name}`)
    }
    if (doc.path !== doc.files[0].url) errors.push(`${channel}: path is not the first file`)
    if (doc.sha512 !== doc.files[0].sha512) errors.push(`${channel}: top-level sha512 does not match path`)
    const first = String(doc.files[0].url).toLowerCase()
    if (channel === 'latest-mac.yml' && !first.endsWith('.zip')) errors.push('latest-mac.yml path must be a zip')
    if (channel === 'latest.yml' && !first.endsWith('.exe')) errors.push('latest.yml path must be an exe')
    if (channel.startsWith('latest-linux')) {
      const hasAppImage = doc.files.some((file) => String(file.url).toLowerCase().endsWith('.appimage'))
      if (hasAppImage && !first.endsWith('.appimage')) errors.push(`${channel}: path must be the AppImage`)
    }
  }
  const mac = names.filter((name) => channelForArtifact(name) === 'latest-mac.yml')
  if (mac.length > 0) {
    const zips = mac.filter((name) => name.toLowerCase().endsWith('.zip'))
    const dmgs = mac.filter((name) => name.toLowerCase().endsWith('.dmg'))
    if (!zips.some((name) => name.toLowerCase().includes('arm64'))) errors.push('missing arm64 updater zip')
    if (!zips.some((name) => !name.toLowerCase().includes('arm64'))) errors.push('missing x64 updater zip')
    if (!dmgs.some((name) => name.toLowerCase().includes('arm64'))) errors.push('missing arm64 dmg')
    if (!dmgs.some((name) => !name.toLowerCase().includes('arm64'))) errors.push('missing x64 dmg')
  }
  if (options.requireBlockMaps !== false) {
    for (const name of names) {
      if (!wantsBlockMap(name)) continue
      if (!existsSync(path.join(dir, `${name}.blockmap`))) errors.push(`missing blockmap for ${name}`)
    }
  }
  return errors
}

export async function writeUpdateFeeds(dir, version, options = {}) {
  const releaseDate = options.releaseDate ?? new Date().toISOString()
  for (const name of readdirSync(dir)) {
    if (name.toLowerCase().endsWith('.dmg.blockmap')) unlinkSync(path.join(dir, name))
  }
  const artifacts = artifactNames(dir)
  if (options.blockMaps !== false) {
    for (const name of artifacts) {
      if (!wantsBlockMap(name)) continue
      await ensureBlockMap(path.join(dir, name))
    }
  }
  const groups = new Map()
  for (const name of artifacts) {
    const channel = channelForArtifact(name)
    const list = groups.get(channel) ?? []
    list.push(name)
    groups.set(channel, list)
  }
  const written = []
  const privateKeyPem = options.privateKeyPem || null
  for (const [channel, files] of groups) {
    const sorted = sortFeedFiles(files)
    const hashed = []
    for (const name of sorted) {
      const full = path.join(dir, name)
      const info = await hashFile(full)
      const entry = { url: name, sha512: info.sha512, size: info.size }
      if (privateKeyPem) entry.ed25519 = signSha256(privateKeyPem, await sha256File(full))
      hashed.push(entry)
    }
    writeFileSync(path.join(dir, channel), renderUpdateYaml({ version, files: hashed, releaseDate }))
    written.push(channel)
  }
  const verifyOptions = {
    requireBlockMaps: options.blockMaps !== false,
    ...(privateKeyPem ? { requireSignatures: true, publicKeyPem: publicKeyFromPrivate(privateKeyPem) } : {})
  }
  const errors = await verifyUpdateFeeds(dir, version, verifyOptions)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return written.sort()
}

async function main() {
  const verifyOnly = process.argv[2] === '--verify'
  const dir = verifyOnly ? process.argv[3] : process.argv[2]
  const version = verifyOnly ? process.argv[4] : process.argv[3]
  if (!dir || !version) {
    console.error('usage: node scripts/update-feed.mjs [--verify] <release-dir> <version>')
    process.exit(1)
  }
  const resolved = path.resolve(dir)
  const keyFile = process.env.FLOWA_UPDATE_KEY
  let privateKeyPem = null
  if (keyFile) {
    if (!existsSync(keyFile)) throw new Error(`FLOWA_UPDATE_KEY not found: ${keyFile}`)
    privateKeyPem = readFileSync(keyFile, 'utf8')
  } else if (!verifyOnly && process.env.FLOWA_REQUIRE_NOTARY === '1') {
    throw new Error('FLOWA_UPDATE_KEY is required to sign the update feed. Run bash scripts/generate-update-key.sh')
  }
  if (verifyOnly) {
    const errors = await verifyUpdateFeeds(resolved, version, privateKeyPem
      ? { requireSignatures: true, publicKeyPem: publicKeyFromPrivate(privateKeyPem) }
      : {})
    if (errors.length > 0) throw new Error(errors.join('\n'))
    console.log(`✓ ${resolved} matches the update feed`)
    return
  }
  const written = await writeUpdateFeeds(resolved, version, { privateKeyPem })
  console.log(`✓ update feed: ${written.join(', ')}`)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
