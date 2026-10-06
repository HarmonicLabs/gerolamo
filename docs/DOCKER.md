# Running Gerolamo in Docker

The image holds the node (TypeScript on Bun), the LMDB ledger store (`liblmdb` through `bun:ffi`) and the
Mithril bootstrap. All node data lives under `/data` in the container, which docker-compose.yml mounts from
a host directory (default `./data/preview`): the chain survives the container being removed, rebuilt or
upgraded, and you can back it up or inspect it directly. The desktop control center is not in the image; it
runs on the host and attaches to the container (see below).

## Quick start (preview relay, Mithril bootstrap)

```bash
docker compose up -d --build
docker compose logs -f gerolamo
curl -s localhost:3030/health
```

On the first start the entrypoint downloads and verifies a Mithril snapshot of the network and imports its
ledger state straight into the LMDB store; that takes a while (download size depends on the network). Later
starts resume from `/data` in seconds. Open `http://localhost:3030/stats` for the node's own status page.

## Data directory and ports (.env)

Put these in a `.env` file next to docker-compose.yml (or export them):

```
GEROLAMO_DATA_DIR=/srv/gerolamo/preview   # host directory for the chain data (default ./data/preview)
UID=1000                                   # the container runs as this user, so the files are yours
GID=1000
GEROLAMO_N2N_HOST_PORT=3001                # host port for node-to-node (change it if 3001 is taken)
```

Create the directory first (`mkdir -p /srv/gerolamo/preview`) so it is owned by you. Removing the container
(`docker compose down`, even `docker rm -f`) leaves the directory and its chain intact; the next container
resumes from it. `docker stop` / `docker compose down` shut the node down cleanly; a hard kill also recovers,
stepping back to the newest block both stores hold.

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `NETWORK` | `preview` | `preview`, `preprod` or `mainnet` |
| `GEROLAMO_BOOTSTRAP` | `mithril` | First start only: `mithril` (verified snapshot) or `genesis` (build the whole ledger from block 0, no snapshot trusted) |
| `GEROLAMO_ROLE` | `relay` | `relay` (serves peers on 3001), `data` (no inbound peers) or `producer` |
| `GEROLAMO_PORT` | `3030` | HTTP API inside the container |
| `GEROLAMO_N2N_PORT` | `3001` | Node-to-node port inside the container |
| `GEROLAMO_MAX_RSS_GB` | `8` | The in-container supervisor restarts the node above this RSS (it resumes in seconds) |
| `GEROLAMO_MITHRIL_CONCURRENCY` | `8` | Parallel snapshot downloads |
| `GEROLAMO_KEEP_SNAPSHOT` | `0` | `1` keeps the downloaded snapshot after the import |

The entrypoint writes `/data/config.json` on the first start; edit it to change peers, role or other node
settings (it overlays `src/config/<network>/config.json`). Delete it to regenerate it.

## Syncing from genesis

Set `GEROLAMO_BOOTSTRAP: genesis` before the first start. The node builds the genesis ledger state and
validates every block itself. Preview takes about a day on public peers; give it CPUs (`--cpus` or no limit).

## Block producer

1. Put `cold.vkey`, `kes.skey`, `vrf.skey` and `node.cert` in a host directory readable only by you and mount
   it read-only (`./pool-keys:/keys:ro` in docker-compose.yml).
2. Set `GEROLAMO_ROLE: producer`, start once so `/data/config.json` exists, then add
   `"producer": { "coldVkeyFile": "/keys/cold.vkey", "kesSkeyFile": "/keys/kes.skey", "vrfSkeyFile": "/keys/vrf.skey", "opcertFile": "/keys/node.cert", "stateFile": "/data/producer-state.json" }`
   to it and restart. Keep the cold signing key off this machine.
3. After a KES rotation, copy the new `kes.skey` and `node.cert` in and `docker kill -s HUP <container>`
   (the node reloads them without a restart).
4. Publish 3001 so relays can pull your blocks.

## The desktop control center (Electrobun)

It works with a containerised node by attaching to it. In the control center, choose **attach** and enter the
published HTTP port (3030 in docker-compose.yml). The app then follows the node through its HTTP API
(`/metrics`, `/ws/stats`): sync state, peers, ledger, KES, leader slots and resources.

It cannot start, stop or wipe an attached node; use `docker compose` for that. CPU and memory figures come
from the node's own `/metrics`. The app's fallback for older nodes reads `/proc` by pid, which does not work
across the container boundary, so keep the node image current. The log tail needs the log path on the host;
the node logs to the container's stdout, so use `docker compose logs`.

## Notes

- `docker stop` sends SIGTERM through `tini` to the entrypoint, which stops the node cleanly; allow up to
  60 s (`stop_grace_period`).
- The node-to-client socket is `<data dir>/node.socket` on the host, so cardano-cli can use it directly
  (`CARDANO_NODE_SOCKET_PATH=<data dir>/node.socket`).
- Do not run two containers on the same data directory: one store, one writer.
