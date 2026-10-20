#!/bin/bash
# Packaged macOS update rehearsal. Run this on the release Mac.
# It Developer ID signs a slim test app (the Whisper models stay in the real
# installers only) for arm64 and x64. Each arch must quit within 20s of
# "installing", relaunch 9.9.1 on its own, then reject a tampered zip and
# stay on 9.9.0. The test app id is com.maxkongerskov.FlowaElectron.e2e, so
# ShipIt's cache is not the real Flowa cache. After each launch the script
# waits until FlowaE2E has exited, removes the
# com.maxkongerskov.FlowaElectron.e2e.ShipIt launchd job, then deletes that
# cache. A busy cache directory does not abort the other arch or the tamper
# case. It does not set FLOWA_E2E_ALLOW_UNSIGNED and it does not notarize.
#
#   bash scripts/e2e-update-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${FLOWA_E2E_ALLOW_UNSIGNED:-}" = "1" ]; then
  echo "This Mac test must be Developer ID signed. Unset FLOWA_E2E_ALLOW_UNSIGNED." >&2
  exit 1
fi
SIGN_ID="${FLOWA_SIGN_ID:-$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')}"
[ -n "${SIGN_ID:-}" ] || { echo "No Developer ID Application identity found" >&2; exit 1; }
export FLOWA_SIGN_ID="$SIGN_ID"
unset NOTARY_PROFILE
exec node scripts/e2e-update.mjs
