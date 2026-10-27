#!/bin/bash
# Keep one gerolamo node running: relaunch when it exits and restart it cleanly when RSS
# passes a limit (native memory grows during long syncs; the kernel OOM killer takes
# 24 GB otherwise). Sync resumes from the DB, every range is one SQLite transaction.
#
# usage: scripts/run-supervised.sh <network> <port> <datadir> [max_rss_gb=14] [logfile] [--bun-flags "<flags>"] [-- <node flags>...]
#   The node gets every setting as a flag (it reads no environment variables; docs/CONFIG.md):
#     --network <network> --port <port> --db-path <datadir>/<network>.db --config <datadir>/config.json
#     --failed-block-dir <datadir>/logs --heap-dir <datadir>/logs --plutus-shadow-ms 2000 --plutus-shadow-sample 10
#   plus the node flags after "--" (they win: a flag given twice takes the last value).
#   --bun-flags: Bun's own flags, e.g. "--cpu-prof --cpu-prof-dir=<dir>" (the profile is written when the node exits).
set -u
NET=$1; PORT=$2; DIR=$3; shift 3
MAX_GB=14; LOGNAME_=${NET}-supervised.log; BUN_FLAGS=""; NODE_FLAGS=()
[ $# -gt 0 ] && [[ $1 != --* ]] && { MAX_GB=$1; shift; }
[ $# -gt 0 ] && [[ $1 != --* ]] && { LOGNAME_=$1; shift; }
while [ $# -gt 0 ]; do
  case $1 in
    --bun-flags) BUN_FLAGS=$2; shift 2 ;;
    --) shift; NODE_FLAGS=("$@"); break ;;
    *) echo "run-supervised.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
REPO=$(cd "$(dirname "$0")/.." && pwd)
LOG=$DIR/logs/$LOGNAME_
mkdir -p "$DIR/logs"
say() { echo "[supervisor $(date -u +%FT%TZ)] $*" | tee -a "$DIR/logs/supervisor.log"; }

# the node on this port: its command line (start-gerolamo ... --port <port>), or, for a node started before
# 2026-10-26, GEROLAMO_PORT=<port> in its environment
port_pid() {
  for p in $(pgrep -x bun); do
    if tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -qE "start-gerolamo .*--port $PORT( |$)"; then echo $p; return; fi
    if tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q "^GEROLAMO_PORT=$PORT$"; then echo $p; return; fi
  done
}
wait_port_free() { for i in $(seq 1 60); do ss -ltn | grep -q ":$PORT " || return 0; sleep 1; done; return 1; }

stop_node() {
  local pid=$1
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 30); do [ -d /proc/$pid ] || break; sleep 1; done
  if [ -d /proc/$pid ]; then say "pid $pid ignored SIGTERM, kill -9"; kill -9 "$pid" 2>/dev/null; fi
  wait_port_free || say "port $PORT still bound after 60 s"
}

while true; do
  old=$(port_pid)
  if [ -n "$old" ]; then say "port $PORT already has pid $old, adopting it"; pid=$old
  else
    say "launching $NET on :$PORT (db $DIR/$NET.db)"
    ( cd "$REPO" && exec bun $BUN_FLAGS src/index.ts start-gerolamo \
        --network "$NET" --port "$PORT" --db-path "$DIR/$NET.db" --config "$DIR/config.json" \
        --failed-block-dir "$DIR/logs" --heap-dir "$DIR/logs" --plutus-shadow-ms 2000 --plutus-shadow-sample 10 \
        "${NODE_FLAGS[@]}" >> "$LOG" 2>&1 ) &
    pid=$!
    sleep 5
  fi
  while [ -d /proc/$pid ]; do
    # anonymous memory only: LMDB's mapped file pages count in VmRSS but are page cache (reclaimable)
    rss_kb=$(awk '/RssAnon/{print $2}' /proc/$pid/status 2>/dev/null); rss_kb=${rss_kb:-0}
    if [ $((rss_kb / 1048576)) -ge "$MAX_GB" ]; then
      say "pid $pid rss $((rss_kb / 1024)) MB >= ${MAX_GB} GB, restarting"
      stop_node "$pid"; break
    fi
    sleep 30
  done
  [ -d /proc/$pid ] || say "pid $pid exited"
  wait_port_free
  sleep 5
done
