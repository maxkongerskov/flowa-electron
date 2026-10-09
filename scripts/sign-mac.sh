#!/usr/bin/env bash
# Sign a packaged Flowa.app inside-out with hardened runtime (Developer ID), then
# optionally notarize + staple. Works around electron-builder resolving the identity
# by display name (fails for names with non-ASCII characters like "ø").
#   IDENTITY=<sha1 or name> [NOTARY_PROFILE=AC_PASSWORD] scripts/sign-mac.sh release/mac-arm64/Flowa.app
set -euo pipefail
APP="${1:?path to Flowa.app}"
ID="${IDENTITY:?set IDENTITY to the Developer ID Application identity (sha1 hash recommended)}"
ENT="$(cd "$(dirname "$0")/.." && pwd)/build/entitlements.mac.plist"
sign() { codesign --sign "$ID" --force --timestamp --options runtime --entitlements "$ENT" "$1"; }

# 1) Loose Mach-O files (dylibs, helpers, whisper.cpp, flowa-helper), deepest first.
while IFS= read -r f; do
  if file -b "$f" | grep -q "Mach-O"; then sign "$f"; fi
done < <(find "$APP/Contents" -type f \( -perm -u+x -o -name "*.dylib" -o -name "*.so" -o -name "*.node" \) \
          -not -path "*/MacOS/*" -print | awk '{ print gsub("/","/"), $0 }' | sort -rn | cut -d' ' -f2-)
# 2) Nested bundles (helper apps, frameworks), deepest first.
while IFS= read -r b; do sign "$b"; done < <(find "$APP/Contents/Frameworks" -depth \( -name "*.app" -o -name "*.framework" \) -print)
# 3) The app itself.
sign "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  ZIP="$(mktemp -d)/Flowa.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  spctl -a -vvv -t exec "$APP"
fi
