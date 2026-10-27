#!/bin/bash
# Container entrypoint: first-start setup, then run the node under a small supervisor.
#
# Everything is a flag (no environment variables; the node's own settings are in docs/CONFIG.md):
#   docker run gerolamo [entrypoint flags] [-- <node flags>]
#     --network preview|preprod|mainnet   (default preview)
#     --port <http port>                  (default 3030)
#     --data <dir>                        (default /data)
#     --max-rss-gb <n>                    restart the node above this anonymous RSS (default 8)
#     --bootstrap mithril|genesis         first start only (default mithril):
#                                         mithril: download + verify a Mithril snapshot and import its ledger state
#                                         straight into the LMDB store (the way the preview nodes were built; fastest)
#                                         genesis: build the ledger from genesis, block by block (no snapshot trusted;
#                                         preview takes about a day)
#     --role relay|producer|data          role written into a new config.json (default relay)
#     --n2n-port <port>                   N2N port written into a new config.json (default 3001)
#     --mithril-concurrency <n>           parallel snapshot downloads (default 8)
#     --keep-snapshot                     keep the snapshot download after the bootstrap
#     --bun-flags "<flags>"               Bun's own flags for every launch
#   Node flags after -- are passed to start-gerolamo after the ones this script sets (the last value wins).
# A config.json is written to the data directory unless one is there already (edit it to change role, peers, ports).
#
# Supervisor: the node is restarted when it exits or when its RSS passes --max-rss-gb (native memory
# grows during long syncs; a restart resumes from the stores in seconds). SIGTERM/SIGINT stop it cleanly.
#
# Profiling hooks (files in $D, picked up within 15 s):
#   touch $D/heap.next        → SIGUSR2 to the node: a heap class summary in $D/logs/heap-<ts>.json
#   echo 120 > $D/cpu-prof.next → the node restarts under `bun --cpu-prof` for that many seconds, then exits
#                                 (Bun writes the profile to $D/prof/ on exit) and runs normally again
set -u
NET=preview; PORT=3030; D=/data; MAX_GB=8; BOOTSTRAP=mithril; ROLE=relay; N2N_PORT=3001; MITHRIL_CONCURRENCY=8; KEEP_SNAPSHOT=0; BUN_FLAGS=""; NODE_FLAGS=()
while [ $# -gt 0 ]; do
  case $1 in
    --network) NET=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --data) D=$2; shift 2 ;;
    --max-rss-gb) MAX_GB=$2; shift 2 ;;
    --bootstrap) BOOTSTRAP=$2; shift 2 ;;
    --role) ROLE=$2; shift 2 ;;
    --n2n-port) N2N_PORT=$2; shift 2 ;;
    --mithril-concurrency) MITHRIL_CONCURRENCY=$2; shift 2 ;;
    --keep-snapshot) KEEP_SNAPSHOT=1; shift ;;
    --bun-flags) BUN_FLAGS=$2; shift 2 ;;
    --) shift; NODE_FLAGS=("$@"); break ;;
    *) echo "[gerolamo-entrypoint] unknown argument $1 (node flags go after --)" >&2; exit 2 ;;
  esac
done
if ! touch "$D/.write-test" 2>/dev/null; then
  echo "[gerolamo-entrypoint] $D is not writable by uid $(id -u). Create the host data directory yourself before the first start (mkdir -p <dir>), or chown it to $(id -u):$(id -g)." >&2
  exit 3
fi
rm -f "$D/.write-test"
mkdir -p "$D/logs"
log() { echo "[gerolamo-entrypoint $(date -u +%FT%TZ)] $*"; }
case "$NET" in preview|preprod|mainnet) ;; *) log "--network must be preview, preprod or mainnet (got $NET)"; exit 2;; esac
echo "$PORT" > "$D/.http-port" # for the image's HEALTHCHECK
# liblmdb: the node finds it itself (standard paths, then ldconfig; --lmdb-lib overrides)

if [ ! -f "$D/config.json" ]; then
  GENESIS=false; [ "$BOOTSTRAP" = "genesis" ] && GENESIS=true
  cat > "$D/config.json" <<EOF
{
 "role": "$ROLE",
 "syncFromTip": false, "syncFromGenesis": $GENESIS, "syncFromPoint": false,
 "ledgerStore": "lmdb", "ledgerSqlWrites": false,
 "blockStoreMode": "primary",
 "relayStore": "chunks",
 "n2cSocketPath": "$D/node.socket",
 "n2n": { "enabled": $([ "$ROLE" = data ] && echo false || echo true), "host": "0.0.0.0", "port": $N2N_PORT },
 "logs": { "logToFile": false, "logToConsole": true, "logLevel": "INFO" },
 "sync": { "skipIndexWhileBehind": true }
}
EOF
  log "wrote $D/config.json (role $ROLE, network $NET, bootstrap $BOOTSTRAP)"
fi

# Mithril bootstrap once, before the first start: the ledger state goes straight into LMDB.
if [ "$BOOTSTRAP" = "mithril" ] && [ ! -d "$D/ledger" ]; then
  log "first start: Mithril bootstrap of $NET into $D (downloads and verifies the snapshot; this takes a while)"
  cd /app && bun src/index.ts mithril-bootstrap --network "$NET" --download-dir "$D/snapshots" \
      --block-store "$D/db" --ledger-state --ledger "$D/ledger" --include-ancillary \
      --db "$D/$NET.db" --download-concurrency "$MITHRIL_CONCURRENCY" || {
        # Do not exit: the restart policy would start the whole download again in a loop. Stay up, unhealthy,
        # until someone looks (docker compose logs); the downloaded chunks in $D/snapshots are reused next time.
        log "Mithril bootstrap FAILED; see the lines above. Fix the cause, then: docker compose restart"
        trap 'exit 1' TERM INT; while true; do sleep 3600 & wait $!; done; }
  if [ "$KEEP_SNAPSHOT" != "1" ]; then rm -rf "$D/snapshots"; log "snapshot download removed (--keep-snapshot keeps it)"; fi
fi

child=0; stopping=0
on_term() { stopping=1; [ "$child" -gt 0 ] && kill -TERM "$child" 2>/dev/null; }
trap on_term TERM INT

while [ "$stopping" = 0 ]; do
  flags=$BUN_FLAGS; prof_until=0
  if [ -f "$D/cpu-prof.next" ]; then
    secs=$(tr -dc 0-9 < "$D/cpu-prof.next"); secs=${secs:-120}; rm -f "$D/cpu-prof.next"; mkdir -p "$D/prof"
    flags="$flags --cpu-prof --cpu-prof-dir=$D/prof"; prof_until=$(( $(date +%s) + secs ))
    log "CPU profile window: ${secs} s"
  fi
  log "starting gerolamo $NET on :$PORT (data $D)"
  # Start bun itself in the background (not `cd && bun` — that backgrounds a subshell, $! would be the subshell,
  # and every restart signal would orphan the running node: several nodes on one store).
  cd /app
  bun $flags src/index.ts start-gerolamo --network "$NET" --port "$PORT" --db-path "$D/$NET.db" --config "$D/config.json" \
      --failed-block-dir "$D/logs" --heap-dir "$D/logs" "${NODE_FLAGS[@]}" &
  child=$!; started=$(date +%s)
  while kill -0 "$child" 2>/dev/null; do
    # SIGUSR2 before the node installs its handler kills it (Bun's default action): hold the request for a minute.
    if [ -f "$D/heap.next" ] && [ $(( $(date +%s) - started )) -ge 60 ]; then rm -f "$D/heap.next"; kill -USR2 "$child" 2>/dev/null && log "heap summary requested"; fi
    if [ "$prof_until" -gt 0 ] && [ "$(date +%s)" -ge "$prof_until" ]; then
      log "CPU profile window over: stopping the node so Bun writes the profile"; prof_until=0; kill -TERM "$child" 2>/dev/null
    elif [ "$prof_until" -eq 0 ] && [ -f "$D/cpu-prof.next" ]; then
      log "CPU profile requested: restarting the node under --cpu-prof"; kill -TERM "$child" 2>/dev/null
    fi
    # anonymous memory only: LMDB's mapped file pages count in VmRSS but are page cache (reclaimable)
    rss_kb=$(awk '/RssAnon/{print $2}' /proc/$child/status 2>/dev/null); rss_kb=${rss_kb:-0}
    if [ "$rss_kb" -ge $((MAX_GB * 1024 * 1024)) ]; then
      log "rss $((rss_kb / 1024)) MB >= ${MAX_GB} GB: restarting"; kill -TERM "$child" 2>/dev/null
    fi
    sleep 15 & wait $! 2>/dev/null
  done
  wait "$child" 2>/dev/null; code=$?
  [ "$stopping" = 1 ] && break
  log "node exited ($code); restarting in 5 s"; sleep 5
done
log "stopped"
