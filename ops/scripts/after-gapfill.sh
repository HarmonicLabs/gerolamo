#!/usr/bin/env bash
# After the explorer gap-fill finishes: bring the relay back, confirm history,
# then bootstrap + start the Dingo preprod relay. Serialised so only one
# write-heavy job touches the disk at a time.
set -uo pipefail
LOG=/home/don/gerolamo/logs/dingo-launch2.log
API=http://192.168.1.173:3050
D=/home/don/gerolamo/node
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

log "waiting for the explorer gap-fill container to exit"
while docker ps --format '{{.Names}}' | grep -qx goofy_mccarthy; do sleep 60; done
log "gap-fill container gone"

log "starting the relay"
docker start gerolamo-preprod-relay >/dev/null || { log "relay start FAILED"; exit 1; }
for i in $(seq 1 20); do
  hist=$(curl -s --max-time 10 "$API/api/v0/gerolamo/status" | python3 -c 'import json,sys;print(json.load(sys.stdin)["coverage"]["historyIndexed"])' 2>/dev/null)
  cur=$(curl -s --max-time 10 "$API/api/v0/gerolamo/status" | python3 -c 'import json,sys;print(json.load(sys.stdin)["index"]["mb_cursor_slot"])' 2>/dev/null)
  log "relay check $i: historyIndexed=$hist cursor=$cur"
  [ "$hist" = "True" ] && break
  sleep 30
done

log "running dingo mithril sync (preprod, 24 GB cap)"
cd "$D" || exit 1
docker compose -f docker-compose.dingo-preprod.yml run --rm dingo-mithril 2>&1 | tail -25
rc=${PIPESTATUS[0]}
log "mithril sync rc=$rc"
if [ "$rc" -ne 0 ]; then log "mithril sync FAILED (rc=$rc); relay stays up, dingo not started"; exit "$rc"; fi

log "starting dingo relay"
docker compose -f docker-compose.dingo-preprod.yml up -d dingo
sleep 30
log "dingo health: $(curl -s --max-time 5 http://127.0.0.1:12799/health || echo unavailable)"
log "disk: $(df -h /home | tail -1)"
log "done"
