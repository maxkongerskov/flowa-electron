#!/usr/bin/env node
// Fetch ggml-large-v3-turbo.bin (same OpenAI large-v3-turbo checkpoint, f16, as the
// Swift app's openai_whisper-large-v3-v20240930_turbo CoreML bundle) into ./models/
// so `electron-builder` ships it inside the app, like the Swift .app does.
// The app itself can also download it on first run into its user-data folder.
//
//   node scripts/fetch-model.mjs              → download + verify
//   node scripts/fetch-model.mjs --link FILE  → reuse an existing copy (hard link / copy), verify
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const URL_ = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
const SHA1 = '4af2b29d7ec73d781377bfd1758ca957a807e941' // keep in sync with src/shared/model.ts
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const dest = path.join(root, 'models', 'ggml-large-v3-turbo.bin')

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
