#!/bin/bash
# Build Flowa installers for all platforms into release/ (not published anywhere).
# Mirrors Pluto.Markets' scripts/build-release.sh:
#   macOS  : dmg for arm64 and x64; app + dmg signed with Developer ID (by SHA-1,
#            electron-builder can't select the identity by name: the "ø" breaks it),
#            dmg notarized + stapled when the notarytool keychain profile exists
#   Windows: x64 NSIS installer (unsigned)
#   Linux  : x64 AppImage + .deb
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
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then NOTARY_PROFILE=""; fi

# ---- preflight ---------------------------------------------------------------
[ -f "$MODEL" ] || { echo "Missing $MODEL (copy it from ~/Library/Application Support/Flowa-Electron/models/, e.g. cp -c)" >&2; exit 1; }
[ "$(shasum -a 1 "$MODEL" | cut -d' ' -f1)" = "$MODEL_SHA1" ] || { echo "$MODEL: SHA-1 mismatch" >&2; exit 1; }
for d in darwin-arm64/whisper-server darwin-x64/whisper-server win32-x64/whisper-server.exe linux-x64/whisper-server; do
  [ -f "resources/bin/$d" ] || { echo "Missing engine resources/bin/$d" >&2; exit 1; }
done
[ -x resources/mac/flowa-helper ] || bash scripts/build-mac-helper.sh

bash scripts/build-mac-icons.sh
npx --no-install electron-vite build

if [ -e "$OUT" ]; then mv "$OUT" "$OUT.prev-$(date +%Y%m%d-%H%M%S)"; fi
mkdir -p "$OUT"

# ---- macOS -------------------------------------------------------------------
for ARCH in arm64 x64; do
  echo "▶ macOS $ARCH: build app"
  $EB --mac dir --$ARCH -c.mac.identity=null
  if [ "$ARCH" = arm64 ]; then APP="$OUT/mac-arm64/Flowa.app"; else APP="$OUT/mac/Flowa.app"; fi
  echo "▶ macOS $ARCH: sign app with $SIGN_ID"
  IDENTITY="$SIGN_ID" NOTARY_PROFILE= bash scripts/sign-mac.sh "$APP"
  echo "▶ macOS $ARCH: dmg"
  $EB --mac dmg --$ARCH --prepackaged "$APP" -c.mac.identity=null
  DMG="$OUT/Flowa-$VERSION-$ARCH.dmg"
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  if [ -n "$NOTARY_PROFILE" ]; then
    echo "▶ macOS $ARCH: notarize (profile $NOTARY_PROFILE)"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
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

echo "✓ Installers in $OUT/:"
ls -l "$OUT"/*.dmg "$OUT"/*.exe "$OUT"/*.AppImage "$OUT"/*.deb
