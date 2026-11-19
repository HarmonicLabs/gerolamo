#!/bin/bash
# Every 5 min: one line per Gerolamo container (status, tip, lag, halted, producer next slot / KES, equivocations, memory).
# Self-healing (the laptop watchdog does not reach this host): a container whose node reports a halt on 2 consecutive
# checks, or whose tip is > 900 s behind the clock on 3 consecutive checks while the container is running, is restarted
# (docker restart) at most once per hour. The entrypoint supervisor inside the container handles exits and memory.
cd /home/don/gerolamo/node
declare -A bad lastRestart
while true; do
  now=$(( $(date +%s) - 1666656000 ))
  for c in gerolamo-relay:3040 gerolamo-producer:3041; do
    name=${c%%:*}; port=${c##*:}
    st=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' $name 2>/dev/null | head -1); st=${st:-absent}
    m=$(curl -s -m 5 http://127.0.0.1:$port/metrics 2>/dev/null)
    summary=$(printf '%s' "$m" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("no-metrics"); sys.exit()
pr=d.get("producer") or {}; s=d.get("sync") or {}
print("tip",d.get("tipSlot"),"halted",s.get("halted"),"next",pr.get("nextLeaderSlot"),"kes",(pr.get("kes") or {}).get("health"),"equiv",(d.get("equivocations") or {}).get("total"),"rssMB",round((d.get("process") or {}).get("rssBytes",0)/1048576))' 2>/dev/null)
    echo "$(date -u +%FT%TZ) slot=$now $name $st $summary"
    # self-healing bookkeeping
    tip=$(printf '%s' "$summary" | awk '{for(i=1;i<=NF;i++) if($i=="tip") print $(i+1)}'); halted=$(printf '%s' "$summary" | awk '{for(i=1;i<=NF;i++) if($i=="halted") print $(i+1)}')
    unhealthy=0
    if [[ "$st" == running* ]]; then
      if [[ -n "$halted" && "$halted" != "None" ]]; then unhealthy=1; fi
      if [[ "$tip" =~ ^[0-9]+$ ]] && (( now - tip > 900 )); then unhealthy=1; fi
    fi
    if (( unhealthy )); then bad[$name]=$(( ${bad[$name]:-0} + 1 )); else bad[$name]=0; fi
    threshold=3; [[ -n "$halted" && "$halted" != "None" ]] && threshold=2
    if (( ${bad[$name]} >= threshold )) && (( $(date +%s) - ${lastRestart[$name]:-0} > 3600 )); then
      echo "$(date -u +%FT%TZ) RESTART $name: unhealthy ${bad[$name]} checks (halted=$halted tip=$tip now=$now)"
      docker restart $name >/dev/null 2>&1; lastRestart[$name]=$(date +%s); bad[$name]=0
    fi
  done >> health.log
  sleep 300
done
