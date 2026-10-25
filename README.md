# Flowa (Electron)

Cross-platform port of **Flowa**, the local push-to-talk dictation app: tap a key, speak, and the
transcript is pasted into the app you were using. Speech recognition runs entirely on your machine
with **OpenAI Whisper large-v3 turbo**, the same checkpoint the Swift app ships.

It runs on **macOS, Windows and Linux** (Electron 44 · React 19 · TypeScript · whisper.cpp v1.9.5).
It is a 1:1 port of the Swift/SwiftUI app: same views, copy, design tokens, preferences keys,
pipeline logic and decoding settings.

---

## System requirements

Flowa bundles the Whisper large-v3 turbo model (1.6 GB) and transcribes locally, so it needs a reasonably capable machine.

| | Minimum | Recommended |
|---|---|---|
| **RAM** | 16 GB | 32 GB |
| **CPU** | Modern 4-core 64-bit CPU (x64 needs AVX2, roughly 2013 or newer) | 8+ cores, or Apple Silicon (M1 or newer) |
| **GPU** | Not required | Apple Silicon with Metal, or a Vulkan GPU on Windows / Linux (AMD, Intel, or NVIDIA) |
| **Disk** | 4 GB free | 8 GB free |
| **OS** | macOS 12+, Windows 10/11 (64-bit), Ubuntu 22.04+ or similar | Latest macOS on Apple Silicon |

The macOS Apple Silicon build uses the GPU via Metal. Windows and Linux ship a Vulkan build of whisper.cpp next to the CPU engine. Automatic mode uses that Vulkan engine when a real Vulkan GPU is present, and the CPU engine otherwise. CUDA is still not bundled. Linux needs `libgomp1`. Vulkan also uses `libvulkan1` when a GPU driver is installed; without it, Flowa stays on the CPU.

## Download

| Platform | Variant | Installer | Size |
|---|---|---|---|
| macOS | Apple Silicon (M1 and later) | [Flowa-1.2.0-arm64.dmg](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.2.0/Flowa-1.2.0-arm64.dmg) | 1.6 GB |
| macOS | Intel | [Flowa-1.2.0-x64.dmg](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.2.0/Flowa-1.2.0-x64.dmg) | 1.6 GB |
| Windows | 64-bit | [Flowa-Setup-1.2.0-x64.exe](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.2.0/Flowa-Setup-1.2.0-x64.exe) | 1.5 GB |
| Linux | AppImage, x86_64 | [Flowa-1.2.0.AppImage](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.2.0/Flowa-1.2.0.AppImage) | 1.6 GB |
| Linux | Debian/Ubuntu | [flowa_1.2.0_amd64.deb](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.2.0/flowa_1.2.0_amd64.deb) | 1.6 GB |

All files for version 1.2.0 are on the [v1.2.0 release page](https://github.com/maxkongerskov/flowa-electron/releases/tag/v1.2.0).

## Quick start (local test)

Requirements: Node 20+, git, cmake, a C/C++ toolchain (macOS: Xcode Command Line Tools ·
Windows: VS 2022 Build Tools · Linux: `build-essential`).

```bash
cd ~/Projects/Flowa-Electron
npm install                 # also fetches the Electron binary (postinstall)
npm run setup:mac-helper    # macOS only: builds resources/mac/flowa-helper (fn key + paste)
npm run setup:whisper       # builds whisper.cpp v1.9.5 → resources/bin/<platform>-<arch>/
npm run setup:model         # downloads ggml-large-v3-turbo.bin (1.6 GB, sha1-verified) → models/
npm run setup:small         # optional: ggml-small.bin (Whisper Small, ~466 MB, sha1-verified) → models/
# FLOWA_WHISPER_VARIANT=cuda npm run setup:whisper     # whisper-server-cuda
# FLOWA_WHISPER_VARIANT=vulkan npm run setup:whisper   # whisper-server-vulkan/ (own libraries)
npm test                    # unit tests for the ported logic
npm start                   # build + run the app
```

`npm run dev` starts the app with hot reload for the renderer.

If you skip `setup:model`, the app downloads Whisper Turbo into its own data folder on first run
(the "Installing" screen, with resume and sha1 check). Whisper Small downloads the same way
the first time you select it.

### Dev self-tests (no hotkey needed)

```bash
npx electron-vite build
E=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron   # Windows/Linux: node_modules/electron/dist/electron(.exe)
FLOWA_SELFTEST=capture FLOWA_SELFTEST_QUIT=1 $E .                   # 3 s mic capture → logs sample count/peak
FLOWA_SELFTEST=transcribe:$PWD/tests/fixtures/quick_brown_fox.wav FLOWA_SELFTEST_LANG=en FLOWA_SELFTEST_QUIT=1 $E .
```

These are disabled in packaged builds.

### Packaging

`npm run dist:mac`, `npm run dist:win` and `npm run dist:linux` produce a dmg, an NSIS installer,
and an AppImage + deb respectively. Each one bundles whatever is in `resources/bin`, `resources/mac`
and `models/`. Those three scripts use `electron-builder.yml` and do **not** bundle the 1.6 GB
speech model. `electron-builder` can build the Windows NSIS target and the Linux AppImage/deb
on a Mac (`npm run dist:win` / `npm run dist:linux` from macOS); you do not need a Windows or
Linux machine for the installer itself. The whisper engine inside it must already be the
target OS's binary (see the release script below).

### Releasing an update

On a Mac, one command runs the unit tests and the packaged update test, then builds.
It commits, tags, and pushes only after that build succeeds, then publishes the GitHub
Release. Notarization is required. A failure in tests, the update rehearsal, signing,
notarization, stapling, or the feed check leaves no tag on origin.

```bash
npm run release -- patch          # next patch, then build and publish
npm run release -- minor
npm run release -- 1.2.3          # package.json is already 1.2.3: build and publish it
```

Before that command will succeed:

- a clean git tree, on a branch
- Developer ID `0EF5E5C4F619F8322BB10EE8255603A26AB18553` in the keychain (`security find-identity`), or set `FLOWA_SIGN_ID`
- notarytool keychain profile `AC_PASSWORD` (`xcrun notarytool history --keychain-profile AC_PASSWORD`), or set `FLOWA_NOTARY_PROFILE`
- `gh auth status` for `maxkongerskov/flowa-electron`
- staged engines `resources/bin/{darwin-arm64,darwin-x64,win32-x64,linux-x64}/`
- the Vulkan engines from the **Vulkan whisper engine** workflow, placed at
  `resources/bin/win32-x64/whisper-server-vulkan/` and
  `resources/bin/linux-x64/whisper-server-vulkan/` (see below)
- `models/ggml-large-v3-turbo.bin` with sha1 `4af2b29d7ec73d781377bfd1758ca957a807e941`
- an update signing key whose public half is committed (see below)

`electron-builder.release.cjs` bundles the Whisper models and picks `resources/bin/<os>-<arch>/`
per target, so the Mac build does not ship the macOS engine inside the Windows installer.
That folder is copied as a whole. `whisper-server-vulkan/` inside the Windows and Linux
folders is the GPU engine; the flat `whisper-server` next to it is still the CPU engine.

### Vulkan engine (Windows x64 and Linux x64)

whisper.cpp v1.9.5 (`d1be6fde11ac6e0407606b4e42fe72d34add8037`) does not publish a Vulkan
binary. `.github/workflows/vulkan-engine.yml` builds it with `-DGGML_VULKAN=ON` and
uploads two artifacts. Linux is built on `ubuntu-22.04` so the binary stays on glibc
2.34 and libstdc++ 3.4.30, the same ceiling as the official CPU build (`b5454`).
Do not substitute the upstream `ghcr.io` `main-vulkan` image: that build wants glibc
2.38 and a `/app/build/bin` run path.

`npm run release` does not compile Vulkan and does not download those artifacts.
Before the command, on the Mac that will publish:

1. Open the successful **Vulkan whisper engine** run for this commit and download
   `whisper-vulkan-win32-x64` and `whisper-vulkan-linux-x64`.
2. Replace `resources/bin/win32-x64/whisper-server-vulkan/` with the Windows artifact.
   Replace `resources/bin/linux-x64/whisper-server-vulkan/` with the Linux artifact.
3. Leave the CPU files beside that folder. Linux is the official
   `whisper-bin-ubuntu-x64.tar.gz` tree. Windows is the official
   `whisper-bin-x64.zip`, limited to what `whisper-server.exe` loads:
   `whisper-server.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, and the
   `ggml-cpu-*.dll` variants. `node scripts/stage-cpu-engine.mjs --windows`
   copies that set and leaves out SDL2, llama, wchess, talk-llama, and the
   other upstream example binaries. Leave `resources/bin/darwin-arm64` and
   `resources/bin/darwin-x64` on the existing Metal builds. Do not copy
   Vulkan's `libggml` / `whisper.dll` up into the CPU folder.
4. `resources/bin/<platform>-<arch>/whisper-backends.json` should contain
   `"vulkan": true`. The app also detects the `whisper-server-vulkan/whisper-server`
   file if the json is stale.

`npm run release -- 1.2.3` then refuses to start unless both Vulkan servers are on
disk. The release config still bundles `models/ggml-large-v3-turbo.bin` (and
`ggml-small.bin` when it has been staged). The Vulkan tree is the only new payload.
Windows and Linux are cross-built on the Mac (NSIS x64, AppImage, and deb). No Windows host
and no Wine step. Windows arm64 is not built. A `.deb` install updates itself when `dpkg` or
`apt` is available; anything else on Linux opens the release page.

Updates are signed with ed25519 over the SHA-256 of each file. The private key stays on the
release Mac. The app refuses to install a file whose signature does not match the public key
baked into that build. macOS still also requires a Developer ID signature. There is no Windows
Authenticode certificate; the ed25519 check is what stops a replaced exe.

Generate the key once, on the Mac that will publish:

```bash
bash scripts/generate-update-key.sh
git add src/shared/updatePublicKey.ts
git commit -m "Add the update signing public key"
```

The private key defaults to `~/.config/flowa/update-private.pem` (`FLOWA_UPDATE_KEY` overrides
the path). Do not commit it. `npm run release` aborts if that file is missing or if its public
half does not match `src/shared/updatePublicKey.ts`.

What lands in `release/` and on the GitHub Release (draft until every upload succeeds, then Latest):

| File | Who uses it |
|---|---|
| `Flowa-<version>-arm64.dmg`, `Flowa-<version>-x64.dmg` | People downloading Flowa. Signed, notarized, stapled. |
| `Flowa-<version>-arm64-mac.zip`, `Flowa-<version>-x64-mac.zip` | electron-updater only. The app never shows these. The zip is not codesigned; the app inside it is. |
| `Flowa-Setup-<version>-x64.exe` | Windows NSIS |
| `Flowa-<version>.AppImage`, `flowa_<version>_amd64.deb` | Linux |
| `latest-mac.yml`, `latest.yml`, `latest-linux.yml` | Written **after** stapling, with sha512, size, and ed25519 of the final files |
| `*.blockmap` | Differential download for the zip, exe, and AppImage |

`latest-mac.yml` lists both zips and both dmgs. Each packaged app contains `app-update.yml`
(on Mac it is written into the `.app` before signing, because electron-builder's `dir` target
does not write it). Home → **Check for updates**, then **Download**. Progress stays in the
banner. When the download finishes and the signature checks out, Flowa quits and restarts into
the new version. An unsigned Mac build keeps the dmg link instead of swapping itself.

Installed 1.2.0 and 1.2.1 Mac apps do not contain `app-update.yml`, so they cannot download
1.2.2 from inside the app. Install 1.2.2 from the dmg once. Updates after that can install
themselves. Windows and Linux 1.2.1 can still download 1.2.2, but those builds do not check
the ed25519 signature. The check starts with 1.2.2, for the update after it.

To rebuild the current version without publishing (still on a Mac, after the key exists):

```bash
FLOWA_SIGN_ID=0EF5E5C4F619F8322BB10EE8255603A26AB18553 \
FLOWA_NOTARY_PROFILE=AC_PASSWORD \
FLOWA_UPDATE_KEY="$HOME/.config/flowa/update-private.pem" \
bash scripts/build-release.sh
```

`npm run release` does not push a tag before the build. If a build fails, fix it and run the
same version again. The packaged rehearsal on this Mac is `bash scripts/e2e-update-mac.sh`
(Developer ID, no notarization, slim app without the Whisper weights). It tests
the arm64 zip and the x64 zip. Each one must quit within 20 seconds of
`installing`, start 9.9.1 on its own, then reject a tampered zip and stay on
9.9.0. The rehearsal bundle id is `com.maxkongerskov.FlowaElectron.e2e`, so it
does not share ShipIt's cache with an installed Flowa.
Linux is
`node scripts/e2e-update.mjs`, and the same command on `ubuntu-latest` in
`.github/workflows/e2e-update-linux.yml` (no secrets). Windows is
`.github/workflows/e2e-update-windows.yml` (no secrets). Neither rehearsal
publishes a release. The real 1.2.2 → 1.2.3 update still has to be run on a
Mac, a Windows machine, and a Linux machine before `npm run release` publishes.

The installed app checks `maxkongerskov/flowa-electron`, the same repo 1.2.2
already uses. `scripts/publish-release.sh` uploads there only. Run the
1.2.2 → 1.2.3 checks in `RELEASING.md` before publishing. This branch does
not tag or upload a GitHub Release.

Clearing recent dictations rewrites `recent.json`. It does not erase copies already in
APFS snapshots or Time Machine.

### Dictation shortcut

One press starts dictation, the next press stops it. Flowa does not have a separate
hold-to-talk mode: holding the key counts as a single press, which is how the fn key
already behaved. A modifier used by itself (Right Alt, Right Option, Ctrl, …) toggles
only when it is **tapped alone**, so AltGr and Ctrl+C keep working.

Change it from **Home → Shortcut** (press the keys you want, Escape cancels, Reset puts
back the default) or from the **tray menu** and the **app menu** (Dictation Shortcut:
presets, Record Shortcut…, Reset). The new key is saved in `prefs.json` and registered
immediately — no restart. A shortcut another app already owns, or one Flowa and the OS
reserve (Quit, Show, Alt+Tab, and similar), is refused with a message.

| | Default | Single key (F8) | Modifier alone (Right Alt) |
|---|---|---|---|
| macOS | `fn` | `globalShortcut` | `flowa-helper watch-modifiers` (Input Monitoring) |
| Windows | `F8` | `globalShortcut` | `modifier-hook.ps1`, low-level keyboard hook. It prints the modifier name only, not the characters you type |
| Linux | `F8` | `globalShortcut` on X11 | Not available. Wayland often cannot register global shortcuts at all |

**Why F8 on Windows and Linux, not Ctrl+Shift+Space.** The 1.1.0 default was three keys
and easy to fumble. F8 is one key, it is not a typing key, and Electron's `globalShortcut`
can register it on every OS the installers target. Right Alt is allowed as a choice (it is
a single key on a typical Windows keyboard) but it is a poor default: on many layouts it
is AltGr. macOS stays on **fn**, the same single key as the Swift app.

**Upgrades.** If `prefs.json` already has a shortcut, it is kept. If the file exists but
has no shortcut — or it still says `fn` on Windows/Linux, which 1.1.0 never actually
registered — it is migrated to **Ctrl+Shift+Space** (or `fn` on macOS) and written back.
A brand-new install gets F8 / fn. Reset switches an upgraded Windows install from
Ctrl+Shift+Space to F8.

---

### Local macOS install (signed + notarized, arm64)

```bash
npm run setup:mac-icons          # Assets.car + icon.icns from the Swift AppIcon set (build/Assets.xcassets)
npx electron-vite build
npx electron-builder --mac dir --arm64 -c.mac.identity=null
IDENTITY=<Developer ID sha1> NOTARY_PROFILE=AC_PASSWORD scripts/sign-mac.sh release/mac-arm64/Flowa.app
```

`scripts/sign-mac.sh` signs inside-out with the hardened runtime and `build/entitlements.mac.plist`,
then notarizes and staples. It exists because electron-builder 26 resolves the signing identity by
display name, and that fails when the name contains "ø". The model is not bundled: the app uses
`~/Library/Application Support/Flowa-Electron/models/ggml-large-v3-turbo.bin`.

---

## Speech model: same model as Swift-Flowa

| | Swift-Flowa | Flowa-Electron |
|---|---|---|
| Checkpoint | `openai/whisper-large-v3-turbo` (2024-09-30) | same |
| Variant id | `openai_whisper-large-v3-v20240930_turbo` | reported as the same id in the UI |
| Format | WhisperKit CoreML `.mlmodelc` (Apple-only) | whisper.cpp **ggml** `ggml-large-v3-turbo.bin`, f16 |
| Engine | WhisperKit (ANE/GPU) | whisper.cpp v1.9.5 `whisper-server` (Metal on mac, CPU or optional Vulkan/CUDA elsewhere) |
| File | bundled in Flowa.app | `huggingface.co/ggerganov/whisper.cpp/…/ggml-large-v3-turbo.bin`, 1,624,555,275 bytes, sha1 `4af2b29d7ec73d781377bfd1758ca957a807e941` (matches whisper.cpp `models/README.md`) |

Evidence in the Swift sources:

- `Flowa/Support/SpeechModelStore.swift:12` declares `static let modelVariant = "openai_whisper-large-v3-v20240930_turbo"`.
- `Flowa/Dictation/Transcriber.swift:30` sets `modelName = SpeechModelStore.modelVariant`.
- `Transcriber.swift:131` builds `WhisperKitConfig(model:, modelFolder:, prewarm: true, load: true, download: false)`.
- `Transcriber.swift:209-213` sets `DecodingOptions()` defaults, with `task = .transcribe`, `language`, and `detectLanguage = (language == nil)`.

The CoreML bundle cannot run on Windows or Linux, so it can't be reused directly. Electron runs the
same weights at the same precision (f16) through ggml instead. WhisperKit's default decoding settings
are mapped one-to-one in `src/shared/model.ts`:

- greedy decoding (`-bs 1 -bo 1`)
- temperature 0, increment 0.2 (sent per request)
- thresholds `-et 2.4`, `-lpt -1.0` and `-nth 0.6`
- auto-detect when the language is "Auto-detect"

The server stays resident on 127.0.0.1 on a random port, like WhisperKit's loaded pipe. `whisper-cli`
is the fallback.

Results on the Swift test fixtures (`tests/fixtures`, copied from `FlowaTests/Fixtures`, Mac Studio
with Metal):

| Fixture | Transcript | Time |
|---|---|---|
| hello_flowa.wav (en) | "Hello Flow a confidence test." | 0.16 s |
| quick_brown_fox.wav (en) | "the quick brown fox jumps over the lazy dog." | 0.16 s |
| iphone_live_speak.wav (auto) | "test actually works. My words should pop up into the terminal …" | 0.34 s |

The model loads in 1–4 s.

---

## Hardware and speech model

Home has two dropdowns, stored in `prefs.json` with the same pattern as the other preferences:

| Preference | Key | Default | Values |
|---|---|---|---|
| Hardware | `flowa.hardware` | `gpu` | `gpu` (automatic), `metal`, `cuda`, `vulkan`, `cpu` |
| Speech model | `flowa.speechModel` | `whisper-turbo` | `whisper-turbo`, `whisper-small` |

**Whisper Turbo stays the default.** A saved `parakeet-tdt-0.6b-v3` value is no longer a model and loads as Turbo.

**GPU (automatic)** picks a real backend, not a label. Both speech models use it:

| OS | Automatic choice |
|---|---|
| macOS | Apple Metal, when the whisper.cpp binary was built with Metal (the default `npm run setup:whisper` on a Mac) |
| Windows / Linux with an NVIDIA driver | NVIDIA CUDA, when `whisper-server-cuda` is staged |
| Windows / Linux otherwise | Vulkan, when `whisper-server-vulkan/` is installed and `vulkaninfo` reports a real GPU. CPU devices and software implementations (lavapipe, llvmpipe, SwiftShader, Microsoft Basic Render, WARP) stay on the CPU engine. |
| Anything else | CPU |

Picking Metal, CUDA, or Vulkan directly uses that backend. When it isn't staged, or the process fails to start on it, Flowa retries on the CPU and shows a quiet yellow note on Home (the same warning banner as the other in-app status text). There is no dialog and no system notification. Choosing CPU skips the GPU attempt and shows no note.

Vulkan has a shorter budget than the other GPU backends: the server must accept a connection within 60 seconds, and the one-second prewarm must finish within 30 seconds. A miss, a crash, or a log that says the GPU did not come up switches that launch to the CPU engine and writes `vulkan-auto-skip.json` in the app's data folder. The file records the app version that gave up. Automatic mode keeps using the CPU until Hardware is changed or Flowa updates to a different version, which deletes the file and tries Vulkan again. Choosing Hardware again, including choosing GPU (automatic) once more, deletes it too. A Vulkan start that succeeds deletes it as well.

Whisper uses whisper.cpp v1.9.5. `-ng` forces CPU. CUDA and Vulkan are extra binaries so one `resources/bin` folder can hold more than one backend. Vulkan is the directory `whisper-server-vulkan/` (its own `whisper-server`, `whisper-cli`, and ggml libraries) because those file names are the same as the CPU engine's. A flat `whisper-server-vulkan` binary from `FLOWA_WHISPER_VARIANT=vulkan` on an older build is still accepted. `whisper-backends.json` records what was staged. The speech-model dropdown only changes the `-m` file passed to that binary.

### Whisper Small

**OpenAI Whisper small**, multilingual (not `small.en`). Same ggml f16 conversion whisper.cpp publishes, MIT license, about 466 MB:

| | |
|---|---|
| File | `ggml-small.bin` |
| Checkpoint | `openai/whisper-small` |
| Source | [huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin) |
| Size | 487,601,967 bytes |
| SHA-1 | `55356645c2b361a969dfd0ef2c5a50d530afd8d5` (whisper.cpp v1.9.5 `models/README.md`) |

`npm run setup:small` downloads it into `models/`. The app also looks in `<appData>/Flowa-Electron/models/ggml-small.bin` and downloads that file the first time Small is selected, the same way Turbo downloads `ggml-large-v3-turbo.bin`. Selecting Small restarts whisper.cpp with `ggml-small.bin`. Selecting Turbo again uses `ggml-large-v3-turbo.bin`. A Turbo file on disk does not satisfy Small.

A release build still requires Turbo. `electron-builder.release.cjs` also copies `models/ggml-small.bin` when that file has been staged. Both weights stay gitignored.

---

## Parity checklist

✅ done · 🟡 partial · ⛔ not portable (with the substitute used)

| Swift area | Electron | Status |
|---|---|---|
| RootView: onboarding → installing → home routing, `firstRunComplete` / `onboardingComplete` sync | `RootView.tsx`, `index.ts` | ✅ |
| OnboardingView (3 permission cards, live re-check) | `OnboardingView.tsx`, `permissions.ts` | ✅ (cards adapt per OS) |
| InstallingView (120 s prepare countdown, errors, retry) | `InstallingView.tsx`, `transcriber.ts` | ✅, plus a real download progress state |
| HomeView (shortcut, language, mic, launch at login, max duration, acknowledgements, recent list, copy, clear) | `HomeView.tsx` | ✅ |
| Banners (error, fn conflict, permissions) | `Banners.tsx` | ✅, plus a "shortcut taken" banner on Win/Linux |
| HomeChrome (status pill, light/dark toggle) | `HomeChrome.tsx` | ✅ |
| AcknowledgementsView | `AcknowledgementsView.tsx` | ✅ |
| Theme.swift colour tokens (light/dark) | `theme.css` | ✅ |
| Flow Bar (FloatingPanel, bottom-centre, waveform, countdown, cancel/commit) | `windows.ts`, `bar.tsx`, `bar.css` | ✅ (transparent always-on-top panel on every Space) |
| Menu bar extra (status text, icons, Show/Reinstall/Repair/Quit) | `tray.ts` | ✅ (tray icon on Win/Linux) |
| DictationPipeline (single-flight, silent-take skip, max-duration message, recent list) | `pipeline.ts` | ✅ |
| AudioCapture (16 kHz mono, RMS×6.5 level, smoothing, peak, silence 0.008, max duration, device kinds) | `AudioCapture.ts`, `audioMath.ts`, `micDeviceKind.ts` | 🟡 same math. The device list comes from Chromium (`enumerateDevices`), not CoreAudio, so the Continuity/aggregate filters work on labels |
| Transcriber (WhisperKit) | `transcriber.ts` (whisper.cpp) | ✅ same model, see above |
| GlobalHotkey: fn tap/hold via CGEventTap | `hotkey.ts` + `shortcut.ts` + `flowa-helper` | ✅ Toggle (one press starts, the next stops; a hold is one press). macOS default `fn`. Windows/Linux default `F8` (1.1.0’s `Ctrl+Shift+Space` is kept on upgrade). Single keys and chords use `globalShortcut`. A modifier by itself uses the macOS tap or a Windows low-level hook; Linux cannot register a modifier alone |
| TextInserter: AX check, activate target, ⌘V via CGEvent, clipboard floor | `textInserter.ts` | ✅ mac (helper) · ✅ Windows (PowerShell keybd_event, untested on real Windows) · 🟡 Linux (needs xdotool / wtype / ydotool, otherwise clipboard only) |
| FnConflictDetector (`AppleFnUsageType`) | `fnConflict.ts` | ✅ mac · n/a elsewhere |
| PermissionChecker (Mic, Input Monitoring, Accessibility) | `permissions.ts` | ✅ mac · auto-granted where the OS has no such gate |
| Repair (tccutil reset, lsregister, relaunch) | `repair.ts` | ✅ mac (packaged only) · 🟡 elsewhere (re-check + relaunch only) |
| LoginItem (SMAppService) | `loginItem.ts` | ✅ mac/win (`setLoginItemSettings`) · ✅ Linux (XDG autostart) |
| Preferences (UserDefaults keys) | `store.ts` → `prefs.json` | ✅ same keys |
| Recent dictations JSON | `recent.ts` | ✅ format-compatible (sorted keys, ISO 8601, upper-case UUIDs) |
| Language catalog (99 + auto) | `languages.ts` | ✅ generated from `LanguageOption.swift` |
| Unit tests (Swift `FlowaTests`) | `tests/*.test.ts` (99) | ✅ logic tests ported, including shortcut validation, migration, the recorder, and update checks. 🟡 the E2E fixtures run through the dev self-test, not under vitest |
| Code signing / notarization | – | ⛔ not done yet (needs certificates) |
| Update check | `electron-updater` → GitHub `latest*.yml`, Home banner | ✅ Check for updates, then Download with progress, then quit and restart. Every artifact is ed25519-signed. macOS also requires Developer ID. Unsigned Mac builds and unsupported Linux packages open the release page |

## Platform-dependent parts and their equivalents

| Swift (file) | Why it is platform-bound | Electron equivalent |
|---|---|---|
| `Hotkey/GlobalHotkey.swift:76-113` CGEventTap on `flagsChanged`/fn | macOS Quartz API | mac: `flowa-helper watch-fn` and `watch-modifiers`. Win: `globalShortcut`, or `resources/win/modifier-hook.ps1` (`WH_KEYBOARD_LL`) for a modifier alone. Linux: `globalShortcut` only (no modifier-only, and Wayland often cannot grab keys) |
| `Permissions/PermissionChecker.swift:53-83` AVCaptureDevice / IOHIDCheckAccess / AXIsProcessTrusted | macOS TCC | `systemPreferences.getMediaAccessStatus` / `askForMediaAccess`, helper `check-im` / `request-im`, `isTrustedAccessibilityClient`. Win/Linux: no gates; Linux paste-tool detection |
| `Dictation/TextInserter.swift:46-75` AX + CGEvent ⌘V | macOS | helper `paste <pid>` (mac) · PowerShell `SetForegroundWindow` + `keybd_event` Ctrl+V (Win) · xdotool / wtype / ydotool (Linux) · clipboard always |
| `Dictation/AudioCapture.swift:58-253` CoreAudio HAL device list + AVAudioEngine | macOS | `getUserMedia` + `AudioContext` (16 kHz) in the Flow Bar renderer |
| `Dictation/Transcriber.swift` WhisperKit / CoreML | Apple-only | whisper.cpp server, ggml model |
| `Hotkey/FloatingPanel.swift` NSPanel | AppKit | frameless transparent `BrowserWindow` (`type: 'panel'` on mac, always on top, every workspace) |
| `FlowaApp.swift:111` MenuBarExtra | SwiftUI/macOS | `Tray` with template icons |
| `FlowaApp.swift:23-32` SMAppService | macOS 13+ | `app.setLoginItemSettings` / XDG autostart |
| `Hotkey/FnConflictDetector.swift:51` `AppleFnUsageType` | macOS defaults | `defaults read com.apple.HIToolbox AppleFnUsageType` (mac only) |
| `Permissions/Repair.swift:66-72` tccutil + lsregister | macOS | same commands (packaged mac); re-check + relaunch elsewhere |
| `Support/SystemSettings.swift` `x-apple.systempreferences:` URLs | macOS | same URLs via `shell.openExternal` (mac) · `ms-settings:` (Win) · no-op (Linux) |

## Data location

The Electron app keeps its data separate from Swift-Flowa, so the two can run side by side:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/Flowa-Electron/` |
| Windows | `%APPDATA%\Flowa-Electron\` |
| Linux | `~/.config/Flowa-Electron/` |

That folder holds `prefs.json`, `recent.json` and, when downloaded in-app, `models/`. The bundle id is
`com.maxkongerskov.FlowaElectron`.

## Project layout

```
src/shared     pure ported logic (prefs, shortcut, languages, mic kinds, recent, wav, audio math, status copy, model)
src/main       Electron main: transcriber, pipeline, hotkey, windows, tray, permissions, paste, repair
src/preload    contextIsolated bridges (window.flowa, window.flowaBar)
src/renderer   React views (index.html = main window, bar.html = Flow Bar)
native/macos   flowa-helper.swift (fn tap, Input Monitoring, frontmost app, ⌘V)
scripts        build-whisper.mjs, fetch-model.mjs, build-mac-helper.sh
tests          vitest suites + Swift WAV fixtures
```

Security: `contextIsolation` and `sandbox` are on and `nodeIntegration` is off. There is a strict CSP,
and only our own pages may use the microphone. Navigation and `window.open` are blocked.

## License

MIT (same as Swift-Flowa). whisper.cpp is MIT. The Whisper weights are MIT (OpenAI).

## Open questions

1. **Data and bundle id.** Should Electron keep its own data (as now), or import Swift-Flowa's
   recent dictations and preferences once? The format is already compatible.
2. **Default shortcut on Windows/Linux.** Resolved in 1.2.0: new installs use `F8`. Upgrades
   keep `Ctrl+Shift+Space`. Right Alt can be chosen on macOS and Windows; Linux cannot
   register a modifier by itself.
3. **Model in installers vs. first-run download.** The Whisper weights stay inside the installers.
4. **GitHub target.** Should this replace `maxkongerskov/Flowa`, or go into `Flowa-Windows` or a new repo?
5. **Signing.** Signing/notarization needs an Apple Developer ID (team 6LZ2DS9JPD) and a Windows code-signing certificate.
6. **Version number.** App version is 1.2.3 (`package.json`). `npm run release -- 1.2.3` publishes
   that version after tests and a packaged update rehearsal on the release Mac. It does not
   publish until that command is run, and this branch does not tag or upload a GitHub Release.
   The feed baked into 1.2.3 is `maxkongerskov/flowa-electron`. Rollback is in
   `RELEASING.md`. `npm run release -- patch` would publish the next patch instead. The
   download table above stays on the last installers that were actually published.
