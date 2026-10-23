#!/bin/bash
# One-time, on the Mac that publishes Flowa. Writes an ed25519 private key
# outside the repo and refreshes the embedded public key.
#
#   bash scripts/generate-update-key.sh
#
# Then commit src/shared/updatePublicKey.ts. Do not commit the private key.
# Override the path with FLOWA_UPDATE_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="${FLOWA_UPDATE_KEY:-$HOME/.config/flowa/update-private.pem}"
PUB="src/shared/updatePublicKey.ts"
mkdir -p "$(dirname "$KEY")"
if [ -f "$KEY" ]; then
  echo "Update signing key already exists: $KEY"
else
  node scripts/update-trust.mjs generate "$KEY"
  chmod 600 "$KEY"
fi
node scripts/update-trust.mjs write-public "$KEY" "$PUB"
echo "Commit $PUB. Leave $KEY on this Mac only."
