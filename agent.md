# agent.md — Embed Gerolamo in a project

**For agents + humans.** How to run Gerolamo as a **local Cardano data node** and wire it into an app (especially **The Lab**).

| | |
|--|--|
| **Repo** | `/media/bakon/data/Dev/HarmonicLabs/gerolamo` |
| **Branch for Lab** | `The-Lab` (ignore `mikes-rolling-updates`) |
| **Package** | `@harmoniclabs/gerolamo` — Bun process, **not** npm `@txpipe/gerolamo` |
|| **Consumer (Lab)** | `/media/bakon/data/Dev/HarmonicLabs/TheLab` — **do not edit from this UI work** |
|| **Standalone UI** | `desktop/` Electrobun Control Center · `bun run ui:dev` · `docs/standalone-ui.md` |

---

## 30-second truth

| Gerolamo **is** | Gerolamo **is not** |
|-----------------|---------------------|
| TS/Bun **node/relay** | TxPipe / Dolos binary |
| N2N peers + SQLite soft ledger | Full stake-pool block producer |
| HTTP data API (:3030) | Full Blockfrost cloud |
| Optional N2C `node.socket` | Drop-in cardano-node |

**Soft apply / batch hydrate ≠ consensus proof.** Density first; validate later.

---

## Two planes (read this)

| Plane | Job | Who owns it today |
|-------|-----|-------------------|
| **Data** | tip, blocks, UTxO, Mini-BF, tx submit | Gerolamo HTTP (+ optional N2C) |
| **Control** | detect, spawn, stop, PID, instance dir, log files | **Host app** (The Lab `gerolamoService`) |

Lab already has control. Other projects should **reuse the same contract**, not invent `pgrep` folklore.

**Need a shared interface?**  
**Yes — thin control client + richer Gerolamo status HTTP.**  
Not a second process manager inside every UI.

Recommended shape (implement when free):

```text
GET  /health          → alive? (exists)
GET  /metrics         → tip, utxo, epoch, nonce (exists)
GET  /api/v0/status   → canonical “dashboard blob” (add)
GET  /api/v0/logs?tail=N  → recent lines if logToFile (optional add)
```

Host still: spawn/kill, instance dirs, multi-instance ports.  
Gerolamo still: one writer per DB, serve data + self-status.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0  
- Clone + `bun install` in this repo  
- Peers (live sync) **or** immutable chunks (offline density)  
- Free disk for SQLite (preprod soft DB = multi‑GB)

```bash
cd /media/bakon/data/Dev/HarmonicLabs/gerolamo
git checkout The-Lab
bun install
```

---

## Start (canonical)

Standalone **Electrobun** control center (not The Lab): `bun run ui:dev` — see `docs/standalone-ui.md`. Instance data under `~/.local/share/gerolamo/`.

```bash
# Live node (peers → SQLite)
NETWORK=preprod bun src/index.ts start-gerolamo

# Mainnet
NETWORK=mainnet bun src/index.ts start-gerolamo
```

**Entry:** `bun src/index.ts start-gerolamo`  
(`package.json` `"start"` → `bun src/index.ts` only — always pass the command.)

### Env (instance isolation)

| Variable | Purpose | Lab default pattern |
|----------|---------|---------------------|
| `NETWORK` | `preprod` \| `mainnet` | from config |
| `GEROLAMO_DB_PATH` | abs SQLite path | `~/.local/share/thelab/gerolamo/<id>/data/gerolamo.db` |
| `DATABASE_URL` | `sqlite:///abs/path` | same file as above |
| `PORT` / `GEROLAMO_PORT` | HTTP API | **3030** (one port per instance) |
| `GEROLAMO_N2C_SOCKET` | Ouroboros N2C unix path | optional; **not** HTTP unix |
| `GEROLAMO_N2C=0` | force N2C off | |
| `GEROLAMO_REPO` | Lab: path to this repo | |

Config JSON: `src/config/{preprod\|mainnet}/config.json`  
Topology: `src/config/{network}/topology.json`

### N2C enable order

1. `GEROLAMO_N2C=0|false` → off  
2. else `GEROLAMO_N2C_SOCKET`  
3. else config `n2cSocketPath` / `n2c.enabled` + `n2c.socketPath`  

**`unixSocket` in config = HTTP over unix — NOT N2C.** Never overload them.

### Isolated spawn example

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

Rules:

- **One writer** per DB file  
- Unique **HTTP port** per live instance  
- Do not commit `ledger/`, `.hydrate/`, runtime DBs  

---

## HTTP — data consumers

Base: `http://127.0.0.1:3030` (or instance port)

| Method | Path | Use |
|--------|------|-----|
| GET | `/health` `/healthz` | Ready probe: `{ healthy, network, port, uptimeSec }` |
| GET | `/metrics` | tipSlot, utxoCount, epoch, epochNonce, validation flags |
| GET | `/block/{slot\|hash}` | Raw block CBOR **hex** |
| GET | `/utxo/{txhash:index}` | UTxO JSON if unspent |
| POST | `/txsubmit` | Raw CBOR body → mempool |
| GET | `/api/v0/*` | Mini-Blockfrost **subset** (see below) |

```bash
curl -s http://127.0.0.1:3030/health | jq .
curl -s http://127.0.0.1:3030/metrics | jq .
curl -s http://127.0.0.1:3030/api/v0/blocks/latest | jq .
```

### Mini-Blockfrost (honest subset)

| Implemented | Missing (common wallet needs) |
|-------------|-------------------------------|
| `/api/v0/health` | full `/txs/{hash}` body |
| `/epochs/latest` (+ params if DB has them) | address **tx history** |
| `/blocks/latest`, `/blocks/{id}` | assets, scripts, pools |
| `/addresses/{addr}/utxos` | datums/ref scripts often null |
| `/txs/{hash}/utxos` (unspent only) | full BF field parity |
| `POST /api/v0/tx/submit` | |

Banner in code: *subset, not full Blockfrost parity.*  
Gap detail: `docs/gerolamo-vs-dolos-gap.md`.

---

## Density without peers (hydrate)

Offline soft state from **immutable chunks**:

```bash
# Preferred fast path (separate DB)
bun scripts/batch-hydrate.mjs --wipe --from 0 --progress 25 \
  --db .hydrate/batch.db \
  --chunks snapshots/preprod/db/immutable

# Monitor (read-only)
bun scripts/batch-watch.mjs --once
tail -f /tmp/hermes-batch-full.log   # if redirected there
```

| | |
|--|--|
| Source | `snapshots/preprod/db/immutable` (local; not mid-run Mithril) |
| Target | default `.hydrate/batch.db` — **not** live node DB while node runs |
| Semantics | soft apply; crash = wipe/restart that disposable DB |

Mithril download (optional):

```bash
bun src/index.ts mithril-bootstrap --network preprod --download-dir ./snapshots/preprod
# then batch-hydrate or read-raw-chunks on immutable/
```

Cert verify = external `mithril-client` (or future WASM).  
**Ancillary UTxO extract = blocked (A2)** — see `src/state/mithril.ts`, `docs/mithril-native-client-research.md`.

Full notes: `docs/hydration.md`.

---

## N2C (local Ouroboros clients)

When `GEROLAMO_N2C_SOCKET` is set, Gerolamo hosts:

| Proto | Name | Status |
|------:|------|--------|
| — | Handshake | yes |
| 5 | LocalChainSync | yes (custom host) |
| 6 | LocalTxSubmission | yes |
| 7 | LocalStateQuery | **minimal** tip/utxoCount/nonce |
| 9 | LocalTxMonitor | yes |

Client pattern (Lab Dolos reference):  
`TheLab/src/bun/dolos/n2cClient.ts` — Multiplexer `protocolType: "node-to-client"`, Handshake, ChainSync.

```text
connect(socket) → Handshake propose (magic) → Accept
→ LocalChainSync findIntersect / requestNext
```

Do **not** claim full ledger LSQ parity. Prefer HTTP Mini-BF for most Lab UI queries until LSQ grows.

Plan history: `docs/N2C_IMPLEMENTATION_PLAN.md`.

---

## The Lab integration (already started)

Lab is the **reference host**. Mirror this; don’t invent TxPipe.

| Piece | Path |
|-------|------|
| Service | `TheLab/src/bun/gerolamoService.ts` |
| Presets | `TheLab/src/shared/gerolamoPresets.ts` |
| Types | `TheLab/src/shared/types.ts` → `GerolamoNodeConfig` |
| UI manager | `TheLab/src/mainview/lib/gerolamoManager.ts` |
| RPC | `gerolamo/detect` `writeConfig` `start` `stop` `status` `health` `logs` |

### Instance layout (Lab)

```text
~/.local/share/thelab/gerolamo/<id>/
  data/gerolamo.db
  logs/daemon.log
  lab-config.json
  README.txt
```

### Spawn contract (what Lab does)

```text
cwd   = <gerolamo repo>
argv  = [bun, "src/index.ts", "start-gerolamo"]
env   += NETWORK, GEROLAMO_PORT, GEROLAMO_DB_PATH, DATABASE_URL=sqlite://…
stdio → logs/daemon.log
stop  = SIGTERM on pid
health = GET {baseUrl}/health  (timeout ~2.5s)
```

### Agent checklist when changing Lab Gerolamo UI

1. **Never** say `npm i -g @txpipe/gerolamo`  
2. Detect = Bun + repo with `src/index.ts`  
3. Unique port + unique DB per instance  
4. Progress UI: poll `/metrics` (tipSlot, utxoCount) + log tail  
5. N2C UI only if socket path set **and** handshake proven  
6. After spawn: wait health, then metrics — not “DB file exists” alone  

### Reuse Dolos UX patterns

- Instance dir under `~/.local/share/thelab/…`  
- Progressive checklist (detect → config → start → health → tip)  
- Live log pane from `daemon.log`  
- Network badge (preprod/mainnet)  

Do **not** copy Dolos install (npm global / Docker). Gerolamo = **repo + bun**.

---

## Embedding in a *new* project (recipe)

```text
1. Depend on Bun + path to gerolamo repo (or submodule)
2. Create instance dir + DB path + free port
3. spawn(bun, ["src/index.ts","start-gerolamo"], { cwd: repo, env })
4. Poll GET /health until healthy
5. Poll GET /metrics for tip/utxo (sync UX)
6. App data via Mini-BF /block /utxo or N2C tip stream
7. stop: SIGTERM; optional unlink N2C socket (Gerolamo does on clean exit)
```

Optional later: extract `@harmoniclabs/gerolamo-client` with `health()`, `metrics()`, `logs()`, `waitReady()` — wrap HTTP only; keep spawn in host.

---

## CLI map

| Command | Purpose |
|---------|---------|
| `start-gerolamo` | Live node |
| `read-raw-chunks <immutable_dir>` | Apply chunks (slower path) |
| `mithril-bootstrap` | External client download + optional apply |
| `load-ancillary` | Ancillary path — **blocked** extract |
| `import-ledger-state` | BF import helpers |

Scripts:

| Script | Purpose |
|--------|---------|
| `scripts/batch-hydrate.mjs` | Fast soft density |
| `scripts/batch-watch.mjs` | Read-only hydrate progress |

---

## Agent policy (this repo)

- Branch **`The-Lab`** for Lab work  
- No commit of `.hydrate/`, `ledger/`, secrets, `.hermes/`  
- Chunk commits: `feat\|fix\|docs(gerolamo): …`  
- Prove with real output: health, metrics tip, `pgrep`, log tail  
- Don’t second-write a DB another process holds  
- Blunt scope: soft ≠ KES proof; Mini-BF ≠ full BF; LSQ ≠ full ledger  

### Related docs

| Doc | Topic |
|-----|--------|
| `docs/hydration.md` | Batch density |
| `docs/gerolamo-vs-dolos-gap.md` | Data-node gaps / P0–P2 |
| `docs/mithril-native-client-research.md` | Built-in Mithril options |
| `docs/N2C_IMPLEMENTATION_PLAN.md` | N2C phases |
| `GEROLAMO_THE_LAB_CONTEXT.md` | Older handoff (verify vs this file) |
| `README.md` | Human quick start |

---

## Definition of done (host integration)

- [ ] `gerolamo/detect` finds bun + repo  
- [ ] Start creates pid + `daemon.log`  
- [ ] `GET /health` → `healthy: true`  
- [ ] `GET /metrics` tip advances **or** hydrate DB tip non-zero when offline-fed  
- [ ] Stop clears pid; port free  
- [ ] UI never claims TxPipe or full BF/N2C ledger parity  

**One line:** Spawn this Bun repo with isolated DB/port; consume **HTTP first**; add N2C when socket + tip stream proven; keep control plane in the host, status surface on Gerolamo.
