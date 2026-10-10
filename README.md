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
| **GPU** | Not required | Apple Silicon with Metal for the fastest transcription |
| **Disk** | 4 GB free | 8 GB free |
| **OS** | macOS 12+, Windows 10/11 (64-bit), Ubuntu 22.04+ or similar | Latest macOS on Apple Silicon |

The macOS Apple Silicon build uses the GPU via Metal. The current Windows and Linux builds run the speech engine on the CPU; CUDA acceleration is not bundled yet. Linux also needs `libgomp1`.

## Download

| Platform | Variant | Installer | Size |
|---|---|---|---|
| macOS | Apple Silicon (M1 and later) | [Flowa-1.1.0-arm64.dmg](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.1.0/Flowa-1.1.0-arm64.dmg) | 1.5 GB |
| macOS | Intel | [Flowa-1.1.0-x64.dmg](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.1.0/Flowa-1.1.0-x64.dmg) | 1.5 GB |
| Windows | 64-bit | [Flowa-Setup-1.1.0-x64.exe](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.1.0/Flowa-Setup-1.1.0-x64.exe) | 1.4 GB |
| Linux | AppImage, x86_64 | [Flowa-1.1.0.AppImage](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.1.0/Flowa-1.1.0.AppImage) | 1.5 GB |
| Linux | Debian/Ubuntu | [flowa_1.1.0_amd64.deb](https://github.com/maxkongerskov/flowa-electron/releases/download/v1.1.0/flowa_1.1.0_amd64.deb) | 1.5 GB |

All files for version 1.1.0 are on the [v1.1.0 release page](https://github.com/maxkongerskov/flowa-electron/releases/tag/v1.1.0).

## Quick start (local test)

Requirements: Node 20+, git, cmake, a C/C++ toolchain (macOS: Xcode Command Line Tools ·
Windows: VS 2022 Build Tools · Linux: `build-essential`).

```bash
cd ~/Projects/Flowa-Electron
npm install                 # also fetches the Electron binary (postinstall)
npm run setup:mac-helper    # macOS only: builds resources/mac/flowa-helper (fn key + paste)
npm run setup:whisper       # builds whisper.cpp v1.9.5 → resources/bin/<platform>-<arch>/
npm run setup:model         # downloads ggml-large-v3-turbo.bin (1.6 GB, sha1-verified) → models/
npm test                    # unit tests for the ported logic
npm start                   # build + run the app
```

`npm run dev` starts the app with hot reload for the renderer.

If you skip `setup:model`, the app downloads the model into its own data folder on first run
(the "Installing" screen, with resume and sha1 check).

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
and `models/`. Code signing and notarization are not configured yet (see open questions).

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
| GlobalHotkey: fn tap/hold via CGEventTap | `hotkey.ts` + `flowa-helper watch-fn` | ✅ on macOS. ⛔ on Win/Linux (no fn key event) → configurable accelerator, default `Ctrl+Shift+Space` |
| TextInserter: AX check, activate target, ⌘V via CGEvent, clipboard floor | `textInserter.ts` | ✅ mac (helper) · ✅ Windows (PowerShell keybd_event, untested on real Windows) · 🟡 Linux (needs xdotool / wtype / ydotool, otherwise clipboard only) |
| FnConflictDetector (`AppleFnUsageType`) | `fnConflict.ts` | ✅ mac · n/a elsewhere |
| PermissionChecker (Mic, Input Monitoring, Accessibility) | `permissions.ts` | ✅ mac · auto-granted where the OS has no such gate |
| Repair (tccutil reset, lsregister, relaunch) | `repair.ts` | ✅ mac (packaged only) · 🟡 elsewhere (re-check + relaunch only) |
| LoginItem (SMAppService) | `loginItem.ts` | ✅ mac/win (`setLoginItemSettings`) · ✅ Linux (XDG autostart) |
| Preferences (UserDefaults keys) | `store.ts` → `prefs.json` | ✅ same keys |
| Recent dictations JSON | `recent.ts` | ✅ format-compatible (sorted keys, ISO 8601, upper-case UUIDs) |
| Language catalog (99 + auto) | `languages.ts` | ✅ generated from `LanguageOption.swift` |
| Unit tests (Swift `FlowaTests`) | `tests/*.test.ts` (60) | ✅ logic tests ported. 🟡 the E2E fixtures run through the dev self-test, not under vitest |
| Code signing / notarization / Sparkle-style updates | – | ⛔ not done yet (needs certificates) |

## Platform-dependent parts and their equivalents

| Swift (file) | Why it is platform-bound | Electron equivalent |
|---|---|---|
| `Hotkey/GlobalHotkey.swift:76-113` CGEventTap on `flagsChanged`/fn | macOS Quartz API | mac: `native/macos/flowa-helper.swift watch-fn` (same tap, stdout events). Win/Linux: `globalShortcut` accelerator |
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
src/shared     pure ported logic (prefs, languages, mic kinds, recent, wav, audio math, status copy, model)
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
2. **Default shortcut on Windows/Linux.** Currently `Ctrl+Shift+Space`. Flowa-Windows may have used
   another one.
3. **Model in installers vs. first-run download.** Bundling adds 1.6 GB per installer. A first-run
   download keeps installers around 100 MB.
4. **GitHub target.** Should this replace `maxkongerskov/Flowa`, or go into `Flowa-Windows` or a new repo?
5. **Signing.** Signing/notarization needs an Apple Developer ID (team 6LZ2DS9JPD) and a Windows code-signing certificate.
6. **Version number.** Currently 1.1.0, mirroring Swift.
