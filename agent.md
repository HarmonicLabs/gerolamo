# agent.md — Using Gerolamo in a project

Instructions for agents and developers embedding **Gerolamo** (HarmonicLabs TypeScript Cardano node/relay) as a **data node**.

> Branch for Lab integration work: **`The-Lab`** (from `origin/master`).  
> Do **not** base work on `mikes-rolling-updates`.

---

## What Gerolamo is

| Layer | Role |
|-------|------|
| **N2N** | Connects to Cardano peers (Handshake, ChainSync, BlockFetch, KeepAlive, TxSubmit). Syncs headers/blocks into SQLite. |
| **HTTP** | Serves raw blocks / UTxOs / health / tx submit on TCP (default **3030**). |
| **N2C** | Unix `node.socket` for local clients (Handshake + LocalChainSync + LocalTxSubmit + LocalStateQuery + LocalTxMonitor). |

Gerolamo is **not** TxPipe / `@txpipe/gerolamo`. It is a real Bun TypeScript process you spawn and point clients at.

**Limits (honest):** full Praos consensus validation is partial; LSQ is minimal tip/acquire; `blockNo` is approximated by slot. Suitable as a **data / relay-style** node, not a drop-in for a stake-pool block producer.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0  
- Network access to bootstrap peers (e.g. `preprod-node.play.dev.cardano.org:3001`)  
- Repo: clone + `bun install` from this package root  

```bash
cd /path/to/gerolamo
bun install
```

---

## How to start

Entry is **CLI**, not a missing `src/start.ts` (README is stale).

```bash
# Preprod (default NETWORK=preprod)
bun src/index.ts start-gerolamo

# Mainnet
NETWORK=mainnet bun src/index.ts start-gerolamo
```

Equivalent: `bun src/cli.ts` is not the module entry — use `bun src/index.ts start-gerolamo`.

### Env vars (instance isolation)

| Variable | Purpose |
|----------|---------|
| `NETWORK` | `preprod` (default) or `mainnet` |
| `DATABASE_URL` | `sqlite:///abs/path/to.db` or `file:/abs/path` |
| `GEROLAMO_DB_PATH` | Absolute SQLite path (if no `DATABASE_URL`) |
| `PORT` / `GEROLAMO_PORT` | HTTP API port (default **3030**) |
| `GEROLAMO_N2C_SOCKET` | Path for Ouroboros N2C Unix socket |
| `GEROLAMO_N2C=0` | Force-disable N2C |

Config JSON lives at `src/config/{preprod|mainnet}/config.json` (topology, genesis, `dbPath`, logs, optional `n2c`).

### N2C enable precedence

1. `GEROLAMO_N2C=0|false` → off  
2. else `GEROLAMO_N2C_SOCKET`  
3. else top-level `n2cSocketPath` in config  
4. else `n2c.enabled === true` + `n2c.socketPath`  

**Important:** `config.unixSocket` is **HTTP-over-unix** on the block server — **not** Ouroboros N2C. Use `GEROLAMO_N2C_SOCKET` for client mini-protocols.

Example:

```bash
NETWORK=preprod \
GEROLAMO_DB_PATH="$HOME/.local/share/myapp/gerolamo/preprod.db" \
PORT=3030 \
GEROLAMO_N2C_SOCKET="$HOME/.local/share/myapp/gerolamo/node.socket" \
bun src/index.ts start-gerolamo
```

Do **not** commit runtime DBs under `ledger/` (gitignored).

---

## HTTP API (data consumers)

Default base: `http://127.0.0.1:3030`

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` or `/healthz` | JSON: healthy, network, port, uptimeSec |
| GET | `/block/{slot\|hash}` | Raw block CBOR (hex) when stored |
| GET | `/utxo/{txhash:index}` | UTxO JSON when present |
| POST | `/txsubmit` | Raw CBOR body → mempool path |

```bash
curl -s http://127.0.0.1:3030/health
curl -s "http://127.0.0.1:3030/block/<slot-or-hash>"
```

---

## N2C for clients (Dolos-style)

After start with `GEROLAMO_N2C_SOCKET` set:

1. Connect to the Unix socket  
2. Multiplexer `protocolType: "node-to-client"`  
3. Handshake Propose → Accept (versions 16–19; parse with **`n2n=false`**)  
4. Then use:
   - **LocalChainSync** (proto **5**) — tip / intersect / roll  
   - **LocalTxSubmission** (proto **6**) — submit to process mempool  
   - **LocalStateQuery** (proto **7**) — minimal acquire/tip result  
   - **LocalTxMonitor** (proto **9**) — mempool snapshot  

Lib note: `IChainDb` is **not** re-exported from the ouroboros package root; Gerolamo hosts implement the server side under `src/network/n2c/`.  
Lib note: `TxMonitorAcquire` may encode CBOR index `3` (same as Release); Gerolamo tolerates idle-state `[3]` as Acquire.

---

## Embedding in another project

1. **Spawn** Gerolamo as a child process (`bun src/index.ts start-gerolamo`) with isolated `GEROLAMO_DB_PATH` + optional `GEROLAMO_N2C_SOCKET` + `PORT`.  
2. **Wait** for `GET /health` → `healthy: true` (and optionally N2C handshake smoke).  
3. **Consume** either HTTP block API and/or N2C `node.socket`.  
4. **Shutdown** with SIGTERM/SIGINT (N2C socket unlinked on stop).  

SQLite uses WAL; multi-reader is fine. Prefer **one writer process** (the Gerolamo node) per DB file.

---

## Dev checks

```bash
bunx tsc --noEmit
# N2C-only smoke (no peers): import startN2CServer from src/network/n2c
# Full node: start-gerolamo, watch logs, query SQLite max(slot) on volatile_blocks
```

Logs: config `logs.logDirectory` (often `./logs`). Structured JSONL when file logging enabled.

Durable project notes: `PROJECT_MEMORY.md`, `CHANGELOG.md`, `docs/N2C_IMPLEMENTATION_PLAN.md`.

---

## Agent policy (this repo)

- Work only on **`The-Lab`** for Lab-related Gerolamo features; ignore `mikes-rolling-updates`.  
- Do **not** commit `ledger/`, secrets, or local DBs.  
- Chunk commits: deps → sql → mempool/health → docs → n2c → consensus wiring.  
- Prefer data-node capabilities in Gerolamo; product UI/spawn lives in the consuming app (e.g. The Lab).  
- After non-trivial features: typecheck once; prove with real process output (health, peer handshake, DB tip growth), not invented logs.
