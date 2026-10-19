// Release config: electron-builder.yml + the speech model bundled in every installer.
// Used by scripts/build-release.sh. The app already looks for
// <resources>/models/ggml-large-v3-turbo.bin before <appData>/Flowa-Electron/models/
// (src/main/transcriber.ts → modelCandidates), so no first-run download is needed.
// Stage the model first: models/ggml-large-v3-turbo.bin (gitignored).
// Parakeet is optional and bundled the same way when models/parakeet-tdt-0.6b-v3/
// is staged (`npm run setup:parakeet`). sherpa-onnx is copied with the rest of
// resources/bin/<platform>-<arch>/, with no filter that would drop dylibs.
// setup:sherpa must place libonnxruntime next to sherpa-onnx-offline. dyld in a
// signed app resolves @rpath/libonnxruntime.dylib from @loader_path (the sherpa
// directory). Contents/Resources/bin/lib/ and sherpa/lib/ are both misses.
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

// Fail the release config when a staged sherpa tree still has the nested layout
// (or is missing the runtime the offline CLI is linked against).
function assertSherpaSibling(platformKey, folder, binaryName, runtimeName) {
  const dir = path.join(__dirname, 'resources', 'bin', platformKey, folder)
  const bin = path.join(dir, binaryName)
  if (!fs.existsSync(bin)) return
  const runtime = path.join(dir, runtimeName)
  if (!fs.existsSync(runtime)) {
    throw new Error(
      `${runtimeName} must sit beside ${binaryName} in ${dir}. ` +
      `The signed app loads it from @loader_path / $ORIGIN, not from ${folder}/lib/. ` +
      'Re-run npm run setup:sherpa.'
    )
  }
}
for (const [key, binary, runtime] of [
  ['darwin-arm64', 'sherpa-onnx-offline', 'libonnxruntime.dylib'],
  ['darwin-x64', 'sherpa-onnx-offline', 'libonnxruntime.dylib'],
  ['linux-x64', 'sherpa-onnx-offline', 'libonnxruntime.so']
]) {
  for (const folder of ['sherpa', 'sherpa-cuda']) assertSherpaSibling(key, folder, binary, runtime)
}

const base = yaml.load(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'))

// electron-builder expands ${platform} to the BUILD HOST's platform (darwin here), so the
// base config's resources/bin/${platform}-${arch} would ship macOS engines in the Windows
// and Linux installers. Pick the engine folder per target OS instead.
const engine = (dir) => [{ from: `resources/bin/${dir}-\${arch}`, to: 'bin' }]
// The macOS helper (resources/mac) only goes into the mac apps.
const common = base.extraResources.filter((r) => !String(r.from).startsWith('resources/bin/') && r.from !== 'resources/mac')

const modelFilter = ['ggml-large-v3-turbo.bin']
const parakeetEncoder = path.join(__dirname, 'models', 'parakeet-tdt-0.6b-v3', 'encoder.int8.onnx')
if (fs.existsSync(parakeetEncoder)) modelFilter.push('parakeet-tdt-0.6b-v3/**')

module.exports = {
  ...base,
  // Outside app.asar: whisper-server and sherpa-onnx open weights by path.
  extraResources: [...common, { from: 'models', to: 'models', filter: modelFilter }],
  mac: { ...base.mac, extraResources: [...(base.mac.extraResources || []), ...engine('darwin'), { from: 'resources/mac', to: 'mac' }] },
  win: { ...base.win, extraResources: [...(base.win.extraResources || []), ...engine('win32')] },
  linux: { ...base.linux, extraResources: engine('linux') },
  // The official whisper.cpp Linux build links libgomp (OpenMP runtime).
  dmg: { ...base.dmg, artifactName: 'Flowa-${version}-${arch}.${ext}' },
  deb: { ...base.deb, fpm: ['--depends', 'libgomp1'] }
}
