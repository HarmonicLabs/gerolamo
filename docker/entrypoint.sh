#!/bin/bash
# Container entrypoint: first-start setup, then run the node under a small supervisor.
#
# First start (empty /data):
#   GEROLAMO_BOOTSTRAP=mithril  download + verify a Mithril snapshot and import its ledger state straight
#                               into the LMDB store (the way the preview nodes were built; fastest)
#   GEROLAMO_BOOTSTRAP=genesis  build the ledger from genesis, block by block (no snapshot trusted;
#                               preview takes about a day)
# A config.json is written to /data unless one is there already (edit it to change role, peers, ports).
#
# Supervisor: the node is restarted when it exits or when its RSS passes GEROLAMO_MAX_RSS_GB (native memory
# grows during long syncs; a restart resumes from the stores in seconds). SIGTERM/SIGINT stop it cleanly.
#
# Profiling hooks (files in $D, picked up within 15 s):
#   touch $D/heap.next        → SIGUSR2 to the node: a heap class summary in $D/logs/heap-<ts>.json
#   echo 120 > $D/cpu-prof.next → the node restarts under `bun --cpu-prof` for that many seconds, then exits
#                                 (Bun writes the profile to $D/prof/ on exit) and runs normally again
# GEROLAMO_BUN_FLAGS adds flags to every launch.
set -u
NET=${NETWORK:-preview}; PORT=${GEROLAMO_PORT:-3030}; D=${GEROLAMO_DATA:-/data}; MAX_GB=${GEROLAMO_MAX_RSS_GB:-8}
if ! touch "$D/.write-test" 2>/dev/null; then
  echo "[gerolamo-entrypoint] $D is not writable by uid $(id -u). Create the host data directory yourself before the first start (mkdir -p <dir>), or chown it to $(id -u):$(id -g)." >&2
  exit 3
fi
rm -f "$D/.write-test"
mkdir -p "$D/logs"
log() { echo "[gerolamo-entrypoint $(date -u +%FT%TZ)] $*"; }
case "$NET" in preview|preprod|mainnet) ;; *) log "NETWORK must be preview, preprod or mainnet (got $NET)"; exit 2;; esac

# liblmdb: Debian's path differs per architecture.
if [ -z "${LMDB_LIB:-}" ]; then
  LMDB_LIB=$(ldconfig -p | awk '/liblmdb\.so/{print $NF; exit}'); export LMDB_LIB
fi

export NETWORK=$NET GEROLAMO_PORT=$PORT GEROLAMO_DB_PATH=$D/$NET.db GEROLAMO_CONFIG_PATH=$D/config.json \
       GEROLAMO_FAILED_BLOCK_DIR=$D/logs GEROLAMO_HEAP_DIR=$D/logs

if [ ! -f "$D/config.json" ]; then
  GENESIS=false; [ "${GEROLAMO_BOOTSTRAP:-mithril}" = "genesis" ] && GENESIS=true
  ROLE=${GEROLAMO_ROLE:-relay}
  cat > "$D/config.json" <<EOF
{
 "role": "$ROLE",
 "syncFromTip": false, "syncFromGenesis": $GENESIS, "syncFromPoint": false,
 "ledgerStore": "lmdb",
 "blockStoreMode": "primary",
 "relayStore": "chunks",
 "n2cSocketPath": "$D/node.socket",
 "n2n": { "enabled": $([ "$ROLE" = data ] && echo false || echo true), "host": "0.0.0.0", "port": ${GEROLAMO_N2N_PORT:-3001} },
 "logs": { "logToFile": false, "logToConsole": true, "logLevel": "INFO" },
 "sync": { "skipIndexWhileBehind": true }
}
EOF
  log "wrote $D/config.json (role $ROLE, network $NET, bootstrap ${GEROLAMO_BOOTSTRAP:-mithril})"
fi

# Mithril bootstrap once, before the first start: the ledger state goes straight into LMDB.
if [ "${GEROLAMO_BOOTSTRAP:-mithril}" = "mithril" ] && [ ! -d "$D/ledger" ]; then
  log "first start: Mithril bootstrap of $NET into $D (downloads and verifies the snapshot; this takes a while)"
  cd /app && bun src/index.ts mithril-bootstrap --network "$NET" --download-dir "$D/snapshots" \
      --block-store "$D/db" --ledger-state --ledger "$D/ledger" --include-ancillary \
      --download-concurrency "${GEROLAMO_MITHRIL_CONCURRENCY:-8}" || {
        # Do not exit: the restart policy would start the whole download again in a loop. Stay up, unhealthy,
        # until someone looks (docker compose logs); the downloaded chunks in $D/snapshots are reused next time.
        log "Mithril bootstrap FAILED; see the lines above. Fix the cause, then: docker compose restart"
        trap 'exit 1' TERM INT; while true; do sleep 3600 & wait $!; done; }
  if [ "${GEROLAMO_KEEP_SNAPSHOT:-0}" != "1" ]; then rm -rf "$D/snapshots"; log "snapshot download removed (GEROLAMO_KEEP_SNAPSHOT=1 keeps it)"; fi
fi

child=0; stopping=0
on_term() { stopping=1; [ "$child" -gt 0 ] && kill -TERM "$child" 2>/dev/null; }
trap on_term TERM INT

while [ "$stopping" = 0 ]; do
  flags=${GEROLAMO_BUN_FLAGS:-}; prof_until=0
  if [ -f "$D/cpu-prof.next" ]; then
    secs=$(tr -dc 0-9 < "$D/cpu-prof.next"); secs=${secs:-120}; rm -f "$D/cpu-prof.next"; mkdir -p "$D/prof"
    flags="$flags --cpu-prof --cpu-prof-dir=$D/prof"; prof_until=$(( $(date +%s) + secs ))
    log "CPU profile window: ${secs} s"
  fi
  log "starting gerolamo $NET on :$PORT (data $D)"
  # Start bun itself in the background (not `cd && bun` — that backgrounds a subshell, $! would be the subshell,
  # and every restart signal would orphan the running node: several nodes on one store).
  cd /app
  bun $flags src/index.ts start-gerolamo &
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
