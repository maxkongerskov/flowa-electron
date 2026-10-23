#!/bin/bash
# Build Flowa installers for all platforms into release/ (not published anywhere).
# Mirrors Pluto.Markets' scripts/build-release.sh:
#   macOS  : signed + notarized + stapled dmg for arm64 and x64 (the public download),
#            plus a signed updater zip of the stapled .app for each arch.
#            Identity is the Developer ID SHA-1 (electron-builder can't select it by
#            name: the "ø" breaks it).
#   Windows: x64 NSIS installer (unsigned; electron-updater still installs it)
#   Linux  : x64 AppImage + .deb
# After the artifacts are final, scripts/update-feed.mjs rewrites latest-mac.yml,
# latest.yml, and latest-linux.yml from the bytes on disk.
# FLOWA_REQUIRE_NOTARY=1 (set by npm run release) aborts when notarization cannot run.
# A plain build warns and continues if the notary profile is missing.
# The speech model (models/ggml-large-v3-turbo.bin, ~1.6 GB) is bundled in every
# installer via electron-builder.release.cjs. Engines must already be staged in
# resources/bin/{darwin-arm64,darwin-x64,win32-x64,linux-x64}/.
# Override with FLOWA_SIGN_ID / FLOWA_NOTARY_PROFILE (default profile: AC_PASSWORD).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="release"
CFG="electron-builder.release.cjs"
EB="npx --no-install electron-builder --config $CFG -c.directories.output=$OUT"
VERSION="$(node -p "require('./package.json').version")"
MODEL="models/ggml-large-v3-turbo.bin"
MODEL_SHA1="4af2b29d7ec73d781377bfd1758ca957a807e941"

SIGN_ID="${FLOWA_SIGN_ID:-$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')}"
[ -n "$SIGN_ID" ] || { echo "No Developer ID Application identity found" >&2; exit 1; }
NOTARY_PROFILE="${FLOWA_NOTARY_PROFILE:-AC_PASSWORD}"
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  if [ "${FLOWA_REQUIRE_NOTARY:-}" = "1" ]; then
    echo "Notary profile '$NOTARY_PROFILE' is not available. Aborting before any installer is published." >&2
    exit 1
  fi
  NOTARY_PROFILE=""
  echo "⚠ No notarytool profile. DMGs will be signed but not notarized."
fi

# ---- preflight ---------------------------------------------------------------
[ -f "$MODEL" ] || { echo "Missing $MODEL (copy it from ~/Library/Application Support/Flowa-Electron/models/, e.g. cp -c)" >&2; exit 1; }
# Whisper Small is optional. When models/ggml-small.bin is staged
# (`npm run setup:small`), electron-builder.release.cjs bundles it next to Turbo.
if [ -f models/ggml-small.bin ]; then
  echo "Whisper Small staged — it will be bundled."
else
  echo "Whisper Small not staged (optional). npm run setup:small"
fi
[ "$(shasum -a 1 "$MODEL" | cut -d' ' -f1)" = "$MODEL_SHA1" ] || { echo "$MODEL: SHA-1 mismatch" >&2; exit 1; }
for d in darwin-arm64/whisper-server darwin-x64/whisper-server win32-x64/whisper-server.exe linux-x64/whisper-server; do
  [ -f "resources/bin/$d" ] || { echo "Missing engine resources/bin/$d" >&2; exit 1; }
done
if [ ! -x resources/mac/flowa-helper ] || [ native/macos/flowa-helper.swift -nt resources/mac/flowa-helper ]; then
  bash scripts/build-mac-helper.sh
fi

bash scripts/build-mac-icons.sh
npx --no-install electron-vite build

if [ -e "$OUT" ]; then mv "$OUT" "$OUT.prev-$(date +%Y%m%d-%H%M%S)"; fi
mkdir -p "$OUT"

# ---- macOS -------------------------------------------------------------------
# Zip the app only after it is signed (and stapled, when notarizing). The dmg is
# hashed later, after it is stapled. electron-builder's own latest-mac.yml is ignored.
for ARCH in arm64 x64; do
  echo "▶ macOS $ARCH: build app"
  $EB --mac dir --$ARCH -c.mac.identity=null
  if [ "$ARCH" = arm64 ]; then APP="$OUT/mac-arm64/Flowa.app"; else APP="$OUT/mac/Flowa.app"; fi
  # `dir` does not run electron-builder's afterPack publish step, so the yml
  # would be missing and Mac downloads would fail with ENOENT. Write it before
  # the bundle is signed.
  node scripts/app-update-yml.mjs write "$APP/Contents/Resources"
  echo "▶ macOS $ARCH: sign app with $SIGN_ID"
  IDENTITY="$SIGN_ID" NOTARY_PROFILE="$NOTARY_PROFILE" bash scripts/sign-mac.sh "$APP"
  # Names match scripts/update-feed.mjs macZipName. The x64 name must not contain "arm64".
  ZIP="$OUT/Flowa-$VERSION-$ARCH-mac.zip"
  echo "▶ macOS $ARCH: updater zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  # The zip is a container. The app inside is already signed. codesign on the
  # zip itself is not what electron-updater checks.
  if [ -n "$NOTARY_PROFILE" ]; then
    echo "▶ macOS $ARCH: notarize updater zip"
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  fi
  echo "▶ macOS $ARCH: dmg"
  $EB --mac dmg --$ARCH --prepackaged "$APP" -c.mac.identity=null
  DMG="$OUT/Flowa-$VERSION-$ARCH.dmg"
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  # Stapling changes the dmg. Drop any blockmap electron-builder wrote before that.
  rm -f "$DMG.blockmap"
  if [ -n "$NOTARY_PROFILE" ]; then
    echo "▶ macOS $ARCH: notarize dmg (profile $NOTARY_PROFILE)"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$APP"
    xcrun stapler validate "$DMG"
  elif [ "${FLOWA_REQUIRE_NOTARY:-}" = "1" ]; then
    echo "Notarization is required and no profile is set. Aborting." >&2
    exit 1
  else
    echo "⚠ No notarytool profile found: $DMG is signed but not notarized"
  fi
done

# ---- Windows -----------------------------------------------------------------
echo "▶ Windows x64: NSIS"
$EB --win nsis --x64

# ---- Linux -------------------------------------------------------------------
echo "▶ Linux x64: AppImage + deb"
$EB --linux AppImage deb --x64

# The packaged engine must be the target platform's (not the host's).
file "$OUT"/mac-arm64/Flowa.app/Contents/Resources/bin/whisper-server | grep -q "arm64"
file "$OUT"/mac/Flowa.app/Contents/Resources/bin/whisper-server | grep -q "x86_64"
file "$OUT"/win-unpacked/resources/bin/whisper-server.exe | grep -q "PE32+"
[ -f "$OUT"/win-unpacked/resources/bin/whisper.dll ]
file "$OUT"/linux-unpacked/resources/bin/whisper-server | grep -q "ELF 64-bit"
[ -f "$OUT"/linux-unpacked/resources/bin/libwhisper.so.1 ]
[ -f "$OUT/Flowa-$VERSION-arm64-mac.zip" ]
[ -f "$OUT/Flowa-$VERSION-x64-mac.zip" ]
[ -f "$OUT/Flowa-$VERSION-arm64.dmg" ]
[ -f "$OUT/Flowa-$VERSION-x64.dmg" ]

echo "▶ app-update.yml in every unpacked bundle"
node scripts/app-update-yml.mjs assert \
  "$OUT/mac-arm64/Flowa.app/Contents/Resources" \
  "$OUT/mac/Flowa.app/Contents/Resources" \
  "$OUT/win-unpacked/resources" \
  "$OUT/linux-unpacked/resources"

echo "▶ update feed (sha512, size, and ed25519 from the final files)"
node scripts/update-feed.mjs "$OUT" "$VERSION"

echo "✓ Release files in $OUT/:"
find "$OUT" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' -o -name '*.exe' -o -name '*.AppImage' -o -name '*.deb' -o -name 'latest*.yml' -o -name '*.blockmap' \) -print
