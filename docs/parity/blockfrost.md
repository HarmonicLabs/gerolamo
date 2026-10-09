# Parity 5b: Blockfrost-compatible API (items 500–529)

Workstream 5b of docs/PLAN_DINGO_PARITY.md. Goal: the mini-Blockfrost (`/api/v0/*`) covers the
Blockfrost OpenAPI endpoints a wallet, dApp or explorer needs, with response shapes that match
Blockfrost's own schemas (blockfrost-backend-ryo semantics for paging, order and errors).

## Summary

| | Blockfrost paths (OpenAPI 0.1.92) | served | shape-validated |
|---|---|---|---|
| Gerolamo before this work | 129 | 26 | not measured; by inspection most failed (required fields were `null`, `/tx/submit` answered 202 with an object) |
| Gerolamo now | 129 | **117** | **115** (112 GET paths by schema, 3 POST paths by behaviour tests) |
| Dingo (14f789e) | 129 | 49 (+ 501 stubs) | not measured |
| Dolos minibf | 129 | 64 | not measured |

Not served (12): `/ipfs/*` (6), `/metrics`, `/metrics/endpoints` (Blockfrost project usage),
`/nutlink/*` (4). These are Blockfrost platform features, not chain data.
The two proposal `/metadata` paths answer 404: the node does not fetch off-chain anchors.

"Shape-validated" means: the endpoint answered 200 on the forged test chain and the body passed
Blockfrost's 200 response schema (vendored as `src/api/blockfrost/blockfrost-openapi.responses.json`,
refreshed by `scripts/blockfrost-vendor-schema.ts`). `/tx/submit` and `/utils/txs/evaluate(/utxos)`
have their own behavioural tests.

## Architecture

- `src/api/miniBlockfrost.ts`: entry (`handleMiniBlockfrost`), a path-template router
  (`src/api/blockfrost/router.ts`) and route modules in `src/api/blockfrost/routes/`
  (core, txs, addresses, assets, pools, governance, extensions).
- Current state from the LMDB ledger store (`src/api/blockfrost/ledger.ts`): registrations,
  delegations, reward balances, UTxO stake, pools and their raw PoolParams, snapshots, reward
  payouts, DReps, DRep delegations and stake, proposals, committee. Whole-table aggregates
  (live stake per pool, DRep delegators) are built in chunks with event-loop yields and cached
  for two minutes; `/network` is cached for one minute.
- History from the explorer projection (`<db>.explorer.db`, written by the explorer worker).
  Schema v2 adds the tables below. Per-transaction endpoints decode the transaction's block on
  demand (`src/db/minibf/blockFacts.ts`, the last 64 blocks cached), so they need no extra rows.
- Writes stay off the applier thread: the applier posts the block bytes (a copy) to the worker
  after the block's transaction deltas; the worker decodes and writes the v2 rows. Without the
  worker (tests, scripts) the same writer runs inline.

## Numbered items

### 500 Explorer projection v2: block facts and history tables
- What: new tables `mb_block` (height, epoch, tx count, fees, output, issuer, VRF key, op cert),
  `mb_tx_meta` + `mb_meta_label`, `mb_mint` + `mb_asset`, `mb_tx_out_asset`, `mb_cert`, `mb_mir`,
  `mb_withdrawal`, `mb_redeemer`, `mb_script`, `mb_datum`, `mb_vote`, `mb_proposal`; payment and
  stake credentials on `mb_tx_out`; `mb_tx.valid_contract` written.
- Why: Blockfrost's history endpoints (labels, assets, account certificates, pool updates, scripts,
  votes, deep block heights, epoch aggregates) need indexes the v1 projection did not have.
- Design: `blockFacts` reads a stored `[era, block]` with a raw CBOR walker
  (`src/db/minibf/cborWalk.ts`), keeping original bytes for hashes. `indexBlock` (db.ts) is called by
  the orchestrator right after `applyBlock`, skipped while `applySkipIndex()` (bulk sync).
  The worker builds the two `mb_tx_out` credential indexes after it reports ready (one table
  scan on a populated file; startup does not wait). On the ledger database (main thread) those
  two indexes are skipped when `mb_tx_out` has more than 100 000 rows. Mint aggregation and label
  counts are idempotent (a block indexed twice counts once). Rollback removes v2 rows above the
  slot and recomputes the asset aggregates and label counts it touched.
- Migration: v1 files get the empty v2 tables; `mb_meta.extras_since` records the tip slot at the
  upgrade. History below it needs `scripts/explorer-backfill.ts --extras --creds` (item 518).
- Tests: `src/db/minibf/blockFacts.test.ts` (27 real preview/preprod blocks: hashes, fees, outputs,
  certificates, header fields equal cardano-ledger-ts; rebuilt tx CBOR round-trips),
  `src/db/minibf/explorerIndexer.test.ts` (block message through the worker: block row,
  metadata and redeemer rows, deferred credential index), rollback and idempotency tests in
  `src/api/blockfrost/blockfrost.test.ts`.
- Measured: a dense preview block (41.5 kB, 40 transactions) decodes in 3.4 ms (ledger-ts: 3.9 ms);
  decode plus v2 writes 3.2 ms, in the worker thread.

### 501 Phase-2-invalid transactions in the projection
- What: `applyInvalidTransaction` now indexes the transaction (`valid_contract` 0, inputs = the
  collateral, output = the collateral return at index |outputs|, fee = the collateral taken).
- Why: Blockfrost lists them (`valid_contract: false`); before, they were missing from every
  address and block list.
- Tests: forged chain transaction 4 (`/txs/{hash}`, `/txs/{hash}/utxos`, `/addresses/{a}/txs`).

### 502 Router, errors and paging
- What: path-template router (literal segments win), Blockfrost error bodies with ryo's messages
  (`The requested component has not been found.`, `Invalid address for this network or malformed
  address format.`, …), 405 with `Allow`, `count` 1–100 (default 100), `page` 1–21474836, `order`
  asc|desc with fastify's 400 texts, `from` / `to` (`height[:index]`) on the transaction lists.
- Tests: "Blockfrost pagination, order and errors" suite.

### 503 Root, health, genesis, network, eras, epochs, blocks
- `/genesis` from the network's Shelley genesis; `/network` supply from the ledger pots and
  deposits, live stake from the delegation index, active stake from the snapshot; `/network/eras`
  from the era table (horizon: next epoch, two inside the safe zone).
- Blocks: `slot_leader` is the bech32 pool id (Byron: `ByronGenesis-<key hash prefix>`),
  `block_vrf` bech32 `vrf_vk`, `op_cert` / counter, `fees` / `output` from `mb_block` (decoded on
  demand when missing), `/previous` oldest first like Blockfrost, EBBs included in next/previous,
  `/blocks/{n}` by height with the explorer's height index beyond the block store's recent window,
  `/blocks/{h}/addresses`, `/txs/cbor`, `/blocks/epoch/{e}/slot/{s}`.
- Epochs: counts, fees and output from `mb_block` (from `mb_tx`/`mb_tx_out` for v1 history),
  `active_stake` from the snapshot taken at the boundary into e−1, `/stakes(/{pool})` from that
  snapshot, `/blocks/{pool_id}`, `/parameters` with string deposits, named cost models plus
  `cost_models_raw`, and the epoch nonce.
- Kept Gerolamo behaviour: a number that is no block's height falls back to the slot (Blockfrost
  would answer 404); extra fields (`ebb`, `epoch_nonce`, `first_slot`, …) are additions only.

### 504 Transactions
- `/txs/{hash}` and all sub-paths from the decoded block: `deposit` by value conservation when every
  input is known (else from certificates and proposals), `utxo_count`, certificate counts, mint
  count, `treasury_donation`; `/utxos` with reference inputs (`reference: true`), collateral inputs and
  the collateral return (`collateral: true`), `consumed_by_tx`; `/redeemers` with the script hash
  resolved like the ledger (sorted inputs, policies, withdrawals, voters) and the fee from the
  epoch's prices; metadata in db-sync's no-schema JSON and as CBOR; `/cbor` rebuilt from the block.
- Tests: redeemer script hashes equal the phase-2 evaluator's on 9 real Plutus transactions.

### 505 `/tx/submit` in Blockfrost's shape
- What: 200 with the transaction id as a JSON string (was 202 with an object); the mempool verdict
  moved to `X-Gerolamo-Mempool-*` headers. The desktop app reads both shapes.

### 506 `/utils/txs/evaluate` and `/utils/txs/evaluate/utxos`
- What: Ogmios v5 response (`EvaluationResult` / `EvaluationFailure`), v6 with `?version=6`; body as
  CBOR, hex or base64; `additionalUtxoSet` in Ogmios v5 form. Inputs resolve from the ledger UTxO set.
- Design: `Phase2Input.budget` (new, optional) evaluates every script against the transaction's
  maximum units instead of its declared units. No behaviour change for block validation.
- Tests: preview transaction 95107576 #0 gives `mint:0 {memory 307346, steps 284206491}`, the
  same as aiken's evaluator.

### 507 Addresses
- `/addresses/{a}` (+ `/extended`, `/total`, `/utxos`, `/utxos/{asset}` with `lovelace`, `/txs`,
  `/transactions`): balances and UTxOs from the ledger UTxO set (ordered by creation via `mb_tx`),
  history from the projection with SQL paging; payment-credential queries (`addr_vkh…`, `script…`)
  through `mb_tx_out.payment_cred`; 404 for an address never seen, 400 for another network's.

### 508 Accounts
- `/accounts/{stake}`: registration, delegation, reward balance and controlled amount from the
  ledger; withdrawals and MIR sums from the projection; `drep_id` in CIP-129.
- `/rewards` (per performance epoch from the ledger's payouts, `leader` when the account is its pool's
  reward account), `/history` (snapshots), `/delegations`, `/registrations`, `/withdrawals`, `/mirs`,
  `/addresses`, `/addresses/assets`, `/addresses/total`, `/utxos`, `/transactions`.

### 509 Assets
- `/assets` (first-mint order), `/assets/{asset}` (fingerprint, supply, mint count, CIP-68 metadata from
  the reference NFT's inline datum, else CIP-25 label 721 of the latest mint), `/history`, `/txs`,
  `/transactions`, `/addresses`, `/utxos`, `/assets/policy/{policy}`. Off-chain registry `metadata` is null.

### 510 Metadata labels
- `/metadata/txs/labels` from the `mb_meta_label` counts (no GROUP BY over every row), with CIP-10
  names for common labels; `/labels/{label}` (+ `/cbor`), an empty page is a 404 like Blockfrost.

### 511 Scripts and datums
- `/scripts` (first-seen order), `/scripts/{hash}` (+ `/json` for native scripts, `/cbor` for Plutus,
  `/redeemers`, `/utxos`), `/scripts/datum/{hash}` (detailed-schema JSON, + `/cbor`). Scripts and
  datums come from witnesses, auxiliary data, reference scripts and inline datums.

### 512 Pools
- `/pools` (+ `/extended`, `/retired`, `/retiring`), `/pools/{id}` with live / active stake, sizes,
  saturation, live pledge, registration and retirement transactions; `/history` (snapshots, reward
  records), `/metadata` and `/relays` (from the raw PoolParams), `/delegators`, `/blocks`, `/updates`,
  `/votes`. Off-chain pool metadata fields (ticker, name, …) are null.

### 513 Governance
- `/governance/dreps` (+ `/{id}`, `/delegators`, `/updates`, `/votes`, `/metadata` with the anchor and an
  `error` because off-chain JSON is not fetched), DRep ids in CIP-129 and legacy form, the two
  predefined DReps; `/governance/proposals` (+ by `tx/index` and by `gov_action1…`: details,
  `/parameters`, `/withdrawals`, `/votes`), `/governance/committee`, `/committee/votes`,
  `/committee/{cc_id}/votes` (a cold id finds its hot key's votes).

### 514 Mempool
- `/mempool` (hash list, paged), `/mempool/{hash}` (decoded transaction), `/mempool/addresses/{a}`.
  The former snapshot shape moved to the extension `/mempool/txs` (desktop app updated).

### 515 `/utils/addresses/xpub/{xpub}/{role}/{index}`
- BIP32-Ed25519 public derivation in pure TypeScript (`src/api/blockfrost/xpub.ts`), checked against
  the private derivation of `@harmoniclabs/bip32_ed25519`. The example in Blockfrost's OpenAPI does not
  derive from its own example xpub (both libraries agree with each other, not with that example).

### 516 Identifiers
- `src/db/minibf/cardanoIds.ts`: bech32 decode, stake addresses, pool ids, CIP-129 DRep / committee /
  governance-action ids (minimal 32-byte form accepted), CIP-14 fingerprints, address parsing with the
  network check. Tests: CIP-14 and CIP-19 vectors, blockfrost-backend-ryo's CIP-129 vectors.

### 517 OpenAPI document
- `/docs` and `/openapi.json` are generated from the router, with Blockfrost's 200 schemas.

### 518 Backfill
- `scripts/explorer-backfill.ts` reads the chunk store (read-only) or the legacy `blocks` table, builds
  the deltas from the block bytes (`src/db/minibf/blockDeltas.ts`), and writes the v1 and v2 rows;
  `--extras` writes only the v2 rows, `--creds` fills credentials and output assets of pre-v2 rows.
  Refuses to apply while a node with `GEROLAMO_PORT=<port>` runs. Checked on the forged chain: the
  backfilled file equals the live writer's (4 blocks, 5 transactions, 9 certificates, supply 7/1/1).

### 519 Comparison with public Blockfrost
- `scripts/blockfrost-compare.ts` samples ids from the node, diffs every path with
  `cardano-<network>.blockfrost.io` (needs `BLOCKFROST_PROJECT_ID`; paced under the free tier), and
  separates moving / off-chain fields from mismatches. Not run (no project id here).

### 520 Tests
- `src/api/blockfrost/blockfrost.test.ts` (forged Conway chain on preview geometry + LMDB ledger store:
  112 GET probes validated against the schemas, behaviour, paging, errors, evaluate, xpub, rollback,
  idempotency, OpenAPI), `src/api/blockfrost/cborJson.test.ts`, `src/db/minibf/cardanoIds.test.ts`,
  `src/db/minibf/blockFacts.test.ts` (also mainnet's first Byron transaction), updated
  `src/api/miniBlockfrost.*.test.ts`.
- Measured: targeted `bun test src/db/minibf src/api` 55 pass; full `bun test src` 1410 pass, 5 fail
  (baseline 1373 pass, the same 5 failures: dashboard tests that need `solid-js`, absent from the
  worktree's node_modules); `tsc --noEmit` clean.

## Known differences from Blockfrost

- Off-chain data is not fetched: pool metadata (ticker, name, …), token registry `metadata`, DRep
  and proposal anchors' JSON (`/governance/proposals/*/metadata` answers 404).
- `/network` `supply.locked` is "0" (script-locked UTxO value is not tracked); `circulating` is
  total − treasury − deposits − fee and donation pots.
- `rewards_sum` is the reward balance plus withdrawals (Blockfrost sums every reward ever earned);
  `/accounts/{stake}/rewards` covers the epochs the ledger keeps (30 by default) and has no
  `pool_deposit_refund` rows.
- `/pools/{id}/history` `rewards` / `fees` are filled only for epochs the ledger recorded pool rewards.
- History endpoints cover what the projection indexed: v1 files need `--extras --creds` for the
  history before the upgrade, and ranges paused during bulk sync need the backfill.
- `/blocks/{n}` falls back to the slot when no block has height `n`.
- Byron `slot_leader` text: `ByronGenesis-` + the first 16 hex characters of the delegate key hash.

## Coverage matrix

"before": served by the mini-Blockfrost at the baseline (31ea98f). "now": served by this tree.
"schema": the 200 body passed Blockfrost's schema in the tests. Dingo and Dolos: routes
registered in ref-dingo/api/blockfrost (14f789e, not counting its 501 stubs) and dolos/crates/minibf.

| path | before | now | schema | Dingo | Dolos |
|---|---|---|---|---|---|
| `/` | yes | yes | yes | yes | yes |
| `/health` | yes | yes | yes | yes | yes |
| `/health/clock` | – | yes | yes | – | yes |
| `/blocks/latest` | yes | yes | yes | yes | yes |
| `/blocks/latest/txs` | – | yes | yes | yes | yes |
| `/blocks/latest/txs/cbor` | – | yes | yes | – | yes |
| `/blocks/{hash_or_number}` | yes | yes | yes | yes | yes |
| `/blocks/{hash_or_number}/next` | yes | yes | yes | – | yes |
| `/blocks/{hash_or_number}/previous` | yes | yes | yes | – | yes |
| `/blocks/slot/{slot_number}` | yes | yes | yes | – | yes |
| `/blocks/epoch/{epoch_number}/slot/{slot_number}` | – | yes | yes | – | – |
| `/blocks/{hash_or_number}/txs` | yes | yes | yes | – | yes |
| `/blocks/{hash_or_number}/txs/cbor` | – | yes | yes | – | yes |
| `/blocks/{hash_or_number}/addresses` | – | yes | yes | – | yes |
| `/genesis` | – | yes | yes | yes | yes |
| `/governance/committee` | – | yes | yes | – | – |
| `/governance/committee/votes` | – | yes | yes | – | – |
| `/governance/committee/{cc_id}/votes` | – | yes | yes | – | – |
| `/governance/dreps` | – | yes | yes | yes | – |
| `/governance/dreps/{drep_id}` | – | yes | yes | yes | yes |
| `/governance/dreps/{drep_id}/delegators` | – | yes | yes | – | – |
| `/governance/dreps/{drep_id}/metadata` | – | yes | yes | – | – |
| `/governance/dreps/{drep_id}/updates` | – | yes | yes | – | – |
| `/governance/dreps/{drep_id}/votes` | – | yes | yes | – | – |
| `/governance/proposals` | – | yes | yes | – | – |
| `/governance/proposals/{tx_hash}/{cert_index}` | – | yes | yes | – | – |
| `/governance/proposals/{tx_hash}/{cert_index}/parameters` | – | yes | yes | – | – |
| `/governance/proposals/{tx_hash}/{cert_index}/withdrawals` | – | yes | yes | – | – |
| `/governance/proposals/{tx_hash}/{cert_index}/votes` | – | yes | yes | – | – |
| `/governance/proposals/{tx_hash}/{cert_index}/metadata` | – | 404 (off-chain) | – | – | – |
| `/governance/proposals/{gov_action_id}` | – | yes | yes | – | – |
| `/governance/proposals/{gov_action_id}/parameters` | – | yes | yes | – | – |
| `/governance/proposals/{gov_action_id}/withdrawals` | – | yes | yes | – | – |
| `/governance/proposals/{gov_action_id}/votes` | – | yes | yes | – | – |
| `/governance/proposals/{gov_action_id}/metadata` | – | 404 (off-chain) | – | – | – |
| `/epochs/latest` | yes | yes | yes | yes | – |
| `/epochs/latest/parameters` | yes | yes | yes | yes | yes |
| `/epochs/{number}` | yes | yes | yes | – | – |
| `/epochs/{number}/next` | yes | yes | yes | – | – |
| `/epochs/{number}/previous` | yes | yes | yes | – | – |
| `/epochs/{number}/stakes` | – | yes | yes | – | – |
| `/epochs/{number}/stakes/{pool_id}` | – | yes | yes | – | – |
| `/epochs/{number}/blocks` | yes | yes | yes | – | yes |
| `/epochs/{number}/blocks/{pool_id}` | – | yes | yes | – | – |
| `/epochs/{number}/parameters` | yes | yes | yes | yes | yes |
| `/txs/{hash}` | yes | yes | yes | yes | yes |
| `/txs/{hash}/utxos` | yes | yes | yes | yes | yes |
| `/txs/{hash}/stakes` | – | yes | yes | yes | yes |
| `/txs/{hash}/delegations` | – | yes | yes | yes | yes |
| `/txs/{hash}/withdrawals` | – | yes | yes | yes | yes |
| `/txs/{hash}/mirs` | – | yes | yes | yes | yes |
| `/txs/{hash}/pool_updates` | – | yes | yes | yes | yes |
| `/txs/{hash}/pool_retires` | – | yes | yes | yes | yes |
| `/txs/{hash}/metadata` | – | yes | yes | yes | yes |
| `/txs/{hash}/metadata/cbor` | – | yes | yes | yes | yes |
| `/txs/{hash}/redeemers` | – | yes | yes | yes | yes |
| `/txs/{hash}/required_signers` | – | yes | yes | yes | – |
| `/txs/{hash}/cbor` | – | yes | yes | yes | yes |
| `/tx/submit` | yes | yes | yes | yes | yes |
| `/accounts/{stake_address}` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/rewards` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/history` | – | yes | yes | – | – |
| `/accounts/{stake_address}/delegations` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/registrations` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/withdrawals` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/mirs` | – | yes | yes | – | – |
| `/accounts/{stake_address}/addresses` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/addresses/assets` | – | yes | yes | – | – |
| `/accounts/{stake_address}/addresses/total` | – | yes | yes | – | – |
| `/accounts/{stake_address}/utxos` | – | yes | yes | yes | yes |
| `/accounts/{stake_address}/transactions` | – | yes | yes | yes | – |
| `/mempool` | yes | yes | yes | – | – |
| `/mempool/{hash}` | yes | yes | yes | – | – |
| `/mempool/addresses/{address}` | – | yes | yes | – | – |
| `/metadata/txs/labels` | – | yes | yes | – | – |
| `/metadata/txs/labels/{label}` | – | yes | yes | yes | yes |
| `/metadata/txs/labels/{label}/cbor` | – | yes | yes | yes | yes |
| `/addresses/{address}` | yes | yes | yes | yes | yes |
| `/addresses/{address}/extended` | – | yes | yes | – | – |
| `/addresses/{address}/total` | – | yes | yes | – | yes |
| `/addresses/{address}/utxos` | yes | yes | yes | yes | yes |
| `/addresses/{address}/utxos/{asset}` | yes | yes | yes | – | yes |
| `/addresses/{address}/txs` | – | yes | yes | – | yes |
| `/addresses/{address}/transactions` | yes | yes | yes | yes | yes |
| `/pools` | – | yes | yes | yes | – |
| `/pools/extended` | – | yes | yes | yes | yes |
| `/pools/retired` | – | yes | yes | – | – |
| `/pools/retiring` | – | yes | yes | yes | yes |
| `/pools/{pool_id}` | – | yes | yes | yes | yes |
| `/pools/{pool_id}/history` | – | yes | yes | – | yes |
| `/pools/{pool_id}/metadata` | – | yes | yes | yes | yes |
| `/pools/{pool_id}/relays` | – | yes | yes | – | yes |
| `/pools/{pool_id}/delegators` | – | yes | yes | – | yes |
| `/pools/{pool_id}/blocks` | – | yes | yes | – | – |
| `/pools/{pool_id}/updates` | – | yes | yes | – | – |
| `/pools/{pool_id}/votes` | – | yes | yes | – | – |
| `/assets` | – | yes | yes | – | – |
| `/assets/{asset}` | – | yes | yes | yes | yes |
| `/assets/{asset}/history` | – | yes | yes | – | – |
| `/assets/{asset}/txs` | – | yes | yes | – | – |
| `/assets/{asset}/transactions` | – | yes | yes | – | yes |
| `/assets/{asset}/addresses` | – | yes | yes | yes | yes |
| `/assets/{asset}/utxos` | – | yes | yes | – | – |
| `/assets/policy/{policy_id}` | – | yes | yes | – | – |
| `/scripts` | – | yes | yes | – | – |
| `/scripts/{script_hash}` | – | yes | yes | – | yes |
| `/scripts/{script_hash}/json` | – | yes | yes | – | yes |
| `/scripts/{script_hash}/cbor` | yes | yes | yes | – | yes |
| `/scripts/{script_hash}/redeemers` | – | yes | yes | – | – |
| `/scripts/{script_hash}/utxos` | – | yes | yes | – | – |
| `/scripts/datum/{datum_hash}` | – | yes | yes | – | yes |
| `/scripts/datum/{datum_hash}/cbor` | – | yes | yes | – | yes |
| `/utils/addresses/xpub/{xpub}/{role}/{index}` | – | yes | yes | – | – |
| `/utils/txs/evaluate` | – | yes | yes | yes | – |
| `/utils/txs/evaluate/utxos` | – | yes | yes | yes | – |
| `/ipfs/add` | – | – | – | – | – |
| `/ipfs/gateway/{IPFS_path}` | – | – | – | – | – |
| `/ipfs/pin/add/{IPFS_path}` | – | – | – | – | – |
| `/ipfs/pin/list` | – | – | – | – | – |
| `/ipfs/pin/list/{IPFS_path}` | – | – | – | – | – |
| `/ipfs/pin/remove/{IPFS_path}` | – | – | – | – | – |
| `/metrics` | – | – | – | – | yes |
| `/metrics/endpoints` | – | – | – | – | – |
| `/network` | yes | yes | yes | yes | yes |
| `/network/eras` | – | yes | yes | yes | yes |
| `/nutlink/{address}` | – | – | – | – | – |
| `/nutlink/{address}/tickers` | – | – | – | – | – |
| `/nutlink/{address}/tickers/{ticker}` | – | – | – | – | – |
| `/nutlink/tickers/{ticker}` | – | – | – | – | – |
