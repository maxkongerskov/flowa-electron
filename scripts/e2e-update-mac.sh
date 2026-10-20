#!/bin/bash
# Packaged macOS update rehearsal. Run this on the release Mac.
# It Developer ID signs a slim test app (the Whisper models stay in the real
# installers only), serves the next version from localhost, and checks that
# the app downloads, verifies, and restarts. It does not set
# FLOWA_E2E_ALLOW_UNSIGNED and it does not notarize.
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
