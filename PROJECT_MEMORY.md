# Project Memory — Gerolamo × The Lab

> Durable notes for agents and humans. Prefer this + `GEROLAMO_THE_LAB_CONTEXT.md` over chat history.

## Branch policy

| Rule | Detail |
|------|--------|
| **IGNORE** | `mikes-rolling-updates` — outdated, behind `origin/master`. Do not base Lab work on it. |
| **BASELINE** | `origin/master` (Hari): dashboard, LMDB tools, Mithril stream, explorer. Tip at branch create: `25abbeb`. |
| **WORK BRANCH** | **`The-Lab`** only — branched from `origin/master`. |

## Product truth

- **Gerolamo** = HarmonicLabs TypeScript Cardano **node/relay** (Bun). N2N yes.
- **N2C Phases 1–5 done** (`src/network/n2c/`): data-node Unix `node.socket` like Dolos — not Lab-only product features.
  - Phase 1: Handshake Accept/Refuse (v16–19)
  - Phase 2: `GerolamoChainDb` + LocalChainSync (proto 5)
  - Phase 3: LocalTxSubmission (proto 6) → process mempool
  - Phase 4: LocalStateQuery (proto 7) minimal acquire/tip result
  - Phase 5: LocalTxMonitor (proto 9)
  - Phase 6 (TheLab spawn/UI) lives in TheLab, not this repo.
- **Not** TxPipe / `@txpipe/gerolamo`. Lab stubs that say otherwise are wrong and should be fixed in TheLab.
- Storage: SQLite via `src/sql.ts` (`initSql`). Bun’s default `import { sql } from "bun"` is **Postgres** — never use it for chain DB.
- HTTP API default port **3030**; Lab health: `GET /health` or `/healthz`.
- `config.unixSocket` = **HTTP** over unix only. Ouroboros N2C uses `n2cSocketPath` / `GEROLAMO_N2C_SOCKET`.
- Lab spawn env: `DATABASE_URL` (`sqlite://…` / `file:…`), `GEROLAMO_DB_PATH`, `PORT` / `GEROLAMO_PORT`, `NETWORK`, `GEROLAMO_N2C_SOCKET`, `GEROLAMO_N2C=0`.

### N2C enable precedence

1. `GEROLAMO_N2C=0|false` → off  
2. else `GEROLAMO_N2C_SOCKET`  
3. else top-level `n2cSocketPath`  
4. else `n2c.enabled === true` + `n2c.socketPath`  

### N2C implementation notes

- Handshake: parse Propose with `HandshakeProposeVersion.fromCborObj(cbor, false)` — do not use `handshakeMessageFromCborObj` (N2N default breaks N2C VersionData).
- `IChainDb` / `IExtendData` are **not** re-exported at ouroboros package root — import from `.../dist/protocols/interfaces/IChainDb.js`.
- LocalChainSync uses protocol **5** (library `ChainSyncServer` is hard-coded to N2N 2).
- `blockNo` currently approximated by **slot** (no dense block index yet).
- LocalTxSubmit mempool status: numeric `0=Ok`, `1=AlreadyPresent` (Bun + local tgz enum import was flaky).
- Hosts start eagerly after Handshake Accept (one set per connection).

Plan: `docs/N2C_IMPLEMENTATION_PLAN.md`.

## Commit cadence on `The-Lab`

Small chunks, in order when possible:

1. **deps** — package.json, lockfile, local tgz, tsconfig  
2. **sql** — `src/sql.ts` + import rewires + consensus export fixes  
3. **mempool / health** — adapter, PeerClient, peerBlockServer, start env overrides  
4. **docs** — this file, CHANGELOG, handoff context  
5. **n2c** — Phases 1–5 data-node N2C (socket → handshake → chainsync/txsubmit/lsq/monitor)  

Convention: `feat|fix|refactor|docs(gerolamo|lab): short message`

## Related paths

| Repo | Path |
|------|------|
| Gerolamo | `/media/bakon/data/Dev/HarmonicLabs/gerolamo` |
| The Lab (consumer) | `/media/bakon/data/Dev/HarmonicLabs/TheLab` |

Lab service lives in TheLab (`gerolamoService`); keep spawn/health wiring there, not only in this repo.

## Goals (ordered)

1. Clean build + typecheck on `The-Lab` — done on branch  
2. Node runs (preprod) + HTTP health  
3. Instance dirs under `~/.local/share/thelab/gerolamo/<id>/` (Lab side)  
4. Real spawn/stop/PID/logs in TheLab (replace TxPipe fiction)  
5. Progressive Lab UI (Dolos-style ops template)  
6. N2C data-node Phases 1–5 — **done** in Gerolamo; Phase 6 = TheLab wiring only  


## Local-only (do not commit)

- `ledger/` — runtime SQLite DB  
- `node_modules/`, `store/`, logs, `.env*`  
