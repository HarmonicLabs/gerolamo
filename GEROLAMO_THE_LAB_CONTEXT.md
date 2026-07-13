# Gerolamo → The-Lab Agent Handoff

> **Read this first.** This file is the source of truth for any agent session working on Gerolamo for The Lab integration.

## Branch policy (mandatory)

| Rule | Detail |
|------|--------|
| **IGNORE** | `mikes-rolling-updates` — outdated (Feb 2026), behind `origin/master` by ~20 commits. Do **not** base work on it. Do **not** merge it in by default. |
| **BASELINE** | `origin/master` (Hari’s work). Last verified tip: `25abbeb` — *Merge pull request #7 from HarmonicLabs/hari/dashboard-v1* (2026-04-02). Re-fetch and use whatever `origin/master` is at session start. |
| **WORK BRANCH** | Create and work **only** on **`The-Lab`**, branched from `origin/master`. |

### Setup (do this first)

```bash
cd /media/bakon/data/Dev/HarmonicLabs/gerolamo
git fetch origin

# If The-Lab does not exist yet:
git checkout -b The-Lab origin/master

# If The-Lab already exists:
git checkout The-Lab
git merge origin/master   # or rebase, if the user prefers linear history

bun install
```

**Do not** `git checkout mikes-rolling-updates` for Lab work.  
Local uncommitted WIP on Mike’s branch (if any) is **out of scope** unless the user explicitly asks to cherry-pick something.

---

## Repo path

`/media/bakon/data/Dev/HarmonicLabs/gerolamo/`

Related Lab app (consumer, separate repo):

`/media/bakon/data/Dev/HarmonicLabs/TheLab/`

---

## What Hari left on master (do not re-invent)

`origin/master` already includes (via PRs #5–#7 and related):

1. **SolidJS dashboard** — real node data (not mock), sync progress, speed, topology peers  
2. **LMDB stream / tools** — shared lmdb-stream module, FFI tools  
3. **Mithril tooling** — stream server / bootstrap explorer pieces  
4. **`gerolamo-explorer`** — unified server + frontend on one port  
5. **Bootstrap client** + UTxO query scripts  
6. **DB / network resilience** — missing-DB handling, auto-retry on bootstrap network errors  
7. Tag **`v0.0.2`**

`The-Lab` **continues from this baseline** — extend it for Lab orchestration, do not rebuild Hari’s dashboard stack.

---

## Product truth (correct wrong Lab stubs)

| Fact | Detail |
|------|--------|
| **What Gerolamo is** | HarmonicLabs TypeScript Cardano **node/relay** (Bun) |
| **What it is not** | TxPipe node manager / multi-cardano-node controller |
| **Lab bug today** | `TheLab` `gerolamoService.ts` / `GerolamoHome.tsx` still describe TxPipe + `npm install -g @txpipe/gerolamo` and fake start (DB save only). Fix that narrative when wiring. |

---

## Architecture snapshot (as of handoff)

| Area | Status |
|------|--------|
| Runtime | Bun (`package.json` start → `bun src/index.ts` / entry via CLI → start path) |
| P2P N2N | **Yes** — Handshake, ChainSync, BlockFetch, KeepAlive, PeerSharing, TxSubmission (`PeerClient`, `protocolType: "node-to-node"`) |
| Storage | SQLite (`bun:sqlite`) primary; LMDB / IndexedDB paths exist / evolved on master |
| HTTP API | `Bun.serve` (default port **3030**): `/block/{slot\|hash}`, `/utxo/...`, `POST /txsubmit` |
| Config | `src/config/{preprod\|mainnet}/config.json` |
| `unixSocket` config | Today toggles **HTTP over Unix path** (`./src/gerolamo.socket`), **not** Ouroboros N2C `node.socket` |
| N2C / LocalStateQuery server | **Not implemented** (ouroboros lib has client-side LocalStateQuery; Gerolamo does not host Dolos-like local socket) |
| Consensus / NES / Praos | Incomplete — networking + storage first |
| Live process | Often **idle**; historical preprod DB may exist under `src/store/db/preprod/` |

---

## Goals for branch `The-Lab`

Ordered for Lab parity (Dolos-like ops, not full consensus yet):

1. **Branch + clean build** — `The-Lab` from `origin/master`, `bun install`, fix typecheck/start blockers  
2. **Prove node runs** — `NETWORK=preprod bun src/start.ts` (or current master start entry), peers + HTTP health  
3. **Instance layout** — move DB/logs out of git tree toward something like `~/.local/share/thelab/gerolamo/<id>/` (mirror Dolos instance dirs)  
4. **Lab service (TheLab repo)** — real spawn/stop/PID, log tail, health via HTTP (replace stub `gerolamoService`)  
5. **Lab UI** — progressive control panel (not TxPipe manager fiction); correct branding (HarmonicLabs)  
6. **N2C later** — only after spawn/health are solid: Unix N2C server (`node.socket`) if/when product needs Dolos socket parity  

---

## Known issues to fix early

Re-verify on `origin/master` after checkout — some applied only to older trees:

- Consensus: `Hash32.bytes` → `asBytes` (if still present)  
- Missing / stub exports from `chainSelection`  
- Mempool typos (`getAvialbleSpace` / `getTxs`) if still present  
- Dynamic import of peer block server must be **awaited** before calling `startPeerBlockServer`  
- Deps: local tgzs (`wasm-kes`, mempool) if required; align `@harmoniclabs/ouroboros-miniprotocols-ts` with sibling repo when needed  

```bash
bunx tsc --noEmit 2>&1 | head -40
NETWORK=preprod bun src/start.ts
```

---

## The Lab consumer notes

When wiring into The Lab (`/media/bakon/data/Dev/HarmonicLabs/TheLab/`):

- Dolos is the **UX/ops template** (instance dir, progressive checklist, live logs, health)  
- Gerolamo service must spawn **this repo** (Bun + config), not a nonexistent `@txpipe/gerolamo` binary  
- Prefer absolute binary/script path + instance config (same lesson as Dolos PATH stripping under Electrobun)  
- N2C in Lab already exists for Dolos — only reuse once Gerolamo actually serves a local Ouroboros socket  

---

## Commit convention

```
feat|fix|refactor|docs(gerolamo|lab): short message
```

Work risky changes on `The-Lab`. Do not force-push `master`/`origin/master`.

---

## Quick commands

```bash
cd /media/bakon/data/Dev/HarmonicLabs/gerolamo
git fetch origin
git checkout -b The-Lab origin/master   # first time
bun install
bunx tsc --noEmit
NETWORK=preprod bun src/start.ts
```

---

## One-line mission

**Forget `mikes-rolling-updates`. Branch `The-Lab` from `origin/master` (Hari). Continue implementing Gerolamo toward Lab-managed node ops — spawn, health, instance dirs — then N2C if needed.**
