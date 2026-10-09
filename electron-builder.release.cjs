// Release config: electron-builder.yml + the speech model bundled in every installer.
// Used by scripts/build-release.sh. The app already looks for
// <resources>/models/ggml-large-v3-turbo.bin before <appData>/Flowa-Electron/models/
// (src/main/transcriber.ts → modelCandidates), so no first-run download is needed.
// Stage the model first: models/ggml-large-v3-turbo.bin (gitignored).
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const base = yaml.load(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'))

// electron-builder expands ${platform} to the BUILD HOST's platform (darwin here), so the
// base config's resources/bin/${platform}-${arch} would ship macOS engines in the Windows
// and Linux installers. Pick the engine folder per target OS instead.
const engine = (dir) => [{ from: `resources/bin/${dir}-\${arch}`, to: 'bin' }]
// The macOS helper (resources/mac) only goes into the mac apps.
const common = base.extraResources.filter((r) => !String(r.from).startsWith('resources/bin/') && r.from !== 'resources/mac')

module.exports = {
  ...base,
  // Outside app.asar: whisper-server opens the file by path.
  extraResources: [...common, { from: 'models', to: 'models', filter: ['ggml-large-v3-turbo.bin'] }],
  mac: { ...base.mac, extraResources: [...(base.mac.extraResources || []), ...engine('darwin'), { from: 'resources/mac', to: 'mac' }] },
  win: { ...base.win, extraResources: engine('win32') },
  linux: { ...base.linux, extraResources: engine('linux') },
  // The official whisper.cpp Linux build links libgomp (OpenMP runtime).
  dmg: { ...base.dmg, artifactName: 'Flowa-${version}-${arch}.${ext}' },
  deb: { ...base.deb, fpm: ['--depends', 'libgomp1'] }
}
