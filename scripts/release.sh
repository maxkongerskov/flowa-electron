#!/bin/bash
# One command on a Mac: test, prove the update on this platform, bump, build,
# and only then commit, tag, push, and publish.
# A failed test, update rehearsal, sign, staple, or feed check exits before
# the tag is pushed and before `gh release create`.
#
#   npm run release -- patch
#   npm run release -- minor
#   npm run release -- 1.2.2
#
# An explicit version equal to package.json tags and publishes that version
# without a second bump. patch / minor / major always move the version forward.
# FLOWA_SIGN_ID / FLOWA_NOTARY_PROFILE override the Developer ID and the
# notarytool keychain profile (default profile: AC_PASSWORD).
# FLOWA_UPDATE_KEY is the ed25519 private key (default ~/.config/flowa/update-private.pem).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -ne 1 ]; then
  echo "usage: npm run release -- patch|minor|major|<x.y.z>" >&2
  exit 1
fi
SPEC="$1"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash before releasing." >&2
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  echo "Detached HEAD. Check out a branch first." >&2
  exit 1
fi

echo "▶ preflight (aborting here publishes nothing)"
SIGN_ID="${FLOWA_SIGN_ID:-$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')}"
[ -n "${SIGN_ID:-}" ] || { echo "No Developer ID Application identity found" >&2; exit 1; }
NOTARY_PROFILE="${FLOWA_NOTARY_PROFILE:-AC_PASSWORD}"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null
gh auth status
MODEL="models/ggml-large-v3-turbo.bin"
MODEL_SHA1="4af2b29d7ec73d781377bfd1758ca957a807e941"
[ -f "$MODEL" ] || { echo "Missing $MODEL" >&2; exit 1; }
[ "$(shasum -a 1 "$MODEL" | cut -d' ' -f1)" = "$MODEL_SHA1" ] || { echo "$MODEL: SHA-1 mismatch" >&2; exit 1; }
for d in darwin-arm64/whisper-server darwin-x64/whisper-server win32-x64/whisper-server.exe linux-x64/whisper-server; do
  [ -f "resources/bin/$d" ] || { echo "Missing engine resources/bin/$d" >&2; exit 1; }
done
UPDATE_KEY="${FLOWA_UPDATE_KEY:-$HOME/.config/flowa/update-private.pem}"
[ -f "$UPDATE_KEY" ] || { echo "Missing $UPDATE_KEY. Run bash scripts/generate-update-key.sh and commit src/shared/updatePublicKey.ts." >&2; exit 1; }
export FLOWA_UPDATE_KEY="$UPDATE_KEY"
node scripts/update-trust.mjs check-embedded "$UPDATE_KEY" src/shared/updatePublicKey.ts

CURRENT="$(node -p "require('./package.json').version")"
NEW="$(node scripts/next-version.mjs "$CURRENT" "$SPEC")"
if git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
  echo "Tag v$NEW already exists locally" >&2
  exit 1
fi
REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/v$NEW")" || {
  echo "Could not reach origin to check whether v$NEW is already tagged." >&2
  exit 1
}
if printf '%s\n' "$REMOTE_TAG" | grep -q "refs/tags/v${NEW}$"; then
  echo "Tag v$NEW already exists on origin" >&2
  exit 1
fi

echo "▶ unit tests"
npm test
npm run typecheck

echo "▶ packaged update test (this platform)"
case "$(uname -s)" in
  Darwin) bash scripts/e2e-update-mac.sh ;;
  Linux) node scripts/e2e-update.mjs ;;
  MINGW*|MSYS*|CYGWIN*) node scripts/e2e-update.mjs ;;
  *) echo "No packaged update test for $(uname -s)" >&2; exit 1 ;;
esac

BUMPED=0
restore_version() {
  if [ "$BUMPED" = "1" ]; then
    mv package.json.release-bak package.json
    mv package-lock.json.release-bak package-lock.json
    BUMPED=0
  fi
}
trap restore_version EXIT

if [ "$NEW" = "$CURRENT" ]; then
  echo "▶ version stays $NEW (no bump)"
else
  echo "▶ version $CURRENT → $NEW (local until the build succeeds)"
  cp package.json package.json.release-bak
  cp package-lock.json package-lock.json.release-bak
  BUMPED=1
  npm version "$NEW" --no-git-tag-version
fi

echo "▶ build (notarization required; a failure stops before the tag is pushed)"
FLOWA_SIGN_ID="$SIGN_ID" FLOWA_NOTARY_PROFILE="$NOTARY_PROFILE" FLOWA_REQUIRE_NOTARY=1 FLOWA_UPDATE_KEY="$UPDATE_KEY" bash scripts/build-release.sh

# The build succeeded. Keep the version bump and publish from here.
trap - EXIT
rm -f package.json.release-bak package-lock.json.release-bak
BUMPED=0

if [ "$NEW" != "$CURRENT" ]; then
  git add package.json package-lock.json
  git commit -m "Release v$NEW"
fi
git tag -a "v$NEW" -m "Flowa $NEW"
git push -u origin HEAD
git push origin "v$NEW"

echo "▶ GitHub Release v$NEW"
bash scripts/publish-release.sh release "$NEW"
