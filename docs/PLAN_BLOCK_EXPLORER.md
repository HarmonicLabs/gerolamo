# PLAN: Block explorer on MiniBF

Status: 2026-09-03 — **M1, M2 (six pages) and M5 implemented** (see §4);
M3 and M4 not started. Companion page (same content, visual): see the
Artifact link in the conversation that produced this.

## 0. Where we start

What exists and is reused as-is:

| Layer | Have | Gap |
|---|---|---|
| Node HTTP (`src/api/miniBlockfrost.ts`) | block by slot/hash, block txs, latest block, tx detail + IO, address summary/UTxOs/txs, script CBOR, epoch latest + parameters, mempool, network, tx submit, OpenAPI | no block *list*, no height/time, no `/epochs/{n}`, no tx metadata/certs/mint, no assets, no pools, no search |
| Tables | `blocks` (hash, slot, prev_hash, header/body bytes), `mb_tx` (fee, size, validity, `block_height` **always null**), `mb_tx_in/out` (full IO, datum, script ref, spent_by), `address_tx`, `block_tx`, `utxo`, `genesis_utxo`, `epoch_params`, `pool_distr`, `delegations`, `stake`, `utxo_deltas` | no `block_no`; no `mb_tx_meta`, `mb_tx_cert`, `mb_tx_mint`, `mb_asset`; `pool_distr` is one JSON blob per snapshot |
| Dashboard (`dashboard/`, Solid) | pages Overview / Blocks / Explorer / Peers / Mempool / Logs / Settings, components BlockCard, BlockDetail, TxDetail, TxRow, FilterBar, ChainDiagram, api client with types, mocks, SSE hook | `fetchRecentBlocks` calls `/blocks?limit=` which does not exist → front page is empty; detail pages fetch by hash only; no address/epoch/asset pages; served by `scripts/dashboard-server.ts` (port 3050) proxying the node |
| Desktop (`desktop/`) | Control Center, Docs page | no explorer; can embed the dashboard in a view later |

Design rules kept from the rest of the node: Blockfrost response shapes so
existing clients keep working; indexes are *derived projections* written during
block apply (never a second source of truth for the ledger); every new table is
rebuildable by a backfill script from `blocks`.

## 1. Milestones

### M1 — Chain navigation (node, ~1 day)
Goal: front page and paging work; every block/tx has height and time.

1. **Block height.** Add `block_no INTEGER` to `blocks` (nullable, indexed).
   Applier sets `block_no = prev.block_no + 1` (Byron EBBs do not count, as on
   chain; genesis = 0). Backfill: walk `blocks ORDER BY slot` once at startup
   when any `block_no IS NULL` (idempotent, ~1 M rows/min on SQLite).
   Fill `mb_tx.block_height` from it.
2. **Time from slot.** Pure function per network: `systemStart + (Byron slots ×
   20 s) + (Shelley slots × 1 s)` using the geometry in
   `src/utils/epochFromSlotCalculations.ts` (mainnet start 2017-09-23T21:44:51Z,
   preprod 2022-06-21T00:00:00Z, preview 2022-10-25T00:00:00Z). No table.
3. **Endpoints.**
   - `GET /blocks?limit&before=<slot|hash>` → BF `BlockContent[]` newest first
     (Blockfrost has no list endpoint; this is our extension, documented).
   - `GET /blocks/{id}/previous?count`, `GET /blocks/{id}/next?count` (BF shape).
   - `GET /blocks/latest` and `/blocks/{id}` gain `height`, `time`, `epoch`,
     `epoch_slot`, `slot_leader` (issuer vkey hash from header), `size`, `tx_count`,
     `previous_block`, `next_block`, `confirmations`.
   - `GET /epochs/{n}`, `/epochs/{n}/blocks?page`, `/epochs/{n}/parameters`
     (from `epoch_params`), `/epochs/{n}/next`, `/epochs/{n}/previous`.
   - `GET /txs/{hash}` gains `block_height`, `block_time`, `index`, `output_amount`,
     `utxo_count`, `asset_mint_or_burn_count` (0 until M3).
4. **Tests.** Fixture DB built in-memory from the Shelley/Conway fixtures plus a
   few synthetic blocks; assert paging boundaries (`before` at a slot with a
   Byron EBB sharing the slot), time for the three networks, `previous/next`
   at genesis and tip.

Acceptance: dashboard front page lists blocks from the live node with height
and time; clicking a block shows its txs; clicking a tx shows IO.

### M2 — Explorer UI (dashboard, ~2 days)
Goal: a usable explorer in the existing Solid dashboard, no new framework.

1. **API client** (`dashboard/src/lib/api.ts`): point `fetchRecentBlocks` at
   `/api/v0/blocks?limit`; add `fetchBlock(id)`, `fetchBlockTxs(id, page)`,
   `fetchTx(hash)`, `fetchTxUtxos(hash)`, `fetchAddress(addr)`,
   `fetchAddressUtxos`, `fetchAddressTxs(page)`, `fetchEpoch(n)`,
   `fetchEpochBlocks(n, page)`, `search(q)`. Types mirror Blockfrost. Keep the
   mocks in sync (they are what the unit tests run against).
2. **Routes.** Hash-based router (already in place): `#/blocks`,
   `#/block/<id>`, `#/tx/<hash>`, `#/address/<addr>`, `#/epoch/<n>`,
   `#/search?q=`. Each page: skeleton → data → error boundary with the
   Blockfrost error message.
3. **Pages.**
   - Blocks: infinite list newest-first (cursor = last slot), columns height,
     slot, epoch/epoch-slot, time (relative + absolute on hover), tx count,
     size, issuer. Live prepend from the node's `/ws/stats` tip event.
   - Block: header card (height, hash, prev/next links, time, epoch, leader,
     size, confirmations), tx table (hash, index, fee, IO counts, size).
   - Transaction: summary (block link, time, fee, size, validity, valid
     contract), inputs/outputs as two columns with address links, amounts
     with assets expanded, datum hash / inline datum (hex + CBOR diag
     toggle), reference script hash → `/scripts/{hash}/cbor` download;
     metadata, certs, mint sections appear in M3.
   - Address: balance (sum of unspent), UTxO count, tx history (paged,
     direction in/out), UTxO list with assets, stake key if base address.
   - Epoch: number, start/end time, block count, tx count, active params
     (from `epoch_params`), first/last block links, prev/next.
   - Search: one box; resolves 64-hex → tx then block, digits → slot or block
     height (ask), `addr…`/`Ae2…`/`DdzFF…` → address, `stake…` → stake key,
     `pool1…` → pool (M4). Server endpoint `GET /search?q=` returns
     `{kind, id}` so the client does not guess.
4. **Node awareness.** Every page shows the node tip and a "syncing to slot N"
   banner when `/metrics.sync` is behind; detail pages for slots beyond the
   tip return the BF 404 shape and the UI says "not yet synced".
5. **Tests.** Component tests with the mocks (already the pattern), plus an
   e2e that boots the dashboard server against a fixture SQLite via
   `--node-url`.

Acceptance: the seven pages work against the live preprod node; front page
refreshes on new blocks; no `mock` data path in production builds.

### M3 — Transaction depth (node indexes, ~2 days)
Goal: tx pages complete: metadata, certificates, withdrawals, mint/burn, assets.

1. **Tables** (all keyed by `tx_hash`, written in `applyTransaction`, all
   rebuildable from `mb_tx.body_cbor` + block aux data):
   - `mb_tx_meta(tx_hash, label, json, cbor)` from auxiliary data (block-level
     `auxiliary_data_set` → tx index).
   - `mb_tx_cert(tx_hash, cert_index, kind, json)` — stake reg/dereg, delegation,
     pool reg/retire, genesis delegation, MIR, Conway DRep/committee/vote
     certs.
   - `mb_tx_withdrawal(tx_hash, stake_address, amount)`.
   - `mb_tx_mint(tx_hash, policy, asset_name, quantity)` (negative = burn).
   - `mb_asset(policy, asset_name, fingerprint, first_mint_tx, quantity,
     mint_count)` maintained from `mb_tx_mint`; CIP-14 fingerprint computed once.
   - `mb_tx_redeemer(tx_hash, purpose, index, unit_mem, unit_steps, datum_hash)`
     from witness sets.
   Byron txs: inputs/outputs only (no certs/metadata by construction).
2. **Endpoints** (BF shapes): `/txs/{hash}/metadata`, `/metadata/cbor`,
   `/stakes`, `/delegations`, `/withdrawals`, `/mirs`, `/pool_updates`,
   `/pool_retires`, `/redeemers`; `/assets/{asset}`, `/assets/{asset}/history`,
   `/assets/{asset}/txs`, `/assets/{asset}/addresses`, `/assets/policy/{id}`;
   `/addresses/{addr}/extended` (amounts with decimals when metadata known).
3. **Backfill.** `scripts/backfill-minibf.mjs` gains the new tables; runs in
   ranges; safe while the node is stopped (one writer).
4. **UI.** Tx page sections render only when non-empty; asset chips link to
   `#/asset/<id>`; asset page (supply, mint history, holders top-N).

Acceptance: a Conway-era preprod tx with metadata, a mint and a redeemer
renders every section; `/assets/{id}` matches Blockfrost for a known preprod
asset.

### M4 — Staking view (~1–2 days, after ledger snapshot work)
`/pools`, `/pools/{id}`, `/pools/{id}/delegators`, `/accounts/{stake}`,
`/accounts/{stake}/history`. Needs per-epoch pool distribution rows instead of
the single JSON blob and stake-address → reward tracking; do it once
`pool_distr`/`rewards` are populated per epoch by the ledger, not before.

### M5 — Ship (~1 day)
- Desktop: "Explorer" nav entry opening the dashboard in an Electrobun view
  pointed at the local node (no separate server needed once the dashboard is
  built into `views/`).
- `bun run dashboard:build` output served by the node itself at `/explorer/`
  (static files from `peerBlockServer`), so `http://127.0.0.1:3030/explorer`
  works with zero extra processes.
- OpenAPI: every new route documented in `src/api/openApi.ts`; contract test
  that walks the spec and hits each path against a fixture DB.

## 2. Cross-cutting

- **Performance.** All list endpoints are cursor-paged (`before=<slot>`),
  never `OFFSET`. Indexes: `blocks(block_no)`, `mb_tx(slot)` (exists),
  `address_tx(address, slot DESC)` (exists), `mb_tx_mint(policy, asset_name)`,
  `mb_tx_meta(tx_hash)`. Read queries run on the same connection as the
  applier (WAL); cap `limit` at 100.
- **Sync-aware UX.** Explorer must never look broken during catch-up: show
  the tip, show "N epochs behind", 404s past the tip say so.
- **Byron correctness.** EBBs share a slot with the epoch's first block:
  paging by slot must be by `(slot, is_ebb)`; heights skip EBBs.
- **No second truth.** Every `mb_*` table is a projection; `utxo`,
  `utxo_deltas` and the ledger tables stay authoritative. A `--rebuild-minibf`
  flag drops and re-derives all projections from stored blocks.
- **Networks.** Everything keyed by the node's network; time/epoch math from
  the shared geometry; the UI shows the network badge everywhere.

## 3. Order and estimate

| Milestone | Depends on | Size | Unlocks |
|---|---|---|---|
| M1 chain navigation | — | 1 d | usable front page, height/time everywhere |
| M2 explorer UI | M1 | 2 d | blocks / block / tx / address / epoch / search pages |
| M3 tx depth | M1 | 2 d | complete tx pages, assets |
| M4 staking | ledger snapshots per epoch | 1–2 d | pools, accounts |
| M5 ship | M2 | 1 d | explorer inside the desktop app and at `/explorer` |

M1 + M2 give a decent explorer in about three days. M3 makes it complete for
everything except staking.

## 4. Status log

### 2026-09-03 — M1, M2, M5

- **M1 (node).** `blocks.block_no` (and on `immutable_blocks`), set by the
  applier (EBBs null, first main block = 1), migrated + backfilled at startup
  for older databases (`backfillBlockHeights`, chunked, EBB-before-main
  ordering); `mb_tx.block_height` filled on apply. Slot → wall-clock time from
  the shared geometry (`slotToUnixTime`; mainnet/preprod/preview system
  starts, 20 s Byron slots). Endpoints: `GET /blocks?limit&before=<slot|hash>`,
  `/blocks/height/{n}`, `/blocks/{id}/previous|next?count`, `/epochs/{n}`,
  `/epochs/{n}/blocks`, `/epochs/{n}/parameters`, `/epochs/{n}/next|previous`,
  `/search?q=`; `/blocks/latest` and `/blocks/{id}` carry height, time,
  epoch, epoch_slot, slot_leader (pool key hash from the header; Byron issuer
  key hash), size, tx_count, previous/next_block, confirmations; `/txs/{hash}`
  carries block_height, block_time, index, output_amount, utxo_count. All in
  OpenAPI. Tests: heights/paging on a temp DB (`db.blocks.test.ts`), the
  endpoints (`miniBlockfrost.explorer.test.ts`), slot leader
  (`blockLeader.test.ts`), geometry.
- **M2 (dashboard).** `lib/explorer.ts` (Blockfrost-shaped client against
  `/api/v0`, hash routes `#/explorer[/block/:id|/tx/:hash|/address/:addr|/epoch/:n|/search?q=]`,
  formatting helpers; tested) and a rewritten `pages/Explorer.tsx`: blocks
  list with cursor paging and live prepend, block, transaction (inputs /
  outputs, datums, reference scripts), address (balance, UTxOs, paged txs),
  epoch (times, block count, stored parameters, block list), search box that
  lets the server classify the query, and a tip/sync banner from `/metrics`.
  Vite `base: "./"` and dev proxies for `/api/v0` and `/metrics`.
- **M5.** The node serves `dashboard/dist` at `/explorer/` (SPA fallback,
  `GEROLAMO_EXPLORER_DIR` override, 503 with the build command when not
  built). The desktop has an **Explorer** nav entry embedding it. `bun run
  dashboard:build` produces the bundle.

Not done: M3 (metadata / certificates / mint / assets tables and pages) and
M4 (staking). The legacy dashboard pages (Overview, Blocks, Peers, Mempool,
Logs) still talk to `scripts/dashboard-server.ts`; only the Explorer page
uses the node directly, so the embedded view is the Explorer route.
