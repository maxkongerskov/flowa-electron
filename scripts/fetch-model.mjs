#!/usr/bin/env node
// Fetch a whisper.cpp ggml file into ./models/ so `electron-builder` can ship it
// inside the app. The app can also download the same file on first use.
//
//   node scripts/fetch-model.mjs              → ggml-large-v3-turbo.bin (default)
//   node scripts/fetch-model.mjs --small      → ggml-small.bin (OpenAI Whisper small)
//   node scripts/fetch-model.mjs --link FILE  → reuse an existing copy (hard link / copy), verify
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// SHA-1 values match whisper.cpp v1.9.5 models/README.md and src/shared/model.ts.
const MODELS = {
  turbo: {
    file: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    sha1: '4af2b29d7ec73d781377bfd1758ca957a807e941'
  },
  small: {
    file: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha1: '55356645c2b361a969dfd0ef2c5a50d530afd8d5'
  }
}
const which = process.argv.includes('--small') ? 'small' : 'turbo'
const { file, url: URL_, sha1: SHA1 } = MODELS[which]
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const dest = path.join(root, 'models', file)

const sha1 = (f) =>
  new Promise((res, rej) => {
    const h = crypto.createHash('sha1')
    fs.createReadStream(f).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex')))
  })

fs.mkdirSync(path.dirname(dest), { recursive: true })
const linkIdx = process.argv.indexOf('--link')
if (linkIdx > 0) {
  const from = process.argv[linkIdx + 1]
  try { fs.linkSync(from, dest) } catch { fs.copyFileSync(from, dest) }
} else if (!fs.existsSync(dest)) {
  const partial = `${dest}.partial`
  const res = await fetch(URL_)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  let last = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    got += c.length
    if (Date.now() - last > 1000) {
      last = Date.now()
      process.stdout.write(`\r${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`)
    }
  })
  await pipeline(body, fs.createWriteStream(partial))
  fs.renameSync(partial, dest)
  process.stdout.write('\n')
}
const sum = await sha1(dest)
if (sum !== SHA1) {
  console.error(`checksum mismatch: ${sum} (expected ${SHA1})`)
  process.exit(1)
}
console.log(`OK ${dest} sha1=${sum}`)
