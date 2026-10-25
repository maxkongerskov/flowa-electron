#!/usr/bin/env node
// app-update.yml is what electron-updater reads before it will download.
// electron-builder writes it for nsis, AppImage, and deb, but not for a macOS
// `dir` target. scripts/build-release.sh builds `--mac dir` and then a
// prepackaged dmg, so the .app would otherwise ship without this file and
// every Mac download would fail with ENOENT.
//
//   node scripts/app-update-yml.mjs write <Resources-dir> [more...]
//   node scripts/app-update-yml.mjs assert <Resources-dir> [more...]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

export const APP_UPDATE_FIELDS = {
  provider: 'github',
  owner: 'maxkongerskov',
  repo: 'flowa-releases',
  updaterCacheDirName: 'flowa-updater'
}

export function renderAppUpdateYml() {
  return `owner: ${APP_UPDATE_FIELDS.owner}
repo: ${APP_UPDATE_FIELDS.repo}
provider: ${APP_UPDATE_FIELDS.provider}
updaterCacheDirName: ${APP_UPDATE_FIELDS.updaterCacheDirName}
`
}

export function appUpdateYmlPath(resourcesDir) {
  return path.join(resourcesDir, 'app-update.yml')
}

export function writeAppUpdateYml(resourcesDir) {
  mkdirSync(resourcesDir, { recursive: true })
  const file = appUpdateYmlPath(resourcesDir)
  writeFileSync(file, renderAppUpdateYml())
  return file
}

export function assertAppUpdateYml(resourcesDir) {
  const file = appUpdateYmlPath(resourcesDir)
  if (!existsSync(file)) throw new Error(`missing ${file}`)
  const doc = yaml.load(readFileSync(file, 'utf8'))
  if (!doc || typeof doc !== 'object') throw new Error(`${file} is not a mapping`)
  for (const [key, expected] of Object.entries(APP_UPDATE_FIELDS)) {
    if (doc[key] !== expected) throw new Error(`${file}: ${key} is ${JSON.stringify(doc[key])}, expected ${expected}`)
  }
  return file
}

function main() {
  const [cmd, ...dirs] = process.argv.slice(2)
  if ((cmd !== 'write' && cmd !== 'assert') || dirs.length === 0) {
    console.error('usage: node scripts/app-update-yml.mjs write|assert <Resources-dir> [more...]')
    process.exit(1)
  }
  for (const dir of dirs) {
    if (cmd === 'write') console.log(`✓ ${writeAppUpdateYml(dir)}`)
    else console.log(`✓ ${assertAppUpdateYml(dir)}`)
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
