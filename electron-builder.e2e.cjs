// Slim package used only by scripts/e2e-update.mjs.
// Release installers still come from electron-builder.release.cjs and still
// bundle the Whisper models. This config exists so the update test can package
// a real app without downloading 1.6 GB of weights.
module.exports = {
  appId: 'com.maxkongerskov.FlowaElectron.e2e',
  productName: 'FlowaE2E',
  executableName: 'FlowaE2E',
  copyright: 'Copyright © 2026 Max Køngerskov',
  directories: { buildResources: 'build' },
  files: ['out/**', 'package.json'],
  extraResources: [{ from: 'resources', to: 'assets', filter: ['icon.png'] }],
  // electron-builder writes app-update.yml when a publish config exists.
  // The running test replaces this URL via setFeedURL. The file still has to
  // be inside the bundle or the download fails with ENOENT.
  publish: { provider: 'generic', url: 'http://127.0.0.1:9/flowa-e2e/' },
  mac: {
    identity: null,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: false,
    icon: 'build/icon.icns',
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: ['dir']
  },
  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  // Assisted, same as the release installer. One-click would install under
  // Programs\flowa-e2e; /S /currentuser installs under Programs\FlowaE2E.
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'Flowa-Setup-${version}-${arch}.${ext}'
  },
  linux: {
    icon: 'build/icon.png',
    category: 'Utility',
    maintainer: 'Max Køngerskov',
    target: ['AppImage'],
    artifactName: 'Flowa-${version}.${ext}',
    synopsis: 'Local voice dictation'
  },
  deb: { artifactName: 'flowa_${version}_amd64.${ext}', packageName: 'flowa-e2e' }
}
