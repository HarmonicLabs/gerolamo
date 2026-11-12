#!/usr/bin/env bash
# Build the experimental Bun AOT executable for Gerolamo.
#
# AOT requires a Bun canary build that exposes `--aot`; stable Bun 1.4.4
# accepts the flag but does not emit machine code. Use:
#   BUN=/path/to/bun-canary/bun bash scripts/build-aot.sh [outfile]
#
# The default output is dist/gerolamo-aot. package.json is embedded because
# src/utils/buildInfo.ts reads it at runtime.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${BUN:-bun}"
OUT="${1:-$ROOT/dist/gerolamo-aot}"

if ! "$BUN_BIN" build --help 2>&1 | grep -q -- '--aot'; then
    echo "[Gerolamo AOT] $BUN_BIN does not support --aot; use a Bun canary." >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
cd "$ROOT"

"$BUN_BIN" build \
    --compile \
    --aot \
    --asset package.json \
    ./src/index.ts \
    --outfile "$OUT"

echo "[Gerolamo AOT] built $OUT"
