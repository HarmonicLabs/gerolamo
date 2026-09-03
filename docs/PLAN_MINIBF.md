# MiniBF implementation plan (pointer)

**Status:** planned (research complete) — not fully implemented  
**Date:** 2026-08-02

## One-liner

Dolos-shaped Mini-Blockfrost for Gerolamo via **derived `mb_*` SQLite projections** — never poison ledger apply tables (`blocks` / `utxo` / `utxo_deltas`).

## Docs

| Doc | Path |
|-----|------|
| **Dolos schema/impl research** | [`docs/dolos-minibf-schema-research.md`](./dolos-minibf-schema-research.md) |
| **Detailed phased plan** | [`.hermes/plans/2026-08-02_201910-minibf-dolos-parity.md`](../.hermes/plans/2026-08-02_201910-minibf-dolos-parity.md) |
| Gap audit (older) | [`docs/gerolamo-vs-dolos-gap.md`](./gerolamo-vs-dolos-gap.md) |
| Prior WS + thin MiniBF plan | [`.hermes/plans/2026-07-31_013608-bun-ws-streaming-and-minibf-parity.md`](../.hermes/plans/2026-07-31_013608-bun-ws-streaming-and-minibf-parity.md) |
| Dolos source (local) | `/media/bakon/data/Dev/HarmonicLabs/dolos` (`crates/minibf`, `crates/core/src/indexes.rs`) |

## Non-poisoning rule

| May write | Must not write |
|-----------|----------------|
| `mb_*` tables | `blocks`, `utxo`, `utxo_deltas` |
| legacy `tx_index` / `address_tx` / `block_tx` (until migrated) | stake/consensus tables as MiniBF side effects |
| backfill on **`.live/*.db` only** | dual-write `.hydrate/batch.db` while hydrate runs |

Consensus/apply never **reads** MiniBF tables to decide tip or validity.

## Phases (summary)

0. **`mb_*` schema + cursor** in `ensureInitialized`  
1. **Forward indexer** (Dolos IndexDelta-lite) on apply + rollback  
2. **Wallet P0 HTTP** — blocks, address, txs full IO when indexed, network, submit  
3. **Backfill** history on live DB  
4. **Tags / assets / block meta**  
5. **Accounts / pools / scripts / metadata** (product-gated)  
6. **Lab bf_servers + curl matrix**

## Already on disk (baseline)

- `src/api/miniBlockfrost.ts` — subset under `/api/v0/*` (v0.3.0 code; live process may still be 0.2.0 until restart)
- Forward index stub: `indexTransaction` + `BlockApplication` `indexCtx`
- Thin tables: `tx_index`, `address_tx`, `block_tx`
- `scripts/backfill-tx-index.mjs` (live only; refuse batch while hydrate writes)

## First implementation slice

See plan Tasks 0.1 → 1.3 → 2.2 (routes 1–16) → live restart smoke → backfill.

Do **not** start Phase 4–5 until Lab wallet flows work on P0.
