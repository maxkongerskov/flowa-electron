#!/usr/bin/env node
// Fetch NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX export for sherpa-onnx) into
// ./models/parakeet-tdt-0.6b-v3/ so a release build can bundle it beside
// ggml-large-v3-turbo.bin. The weights are gitignored.
//
// Upstream checkpoint (CC-BY-4.0, 25 European languages, English included):
//   https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
// Packed export used here (encoder/decoder/joiner/tokens):
//   https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
// Keep the URL in sync with src/shared/speech.ts → parakeetArchiveUrl.
//
//   node scripts/fetch-parakeet.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const URL_ = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const destDir = path.join(root, 'models', 'parakeet-tdt-0.6b-v3')
const need = [
  ['encoder.int8.onnx', 600 * 1024 * 1024],
  ['decoder.int8.onnx', 8 * 1024 * 1024],
  ['joiner.int8.onnx', 4 * 1024 * 1024],
  ['tokens.txt', 1024]
]

function complete() {
  return need.every(([name, min]) => {
    try {
      return fs.statSync(path.join(destDir, name)).size >= min
    } catch {
      return false
    }
  })
}

if (complete()) {
  console.log(`OK ${destDir} (already present)`)
  process.exit(0)
}

fs.mkdirSync(destDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-parakeet-'))
const archive = path.join(tmp, 'parakeet.tar.bz2')
console.log(`Downloading ${URL_}`)
const res = await fetch(URL_)
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive))
execFileSync('tar', ['-xjf', archive, '-C', tmp], { stdio: 'inherit' })

const extracted = fs.readdirSync(tmp).map((name) => path.join(tmp, name)).find((p) => fs.existsSync(path.join(p, 'encoder.int8.onnx')))
if (!extracted) throw new Error('archive did not contain encoder.int8.onnx')
for (const [name] of need) fs.copyFileSync(path.join(extracted, name), path.join(destDir, name))
fs.rmSync(tmp, { recursive: true, force: true })

if (!complete()) {
  console.error('Parakeet files are missing or too small after extract')
  process.exit(1)
}
console.log(`OK ${destDir}`)
for (const [name] of need) {
  const st = fs.statSync(path.join(destDir, name))
  console.log(`  ${name}  ${(st.size / 1e6).toFixed(1)} MB`)
}
