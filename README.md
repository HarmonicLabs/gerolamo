<p align="center">
  <img width="200px" src="https://github.com/HarmonicLabs/gerolamo/blob/closeout-demo/assets/gerolamo-logo.svg" align="center"/>
  <h1 align="center">Gerolamo</h1>
  <p align="center">Cardano TypeScript node / relay — Bun runtime</p>
</p>

<p align="center">
  <img src="https://img.shields.io/github/commit-activity/m/HarmonicLabs/gerolamo?style=for-the-badge" />
  <a href="https://twitter.com/hlabs_tech">
    <img src="https://img.shields.io/twitter/follow/hlabs_tech?style=for-the-badge&logo=twitter" />
  </a>
</p>

**Gerolamo** is a lightweight, modular Cardano **node/relay** in TypeScript (Bun).  
It is **HarmonicLabs** software — **not** TxPipe / `@txpipe/gerolamo`.

| Layer | What you get |
|-------|----------------|
| **N2N** | Handshake, ChainSync, BlockFetch → SQLite |
| **HTTP** | Blocks, UTxOs, health/metrics, Mini-Blockfrost subset, tx submit |
| **N2C** | Optional `node.socket` (LocalChainSync, LocalTxSubmit, minimal LSQ, TxMonitor) |
| **Bootstrap** | Mithril via external `mithril-client` + chunk apply / batch hydrate |

**Honest limits:** soft body path available; full Praos leadership / governance **not** in scope. Mini-BF is a **subset**. LSQ is **minimal**. Soft hydrate ≠ consensus proof.

---

## Quick start

```bash
# Bun ≥ 1.0
git clone https://github.com/HarmonicLabs/gerolamo.git
cd gerolamo
bun install

# Live preprod node
NETWORK=preprod bun src/index.ts start-gerolamo

# Standalone desktop Control Center (Electrobun — not The Lab)
bun run ui:dev

# Mainnet
NETWORK=mainnet bun src/index.ts start-gerolamo
```

| Surface | Default |
|---------|---------|
| HTTP API | `http://127.0.0.1:3030` |
| DB | `./ledger/gerolamo.db` (override with env) |
| Entry | `bun src/index.ts start-gerolamo` |

### Env (instance isolation)

| Variable | Purpose |
|----------|---------|
| `NETWORK` | `preprod` (default) \| `mainnet` |
| `GEROLAMO_DB_PATH` | Absolute SQLite path |
| `DATABASE_URL` | `sqlite:///abs/path` |
| `PORT` / `GEROLAMO_PORT` | HTTP port (default **3030**) |
| `GEROLAMO_N2C_SOCKET` | Ouroboros N2C unix socket path |
| `GEROLAMO_N2C=0` | Disable N2C |

Config: `src/config/{preprod|mainnet}/config.json`  
Topology: `src/config/{network}/topology.json`

**Note:** config `unixSocket` = **HTTP** over unix — **not** N2C. Use `GEROLAMO_N2C_SOCKET` for Ouroboros.

```bash
INST="$HOME/.local/share/myapp/gerolamo/preprod-1"
mkdir -p "$INST"/{data,logs}

NETWORK=preprod \
GEROLAMO_DB_PATH="$INST/data/gerolamo.db" \
DATABASE_URL="sqlite://$INST/data/gerolamo.db" \
GEROLAMO_PORT=3030 \
GEROLAMO_N2C_SOCKET="$INST/node.socket" \
bun src/index.ts start-gerolamo
```

One **writer** per DB. Unique **port** per live instance.

---

## HTTP API

```bash
curl -s http://127.0.0.1:3030/health | jq .
curl -s http://127.0.0.1:3030/metrics | jq .
curl -s http://127.0.0.1:3030/governor | jq .
open http://127.0.0.1:3030/stats   # HTML dashboard (or curl -s …/stats | head)
curl -s http://127.0.0.1:3030/block/<slot-or-hash>
curl -s "http://127.0.0.1:3030/utxo/<txhash>:<index>"
curl -s http://127.0.0.1:3030/api/v0/
curl -s http://127.0.0.1:3030/api/v0/blocks/latest | jq .
curl -X POST http://127.0.0.1:3030/txsubmit --data-binary @tx.cbor \
  -H "Content-Type: application/cbor"
```

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` `/healthz` | `{ healthy, network, port, uptimeSec }` |
| GET | `/metrics` | tipSlot, utxoCount, epoch, epochNonce, peers, flags |
| GET | `/governor` `/api/v0/governor` | Peer governor snapshot `{ cold, warm, hot, total, hotKeys, targets }` |
| GET | `/stats` `/dashboard` | **HTML dashboard** (local only) — tip, UTxO, epoch, peer tiers; **WS-first** via `/ws/stats`, 5s poll fallback |
| WS | `/ws/stats` | Bun WebSocket stream: `hello` + `tip`/`peers`/`metrics`/`governor` topics; client ops `subscribe`/`unsubscribe`/`ping` |
| GET | `/block/{slot\|hash}` | Raw CBOR hex |
| GET | `/utxo/{txhash:index}` | UTxO JSON if unspent |
| POST | `/txsubmit` | Raw CBOR → mempool / hot peers |
| GET/POST | `/api/v0/*` | Mini-Blockfrost **subset** v0.2.0 |

Mini-BF v0.2.0: health, epochs/latest (+ params if stored), blocks (+ `/txs`), address UTxOs + **transactions**, **tx by hash**, tx UTxOs (unspent only), **mempool** snapshot, tx submit (returns body hash).  
Tx/address history needs `tx_index` (empty until backfill or forward index). **Not** full Blockfrost. See `docs/gerolamo-vs-dolos-gap.md`.

```bash
# Ops stream (Bun WS)
# browser: open /stats  — or:
# bun -e 'const ws=new WebSocket("ws://127.0.0.1:3040/ws/stats"); ws.onmessage=e=>console.log(e.data)'

# Mini-BF listing
curl -s http://127.0.0.1:3040/api/v0/ | jq '{version,endpoints}'

# Off-hot-path index backfill (never dual-write soak batch.db while hydrate runs)
bun scripts/backfill-tx-index.mjs --db .live/test.db --limit 200
# refuse soak unless hydrate stopped: --force-batch
```

### How the tip advances (ChainSync)

Yes — **peer tip is carried with each header** on the N2N **ChainSync** mini-protocol.

1. Hot peer streams `MsgRollForward` = **header + tip** (point the peer claims is chain head).
2. Gerolamo parses the header (`headerParser` / `handleRollForward`).
3. **BlockFetch** pulls the body when needed.
4. Soft body validation (optional) → apply → SQLite `MAX(slot)` rises.
5. HTTP `/metrics` / `/stats` / Mini-BF `blocks/latest` read that DB tip.

So tip is **not** HTTP-only. Frozen `tipSlot` + `hot = 0` means **stalled** (no header pipeline), not “at tip.”

### Tip + peers (local)

```bash
# Local tip + peer tiers
curl -s http://127.0.0.1:3030/metrics | jq '{tip:.tipSlot, peers:.peers, utxo:.utxoCount, epoch}'
curl -s http://127.0.0.1:3030/governor | jq '{hot, warm, cold, hotKeys, warmKeys, coldSample, targets}'

# HTML dashboard (peer bars + metrics panels, no external APIs)
open http://127.0.0.1:3030/stats
```

Frozen `tipSlot` + `hot = 0` = stalled (no ChainSync header pipeline).

### Optional log monitor (outside the node)

```bash
# Read-only watcher for a live node log + DB (does not write chain DBs)
bun scripts/node-watch.mjs --log /tmp/gerolamo-live-test.log --db .live/test.db --http 3040 --port 3041
curl -s http://127.0.0.1:3041/health | jq .
curl -s http://127.0.0.1:3041/errors | jq .
curl -s 'http://127.0.0.1:3041/tail?n=40' | jq .
```

| Method | Path | Notes |
|--------|------|--------|
| GET | `http://…:3041/health` | mon verdict, toHexCrashes, tip |
| GET | `http://…:3041/errors` | classified log counts + samples |
| GET | `http://…:3041/tail?n=N` | last N log lines |
| GET | `http://…:3041/` | full JSON snapshot |

---

## Embed in your project (The Lab & others)

**Agents / integrators:** start with **[`agent.md`](./agent.md)** — spawn contract, Lab RPC map, density path, N2C notes, definition of done.

### Two planes

| Plane | Job | Owner |
|-------|-----|--------|
| **Data** | tip, blocks, UTxO, Mini-BF, submit | Gerolamo HTTP (+ optional N2C) |
| **Control** | detect, spawn, stop, PID, instance dirs, log files | **Host app** |

**The Lab** already implements control:

- Service: `TheLab/src/bun/gerolamoService.ts`
- Layout: `~/.local/share/thelab/gerolamo/<id>/`
- Spawn: `bun src/index.ts start-gerolamo` with `GEROLAMO_DB_PATH` + `GEROLAMO_PORT`
- Health: `GET /health` · Logs: instance `logs/daemon.log`

Recipe for any host:

1. Point at this repo + Bun  
2. Instance dir + unique DB + unique port  
3. Spawn child process (cwd = repo)  
4. Poll `/health` then `/metrics` for tip  
5. Consume Mini-BF / block / N2C  
6. Stop with SIGTERM  

### Status / logs interface (product direction)

Host apps should **not** rely on `pgrep` + ad-hoc log paths alone.

| Today | Next (recommended) |
|-------|---------------------|
| `GET /health` + `GET /metrics` | `GET /api/v0/status` — one dashboard blob |
| Host tails `daemon.log` | Optional `GET /api/v0/logs?tail=N` (bounded) |

Keep **start/stop** in the host. Gerolamo stays data + self-status.

---

## Density / offline hydrate

Rebuild soft state from **local immutable chunks** (no live peers required):

```bash
# Fast path (separate DB — never dual-write a live node DB)
bun scripts/batch-hydrate.mjs --wipe --from 0 --progress 25 \
  --db .hydrate/batch.db \
  --chunks snapshots/preprod/db/immutable

bun scripts/batch-watch.mjs --once
```

Docs: [`docs/hydration.md`](./docs/hydration.md).

Optional Mithril download (external binary; Gerolamo does not reimplement cert crypto):

```bash
bun src/index.ts mithril-bootstrap --network preprod \
  --download-dir ./snapshots/preprod
```

Ancillary ledger UTxO extract is **blocked** (A2 CBOR adapter) — density = chunks.  
Research: [`docs/mithril-native-client-research.md`](./docs/mithril-native-client-research.md).

---

## N2C

**Optional.** Gerolamo does **not** create a `node.socket` on every start.

| Enable when | How |
|-------------|-----|
| Env | `GEROLAMO_N2C_SOCKET=./ledger/node.socket` |
| Config | `n2c.enabled: true` + `n2c.socketPath` (path alone is not enough) |
| Disable | `GEROLAMO_N2C=0` (or omit path) |

```bash
GEROLAMO_N2C_SOCKET=./ledger/node.socket \
NETWORK=preprod bun src/index.ts start-gerolamo
```

Hosts: Handshake, LocalChainSync, LocalTxSubmit, LocalTxMonitor, **minimal** LocalStateQuery.  
Client pattern (Lab): `TheLab/src/bun/dolos/n2cClient.ts` — Multiplexer `node-to-client`.  
Plan: [`docs/N2C_IMPLEMENTATION_PLAN.md`](./docs/N2C_IMPLEMENTATION_PLAN.md).

**Note:** config `unixSocket` = **HTTP** over unix — **not** N2C. Use `GEROLAMO_N2C_SOCKET` for Ouroboros.

---

## CLI

| Command | Purpose |
|---------|---------|
| `start-gerolamo` | Live node |
| `read-raw-chunks <dir>` | Apply immutable chunks |
| `mithril-bootstrap` | Download/verify via `mithril-client` + optional apply |
| `load-ancillary` | Ancillary path (extract blocked) |

```bash
bun src/index.ts --help
```

---

## Architecture (high level)

```
bun src/index.ts start-gerolamo
        │
        ├─ init SQLite (GEROLAMO_DB_PATH / config)
        ├─ peerBlockServer  :3030  ── HTTP + Mini-BF
        ├─ peerManager      N2N    ── ChainSync / BlockFetch → DB
        └─ N2CServer (opt)  unix   ── LocalChainSync / Tx / LSQ*
```

| Area | Location |
|------|----------|
| Entry / CLI | `src/index.ts`, `src/cli.ts` |
| Network start | `src/network/index.ts` |
| HTTP | `src/network/peerBlockServer.ts` |
| Mini-BF | `src/api/miniBlockfrost.ts` |
| Peers | `src/network/PeerClient.ts`, `peerManager.ts` |
| N2C | `src/network/n2c/` |
| DB / apply | `src/db.ts`, `src/consensus/` |
| Agent embed guide | **`agent.md`** |

---

## Docs map

| Doc | Topic |
|-----|--------|
| [`agent.md`](./agent.md) | **Embed Gerolamo** (agents + Lab) |
| [`docs/hydration.md`](./docs/hydration.md) | Batch soft density |
| [`docs/gerolamo-vs-dolos-gap.md`](./docs/gerolamo-vs-dolos-gap.md) | vs Dolos / Blockfrost |
| [`docs/mithril-native-client-research.md`](./docs/mithril-native-client-research.md) | Native Mithril options |
| [`docs/N2C_IMPLEMENTATION_PLAN.md`](./docs/N2C_IMPLEMENTATION_PLAN.md) | N2C phases |

---

## Development

```bash
bunx tsc --noEmit
NETWORK=preprod bun src/index.ts start-gerolamo
# optional inspect
bun --inspect src/index.ts start-gerolamo
```

Logs: config `logs.logDirectory` (often `./logs/…`) JSONL when enabled.  
Do not commit `ledger/`, `.hydrate/`, or secrets.

Branch for Lab work: **`The-Lab`**.

---

## Roadmap (blunt)

**Have:** N2N sync, SQLite soft ledger, HTTP + Mini-BF subset, N2C scaffold, batch hydrate, pure-TS KES.

**Next for data-node parity:** tx/address indexes → richer Mini-BF; canonical `/api/v0/status` (+ optional logs); Lab polish; Mithril WASM verify spike; LSQ breadth only if product needs it.

---

## Resources

- [Ouroboros network](https://ouroboros-network.cardano.intersectmbo.org/)
- [ouroboros-miniprotocols-ts](https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts)
- [Bun](https://bun.sh/docs)
- [Mithril](https://mithril.network/doc/mithril/intro)

Built by [Harmonic Labs](https://harmoniclabs.com).
