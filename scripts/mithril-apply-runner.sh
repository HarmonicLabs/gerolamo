#!/usr/bin/env bash
# Gap-fill apply runner: keeps applying downloaded chunks while the
# Mithril download continues. Exits when caught up AND download is done.
#
# Exit-code contract from scripts/mithril-apply-gapfill.ts:
#   0 = ok (limit or frontier reached)
#   2 = halted on a chunk that applied ZERO blocks (locked/disk-full/env)
#   3 = locked by another live applier
# This runner STOPs on 2 and 3 (needs human attention). It retries exit 1
# a bounded number of times, then stops.
set -u
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Repo root = parent of this scripts/ directory, wherever the checkout lives.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

LOG=/tmp/mithril-apply-gapfill.log
MAX_TRANSIENT_RETRIES=3

echo "APPLY_RUNNER_START $(date -u +%FT%TZ) pid=$$" | tee -a "$LOG"

round=0
transient=0
while true; do
  round=$((round + 1))
  echo "APPLY_ROUND $round $(date -u +%FT%TZ)" >> "$LOG"

  # Run one pass; stream output live to $LOG (tee) so `tail -f` works
  # mid-round, and keep a per-round copy so the caught-check uses only
  # THIS round (not the whole accumulated log).
  roundout=$(mktemp /tmp/apply-round-XXXXXX.out)
  MARGIN=3 GEROLAMO_DB_PATH=./.live/test.db \
    bun scripts/mithril-apply-gapfill.ts 2>&1 | tee -a "$LOG" > "$roundout"
  ec=${PIPESTATUS[0]}

  if [ "$ec" -eq 3 ]; then
    echo "APPLY_RUNNER_STOP: another applier holds the lock (exit=3). $(date -u +%FT%TZ)" | tee -a "$LOG"
    rm -f "$roundout"
    exit 3
  fi
  if [ "$ec" -eq 2 ]; then
    echo "APPLY_RUNNER_STOP: a chunk applied ZERO blocks (exit=2). Inspect $LOG — progress NOT advanced; needs human attention. $(date -u +%FT%TZ)" | tee -a "$LOG"
    rm -f "$roundout"
    exit 2
  fi
  if [ "$ec" -ne 0 ]; then
    transient=$((transient + 1))
    echo "APPLY_RUNNER_RETRY round=$round exit=$ec transient=$transient/$MAX_TRANSIENT_RETRIES" >> "$LOG"
    rm -f "$roundout"
    if [ "$transient" -ge "$MAX_TRANSIENT_RETRIES" ]; then
      echo "APPLY_RUNNER_STOP: $MAX_TRANSIENT_RETRIES consecutive transient failures. $(date -u +%FT%TZ)" | tee -a "$LOG"
      exit 1
    fi
    sleep 60
    continue
  fi

  # A successful pass resets the transient counter.
  transient=0

  # Did THIS round catch up to the frontier?
  caught_this_round=0
  if grep -q 'APPLY_CAUGHT_UP' "$roundout"; then
    caught_this_round=1
  fi

  # Is the download still running?
  if pgrep -f 'mithril-bootstrap.*--skip-apply' >/dev/null 2>&1; then
    dl_running=1
  else
    dl_running=0
  fi

  last_line=$(grep '"phase":"done"' "$roundout" | tail -1)
  echo "APPLY_ROUND_DONE round=$round dl_running=$dl_running caught=$caught_this_round :: $last_line" >> "$LOG"
  rm -f "$roundout"

  if [ "$dl_running" -eq 0 ] && [ "$caught_this_round" -eq 1 ]; then
    # Download finished AND this round reached the frontier. Run a final
    # MARGIN=0 sweep to pick up any tail chunks, then exit.
    sweep=$(mktemp /tmp/apply-round-XXXXXX.out)
    MARGIN=0 GEROLAMO_DB_PATH=./.live/test.db \
      bun scripts/mithril-apply-gapfill.ts 2>&1 | tee -a "$LOG" > "$sweep"
    sec=${PIPESTATUS[0]}
    if [ "$sec" -eq 0 ] && grep -q 'APPLY_CAUGHT_UP' "$sweep"; then
      echo "APPLY_RUNNER_COMPLETE $(date -u +%FT%TZ)" | tee -a "$LOG"
      rm -f "$sweep"
      exit 0
    fi
    echo "APPLY_RUNNER: final sweep exit=$sec — will re-check next round. $(date -u +%FT%TZ)" >> "$LOG"
    rm -f "$sweep"
  fi

  sleep 90
done
