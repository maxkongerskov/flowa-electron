# Third-party notices

Flowa is MIT licensed (see [LICENSE](LICENSE)). It bundles, links to, or downloads the
third-party components below. Each license claim links to the source it was checked against
on 2026-10-25. Anything that could not be confirmed is marked **UNVERIFIED**.

Full license texts for the npm packages are inside each package in `node_modules/<name>/LICENSE`
and are copied into the packaged app by electron-builder.

---

## 1. Speech engine: whisper.cpp

| | |
|---|---|
| Project | whisper.cpp (ggml-org) — https://github.com/ggml-org/whisper.cpp |
| Version | **v1.9.5**, commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` |
| License | **MIT**, "Copyright (c) 2023-2026 The ggml authors" |
| Source | https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/LICENSE |

How each build gets it:

| Build | Binary | Origin |
|---|---|---|
| macOS arm64 / x64 | `whisper-server`, `whisper-cli` + ggml libs (Metal on arm64) | Compiled from the v1.9.5 tag by `scripts/build-whisper.mjs` |
| Windows x64, Linux x64 (CPU) | `whisper-server`, `whisper.dll` / `libwhisper.so.1`, ggml CPU libs | Official upstream release **b5454** (same commit `d1be6fd…`): `whisper-bin-x64.zip`, `whisper-bin-ubuntu-x64.tar.gz` from https://github.com/ggml-org/whisper.cpp/releases/tag/b5454 |
| Windows x64, Linux x64 (Vulkan, branch `cursor/vulkan-whisper-engine-27ec`, planned for 1.2.3) | `whisper-server-vulkan/` | Compiled from v1.9.5 with `-DGGML_VULKAN=ON` in `.github/workflows/vulkan-engine.yml`. The Vulkan loader (`vulkan-1.dll` / `libvulkan.so`) is **not** bundled; the system one is used |

Code compiled into `whisper-server` from the whisper.cpp tree (checked in the v1.9.5 sources):

| Component | File in whisper.cpp | License | Source |
|---|---|---|---|
| ggml | `ggml/` | MIT (same LICENSE as whisper.cpp) | https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/LICENSE |
| cpp-httplib (Yuji Hirose) | `examples/server/httplib.h` | MIT | header of https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/server/httplib.h |
| nlohmann/json (Niels Lohmann) | `examples/json.hpp` | MIT (SPDX header) | header of https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/json.hpp |
| miniaudio (decoding only) | `examples/miniaudio.h`, used by `examples/common-whisper.cpp` | Public domain (Unlicense) or MIT-0, at your choice | end of https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/miniaudio.h |
| stb_vorbis | `examples/stb_vorbis.c`, used by `examples/common-whisper.cpp` | Public domain or MIT | header of https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/stb_vorbis.c |
| Vulkan-Hpp / Vulkan-Headers (Vulkan build only, compile-time headers) | from the Vulkan SDK | Apache-2.0 (Vulkan-Hpp); Apache-2.0 OR MIT (Vulkan-Headers) | https://github.com/KhronosGroup/Vulkan-Hpp (GitHub license API: Apache-2.0), https://github.com/KhronosGroup/Vulkan-Headers/blob/main/LICENSE.md |

Extra files in the upstream b5454 **Windows** zip. `scripts/stage-cpu-engine.mjs` copies the whole
`Release/` folder, so these end up in the installer unless they are pruned (see CHECKLIST.md):

| File | Project | License | Source |
|---|---|---|---|
| `SDL2.dll` | SDL 2 | zlib | https://github.com/libsdl-org/SDL/blob/SDL2/LICENSE.txt |
| `llama.dll` (used by `whisper-talk-llama.exe`) | llama.cpp | MIT | https://github.com/ggml-org/llama.cpp (GitHub license API: MIT) |
| `parakeet.dll`, `parakeet-*.exe`, other example/test `.exe` files | whisper.cpp tree | MIT (whisper.cpp LICENSE) — **UNVERIFIED** that no file in these binaries carries a different license | https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/LICENSE |

The Linux tarball ships whisper.cpp's own `LICENSE` file next to the binaries.

---

## 2. Speech model weights

The app uses two OpenAI Whisper checkpoints in whisper.cpp's ggml format. URLs and SHA-1 values are
in `src/shared/model.ts` and `scripts/fetch-model.mjs`.

| App model id | File | Downloaded from | SHA-1 | Bundled? |
|---|---|---|---|---|
| `whisper-turbo` (default) | `ggml-large-v3-turbo.bin` (f16, 1,624,555,275 bytes) | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin | `4af2b29d7ec73d781377bfd1758ca957a807e941` | Yes, in release installers |
| `whisper-small` | `ggml-small.bin` (f16, 487,601,967 bytes) | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin | `55356645c2b361a969dfd0ef2c5a50d530afd8d5` | Only if staged at release time; otherwise downloaded on first use |

Both SHA-1 values match the table in https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/models/README.md.

### License of the weights

| Claim | License | Source |
|---|---|---|
| OpenAI: "Whisper's code and model weights are released under the MIT License." | **MIT**, "Copyright (c) 2022 OpenAI" | https://github.com/openai/whisper#license and https://github.com/openai/whisper/blob/main/LICENSE |
| The original checkpoints `small.pt` and `large-v3-turbo.pt` are published by OpenAI in that repo | — | https://github.com/openai/whisper/blob/main/whisper/__init__.py (`_MODELS`) |
| whisper.cpp converts those OpenAI `.pt` files to ggml with `convert-pt-to-ggml.py` | — | https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/models/README.md |
| Hugging Face repo `ggerganov/whisper.cpp` (the files Flowa downloads) | **MIT** (`license: mit` in the model card) | https://huggingface.co/ggerganov/whisper.cpp (README front matter / API `cardData.license`) |
| Hugging Face `openai/whisper-large-v3-turbo` (Transformers version of the same turbo checkpoint) | MIT | https://huggingface.co/openai/whisper-large-v3-turbo |
| Hugging Face `openai/whisper-small` (Transformers version of the small checkpoint) | Apache-2.0 | https://huggingface.co/openai/whisper-small |

Note on Whisper small: OpenAI's GitHub repo puts all Whisper weights under MIT, while OpenAI's
Hugging Face card for the Transformers copy of `whisper-small` says Apache-2.0. The file Flowa
downloads is the ggml conversion of the GitHub `.pt` checkpoint and is labelled MIT by its
publisher, so MIT applies. Both licenses are permissive and compatible with MIT; if in doubt, keep
both notices.

Required notice for the weights (MIT):

```
Copyright (c) 2022 OpenAI
(MIT License text as in LICENSE, with this copyright line)
```

---

## 3. Electron runtime

| | |
|---|---|
| Package | `electron` 44.7.0 |
| License | **MIT**, "Copyright (c) Electron contributors / Copyright (c) 2013-2020 GitHub Inc." |
| Source | https://github.com/electron/electron/blob/main/LICENSE, npm registry `electron@44.7.0` `license: MIT` |

Electron bundles Chromium, Node.js, V8, FFmpeg and many other projects under their own licenses
(BSD, MIT, LGPL-2.1 for FFmpeg as a separate shared library, and others). electron-builder copies
Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` into every packaged app; those files
are the authoritative list. **UNVERIFIED:** I did not unpack a released Flowa installer to confirm
both files are present in 1.2.2.

---

## 4. npm packages shipped in the app

Derived from `package-lock.json` on `main` (Flowa 1.2.2). The branch
`cursor/vulkan-whisper-engine-27ec` (1.2.3) has the same runtime set. Licenses were checked against
the npm registry entry for the exact version (`https://registry.npmjs.org/<name>/<version>`,
field `license`), because many lockfile entries have no `license` field.

### 4a. Runtime dependencies (`dependencies`, in `app.asar/node_modules`)

| Package | Version | License | Repository |
|---|---|---|---|
| electron-updater | 6.8.9 | MIT | https://github.com/electron-userland/electron-builder |
| builder-util-runtime | 9.7.0 | MIT | https://github.com/electron-userland/electron-builder |
| semver (nested in electron-updater) | 7.7.4 | ISC | https://github.com/npm/node-semver |
| argparse | 2.0.1 | Python-2.0 (PSF-style, permissive) | https://github.com/nodeca/argparse |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| fs-extra | 10.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| js-yaml | 4.3.2 | MIT | https://github.com/nodeca/js-yaml |
| jsonfile | 6.2.1 | MIT | https://github.com/jprichardson/node-jsonfile |
| lazy-val | 1.0.5 | MIT | https://github.com/develar/lazy-val |
| lodash.escaperegexp | 4.1.2 | MIT | https://github.com/lodash/lodash |
| lodash.isequal | 4.5.0 | MIT | https://github.com/lodash/lodash |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| sax | 1.6.1 | BlueOak-1.0.0 (permissive) | https://github.com/isaacs/sax-js |
| tiny-typed-emitter | 2.1.0 | MIT | https://github.com/binier/tiny-typed-emitter |
| universalify | 2.0.1 | MIT | https://github.com/RyanZim/universalify |

### 4b. Bundled into the renderer by Vite (listed as `devDependencies`, but their code ships)

| Package | Version | License | Repository |
|---|---|---|---|
| react | 19.3.0 | MIT | https://github.com/react/react (per npm registry; formerly facebook/react) |
| react-dom | 19.3.0 | MIT | https://github.com/react/react (per npm registry; formerly facebook/react) |
| scheduler | 0.28.0 | MIT | https://github.com/react/react (per npm registry; formerly facebook/react) |
| lucide-react | 1.54.0 | ISC; icons derived from Feather are MIT (Cole Bemis) | https://github.com/lucide-icons/lucide/blob/main/LICENSE |

Build-only tools (electron-builder, electron-vite, vite, vitest, typescript, @types/*,
@vitejs/plugin-react) are not shipped in the app and are not listed here.

---

## 5. Flowa's own native helpers

`native/macos/flowa-helper.swift` and `resources/win/modifier-hook.ps1` are part of Flowa and
covered by Flowa's MIT license. They use only OS frameworks (AppKit, ApplicationServices, Foundation, IOKit.hid;
Win32 via PowerShell).
