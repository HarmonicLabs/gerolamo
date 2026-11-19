#!/usr/bin/env bash
# Rebuild the preprod image and recreate relay + producer from it, with a maintenance marker so the
# log watcher does not page for the containers being down while they are deliberately replaced.
#   ./deploy-preprod.sh            rebuild from this directory's source, then recreate
#   ./deploy-preprod.sh --no-build recreate from the current image
set -uo pipefail
HERE=/home/don/gerolamo/node
MARK=$HERE/.maintenance
cd "$HERE" || exit 0

touch "$MARK"
trap 'rm -f "$MARK"' EXIT
echo "[deploy $(date -u +%FT%TZ)] maintenance marker set"

if [ "${1:-}" != "--no-build" ]; then
    docker build -q -t gerolamo:preprod . 2>&1 | tail -1 || { echo "build failed"; exit 1; }
fi

docker compose -f docker-compose.preprod.yml up -d --force-recreate 2>&1 | tail -4

for i in $(seq 1 30); do
    ok=$(curl -s -m 5 http://127.0.0.1:3050/health | grep -c '"healthy":true')
    [ "$ok" = "1" ] && { echo "[deploy] relay healthy after ${i}0s"; break; }
    sleep 10
done

echo "[deploy $(date -u +%FT%TZ)] done"
