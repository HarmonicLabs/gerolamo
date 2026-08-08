#!/usr/bin/env bash
# Gap-fill apply runner: keeps applying downloaded chunks while the
# Mithril download continues. Exits when caught up AND download is done.
set -u
export PATH="/home/bakon/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd /media/bakon/data/Dev/HarmonicLabs/gerolamo

LOG=/tmp/mithril-apply-gapfill.log
: > "$LOG"

echo "APPLY_RUNNER_START $(date -u +%FT%TZ)" | tee -a "$LOG"

round=0
while true; do
  round=$((round + 1))
  echo "APPLY_ROUND $round $(date -u +%FT%TZ)" >> "$LOG"

  MARGIN=3 GEROLAMO_DB_PATH=./.live/test.db \
    bun scripts/mithril-apply-gapfill.ts >> "$LOG" 2>&1
  ec=$?

  caught=$(rg -c 'APPLY_CAUGHT_UP' "$LOG" 2>/dev/null || echo 0)
  if [ "$ec" -ne 0 ]; then
    echo "APPLY_RUNNER_ERROR round=$round exit=$ec" | tee -a "$LOG"
    sleep 60
    continue
  fi

  # Is the download still running?
  if pgrep -f 'mithril-bootstrap.*--skip-apply' >/dev/null 2>&1; then
    dl_running=1
  else
    dl_running=0
  fi

  last_line=$(rg '"phase":"done"' "$LOG" | tail -1)
  echo "APPLY_ROUND_DONE round=$round dl_running=$dl_running :: $last_line" >> "$LOG"

  if [ "$dl_running" -eq 0 ] && [ "$caught" -ge 1 ]; then
    # download finished; run once more to be sure, then exit
    MARGIN=0 GEROLAMO_DB_PATH=./.live/test.db \
      bun scripts/mithril-apply-gapfill.ts >> "$LOG" 2>&1 || true
    if rg -q 'APPLY_CAUGHT_UP' "$LOG" 2>/dev/null; then
      echo "APPLY_RUNNER_COMPLETE $(date -u +%FT%TZ)" | tee -a "$LOG"
      exit 0
    fi
  fi

  sleep 90
done
