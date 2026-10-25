import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (source: string) => BuilderConfig }
const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js') as {
  getFileMatchers: (
    config: BuilderConfig,
    name: string,
    destination: string,
    options: {
      macroExpander: (value: string) => string
      customBuildOptions: BuilderConfig
      globalOutDir: string
      defaultSrc: string
    }
  ) => Array<{ from: string }> | null
}

interface FileSet {
  from?: string
}

interface BuilderConfig {
  extraResources?: FileSet[]
  mac?: BuilderConfig
  win?: BuilderConfig
  linux?: BuilderConfig
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const licenseFiles = [path.join(root, 'LICENSE'), path.join(root, 'THIRD_PARTY_NOTICES.md')]

function shippedSources(config: BuilderConfig, platform: BuilderConfig | undefined): string[] {
  const matchers = getFileMatchers(config, 'extraResources', path.join(root, 'resources-out'), {
    macroExpander: (value) => value,
    customBuildOptions: platform ?? {},
    globalOutDir: path.join(root, 'release'),
    defaultSrc: root
  })
  return (matchers ?? []).map((matcher) => matcher.from)
}

describe('packaged license notices', () => {
  const yml = yaml.load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  const release = require(path.join(root, 'electron-builder.release.cjs')) as BuilderConfig

  it('puts LICENSE and THIRD_PARTY_NOTICES.md in every installer target', () => {
    for (const config of [yml, release]) {
      for (const platform of [config.mac, config.win, config.linux]) {
        const sources = shippedSources(config, platform)
        for (const file of licenseFiles) expect(sources).toContain(file)
      }
    }
  })

  it('keeps the npm package fields for the public repository', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      license: string
      private: boolean
      homepage: string
      repository: { type: string; url: string }
      bugs: { url: string }
    }
    expect(pkg.license).toBe('MIT')
    expect(pkg.private).toBe(true)
    expect(pkg.homepage).toBe('https://github.com/maxkongerskov/flowa-electron')
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/maxkongerskov/flowa-electron.git'
    })
    expect(pkg.bugs).toEqual({ url: 'https://github.com/maxkongerskov/flowa-electron/issues' })
  })

  it('documents the trademark limit and does not publish the internal audit', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('## Trademark')
    expect(readme).toContain('The name "Flowa" and the Flowa icon and logo are not covered by the MIT license and are not licensed for reuse.')
    expect(readme).toContain('Forks and redistributed modified versions must use a different name and a different logo.')
    expect(readme).toContain('The source code itself remains available under the MIT License.')
    expect(existsSync(path.join(root, 'docs/audits/AUDIT-2026-10-20.md'))).toBe(false)
    expect(existsSync(path.join(root, 'docs/screenshots/stage4-home.png'))).toBe(true)
    expect(existsSync(path.join(root, 'CHECKLIST.md'))).toBe(false)
    const notices = [
      readme,
      readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      readFileSync(path.join(root, 'src/shared/acknowledgements.ts'), 'utf8')
    ].join('\n')
    expect(notices).not.toMatch(/license[- ]key/i)
    expect(notices).not.toMatch(/\bpricing\b/i)
    expect(notices).not.toMatch(/\bpaddle\b/i)
    expect(notices).not.toMatch(/free[- ]tier/i)
  })
})
