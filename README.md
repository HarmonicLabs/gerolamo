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
| GET | `/metrics` | tipSlot, utxoCount, epoch, epochNonce, flags |
| GET | `/block/{slot\|hash}` | Raw CBOR hex |
| GET | `/utxo/{txhash:index}` | UTxO JSON if unspent |
| POST | `/txsubmit` | Raw CBOR → mempool |
| GET/POST | `/api/v0/*` | Mini-Blockfrost **subset** |

Mini-BF today: health, epochs/latest (+ params if stored), blocks, address UTxOs, tx UTxOs (unspent only), tx submit.  
**Not** full Blockfrost (no full tx history/assets/pools/…). See `docs/gerolamo-vs-dolos-gap.md`.

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

```bash
GEROLAMO_N2C_SOCKET=./ledger/node.socket \
NETWORK=preprod bun src/index.ts start-gerolamo
```

Hosts: Handshake, LocalChainSync, LocalTxSubmit, LocalTxMonitor, **minimal** LocalStateQuery.  
Client pattern (Lab): `TheLab/src/bun/dolos/n2cClient.ts` — Multiplexer `node-to-client`.  
Plan: [`docs/N2C_IMPLEMENTATION_PLAN.md`](./docs/N2C_IMPLEMENTATION_PLAN.md).

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
