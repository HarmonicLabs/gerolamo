#!/usr/bin/env bash
# Chained bring-up: wait for the Preprod explorer backfill to finish, then
# bootstrap and start the Dingo preprod relay. Keeps the two write-heavy jobs
# off the disk at the same time.
set -uo pipefail
API=http://192.168.1.173:3050
D=/home/don/gerolamo/node
LOG=/home/don/gerolamo/logs/dingo-launch.log
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

log "waiting for historyIndexed=true (backfill) before touching dingo"
waited=0
while :; do
  hist=$(curl -s --max-time 10 "$API/api/v0/gerolamo/status" | python3 -c 'import json,sys;print(json.load(sys.stdin)["coverage"]["historyIndexed"])' 2>/dev/null)
  backfill_state=$(docker inspect gerolamo-backfill --format '{{.State.Status}}' 2>/dev/null)
  if [ "$hist" = "True" ]; then log "backfill reports historyIndexed=true"; break; fi
  if [ "$backfill_state" != "running" ]; then log "backfill container is no longer running ($backfill_state) and historyIndexed=$hist — proceeding"; break; fi
  if [ $((waited % 6)) -eq 0 ]; then log "still running (backfill=$backfill_state historyIndexed=$hist, ${waited}m elapsed)"; fi
  waited=$((waited+1)); sleep 600
done

log "starting dingo mithril sync (preprod) — this is the write-heavy step"
cd "$D" || exit 1
docker compose -f docker-compose.dingo-preprod.yml run --rm dingo-mithril 2>&1 | tail -20
rc=${PIPESTATUS[0]}
log "mithril sync rc=$rc"
[ "$rc" -ne 0 ] && { log "mithril sync failed; not starting the relay"; exit "$rc"; }

log "starting dingo relay"
docker compose -f docker-compose.dingo-preprod.yml up -d dingo
sleep 30
log "health: $(curl -s --max-time 5 http://127.0.0.1:12799/health || echo unavailable)"
log "disk: $(df -h /home | tail -1)"
log "done"
