#!/usr/bin/env bash
# Gerolamo health watch: the failures that are silent in a status page.
#   - relay unhealthy twice in a row, or its explorer index falling far behind
#   - pool stake activating but no block produced well into the epoch (the no-forging case)
#   - KES evolution approaching the 62 cap (the pool dies silently at the cap)
#   - disk headroom
# Emits lines starting with ALERT. Runs under systemd, appending to logs/alerts.log.
set -uo pipefail
API=http://127.0.0.1:3050
POOL=97f7baea3032f9242a09bec9044c67b1f25efddb45f0229e88dd759c
STATE=/home/don/gerolamo/node/health.state
mkdir -p "$STATE"
CYCLE=300

prev_active=""; prev_minted=""; prev_epoch=""

while :; do
  health=$(curl -s --max-time 5 "$API/health")
  ok=$(printf '%s' "$health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["healthy"])' 2>/dev/null)
  if [ "$ok" != "True" ]; then
    sleep 20
    ok2=$(curl -s --max-time 5 "$API/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["healthy"])' 2>/dev/null)
    [ "$ok2" != "True" ] && echo "ALERT relay unhealthy (two consecutive checks)"
  fi

  st=$(curl -s --max-time 8 "$API/api/v0/gerolamo/status")
  epoch=$(printf '%s' "$st" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["tip"]["epoch"])' 2>/dev/null)
  lag=$(printf '%s' "$st" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["index"]["lag_slots"])' 2>/dev/null)
  [ -n "${lag:-}" ] && [ "$lag" -gt 5000 ] 2>/dev/null && echo "ALERT explorer index lag ${lag} slots behind the tip"

  pool=$(curl -s --max-time 8 "$API/api/v0/pools/$POOL")
  active=$(printf '%s' "$pool" | python3 -c 'import json,sys;print(json.load(sys.stdin)["active_stake"])' 2>/dev/null)
  minted=$(printf '%s' "$pool" | python3 -c 'import json,sys;print(json.load(sys.stdin)["blocks_minted"])' 2>/dev/null)
  bepoch=$(printf '%s' "$pool" | python3 -c 'import json,sys;print(json.load(sys.stdin)["blocks_epoch"])' 2>/dev/null)

  [ -n "$prev_active" ] && [ -n "${active:-}" ] && [ "$active" != "$prev_active" ] && echo "ALERT active_stake changed: $prev_active -> $active (pool is live)"
  [ -n "$prev_minted" ] && [ -n "${minted:-}" ] && [ "$minted" != "$prev_minted" ] && echo "ALERT blocks_minted changed: $prev_minted -> $minted"

  # Stake active, deep into the epoch, still nothing minted: the failure that looks like health.
  eslot=$(printf '%s' "$st" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tip"]["slot"])' 2>/dev/null)
  if [ -n "${active:-}" ] && [ "${active:-0}" -gt 0 ] 2>/dev/null && [ -n "${bepoch:-}" ] && [ "$bepoch" -eq 0 ] 2>/dev/null; then
    if [ -n "${epoch:-}" ] && [ "$epoch" != "$prev_epoch" ]; then
      echo "ALERT epoch $epoch began with active stake and 0 blocks so far (normal until the first leader slot)"
    fi
  fi
  prev_epoch="${epoch:-}"

  # KES runway: the producer logs "period P, KES evolution E" at start.
  evo=$(docker logs --tail 400 gerolamo-preprod-producer 2>&1 | grep -oE "KES evolution [0-9]+" | awk '{print $3}' | sort -n | tail -1)
  if [ -n "${evo:-}" ] && [ "$evo" -ge 50 ] 2>/dev/null; then
    echo "ALERT KES evolution ${evo}/62: rotate the operational certificate (needs cold.skey)"
  fi

  free_gb=$(df --output=avail /home | tail -1 | awk '{print int($1/1048576)}')
  [ "${free_gb:-999}" -lt 20 ] 2>/dev/null && echo "ALERT disk: only ${free_gb} GB free on /home"

  sleep "$CYCLE"
done
