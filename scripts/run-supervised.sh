#!/bin/bash
# Keep one gerolamo node running: relaunch when it exits and restart it cleanly when RSS
# passes a limit (native memory grows during long syncs; the kernel OOM killer takes
# 24 GB otherwise). Sync resumes from the DB, every range is one SQLite transaction.
#
# usage: scripts/run-supervised.sh <network> <port> <datadir> [max_rss_gb=14] [logfile]
# env: GEROLAMO_BUN_FLAGS (e.g. "--cpu-prof --cpu-prof-dir=<dir>": the profile is written when the node exits — SIGTERM it after the sample window)
# env passthrough: GEROLAMO_PLUTUS_SHADOW_MS (default 2000: shadow evaluation runs detached, off the apply path), GEROLAMO_PLUTUS_SHADOW_SAMPLE (default 10)
set -u
NET=$1; PORT=$2; DIR=$3; MAX_GB=${4:-14}; LOGNAME_=${5:-${NET}-supervised.log}
REPO=$(cd "$(dirname "$0")/.." && pwd)
LOG=$DIR/logs/$LOGNAME_
mkdir -p "$DIR/logs"
say() { echo "[supervisor $(date -u +%FT%TZ)] $*" | tee -a "$DIR/logs/supervisor.log"; }

port_pid() { for p in $(pgrep -x bun); do tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q "^GEROLAMO_PORT=$PORT$" && echo $p && return; done; }
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
    ( cd "$REPO" && NETWORK=$NET GEROLAMO_PORT=$PORT GEROLAMO_DB_PATH=$DIR/$NET.db GEROLAMO_CONFIG_PATH=$DIR/config.json \
        GEROLAMO_FAILED_BLOCK_DIR=$DIR/logs GEROLAMO_HEAP_DIR=$DIR/logs \
        GEROLAMO_PLUTUS_SHADOW_MS=${GEROLAMO_PLUTUS_SHADOW_MS:-2000} GEROLAMO_PLUTUS_SHADOW_SAMPLE=${GEROLAMO_PLUTUS_SHADOW_SAMPLE:-10} GEROLAMO_PLUTUS_TRACE=${GEROLAMO_PLUTUS_TRACE:-0} \
        exec bun ${GEROLAMO_BUN_FLAGS:-} src/index.ts start-gerolamo >> "$LOG" 2>&1 ) &
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
