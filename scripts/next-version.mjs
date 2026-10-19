#!/usr/bin/env node
// next version for `npm run release`.
//   node scripts/next-version.mjs 1.2.1 patch
//   node scripts/next-version.mjs 1.2.1 1.3.0
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function parseReleaseVersion(input) {
  const match = SEMVER.exec(String(input).trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function format(version) {
  return `${version.major}.${version.minor}.${version.patch}`
}

function compare(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return 0
}

/**
 * patch / minor / major always move forward.
 * An explicit x.y.z may equal the current version (publish it as-is) but must not go backwards.
 */
export function nextVersion(current, spec) {
  const parsed = parseReleaseVersion(current)
  if (!parsed) throw new Error(`Current version is not major.minor.patch: ${current}`)
  if (spec === 'patch') return format({ ...parsed, patch: parsed.patch + 1 })
  if (spec === 'minor') return format({ major: parsed.major, minor: parsed.minor + 1, patch: 0 })
  if (spec === 'major') return format({ major: parsed.major + 1, minor: 0, patch: 0 })
  const explicit = parseReleaseVersion(spec)
  if (!explicit) throw new Error(`Version must be patch, minor, major, or x.y.z, not ${spec}`)
  if (compare(explicit, parsed) < 0) throw new Error(`${format(explicit)} is older than ${format(parsed)}`)
  return format(explicit)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  try {
    const current = process.argv[2]
    const spec = process.argv[3]
    if (!current || !spec) throw new Error('usage: node scripts/next-version.mjs <current> <patch|minor|major|x.y.z>')
    process.stdout.write(`${nextVersion(current, spec)}\n`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
