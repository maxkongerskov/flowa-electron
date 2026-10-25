#!/bin/bash
# Upload release/ to GitHub Releases.
# 1.2.3 and later check maxkongerskov/flowa-releases. 1.2.2 still checks
# maxkongerskov/flowa-electron, so 1.2.3 is uploaded to both repos with the
# same files. latest*.yml keeps relative urls, so one copy works on either repo.
# Later versions upload to flowa-releases only.
#
# The release stays a draft until every file has been uploaded and the feed
# still matches. Only files that exist are uploaded (a missing
# latest-linux-arm64.yml is skipped). Each upload is retried on its own so a
# 408 on a large dmg does not abort the whole set.
# An already-published release is left alone unless FLOWA_PUBLISH_FORCE=1.
#
#   bash scripts/publish-release.sh
#   bash scripts/publish-release.sh release 1.2.3
# gh must be logged in with access to both repos for the 1.2.3 bridge.
# flowa-releases is created by hand before the first publish. This script does not create it.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-release}"
VERSION="${2:-$(node -p "require('./package.json').version")}"
if [ -z "${FLOWA_UPDATE_KEY:-}" ] && [ -f "${HOME}/.config/flowa/update-private.pem" ]; then
  export FLOWA_UPDATE_KEY="${HOME}/.config/flowa/update-private.pem"
fi
RELEASE_REPO="maxkongerskov/flowa-releases"
# 1.2.2 reads this repo. Only the bridge version is copied here.
BRIDGE_REPO="maxkongerskov/flowa-electron"
BRIDGE_VERSION="1.2.3"
TAG="v${VERSION}"

[ -d "$OUT" ] || { echo "Missing $OUT. Run bash scripts/build-release.sh first." >&2; exit 1; }
node scripts/update-feed.mjs --verify "$OUT" "$VERSION"

shopt -s nullglob
files=()
for pattern in '*.dmg' '*.zip' '*.exe' '*.AppImage' '*.deb' 'latest-mac.yml' 'latest.yml' 'latest-linux.yml' 'latest-linux-arm64.yml' '*.blockmap'; do
  for f in "$OUT"/$pattern; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      latest-*.yml|latest.yml) ;;
      *)
        case "$base" in
          *"$VERSION"*) ;;
          *) echo "Skipping $base (does not match $VERSION)" >&2; continue ;;
        esac
        ;;
    esac
    files+=("$f")
  done
done
[ "${#files[@]}" -gt 0 ] || { echo "No release files in $OUT" >&2; exit 1; }

NOTES="Flowa ${VERSION}

The installed app checks this release, verifies its signature, downloads it, and restarts into it.
macOS updater zips are for electron-updater. The dmg is the file to download by hand."

upload_one() {
  local repo="$1"
  local f="$2"
  local attempt=1
  local delay=4
  while [ "$attempt" -le 5 ]; do
    if gh release upload "$TAG" --repo "$repo" --clobber "$f"; then
      return 0
    fi
    echo "Upload failed (attempt ${attempt}) for $(basename "$f") on ${repo}. Retrying in ${delay}s." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
  echo "Giving up on $(basename "$f") for ${repo}" >&2
  return 1
}

publish_repo() {
  local repo="$1"
  if gh release view "$TAG" --repo "$repo" >/dev/null 2>&1; then
    local draft
    draft="$(gh release view "$TAG" --repo "$repo" --json isDraft --jq .isDraft)"
    if [ "$draft" != "true" ] && [ "${FLOWA_PUBLISH_FORCE:-}" != "1" ]; then
      echo "Release $TAG is already published on ${repo}. Refusing to replace it. Set FLOWA_PUBLISH_FORCE=1 to override." >&2
      exit 1
    fi
  else
    gh release create "$TAG" --repo "$repo" --draft --title "Flowa ${VERSION}" --notes "$NOTES"
  fi

  for f in "${files[@]}"; do
    echo "▶ upload $(basename "$f") to ${repo}"
    upload_one "$repo" "$f"
  done

  echo "▶ verify uploaded names on ${repo}"
  local asset_names
  asset_names="$(gh release view "$TAG" --repo "$repo" --json assets --jq '.assets[].name')"
  for f in "${files[@]}"; do
    local base
    base="$(basename "$f")"
    printf '%s\n' "$asset_names" | grep -qx "$base" || { echo "Missing on ${repo}: $base" >&2; exit 1; }
  done
  node scripts/update-feed.mjs --verify "$OUT" "$VERSION"

  gh release edit "$TAG" --repo "$repo" --draft=false --latest --title "Flowa ${VERSION}" --notes "$NOTES"
  echo "✓ Published ${TAG} on ${repo} (Latest)"
}

publish_repo "$RELEASE_REPO"
if [ "$VERSION" = "$BRIDGE_VERSION" ]; then
  echo "▶ 1.2.3 bridge: identical artifacts and latest*.yml to ${BRIDGE_REPO}"
  publish_repo "$BRIDGE_REPO"
fi
