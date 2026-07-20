# Soft-state hydration (batch path)

Gerolamo can rebuild **soft ledger state** (blocks tip + UTxO set + deltas) from
Cardano **immutable chunk** files without full Praos consensus.

This is **not** a validating node path. Soft apply only — no VRF/KES/script proof
as a gate on density.

## Paths

| Path | Script / entry | DB | Notes |
|------|----------------|-----|--------|
| **Batch (preferred)** | `scripts/batch-hydrate.mjs` | `.hydrate/batch.db` (default) | One `BEGIN`/`COMMIT` per chunk + bulk pragmas |
| Slow / legacy A3 | ad-hoc resume scripts | was `.hydrate/full.db` | Row-ish autocommit; minutes/chunk late chain — **retired** for density |
| Live node | `start-gerolamo` + peers | `./ledger/gerolamo.db` | N2N ChainSync/BlockFetch into main DB |
| Mithril ancillary | `load-ancillary` | — | **Blocked** (A2): CBOR adapter gap; download OK via `mithril-client` |

## Batch hydrate

### Prerequisites

- Bun ≥ 1.0
- Immutable dir: `snapshots/preprod/db/immutable` (or `--chunks`)
- Enough free disk (full preprod soft DB is multi‑GB; rate grows with UTxO)

### Commands

```bash
# Full clean rebuild (wipes target DB)
bun scripts/batch-hydrate.mjs --wipe --from 0 --progress 25

# Range / resume-style (only if DB already has earlier chunks applied)
bun scripts/batch-hydrate.mjs --from 500 --to 969 --progress 25

# Custom DB (never dual-write with another hydrate on same file)
bun scripts/batch-hydrate.mjs --db .hydrate/batch2.db --wipe --from 0

# Monitor
tail -f /tmp/hermes-batch-full.log   # if redirected there
# or
bun scripts/batch-watch.mjs
```

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--from N` | `50` | First chunk number |
| `--to N` | last on disk | Inclusive end |
| `--limit N` | — | Alternative to `--to` |
| `--db PATH` | `.hydrate/batch.db` | SQLite file |
| `--chunks DIR` | `snapshots/preprod/db/immutable` | Immutable root |
| `--wipe` | off | Delete target DB (+ wal/shm) first |
| `--progress N` | `1` | Log every N chunks |

### What it does

1. `initSql(db)` **after** env set; uses **returned** client (not a stale destructure).
2. Pragmas: `WAL`, `synchronous=OFF`, large `cache_size` / `mmap` (disposable rebuild).
3. `ensureInitialized()` schema.
4. Per chunk: `sql.begin(tx => processChunk(..., tx))` so apply* write through optional `SqlClient`.
5. Progress JSON: `chunk`, `applied`, `failed`, `total`, `remaining`, `pct`, `tip`, `utxo`, `secPerChunk`.

### Isolation rules

- **One writer** per DB file. Two hydrates on the same path → `SQLITE_BUSY`.
- Do **not** point `--db` at a live node DB while the node is running.
- Read-only `bun:sqlite` probes are fine for tip/UTxO counts.
- `synchronous=OFF` is for rebuild speed; crash can trash that disposable file — wipe and restart.

### Expected rate (blunt)

- Early Byron / empty-body chunks: sub‑second to few seconds.
- Dense Shelley+: seconds → tens of seconds per chunk as UTxO + `utxo_deltas` grow.
- Prior soak 500→969: finished ~1.7 h, late ~13 s/chunk, **0 failed**.
- Full 0→5298: multi‑hour; ETA from latest `secPerChunk` **underestimates** late chain.

Soft apply ≠ consensus. Same tip/UTxO between slow and batch paths was checked on sample chunks; not a full-chain golden compare.

## Resume semantics

| Situation | Action |
|-----------|--------|
| Fresh rebuild | `--wipe --from 0` |
| Continue **same** batch DB after kill | `--from <next_chunk>` **without** `--wipe` (must match applied history) |
| “Pick up A3 full.db tip on empty batch.db” | **Wrong** — missing early UTxOs; full rebuild or migrate DB |
| Node live DB | Separate path; don’t mix with batch wipe |

## Related

- Client injection: `SqlClient` on `applyTransaction` / `applyBlock` / `processChunk`
- Commit: `017637e` batch path
- Mithril A2: `src/state/mithril.ts` (honest no-op extract)
- Live follow (example): `tail -f /tmp/hermes-batch-full.log`
