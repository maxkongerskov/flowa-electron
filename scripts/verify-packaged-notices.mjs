#!/usr/bin/env node
// Confirms the built installers contain the repo LICENSE and THIRD_PARTY_NOTICES.md.
// electron-builder also ships Electron's own license under a different file name.
//
//   node scripts/verify-packaged-notices.mjs --dir release --require appimage,deb
//
// Kinds: dmg-arm64, dmg-x64, nsis-x64, nsis-arm64, appimage, deb
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expected = {
  LICENSE: readFileSync(path.join(root, 'LICENSE')),
  'THIRD_PARTY_NOTICES.md': readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'))
}

const kinds = {
  'dmg-arm64': (name) => name.endsWith('-arm64.dmg'),
  'dmg-x64': (name) => name.endsWith('-x64.dmg'),
  'nsis-x64': (name) => name.endsWith('-x64.exe'),
  'nsis-arm64': (name) => name.endsWith('-arm64.exe'),
  appimage: (name) => name.endsWith('.AppImage'),
  deb: (name) => name.endsWith('.deb')
}

function parseArgs(argv) {
  let dir = ''
  const required = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') dir = argv[++i] ?? ''
    else if (arg === '--require') required.push(...(argv[++i] ?? '').split(',').filter(Boolean))
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!dir) throw new Error('pass --dir <release directory>')
  if (required.length === 0) throw new Error(`pass --require with one or more of: ${Object.keys(kinds).join(', ')}`)
  for (const kind of required) {
    if (!kinds[kind]) throw new Error(`unknown kind ${kind}`)
  }
  return { dir: path.resolve(dir), required }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

function sevenZip() {
  const candidates = [
    '7z',
    '7zz',
    '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
    '/usr/bin/7z',
    '/usr/bin/7zz'
  ]
  for (const candidate of candidates) {
    const probed = run(candidate, ['i'])
    if (!probed.error && probed.status === 0) return candidate
  }
  throw new Error('7-Zip is not installed (tried 7z, 7zz, and 7za)')
}

function extract7z(archive, dest) {
  const bin = sevenZip()
  const result = run(bin, ['x', '-y', `-o${dest}`, archive])
  // 7-Zip uses exit code 1 for warnings (for example an NSIS stub) and 2 for fatal errors.
  if (result.error || result.status == null || result.status > 1) {
    throw new Error(`7-Zip failed on ${archive} (exit ${result.status})\n${result.stderr || result.stdout}`)
  }
}

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else found.push(full)
  }
  return found
}

function extractNestedArchives(dir, depth = 0) {
  if (depth > 3) return
  const archives = walk(dir).filter((file) => file.endsWith('.7z'))
  for (const archive of archives) {
    const dest = `${archive}.extracted`
    extract7z(archive, dest)
    extractNestedArchives(dest, depth + 1)
  }
}

function squashfsOffsets(file) {
  return new Promise((resolve, reject) => {
    const offsets = []
    const stream = createReadStream(file, { highWaterMark: 1024 * 1024 })
    let pending = Buffer.alloc(0)
    let base = 0
    stream.on('data', (chunk) => {
      const buf = Buffer.concat([pending, chunk])
      let from = 0
      while (from <= buf.length - 4) {
        const at = buf.indexOf('hsqs', from)
        if (at === -1) break
        offsets.push(base + at)
        from = at + 4
      }
      const keep = Math.min(3, buf.length)
      pending = buf.subarray(buf.length - keep)
      base += buf.length - keep
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(offsets))
  })
}

function extractAppImage(file, dest) {
  return squashfsOffsets(file).then((offsets) => {
    if (offsets.length === 0) throw new Error(`no squashfs header in ${file}`)
    let last = ''
    for (const offset of offsets) {
      rmSync(dest, { recursive: true, force: true })
      const result = run('unsquashfs', ['-offset', String(offset), '-dest', dest, file])
      if (!result.error && result.status === 0) return
      const retry = run('unsquashfs', ['-o', String(offset), '-d', dest, file])
      if (!retry.error && retry.status === 0) return
      last = result.stderr || result.stdout || retry.stderr || retry.stdout || result.error?.message || ''
    }
    throw new Error(`unsquashfs could not read ${file}\n${last}`)
  })
}

function extract(file, dest) {
  const name = path.basename(file)
  if (name.endsWith('.deb')) {
    const result = run('dpkg-deb', ['-x', file, dest])
    if (result.error || result.status !== 0) throw new Error(`dpkg-deb failed on ${file}\n${result.stderr}`)
    return Promise.resolve()
  }
  if (name.endsWith('.AppImage')) return extractAppImage(file, dest)
  if (name.endsWith('.dmg')) {
    const result = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', dest, file])
    if (result.error || result.status !== 0) throw new Error(`hdiutil attach failed on ${file}\n${result.stderr}`)
    return Promise.resolve()
  }
  if (name.endsWith('.exe')) {
    extract7z(file, dest)
    extractNestedArchives(dest)
    return Promise.resolve()
  }
  throw new Error(`do not know how to read ${file}`)
}

function detachDmg(mount) {
  if (!mount) return
  const result = run('hdiutil', ['detach', mount])
  if (result.status !== 0) run('hdiutil', ['detach', '-force', mount])
}

function shippedCopies(rootDir) {
  const copies = { LICENSE: [], 'THIRD_PARTY_NOTICES.md': [] }
  for (const file of walk(rootDir)) {
    const base = path.basename(file)
    if (!Object.prototype.hasOwnProperty.call(copies, base)) continue
    const rel = path.relative(rootDir, file).replace(/\\/g, '/')
    if (!/(^|\/)(resources|Resources)\/(LICENSE|THIRD_PARTY_NOTICES\.md)$/.test(rel)) continue
    copies[base].push(rel)
    const actual = readFileSync(file)
    if (!actual.equals(expected[base])) {
      throw new Error(`${rel} does not match the repository ${base}`)
    }
  }
  return copies
}

function artifacts(dir, kind) {
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile()) : []
  return names.filter((name) => kinds[kind](name)).sort()
}

async function verifyOne(dir, kind) {
  const matches = artifacts(dir, kind)
  if (matches.length !== 1) {
    throw new Error(`${kind}: expected 1 installer in ${dir}, found ${matches.length} (${matches.join(', ') || 'none'})`)
  }
  const artifact = path.join(dir, matches[0])
  const dest = mkdtempSync(path.join(tmpdir(), `flowa-notices-${kind}-`))
  const mounted = kind.startsWith('dmg')
  try {
    if (!mounted) {
      // mkdtemp creates the directory. dpkg-deb and unsquashfs want to create or fill it.
      rmSync(dest, { recursive: true, force: true })
    }
    await extract(artifact, dest)
    const copies = shippedCopies(dest)
    for (const name of Object.keys(expected)) {
      if (copies[name].length === 0) {
        const nearby = walk(dest)
          .map((file) => path.relative(dest, file).replace(/\\/g, '/'))
          .filter((rel) => /license|notice/i.test(rel))
        throw new Error(`${matches[0]} is missing resources/${name}. Nearby: ${nearby.join(', ') || 'none'}`)
      }
    }
    return { kind, artifact: matches[0], license: copies.LICENSE[0], notices: copies['THIRD_PARTY_NOTICES.md'][0] }
  } finally {
    if (mounted) detachDmg(dest)
    rmSync(dest, { recursive: true, force: true })
  }
}

async function main() {
  const { dir, required } = parseArgs(process.argv.slice(2))
  const rows = []
  for (const kind of required) rows.push(await verifyOne(dir, kind))
  const width = Math.max(...rows.map((row) => row.artifact.length))
  console.log(`${'kind'.padEnd(12)} ${'installer'.padEnd(width)}  LICENSE  THIRD_PARTY_NOTICES.md`)
  for (const row of rows) {
    console.log(`${row.kind.padEnd(12)} ${row.artifact.padEnd(width)}  ${row.license}  ${row.notices}`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
