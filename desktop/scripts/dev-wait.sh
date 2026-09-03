#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

# Fresh clone: install this package's deps if the root `bun install` did not
# (its postinstall normally does), then verify system libraries.
if [ ! -x node_modules/.bin/electrobun ] || [ ! -x node_modules/.bin/vite ]; then
  echo "[Gerolamo UI] desktop dependencies missing — running bun install"
  bun install
fi
bun ../scripts/preflight.ts || { echo "[Gerolamo UI] preflight failed — fix the items above and rerun"; exit 1; }

# A previous dev session still running would keep serving old code next to the
# new one (two windows, two bun backends). Refuse unless FORCE=1.
if pgrep -f "electrobun dev" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
  echo "[Gerolamo UI] An Electrobun dev session is already running (pid $(pgrep -f 'electrobun dev' | head -1))."
  echo "[Gerolamo UI] Close it first (Ctrl+C in its terminal), or run FORCE=1 bun run ui:dev to start another."
  exit 1
fi
if [ ! -d node_modules/electrobun/dist-linux-x64 ]; then
  echo "[Gerolamo UI] First run: Electrobun downloads its Linux runtime (~150 MB) now…"
fi

export GDK_BACKEND=x11
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_FORCE_SOFTWARE_OPENGL=1
export ELECTROBUN_SKIP_UPDATER=1
export LD_LIBRARY_PATH="$PWD/node_modules/electrobun/dist-linux-x64:$PWD:$LD_LIBRARY_PATH"

echo "[Gerolamo UI] WebKit env forced: GDK_BACKEND=$GDK_BACKEND"

mkdir -p Resources ../Resources
cat > Resources/version.json << 'EOF'
{
  "version": "0.0.1-dev",
  "hash": "dev",
  "channel": "dev",
  "baseUrl": ""
}
EOF
cp -f Resources/version.json ../Resources/version.json 2>/dev/null || true

cp -f "$PWD/node_modules/electrobun/dist-linux-x64/libNativeWrapper.so" "$PWD/libNativeWrapper.so" || true
cp -f "$PWD/node_modules/electrobun/dist-linux-x64/libasar.so" "$PWD/libasar.so" 2>/dev/null || true

echo "[Gerolamo UI] Clearing cache and build folders..."
# Wipe the previous dev bundle (views AND the bun main process) so a restart can
# never run stale backend code from an earlier session.
rm -rf dist views build/dev-linux-x64/Gerolamo-dev/Resources/app/views build/dev-linux-x64/Gerolamo-dev/Resources/app/bun 2>/dev/null || true
GIT_HASH="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY="$(git -C .. status --porcelain --untracked-files=no 2>/dev/null | head -1)"
echo "[Gerolamo UI] Building UI from commit ${GIT_HASH}${GIT_DIRTY:+ (with local changes)} — $(date -u +%FT%TZ)"

echo "[Gerolamo UI] Initial Vite build..."
./node_modules/.bin/vite build || exit 1

mkdir -p views/mainview
rsync -a --delete dist/ views/mainview/

TARGET_VIEWS_DIR="build/dev-linux-x64/Gerolamo-dev/Resources/app/views/mainview"
mkdir -p "$TARGET_VIEWS_DIR"
rsync -a --delete dist/ "$TARGET_VIEWS_DIR/" || true

VITE_LOG="$(mktemp -t gerolamo-vite-watch.XXXXXX.log)"
cleanup() {
  local ec=$?
  if [[ -n "${VITE_PID:-}" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
  fi
  if [[ -n "${ELECTROBUN_PID:-}" ]] && kill -0 "$ELECTROBUN_PID" 2>/dev/null; then
    kill "$ELECTROBUN_PID" 2>/dev/null || true
    wait "$ELECTROBUN_PID" 2>/dev/null || true
  fi
  rm -f "$VITE_LOG" 2>/dev/null || true
  exit "$ec"
}
trap cleanup EXIT INT TERM

echo "[Gerolamo UI] Starting Vite watch…"
./node_modules/.bin/vite build --watch 2>&1 | sed -u 's/^/[0] /' | tee "$VITE_LOG" &
VITE_PID=$!

FIRST_BUILD_OK=0
for _ in $(seq 1 240); do
  if grep -qE 'built in [0-9]' "$VITE_LOG" 2>/dev/null; then
    FIRST_BUILD_OK=1
    break
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "[Gerolamo UI] ERROR: Vite watch exited before first build." >&2
    exit 1
  fi
  sleep 0.5
done

if [[ "$FIRST_BUILD_OK" -ne 1 ]]; then
  echo "[Gerolamo UI] ERROR: Timed out waiting for Vite watch build." >&2
  exit 1
fi

sleep 1
rsync -a --delete dist/ views/mainview/
rsync -a --delete dist/ "$TARGET_VIEWS_DIR/" || true

echo "[Gerolamo UI] Launching Electrobun…"
./node_modules/.bin/electrobun dev --watch 2>&1 | sed -u 's/^/[1] /' &
ELECTROBUN_PID=$!
wait -n "$VITE_PID" "$ELECTROBUN_PID" 2>/dev/null || wait
