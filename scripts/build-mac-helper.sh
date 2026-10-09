#!/usr/bin/env bash
# Compile native/macos/flowa-helper.swift → resources/mac/flowa-helper (universal).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != "Darwin" ]]; then echo "macOS only — skipping."; exit 0; fi
mkdir -p resources/mac build/helper
SRC=native/macos/flowa-helper.swift
swiftc -O -target arm64-apple-macos12 "$SRC" -o build/helper/flowa-helper-arm64
swiftc -O -target x86_64-apple-macos12 "$SRC" -o build/helper/flowa-helper-x86_64
lipo -create build/helper/flowa-helper-arm64 build/helper/flowa-helper-x86_64 -output resources/mac/flowa-helper
chmod +x resources/mac/flowa-helper
echo "Built resources/mac/flowa-helper"
