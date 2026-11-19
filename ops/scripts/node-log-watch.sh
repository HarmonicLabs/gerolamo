#!/usr/bin/env bash
# Node log watcher. Alerts on hard failures and on rollbacks that actually delete
# data; routine noise (peer dial timeouts, normal 0-block rollbacks, PeerGovernor
# spam) is filtered out.
#
# Emits "ALERT ..." lines (the Hermes watch pattern). Silent otherwise.
set -uo pipefail
CONTAINERS="gerolamo-preprod-relay gerolamo-preprod-producer gerolamo-dingo93"
NOISE='PeerGovernor|short-lived connection|outbound: delaying|protocol is shutting down|peer closed the connection|Range seq=.*MsgNoBlocks|dropping never-connected|over quota|outbound: failed to establish|dial tcp|i/o timeout|active connection changed|ChainSync host|ChainSync.*RollBackward|Pre-rollback|Post-rollback|unexpected connection failure|timeout waiting on transition from protocol state|failed to add tx .* to mempool|validate transaction'
HARD='level=ERROR|\[ERROR ?\]|fatal|panic|halt|ValidationTagMismatch|readonly|OOM|out of memory|collect error|UnsupportedScript|does not decode'
ROLLBACK='Rollback to slot.*[1-9][0-9]* blocks|utxoRemoved=[1-9]|utxoRestored=[1-9]'
STATE=/home/don/gerolamo/node/logwatch.state
mkdir -p "$STATE"
CYCLE=300

for c in $CONTAINERS; do
  [ -f "$STATE/$c.last" ] || date -u +%FT%TZ > "$STATE/$c.last"
done

while :; do
  now=$(date -u +%FT%TZ)
  # Planned maintenance: a deploy touches this file, and every container briefly being down is
  # expected rather than an incident. Cursors advance so no backlog is replayed when it clears.
  if [ -f /home/don/gerolamo/node/.maintenance ]; then
    for c in $CONTAINERS; do echo "$now" > "$STATE/$c.last"; done
    sleep "$CYCLE"
    continue
  fi
  for c in $CONTAINERS; do
    f="$STATE/$c.last"
    since=$(cat "$f" 2>/dev/null || echo "$now")
    running=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo "?")
    restarts=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)
    rk="$STATE/$c.restarts"
    prevr=$(cat "$rk" 2>/dev/null || echo 0)

    [ "$running" != "running" ] && echo "ALERT $c is $running"
    [ "$health" = "unhealthy" ] && echo "ALERT $c unhealthy"
    if [ "$restarts" != "$prevr" ]; then
      echo "ALERT $c restarted (RestartCount $prevr -> $restarts)"
      echo "$restarts" > "$rk"
    fi

    if [ "$running" = "running" ]; then
      raw=$(docker logs --since "$since" "$c" 2>&1 | grep -vE "$NOISE")

      hard=$(printf '%s\n' "$raw" | grep -iE "$HARD" || true)
      if [ -n "$hard" ]; then
        n=$(printf '%s\n' "$hard" | wc -l)
        echo "ALERT $c $n hard error line(s) since $since"
        printf '%s\n' "$hard" | tail -4 | cut -c1-220 | sed "s/^/  $c | /"
      fi

      rb=$(printf '%s\n' "$raw" | grep -E "$ROLLBACK" || true)
      if [ -n "$rb" ]; then
        printf '%s\n' "$rb" | tail -2 | cut -c1-200 | sed "s/^/ALERT $c rollback with data: /"
      fi

      mm=$(printf '%s\n' "$raw" | grep -oE "[0-9]+ tx verdict mismatch" | awk '{print $1}' | sort -n | tail -1)
      if [ -n "${mm:-}" ] && [ "$mm" -gt 0 ] 2>/dev/null; then
        echo "ALERT $c phase-2 verdict mismatches: $mm"
      fi
    fi
    date -u +%FT%TZ > "$f"
  done
  sleep "$CYCLE"
done
