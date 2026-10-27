# Gerolamo node image: the TypeScript node on Bun, its LMDB ledger store (liblmdb through bun:ffi)
# and the Mithril bootstrap. The desktop app (Electrobun) and the web dashboards are not in the
# image: the desktop app runs on the host and attaches to the container's HTTP port.
#
#   docker build -t gerolamo .
#   docker compose up -d            (see docker-compose.yml and docs/DOCKER.md)

FROM oven/bun:1.4.2 AS deps
WORKDIR /app
# Dependencies only, so code changes do not reinstall them. --ignore-scripts skips the postinstall that
# installs the desktop and dashboard apps; patchedDependencies (patches/) are applied by the install itself.
COPY package.json bun.lock ./
COPY vendor ./vendor
COPY patches ./patches
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends liblmdb0 zstd ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY vendor ./vendor
COPY src ./src
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/gerolamo-entrypoint
RUN chmod -R a+rX /app && chmod +x /usr/local/bin/gerolamo-entrypoint && mkdir -p /data && chmod 0777 /data

# Node data (block store, LMDB ledger, SQLite bookkeeping, sockets, logs) lives in /data: mount a host
# directory there (docker-compose.yml does) so it outlives the container. The image runs as any UID
# (`user:` in compose); /app is read-only to it and everything it writes goes to /data.
VOLUME ["/data"]
# Settings are flags, not environment variables: pass them as the container command, e.g.
#   docker run ... gerolamo --network preview --port 3030 --role relay -- --n2n-ws-port 3004
# (docker/entrypoint.sh lists its flags; the node's are in docs/CONFIG.md). HOME is only for Bun's cache.
ENV HOME=/tmp
# 3030 HTTP (/health, /metrics, /stats, WS /ws/stats, mini-Blockfrost); 3001 node-to-node (relay / producer role).
EXPOSE 3030 3001
HEALTHCHECK --interval=60s --timeout=10s --start-period=30m --retries=5 \
  CMD curl -fsS "http://127.0.0.1:$(cat /data/.http-port 2>/dev/null || echo 3030)/health" > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "gerolamo-entrypoint"]
