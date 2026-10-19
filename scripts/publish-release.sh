#!/bin/bash
# Upload release/ to GitHub Releases as a published Latest release (not a draft,
# not a prerelease). The channel yml files must already match the artifacts;
# this script checks that before uploading.
#   bash scripts/publish-release.sh
#   bash scripts/publish-release.sh release 1.2.1
# gh must be logged in with access to maxkongerskov/flowa-electron.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-release}"
VERSION="${2:-$(node -p "require('./package.json').version")}"
REPO="maxkongerskov/flowa-electron"
TAG="v${VERSION}"

[ -d "$OUT" ] || { echo "Missing $OUT. Run bash scripts/build-release.sh first." >&2; exit 1; }
node scripts/update-feed.mjs --verify "$OUT" "$VERSION"

shopt -s nullglob
files=(
  "$OUT"/*.dmg
  "$OUT"/*.zip
  "$OUT"/*.exe
  "$OUT"/*.AppImage
  "$OUT"/*.deb
  "$OUT"/latest-mac.yml
  "$OUT"/latest.yml
  "$OUT"/latest-linux.yml
  "$OUT"/latest-linux-arm64.yml
  "$OUT"/*.blockmap
)
[ "${#files[@]}" -gt 0 ] || { echo "No release files in $OUT" >&2; exit 1; }

NOTES="Flowa ${VERSION}

The installed app can check for this release, download it, and restart into it.
macOS updater zips are for electron-updater. The dmg is the file to download by hand."

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$REPO" --clobber "${files[@]}"
  gh release edit "$TAG" --repo "$REPO" --latest --title "Flowa ${VERSION}" --notes "$NOTES"
else
  gh release create "$TAG" --repo "$REPO" --title "Flowa ${VERSION}" --notes "$NOTES" --latest "${files[@]}"
fi

echo "✓ Published ${TAG} on ${REPO} (Latest, not a draft or prerelease)"
