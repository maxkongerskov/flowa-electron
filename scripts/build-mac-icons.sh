#!/usr/bin/env bash
# Build the macOS app icon from the SAME AppIcon.appiconset the Swift app uses
# (build/Assets.xcassets, copied verbatim from Flowa/Assets.xcassets):
#   build/mac/Assets.car  — compiled by actool, exactly like Xcode does for Swift-Flowa
#                           (gives the same macOS 26 icon rendering; CFBundleIconName=AppIcon)
#   build/icon.icns       — classic fallback (CFBundleIconFile)
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != "Darwin" ]]; then echo "macOS only — skipping."; exit 0; fi
mkdir -p build/mac build/mac/partial
xcrun actool build/Assets.xcassets --compile build/mac --platform macosx \
  --minimum-deployment-target 12.0 --app-icon AppIcon \
  --output-partial-info-plist build/mac/partial/Info.plist --output-format human-readable-text >/dev/null
rm -rf build/mac/AppIcon.icns build/mac/partial
ICONSET=build/mac/icon.iconset
rm -rf "$ICONSET" && cp -R build/Assets.xcassets/AppIcon.appiconset "$ICONSET" && rm -f "$ICONSET/Contents.json"
iconutil -c icns "$ICONSET" -o build/icon.icns
rm -rf "$ICONSET"
echo "Built build/mac/Assets.car and build/icon.icns"
