#!/usr/bin/env bash
# Bring up the dingo v0.93.0 preprod reference relay: pull, mithril import, start, verify.
set -uo pipefail
LOG=/home/don/gerolamo/logs/dingo93.log
D=/home/don/gerolamo/node
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

log "pulling ghcr.io/blinklabs-io/dingo:main"
docker pull ghcr.io/blinklabs-io/dingo:main 2>&1 | tail -3 || { log "PULL FAILED"; exit 1; }
log "pull ok"

mkdir -p /home/don/gerolamo/dingo/db /home/don/gerolamo/dingo/ipc
cd "$D" || exit 1

log "mithril sync (preprod) into /home/don/gerolamo/dingo/db"
docker compose -f docker-compose.dingo-v93.yml run --rm dingo93-mithril 2>&1 | tail -20
rc=${PIPESTATUS[0]}
log "mithril rc=$rc"
[ "$rc" -ne 0 ] && { log "mithril FAILED"; exit "$rc"; }

log "starting dingo93"
docker compose -f docker-compose.dingo-v93.yml up -d dingo93
sleep 45

for i in $(seq 1 10); do
  h=$(curl -s --max-time 6 http://127.0.0.1:12799/health)
  log "health $i: $h"
  echo "$h" | grep -q '"ready":true' && break
  sleep 60
done

log "stall check: blockfetch/sqlstore warnings in the last 5 m"
docker logs --since 5m gerolamo-dingo93 2>&1 | grep -c "not making progress" | sed 's/^/stall_warnings=/'
log "disk: $(df -h /home | tail -1)"
log "done"
