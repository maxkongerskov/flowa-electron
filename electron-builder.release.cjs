// Release config: electron-builder.yml + the speech models bundled in every installer.
// Used by scripts/build-release.sh. The app looks for
// <resources>/models/<ggml file> before <appData>/Flowa-Electron/models/
// (src/main/transcriber.ts → modelCandidates), so a bundled file needs no first-run download.
// Stage Turbo first: models/ggml-large-v3-turbo.bin (gitignored, required).
// Whisper Small is optional: models/ggml-small.bin (`npm run setup:small`) is
// copied the same way when that file is present.
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const base = yaml.load(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'))

// electron-builder expands ${platform} to the BUILD HOST's platform (darwin here), so the
// base config's resources/bin/${platform}-${arch} would ship macOS engines in the Windows
// and Linux installers. Pick the engine folder per target OS instead.
const engine = (dir) => [{ from: `resources/bin/${dir}-\${arch}`, to: 'bin' }]
// The macOS helper (resources/mac) only goes into the mac apps.
// Keeps top-level extraResources other than the per-OS engine and the macOS helper.
// LICENSE and THIRD_PARTY_NOTICES.md stay in this list. electron-builder appends
// platform extraResources to it, so every mac, Windows, and Linux installer ships them.
const common = base.extraResources.filter((r) => !String(r.from).startsWith('resources/bin/') && r.from !== 'resources/mac')

const modelFilter = ['ggml-large-v3-turbo.bin']
if (fs.existsSync(path.join(__dirname, 'models', 'ggml-small.bin'))) modelFilter.push('ggml-small.bin')

module.exports = {
  ...base,
  // Outside app.asar: whisper-server opens the ggml weights by path.
  extraResources: [...common, { from: 'models', to: 'models', filter: modelFilter }],
  mac: { ...base.mac, extraResources: [...(base.mac.extraResources || []), ...engine('darwin'), { from: 'resources/mac', to: 'mac' }] },
  win: { ...base.win, extraResources: [...(base.win.extraResources || []), ...engine('win32')] },
  linux: { ...base.linux, extraResources: engine('linux') },
  // The official whisper.cpp Linux build links libgomp (OpenMP runtime).
  dmg: { ...base.dmg, artifactName: 'Flowa-${version}-${arch}.${ext}' },
  deb: { ...base.deb, fpm: ['--depends', 'libgomp1'] }
}
