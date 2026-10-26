import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { acknowledgements } from '@shared/acknowledgements'

const bundledNpm = [
  'electron-updater',
  'builder-util-runtime',
  'semver',
  'argparse',
  'debug',
  'fs-extra',
  'graceful-fs',
  'js-yaml',
  'jsonfile',
  'lazy-val',
  'lodash.escaperegexp',
  'lodash.isequal',
  'ms',
  'sax',
  'tiny-typed-emitter',
  'universalify',
  'react-dom',
  'scheduler'
]

describe('acknowledgements', () => {
  it('names the whisper.cpp components and every bundled npm package', () => {
    const names = acknowledgements.map((entry) => entry.name)
    for (const name of ['cpp-httplib', 'nlohmann/json', 'miniaudio', 'stb_vorbis', ...bundledNpm]) {
      expect(names, name).toContain(name)
    }
    expect(names).toEqual([...new Set(names)])
  })

  it('keeps the original notices and records Feather under Lucide', () => {
    const byName = new Map(acknowledgements.map((entry) => [entry.name, entry.notice]))
    expect(byName.get('Whisper / OpenAI')).toContain('Copyright © 2022 OpenAI')
    expect(byName.get('whisper.cpp / ggml')).toContain('Copyright © 2023-2026 The ggml authors')
    expect(byName.get('Electron')).toContain('Copyright © 2013-2020 GitHub Inc.')
    expect(byName.get('React')).toContain('Copyright © Meta Platforms, Inc. and affiliates.')
    const lucide = byName.get('Lucide') ?? ''
    expect(lucide).toContain('lucide-react')
    expect(lucide).toContain('Feather')
    expect(lucide).toContain('Copyright © 2013-present Cole Bemis')
    expect(byName.get('cpp-httplib')).toContain('Yuji Hirose')
    expect(byName.get('nlohmann/json')).toContain('Niels Lohmann')
    expect(byName.get('miniaudio')).toContain('David Reid')
    expect(byName.get('miniaudio')).toMatch(/public domain/i)
    expect(byName.get('stb_vorbis')).toContain('Sean Barrett')
  })

  it('renders the shared list in the acknowledgements sheet', () => {
    const view = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/views/AcknowledgementsView.tsx'), 'utf8')
    expect(view).toContain("from '@shared/acknowledgements'")
    expect(view).toContain('acknowledgements.map')
    expect(view).toContain('entry.notice')
  })
})
