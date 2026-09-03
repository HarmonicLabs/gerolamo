#!/usr/bin/env bash
# Re-pack HarmonicLabs libraries that are not on npm yet into vendor/*.tgz.
#
# Each entry is "<sibling checkout dir>". The tarball name comes from the
# package's own name+version, so bump the version in the library before
# re-packing if you want the lockfile to notice the change. After running,
# update the "file:vendor/..." specs in package.json if a filename changed,
# then `bun install`.
#
# Usage: scripts/vendor-pack.sh [dir ...]   (defaults to the list below)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
mkdir -p "$VENDOR"

DEFAULT_LIBS=(
  "$ROOT/../kes-ts"
  "$ROOT/../cardano-ledger-ts"
)
LIBS=("${@:-${DEFAULT_LIBS[@]}}")

for lib in "${LIBS[@]}"; do
  if [ ! -f "$lib/package.json" ]; then
    echo "skip: $lib has no package.json" >&2
    continue
  fi
  name=$(node -p "require('$lib/package.json').name")
  # Packages with a build step must ship a fresh dist/.
  if node -e "process.exit(require('$lib/package.json').scripts?.build ? 0 : 1)"; then
    echo "building $name"
    (cd "$lib" && bun run build >/dev/null)
  fi
  # Self-contained tarball: peerDependencies become dependencies so the
  # library keeps its own copies (e.g. cardano-ledger-ts needs cbor 2.x while
  # gerolamo + ouroboros-miniprotocols-ts stay on cbor 1.6). Gerolamo passes
  # bytes across that boundary, never CborObj instances, so nesting is safe.
  # package.json is patched in place and restored afterwards.
  echo "packing $name from $lib (peers → deps)"
  (
    cd "$lib"
    cp package.json package.json.vendor-bak
    trap 'mv -f package.json.vendor-bak package.json' EXIT
    node -e '
      const fs = require("fs");
      const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
      if (p.peerDependencies) {
        p.dependencies = { ...(p.dependencies || {}), ...p.peerDependencies };
        delete p.peerDependencies;
        delete p.peerDependenciesMeta;
      }
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    '
    npm pack --pack-destination "$VENDOR" 2>/dev/null | tail -1
  )
done

echo
echo "vendor/ now holds:"
ls -1 "$VENDOR"/*.tgz
echo
echo "package.json specs should read:"
for f in "$VENDOR"/*.tgz; do
  echo "  \"file:vendor/$(basename "$f")\""
done
