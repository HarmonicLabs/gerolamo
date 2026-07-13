# Project Memory — Gerolamo × The Lab

> Durable notes for agents and humans. Prefer this + `GEROLAMO_THE_LAB_CONTEXT.md` over chat history.

## Branch policy

| Rule | Detail |
|------|--------|
| **IGNORE** | `mikes-rolling-updates` — outdated, behind `origin/master`. Do not base Lab work on it. |
| **BASELINE** | `origin/master` (Hari): dashboard, LMDB tools, Mithril stream, explorer. Tip at branch create: `25abbeb`. |
| **WORK BRANCH** | **`The-Lab`** only — branched from `origin/master`. |

## Product truth

- **Gerolamo** = HarmonicLabs TypeScript Cardano **node/relay** (Bun). N2N yes; N2C **not** implemented.
- **Not** TxPipe / `@txpipe/gerolamo`. Lab stubs that say otherwise are wrong and should be fixed in TheLab.
- Storage: SQLite via `src/sql.ts` (`initSql`). Bun’s default `import { sql } from "bun"` is **Postgres** — never use it for chain DB.
- HTTP API default port **3030**; Lab health: `GET /health` or `/healthz`.
- Lab spawn env: `DATABASE_URL` (`sqlite://…` / `file:…`), `GEROLAMO_DB_PATH`, `PORT` / `GEROLAMO_PORT`, `NETWORK`.

## Commit cadence on `The-Lab`

Small chunks, in order when possible:

1. **deps** — package.json, lockfile, local tgz, tsconfig  
2. **sql** — `src/sql.ts` + import rewires + consensus export fixes  
3. **mempool / health** — adapter, PeerClient, peerBlockServer, start env overrides  
4. **docs** — this file, CHANGELOG, handoff context  

Convention: `feat|fix|refactor|docs(gerolamo|lab): short message`

## Related paths

| Repo | Path |
|------|------|
| Gerolamo | `/media/bakon/data/Dev/HarmonicLabs/gerolamo` |
| The Lab (consumer) | `/media/bakon/data/Dev/HarmonicLabs/TheLab` |

Lab service lives in TheLab (`gerolamoService`); keep spawn/health wiring there, not only in this repo.

## Goals (ordered)

1. Clean build + typecheck on `The-Lab`  
2. Node runs (preprod) + HTTP health  
3. Instance dirs under `~/.local/share/thelab/gerolamo/<id>/` (Lab side)  
4. Real spawn/stop/PID/logs in TheLab (replace TxPipe fiction)  
5. Progressive Lab UI (Dolos-style ops template)  
6. N2C only after spawn/health are solid  

## Local-only (do not commit)

- `ledger/` — runtime SQLite DB  
- `node_modules/`, `store/`, logs, `.env*`  
