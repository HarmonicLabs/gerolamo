#!/usr/bin/env bash
# Wait for the devnet's first forged block (or for the producer to be handed no slots).
set -uo pipefail
API=http://127.0.0.1:3052
NAME=gerolamo-devnet-producer
last_epoch=""
while :; do
  tip=$(curl -s --max-time 5 "$API/api/v0/gerolamo/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["tip"]["slot"], d["tip"]["epoch"])' 2>/dev/null)
  slot=${tip% *}; epoch=${tip#* }
  if [ -n "${slot:-}" ] && [ "$slot" -gt 0 ] 2>/dev/null; then
    echo "ALERT devnet forged a block: tip slot $slot epoch $epoch"
    docker logs --tail 5 "$NAME" 2>&1 | grep -iE "forg|mint|block" | tail -3 | sed 's/^/  /'
    exit 0
  fi
  if [ -n "${epoch:-}" ] && [ "$epoch" != "$last_epoch" ] && [ "$epoch" -ge 2 ] 2>/dev/null; then
    sched=$(docker logs --tail 200 "$NAME" 2>&1 | grep "epoch $epoch schedule" | tail -1)
    echo "ALERT devnet epoch $epoch started at tip slot 0: ${sched:-no schedule line yet}"
    last_epoch=$epoch
  fi
  sleep 60
done
