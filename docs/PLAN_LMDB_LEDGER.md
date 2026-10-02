# LMDB ledger store — full implementation plan (2026-09-15)

Decision (user, 2026-09-15): the whole ledger state moves to LMDB; SQLite remains only for the
mini-Blockfrost / explorer projection, which can equally sit behind the public Blockfrost API.
The block store is already cardano-node's chunk format (PLAN_CHUNK_STORE.md, delivered
2026-09-14). This plan removes SQLite from the block-application path.

Sequencing constraint: the producer mints its two 2026-09-15 blocks (06:49 and 21:40 UTC) on the
current code first. LMDB work starts on the data node (3036) and the fresh directory
(`gerolamo-preview-chunks`); the producer moves last, after an epoch of identical results.

---

## 1. Target architecture

```
<nodeDir>/
  db/immutable/                 NNNNN.chunk|primary|secondary   blocks ≥ k deep (cardano-node format)
  db/volatile/                  blocks-N.dat                     last k blocks and fork branches
  db/gerolamo/                  hash-index.bin, selected-tip.hex
  ledger/data.mdb, lock.mdb     LMDB environment: ledger state AT THE IMMUTABLE POINT
  ledger/meta.json              { anchor: {slot, hash}, k, network, formatVersion, nodeVersion }
  preview.explorer.db           mini-Blockfrost / explorer projection (SQLite, optional)
  config.json, topology.json, logs/
```

Two layers, one invariant:

- **Immutable layer (LMDB)** — the ledger state after applying every block up to and including
  the chunk store's tip (`meta.anchor`). Written only by `promote()`, in the same step that
  appends blocks to the chunk files, as one LMDB write transaction per promotion batch. Never
  written by block application directly.
- **Volatile layer (memory)** — one `LedgerDiff` per volatile block (at most k on the selected
  chain plus fork branches), holding every key the block created, deleted or changed per
  database together with the previous value. Reads consult the diffs along the selected chain
  newest-first, then LMDB. A fork switch drops the diffs above the intersection. A restart
  rebuilds the diffs by re-applying the volatile blocks from `db/volatile` through the rules
  (≤ k blocks: seconds on preview, about a minute on mainnet), which also re-validates them.

The epoch boundary is part of the diff of the epoch's first block. Rollbacks across a boundary
stop being special.

This is the shape of cardano-node's UTxO-HD (LMDB backend + in-memory diff sequence) applied
to the whole ledger state rather than the UTxO alone.

---

## 2. On-disk layout: LMDB databases, keys, values

One environment, named databases (`MDB_CREATE`), map size 64 GiB (virtual; cost is what is
used). All integers big-endian so key order is numeric order. Values are CBOR, using
cardano-ledger's own encodings wherever one exists (TxOut, PoolParams, PParams, GovAction,
Anchor, …) so node-to-client queries can serve stored bytes untouched and the snapshot importer
writes what it decodes.

| DB | Key | Value | Notes |
|---|---|---|---|
| `meta` | text | CBOR | `anchor` (slot ‖ hash), `k`, `network`, `formatVersion`, `epoch`, `protocolVersion`. |
| `utxo` | `txid(32) ‖ index(u16)` | TxOut CBOR (map form for Babbage+, legacy list otherwise), exactly the bytes from the block | 3.2 M entries preview, ~14 M mainnet. |
| `utxo_addr` | `paymentCred(29 max: header ‖ hash) ‖ txid ‖ index` | empty | Address → outputs; the producer's wallet, the API and `GetUTxOByAddress`. Byron addresses key by their address hash. |
| `utxo_meta` | `txid ‖ index` | `{ lovelace, stakeCred?, refScriptHash?, datumHash? }` CBOR | The columns the rules ask for without decoding the TxOut (stake-balance triggers, reference-script cache). Written with `utxo`. |
| `stake_bal` | `stakeCred(29)` | u64 lovelace | Sum of `utxo` at addresses with that stake credential; kept by the same diff as `utxo`. |
| `stake` | `stakeCred(29)` | `{ registeredAt, deposit, rewardAccount, delegatedPool?, drepDeleg?, pointer? }` CBOR | Registration + delegation + reward account, replaces `stake` + `delegations` + `stake_pointers` (pointer entries keyed separately in `pointer`). |
| `pointer` | `slot(u64) ‖ txIx(u32) ‖ certIx(u32)` | stakeCred | Byron/Shelley pointer addresses. |
| `reward` | `stakeCred` | u64 | Reward account balance (withdrawals debit). |
| `pool` | `poolId(28)` | PoolParams CBOR (the certificate's 9-field record) ‖ `{ registeredSlot, retiringEpoch? }` | Pending updates in `pool_pending` (`poolId` → PoolParams) promoted at the boundary. |
| `pool_vrf` | `poolId` | vrfKeyHash | Header leader checks. |
| `opcert` | `poolId` | `{ counter, kesPeriod }` | Operational certificate counters (bug 109 rule m ≤ n ≤ m+1). |
| `blocks_made` | `epoch(u32) ‖ poolId` | u32 | Performance for rewards. |
| `snap_mark`, `snap_set`, `snap_go` | `stakeCred` → `{ stake u64, pool }` ; `pool_total:poolId` → u64 ; `pool_params:poolId` → PoolParams ; `total` → u64 | Three snapshots; rotation = `mdb_drop(go)`, rename set→go, mark→set, take mark. (LMDB has no rename: keep three DBs and a `meta.snapshotOrder` triple.) |
| `pots` | `"pots"` | `{ reserves, treasury, fees, deposits, epochFees }` | One record. |
| `reward_pending` | `epoch(u32) ‖ stakeCred` | `{ amount, poolId, kind }` | Queued at boundary e, paid at e+1. |
| `reward_epoch` | `epoch` | `{ rewardPot, treasuryCut, R, activeStake, blocks, perPool: [...] }` | Reports and the `/rewards` API. |
| `params` | `epoch(u32)` | PParams CBOR (Conway record from PLAN_CHUNK_STORE phase-3 `pparamsCbor.ts` for Conway; Shelley→Babbage list encodings per era) ‖ raw JSON for the rules | Body validation reads per epoch. |
| `pparam_prop` | `epoch ‖ genesisKeyHash` | update map CBOR | Shelley→Babbage PPUP. |
| `nonce` | `epoch(u32)` | `{ eta0, etaV, etaC, etaH, freezeSlot }` | Evolving / candidate / frozen nonces. |
| `gov_prop` | `txid ‖ index` | `{ action CBOR, deposit, returnAcct, anchor, proposedIn, expiresAfter, ratifiedIn?, enactedIn?, droppedIn? }` | |
| `gov_vote` | `txid ‖ index ‖ voterKind(u8) ‖ voterCred` | `{ vote, anchor?, epoch }` | |
| `drep` | `drepCred` | `{ registeredAt, deposit, anchor?, expiry, lastActive }` | |
| `drep_deleg` | `stakeCred` | drepCred or `abstain`/`no-confidence` sentinel | (also mirrored in `stake.drepDeleg` for the per-account view). |
| `drep_stake` | `epoch ‖ drepCred` | u64 | DRep stake snapshot for tallies. |
| `committee` | `coldCred` | `{ hotCred?, expiry, resigned? }` | |
| `gov_enacted` | `"constitution"`, `"committee"`, `"pparams"`, `"hardfork"`, `"withdrawals:<epoch>"` | CBOR | Enacted state and prev-action ids per purpose. |
| `gov_state` | `"pulser"`, `"ratifyQueue"` | CBOR | Boundary bookkeeping. |
| `genesis_deleg`, `genesis_utxo_stats`, `mir_pending` | as today | CBOR | Small. |

Composite `stake` replaces three SQLite tables because the certificate rules read them
together; the reward and DRep delegation live beside it to keep "one credential, one read".

---

## 3. The store API

`src/ledger/LedgerStore.ts` (all reads answer diffs-then-LMDB along the selected chain):

```ts
type Db = "utxo" | "utxo_addr" | "utxo_meta" | "stake_bal" | "stake" | … ;

interface LedgerStore {
  // block lifecycle (called by the orchestrator around applyBlock)
  beginBlock(hash: Uint8Array, prevHash: Uint8Array | null, slot: number): void;  // opens the block's diff
  commitBlock(): void;                                                             // seals it
  abortBlock(): void;                                                              // drops it (failed range)
  // reads (inside or outside a block)
  get(db: Db, key: Uint8Array): Uint8Array | undefined;
  has(db: Db, key: Uint8Array): boolean;
  range(db: Db, prefix: Uint8Array, opts?: { limit?: number; after?: Uint8Array }): Iterable<[Uint8Array, Uint8Array]>;
  // writes (only inside a block)
  put(db: Db, key: Uint8Array, value: Uint8Array): void;
  del(db: Db, key: Uint8Array): void;
  addU64(db: Db, key: Uint8Array, delta: bigint): void;      // stake_bal, reward, pots, blocks_made
  // chain management (called by the orchestrator / block store)
  selectTip(hash: Uint8Array): void;                          // which volatile branch reads follow
  rollbackTo(hash: Uint8Array): number;                       // drop diffs above the block; returns dropped count
  promote(hashes: Uint8Array[]): Promise<void>;               // apply those diffs to LMDB in one txn, advance meta.anchor
  snapshot(): LedgerView;                                     // frozen read view (queries, API, producer)
  anchor(): { slot: number; hash: Uint8Array };
}
```

`LedgerDiff` (`src/ledger/LedgerDiff.ts`): `Map<Db, Map<keyHex, { before?: Uint8Array; after?: Uint8Array }>>`
plus `adds: Map<Db, Map<keyHex, bigint>>` for counters. Two blocks' diffs compose; `range()`
merges LMDB's cursor with the diffs' sorted keys (deleted keys masked). `before` is captured on
first touch so `promote` can also verify against LMDB (`before` must equal the stored value —
a cheap consistency check on every promotion).

`src/ledger/lmdb.ts`: the FFI binding, grown from `scripts/lmdb-ffi.ts` (read-only cursor
iterator, tested against a cardano-node LMDB snapshot) with `mdb_env_create/open/set_mapsize/
set_maxdbs`, `mdb_dbi_open`, `mdb_txn_begin/commit/abort`, `mdb_get/put/del`, `mdb_cursor_*`,
`MDB_NOTLS`, write transactions serialised by a mutex on our side. Values are copied out of the
map on read (Bun `toArrayBuffer` over the pointer, then `slice`) so no reference outlives its txn.

Thread model: block application runs on the main thread; the validation worker pool only needs
UTxO reads for script contexts — it already receives resolved inputs from the main thread, so
workers do not open the environment.

---

## 4. Write path: what a block does to the store

`applyBlock` (`BlockApplication.ts`) keeps its structure; the SQLite calls it makes today map
one to one:

| Today (db.ts / leaderState.ts / governance/state.ts) | Store operations |
|---|---|
| `applyTransaction`: `deleteBlockSpends`, `buildUtxoRowForOutput`, `flushPendingUtxoWrites`, stake-balance triggers | For each input: `del(utxo)`, `del(utxo_addr)`, `del(utxo_meta)`, `addU64(stake_bal, −lovelace)`. For each output: `put(utxo, TxOut bytes)`, `put(utxo_addr)`, `put(utxo_meta)`, `addU64(stake_bal, +lovelace)`. Fee: `addU64(pots.fees)`. |
| `applyCertificates` → `recordPoolRegistration`, `recordPoolRetirement`, stake registration/deregistration/delegation, `recordDRep*`, `recordVoteDelegation`, `recordCommitteeHot/Resign`, `setOpcertCounter` | `put/del` on `stake`, `pool`/`pool_pending`, `pool_vrf`, `drep`, `drep_deleg`, `committee`; deposits into `pots.deposits`. |
| `applyWithdrawals` | `addU64(reward, −amount)`. |
| `recordProposals`, `recordVotes` | `put(gov_prop)`, `put(gov_vote)`, deposit into `pots.deposits`. |
| `noteBlockMade` (header) | `addU64(blocks_made, epoch ‖ pool, 1)`. |
| `addFeeToPot`, `addDonationToPot` | `addU64(pots)`. |
| Nonce evolution (`storeEpochNonce*`) | `put(nonce, epoch)` at the freeze slot and boundary. |

Rules' reads (`getUtxosByRefs`, `getUtxoByRef`, `rulesQueries.getUtxoRowsByRefs`,
`registeredPools`, `rewardBalancesFor`, `getStakeByCredentials`, `poolParamsAt`,
`opcertCounter`, `registeredPoolVrf`, `activeDRepCredentials`, `readEpochParamsRaw`,
`getEpochNonce`) become `store.get/range` wrappers with the same signatures in
`src/ledger/reads.ts`, so `txRules.ts`, `certificateRules.ts`, `leaderCheck.ts` and the
validators change only their import.

### Epoch boundary as a diff

`onEpochStart(e)` keeps its order, each step now a store operation inside the first block's diff:
`applyPendingMir`, `promotePendingPoolParams`, `retirePoolsAtEpoch` + `refundPoolDeposits`,
`takeStakeSnapshot` (rotate mark/set/go, write the new mark from `stake` + `stake_bal` +
`reward` + `pool`), `runEpochRewards` (pure `rewards.ts` over `snap_go`, `blocks_made`, `pots`,
`params[e−1]` → `reward_pending[e+1]`, `pots` updated, `reward_epoch[e]`), `payPendingRewards`
(`reward_pending[e]` → `reward`), `deriveLocalParams` (PPUP quorum or Conway enactment →
`params[e]`), `governanceBoundary` (`takeDRepStakeSnapshot`, `ratifyAndEnact`, expiries),
nonce freeze/rollover.

The boundary diff is large (a full stake snapshot: 240 k credentials on preview, ~1.3 M on
mainnet) — held in memory like any diff and written to LMDB when that block promotes. To keep
the volatile memory bounded the snapshot diff stores the *changes* against the previous mark
(most credentials' stake does not change between epochs); `takeStakeSnapshot` writes only
differing entries plus a `snap_meta` record. Measured target: mainnet boundary diff < 300 MB.

### Restart

On start: open LMDB, read `meta.anchor`; it must equal the chunk store's tip (else refuse: the
two stores were not written together — repair = re-import from a snapshot). Then replay the
volatile files on the selected chain (`db/gerolamo/selected-tip.hex`) through `applyBlock`
with full validation, rebuilding the diffs; blocks that fail validation are a dead branch and are
dropped. Time bound: k blocks.

### Promotion

`BlockStore.promote(tipHash, k)` becomes `promoteChain(tipHash, k)` in a new
`src/storage/ChainPromoter.ts`: for the blocks more than k deep on the selected chain, in
order: (1) `chunks.append(block)`, (2) `ledger.promote([hash])`, (3) `meta.anchor = block`.
One LMDB txn per promotion batch (`MDB_NOSYNC` off: the commit fsyncs). Crash between (1) and
(2): on restart the chunk tip is one block ahead of the anchor → the store re-applies that block
from the chunk file into LMDB (its diff is rebuilt by replay from the chunk bytes) — the only
repair rule, and it is tested.

---

## 5. Snapshot bootstrap into LMDB

`mithril-bootstrap --block-store <nodeDir>/db --ledger-state --ledger <nodeDir>/ledger`:

1. chunks in place, trimmed to the state's block, tip pinned (as today);
2. `importUtxo.ts` streams the `tables` file (3.2 M entries in 5 min today into SQLite) into
   `utxo`/`utxo_addr`/`utxo_meta`/`stake_bal`, one LMDB txn per 50 000 entries, sorted by key
   within a txn (`MDB_APPEND` where the input is already sorted, else plain put);
3. `importState.ts` writes the decoded NewEpochState: stake and pools, the three snapshots,
   pots, pending rewards, params (as CBOR), nonces, governance;
4. `meta.anchor = state block`; the SQLite ledger tables are not created.

Acceptance: the imported LMDB state, read back through `snapshot()`, matches the SQLite import
of the same snapshot field by field (a one-off comparison script, `scripts/ledger-compare.ts`,
which also serves phase gates below: it hashes every database's key/value stream and per-table
row streams from SQLite in the same canonical form).

---

## 6. Node-to-client, API, producer

- `LocalStateQueryHost` reads through `snapshot()`: `GetUTxOByAddress` = `range(utxo_addr,
  cred)` + `get(utxo)`; `GetUTxOByTxIn` = `get(utxo)`; `GetCurrentPParams` = `get(params,
  epoch)` served byte for byte; `GetStakePools` = keys of `pool`; `GetStakePoolParams` = values
  of `pool`; `GetStakeDistribution` = `snap_mark` totals; `GetGovState` / `GetConstitution` from
  `gov_enacted`/`gov_prop`. The relay cardano-node stays the oracle for byte equality.
- Mini-Blockfrost: history endpoints from `preview.explorer.db`; ledger endpoints (`/addresses/
  {addr}/utxos`, `/pools/{id}`, `/epochs/{n}/parameters`, `/accounts/{stake}`) from `snapshot()`.
- Producer: tip from the block store (unchanged); nonce from `nonce`; schedule from `snap_go`
  and `pool`; greeting wallet from `utxo_addr`. `forge-dry-run.ts` opens the environment
  read-only (`MDB_RDONLY`, no lock contention with the node).

---

## 7. Modes and verification

`ledgerStore: "sqlite" | "lmdb" | "dual"` (config; env `GEROLAMO_LEDGER_STORE` wins).

- `sqlite`: today's path (kept through phase 3 for comparison, removed in phase 4).
- `lmdb`: the store above.
- `dual`: both are written from the same `applyBlock` run; after every block (and every
  boundary) the two are compared on the touched keys, and every 1 000 blocks on a full
  canonical hash per database/table. Any difference halts with both values logged. This is the
  primary acceptance instrument of phases 1–3 and runs on node 3036 for at least one full
  epoch per phase.

---

## 8. Phases, files, tests

### Phase 1 — binding, UTxO store, dual mode for the UTxO (4 days)

Files: `src/ledger/lmdb.ts` (+ `lmdb.test.ts`: env, DBs, txns, cursors, 1 M put/get/range,
crash-abort), `src/ledger/LedgerDiff.ts` (+ test: compose, mask, before-capture, range merge),
`src/ledger/LedgerStore.ts` (+ test: beginBlock/commit/abort, rollbackTo, promote with before-
check, selectTip across a same-slot fork), `src/ledger/reads.ts` (UTxO readers with today's
signatures), `src/ledger/encodings.ts` (keys; TxOut bytes slicing from the block — reuse
`buildUtxoRowForOutput`'s metadata extraction for `utxo_meta`), `src/storage/ChainPromoter.ts`,
`src/mithril/importUtxo.ts` (LMDB target), `scripts/ledger-compare.ts` (UTxO part).
Changes: `BlockApplication.ts` UTxO section behind the store; `db.ts` UTxO readers route to the
store in `lmdb`/`dual` mode (same pattern as `primaryBlockStore()`); `peerManager.ts` opens the
store; `ConsensusOrchestratooor.ts` calls `beginBlock/commitBlock/abortBlock` around each block
and `rollbackTo` in `rollbackOurChainTo`.
Gate: node 3036 in `dual` for one epoch with zero UTxO differences; restart replay of k blocks
< 60 s; a fresh directory imported into LMDB matches the SQLite import.

### Phase 2 — stake, pools, snapshots, rewards, pots (5 days)

Files: `src/ledger/reads.ts` (stake/pool/opcert/pots readers), `leaderState.ts` split: the
pure computations stay, the 90 SQL statements become store operations in
`src/ledger/stakeWrites.ts`; `epochRewards.ts` unchanged (pure) with a store-backed
`buildRewardInputs`; `takeStakeSnapshot` as a change-set; `importState.ts` (LMDB target for these
groups); `scripts/ledger-compare.ts` extended (stake, pools, snapshots, pots, rewards).
Gate: two epoch boundaries in `dual` with identical snapshots, reward pots, per-account
rewards and pool retirements; boundary diff size measured and under budget.

### Phase 3 — parameters, nonces, governance (4 days)

Files: `src/ledger/govWrites.ts` from `governance/state.ts` (64 statements; `tally.ts` stays
pure), `pparams.ts` / `epochParams.ts` readers and writers, nonce storage, `importState.ts`
(governance groups), compare script extended (all groups). PParams written as CBOR via
`pparamsCbor.ts` (Conway) and per-era encoders for older epochs.
Gate: a Conway epoch with proposals, votes, a DRep expiry and an enactment identical in `dual`;
`cardano-cli query protocol-parameters` byte-identical to the relay's from the LMDB path.

### Phase 4 — importer, node-to-client, cut-over (3 days)

`mithril-bootstrap` LMDB target end to end; `LocalStateQueryHost` over `snapshot()` including
GetStakeDistribution / GetStakePoolParams / GetGovState (oracle: relay cardano-node);
mini-Blockfrost ledger endpoints over `snapshot()`; `ledgerStore: "lmdb"` default; SQLite
ledger tables no longer created; `preview.explorer.db` the only SQLite file; stats page shows
the LMDB anchor, diff count and map usage.
Gate: fresh preview node from snapshot to tip in LMDB mode; node 3036 on `lmdb` for a week;
the producer switched after its next leader slots with `forge-dry-run.ts` against LMDB first.

### Phase 5 — mainnet (2 days)

Mainnet data node from a Mithril snapshot in block-store + LMDB mode; hold the tip a day;
record apply time per block, boundary time and RSS; tune map size and txn batch.

Total: eighteen working days, sequential, with the producer switch as the last step of phase 4.

---

## 9. Cut-over runbook (per node)

1. Node at tip on `sqlite`; stop it (supervisor + node).
2. `mithril-bootstrap --skip-download --block-store db --ledger ledger --ledger-state` with the
   current snapshot **or** `scripts/ledger-export.ts` (phase 4 tool: SQLite ledger → LMDB at the
   node's current tip, which avoids re-syncing from the snapshot slot). Verify with
   `ledger-compare.ts`.
3. Config `ledgerStore: "lmdb"`; start; watch: anchor == chunk tip, volatile replay time, tip
   tracking the relay, boundary lines at the next epoch.
4. After a clean epoch: delete the SQLite ledger file (the explorer database is separate).
5. Producer only after 3036 and the fresh node have done 1–4 and the forge dry run passes.

Rollback plan: the SQLite ledger file is kept until step 4; switching `ledgerStore` back and
restarting returns to the previous path (the block store is shared and unaffected).

---

## 10. Risks and open decisions

- **Restart replay cost on mainnet** (k = 2 160 dense blocks): ~1 minute of full validation. If
  measured worse, persist the diffs (`ledger/volatile-diffs.mdb`, one record per block) so a
  restart loads instead of replaying; the design allows either.
- **Boundary diff memory on mainnet**: change-set snapshots keep it small; measured in phase 2.
- **Byron era**: the LMDB path is used from the snapshot slot onwards; genesis replays stay a
  SQLite-mode tool until Byron/Shelley writes are moved in a later step (they are the same
  functions, fewer of them).
- **Explorer worker** reads ledger facts (stake keys of outputs) — it will read `snapshot()`
  instead of SQLite; owned by the explorer plan.
- **cardano-node LMDB compatibility**: our layout is our own (the node's UTxO-HD LMDB backend
  stores TxIn → TxOut with a different key scheme, and the Mithril snapshots we use are the
  in-memory flavor). Compatibility with the node's `--utxo-hd-flavor LMDB` files is a possible
  later extra, not a goal.
- **Open**: whether `utxo_meta` is worth its space versus decoding the TxOut on demand (decide
  in phase 1 from the applier profile); whether `reward` merges into `stake` (one read per
  credential) — leaning yes.

## Status

### 2026-09-16 04:00 UTC — phase 1 built, dual mode deploying on node 3036

- `src/ledger/lmdb.ts`: Bun FFI binding over liblmdb (env, named DBs, read/write txns, get/put/del,
  cursor ranges forward and reverse, counts, clear; write txns serialised; values copied out).
  Measured in tests: 2 µs per put inside one transaction, 2.4 µs per get.
- `LedgerDiff.ts` / `LedgerStore.ts`: per-block diffs with before-images and u64 counter deltas;
  reads walk the selected chain's diffs then LMDB; `range` merges LMDB cursors with diff
  overlays; `promote` writes diffs in one txn and refuses when a before-image no longer matches
  the stored value; `rollbackTo`, `selectTip`, `snapshot()` view, `meta.anchor`.
- `utxoStore.ts`: the UTxO group — `utxo` (txid ‖ index → record with the same fields as the
  SQLite row, tx_out JSON included), `utxo_addr`, `utxo_rs`, `stake_bal` counters, `utxo_stats`.
- `nodeLedgerStore.ts`: `ledgerStore: sqlite | dual | lmdb`; open + seed from SQLite at the
  selected tip when the environment is empty; block hooks (begin at `setApplyBlock`, commit after
  the block row, abort on a failed range, promote k deep after each range, rollback to the block
  at the rollback slot); dual verifier comparing every touched reference after each range, halting
  the sync on a difference. Writes hooked in `upsertUtxoRow` / `deleteBlockSpends`; reads routed
  in `lmdb` mode (`getUtxoRowsByRefs`, `getUtxoByRef`, `getUtxosByTxHash`, `getUtxoCount`,
  `countUtxosWithReferenceScript`).
- Tests: `bun test src/ledger` (4 files) plus the storage suite. Node 3036 switched to `dual` at
  04:00 UTC (seeding 3.2 M UTxOs into LMDB at startup).
- Chunk store phase 5 done in parallel: the producer runs `blockStoreMode: primary` and serves
  peers from chunks since 03:44 UTC (forge dry run from the store passes); its frozen block tables
  are being emptied and vacuumed.

### 2026-09-16 04:40 UTC — phases 2 and 3 built; node 3036 in dual mode over every ledger group

- **Restart handling (phase 1 gate):** volatile diffs are persisted as `ledger/diffs/<hash>.diff`
  (binary, written at `commitBlock`, removed at promotion or rollback). On open the diffs are
  loaded and the selected tip must reach the anchor through them; a torn file is discarded. A store
  that cannot reach the tip (crash between the SQLite commit and the diff file) or was seeded by an
  older seed version is rebuilt from SQLite in `dual` mode (about 2 min on preview) and refused in
  `lmdb` mode. Since bug 245 (2026-09-30): diff files carry a length + CRC-32 trailer and are
  written temp → fsync → rename (an incomplete file is absent, a leftover `.tmp` is swept); a diff
  of a block at or below the anchor (a promotion whose unlink was lost in the crash) is ignored and
  removed; in `lmdb` mode the node lands on the newest block of the block store's chain whose diffs
  reach the anchor (`LedgerStore.recoveryTip`, the block store's immutable tip as the last
  candidate) and the block store's tip follows — refused only when no block of that chain does.
- **Phase 2 — `src/ledger/stakeStore.ts`:** `stake`, `deleg`, `pointer`, `reward` (counter),
  `pool`, `pool_pending`, `pool_relays`, `opcert`, `blocks_made` (counter), `gdeleg`, `mir`,
  `pots` (counters), the three-plus-one snapshots (`snap_cred`, `snap_pool`, `snap_pparams`,
  `snap_totals`), `pending_rew`, `reward_epochs`, `reward_payouts`, `reward_pool_epochs`,
  `pot_snap`. `takeStakeSnapshot` and `retirePoolsAtEpoch` are computed from the store's own state
  (the dual-run compares the result with SQLite's). Every write in `db/leaderState.ts`,
  `db.ts` (`applyCertificates`, `applyWithdrawals`) and `consensus/epochRewards.ts` is mirrored;
  every read routes to the store in `lmdb` mode. The block's diff now opens *before* the epoch
  boundary work, so the transition belongs to the epoch's first block (§1).
- **Phase 3 — `src/ledger/govStore.ts`:** `gov_dreps`, `gov_drep_deleg`, `gov_committee`,
  `gov_cc_auth`, `gov_state`, `gov_proposals`, `gov_votes`, `gov_enacted`, `drep_stake`,
  `epoch_params`, `pparam_props`, `nonces`; `governance/state.ts`, `epochParams.ts`,
  `pparams.ts` and the nonce functions of `db.ts` mirror writes and route reads. Nonce and
  parameter writes that happen outside a block (header-driven evolution, startup repair) go
  straight to LMDB (`ledgerGovDirect`): derived state the chain recomputes after a rollback.
- **Verification:** `stakeVerify.ts` / `govVerify.ts` compare every key a range's diffs touched
  with the SQLite rows after the range commits (a touched snapshot total compares the whole
  snapshot); `scripts/ledger-compare.ts <nodeDir>` compares all 36 tables of a node read-only.
  After the phase 2 seed on 3036: all 23 tables matched (UTxO 3 171 557 rows sampled 100 k,
  278 086 stake balances, 111 094 registrations, 80 429 delegations, 319 046 snapshot rows).
- **Stats:** `/stats` carries `ledgerStore` (mode, anchor slot, volatile diffs, dual-run counts);
  the stats page shows it under the block store line. Seed version 3.
- **Not done (needs chain time):** the `dual` gate of one epoch boundary with identical
  snapshots, rewards and pots (next boundary: epoch 1423 at 2026-09-17 00:00 UTC); `lmdb` mode
  on 3036 after that; SQLite ledger writes are still performed in `lmdb` mode (removal is the
  phase 4 cut-over); mini-Blockfrost / explorer ledger endpoints still read SQLite; the snapshot
  importer writes SQLite and the store seeds itself from it at the first start.
- 04:38 UTC: phase 3 seed on 3036 (3 171 613 UTxO, 610 861 stake/pool/reward, 96 522 governance/
  parameter/nonce rows, 150 s); `ledger-compare.ts` over all 36 tables: all match; dual-run 95 keys
  over 4 blocks, 0 differences; `bun test src`: 820 pass (one cardano-cli keystore interop test
  times out under full-suite load and passes alone).
- **Bug 125 (found by the dual run, 06:43 UTC, fixed 16:45 UTC):** a 1-block rollback "to slot
  122885007" (tip slot − 1, an empty slot) looked the block up by slot, found none and called
  `rollbackTo(null)`, which dropped every volatile diff; the store silently fell back to the
  anchor state and the next block's verification showed the fee pot 273 ADA short and two pools'
  block counts behind. Fixes: `LedgerStore.rollbackToSlot(slot)` walks the store's own selected
  chain to the newest block at or below the slot (like the SQLite rollback), `rollbackTo(hash)`
  refuses an unknown target, an aborted range drops exactly the diffs it committed, and after
  every range the tip must reach the anchor through the diffs or the sync halts with the reason.
  3036 rebuilt from SQLite and resumed dual mode.
- 16:39 UTC: after the rebuild 3036 re-applied the 10 hours it had missed while halted (1 108
  blocks in 4 min) in dual mode: 17 485 keys compared, 0 differences; the first k-deep promotions
  ran live — anchor advanced from 122 885 032 to 122 906 404 with exactly 432 volatile diffs kept.

### 2026-09-18 16:30 UTC — after the epoch 1423 boundary

- The 1423 boundary passed the dual run (80 497 keys over 5 066 blocks, 0 differences: snapshot,
  reward update, pots, governance tallies identical), but promotion had stalled (bug 126, nonce
  before-image) and the node later halted on a consensus bug (127, slot battle at 123 032 202).
- A dual-mode store seeded at SQLite's tip anchors on a *volatile* block; when that block was
  rolled back the anchor could not be rolled back with it. Dual mode now rebuilds the store from
  SQLite (about 70 s) whenever it becomes unusable — a rollback below the seed point, a refused
  promotion, a chain that no longer reaches the anchor — instead of halting; `lmdb` mode still
  halts, since there SQLite is not the reference. Seed version 4.
- 16:30 UTC: 3036 rebuilt (72 s), re-applied 1 784 blocks in dual mode with 0 differences over
  18 011 keys and reached the producer's tip 123 093 013; promotion works again (anchor
  123 081 466, exactly 432 diffs).

### 2026-09-20 06:50 UTC — 3036 switched to `lmdb` mode

- Dual mode ran clean through the 1425 and 1426 boundaries (148 665 keys over 6 543 blocks, 0
  differences). A chain-derived cross-check (blocks per pool in epoch 1426 counted from the block
  chain itself: 826) matched both SQLite and LMDB exactly; the compare script's occasional
  one-block skews against a live node are read timing (its SQLite snapshot and the diff files it
  loads are not taken at the same instant), not divergence.
- Bug 127 fixed and deployed to both nodes (range dedupe no longer treats a skipped block below
  the tip as the tip; a same-slot competing header counts as a fork below the tip).
- 3036 now runs `ledgerStore: "lmdb"`: every ledger read (UTxO, stake, pools, rewards, pots,
  snapshots, governance, parameters, nonces, node-to-client UTxO/pool queries) is answered by the
  store; SQLite ledger tables are still written (phase 4 removes that). A broken store halts the
  node in this mode instead of rebuilding.
- 07:15 UTC: producer 3035 on `dual` (seed 244 s: 3.19 M UTxO, 9.9 M stake/reward rows — its
  genesis-synced SQLite keeps every epoch's reward payouts and DRep stake; LMDB 3.8 GB). Forge dry
  run with `GEROLAMO_LEDGER_STORE=lmdb` (new `attachReadOnlyLedgerStore`): VRF / leader / KES /
  opcert PASS from the LMDB snapshot, pool set and nonce. Producer switch to `lmdb` after today's
  15:19 UTC slot and the 1427 boundary.

### 2026-09-20 07:40 UTC — phase 4 cut-over switch

- `GEROLAMO_LEDGER_SQL_WRITES=0` (only honoured in `lmdb` mode) stops every SQLite ledger write:
  UTxO rows and deltas, stake / delegation / pointer rows, withdrawals, pools, rewards, pots,
  snapshots, reports, MIR, opcerts, blocks made, genesis delegations, governance, parameters,
  update proposals and nonces (`sqlLedgerWrites()` guards in db.ts, leaderState.ts,
  governance/state.ts, epochParams.ts, pparams.ts). The strict spend check then counts the
  store's own deletions. All remaining SQLite ledger reads outside the routed modules (producer
  wallet UTxOs, mempool input check, leader-check pool parameters, UTxO by address, reference
  scripts, spent-row loader, collateral) route through the store in `lmdb` mode.
- Deployed on 3036 (lmdb + writes off). With the switch on, the SQLite file holds only the
  frozen ledger tables plus the mini-Blockfrost projection; `preview.explorer.db` separation
  and dropping the frozen tables are the remaining phase 4 steps.
- 07:35 UTC: 3036 confirmed on lmdb + `GEROLAMO_LEDGER_SQL_WRITES=0`: SQLite `utxo` count and
  ledger journal frozen while the node applies blocks from the store alone; address UTxOs, epoch
  parameters and the block/tx endpoints answer from LMDB. `/epochs/latest/parameters` now serves
  the node's own record (the Koios live fetch tried to write inside a read-only connection).

### 2026-09-21 17:05 UTC — bug 128 fixed; 3036 re-applied a day of blocks on LMDB alone

- 3036 (lmdb, SQLite writes off) had halted 2026-09-20 16:45 UTC on bug 128 (aborted range after a
  rollback). With the fix it re-applied slots 123 266 740 → 123 354 394 (24 h of chain, ~4 400
  blocks incl. the 1427 boundary) from the store alone and sits at the producer's tip; anchors of
  both nodes equal (123 342 894). Producer (dual): 43 004 keys, 0 differences across the 1427
  boundary; 5 leader slots in epoch 1428 (04:59 … 18:34 UTC).
- 17:47 UTC: report-history retention (`GEROLAMO_LEDGER_KEEP_EPOCHS`, default 30): reward
  payouts, pool reward reports, blocks made, per-pool snapshot stake and DRep stake below the
  window are pruned at seed, at open and at each boundary, one epoch slice per LMDB transaction
  via raw cursors (the first version walked the overlay-merging `range` and hit 16.8 GB RSS —
  supervisor restart loop for 10 min). Producer: 10 620 290 keys pruned in 108 s, RSS 2.6 GB.
  docs/RUNBOOK_PREPROD_NODE.md written for the user's new server.

### 2026-09-22 05:05 UTC — reboot outage, bug 129, direct LMDB importer

- The laptop rebooted 2026-09-21 17:51 UTC; the supervisors are plain processes and stayed down
  10.5 h. Producer relaunched 04:22, re-applied the 1428 boundary (513 s, 75 789 reward
  accounts in dual mode), reached the tip 04:42, recomputed 6 leader slots. 00:53 slot missed
  (down); 04:59 slot forged but orphaned — no inbound peer was pulling yet. 3036 hit bug 129
  (block store and ledger store on different last blocks after the crash; fixed: persisted tip
  first in lmdb mode, newest-common-block fallback moves the block store's tip).
- Direct LMDB importer written: `mithril-bootstrap … --ledger-state --ledger <nodeDir>/ledger`
  imports the UTxO set and the NewEpochState into the store (`src/mithril/importLmdb.ts`,
  anchored at the snapshot block, seed version stamped); SQLite gets no ledger tables. The
  equivalence test against the SQLite importer on the 2026-09-09 preview snapshot is still to be
  run (the first attempt was interrupted by the producer's catch-up).
- 22:50 UTC: direct LMDB importer verified against the SQLite importer on the 2026-09-09 preview
  snapshot (epoch 1415, slot 122 316 253): UTxO 3 167 873 rows in 218 s into LMDB (SQLite path
  320 s), state 4.1 s; every one of the 36 tables identical. The one "difference" was the compare
  script reading a 2.27e16-lovelace faucet output through bun:sqlite as a JS number (2^53
  rounding) — fixed with CAST AS TEXT; the LMDB record was exact. Bug 130 (tracker kept a
  replaced block "confirmed") fixed; both nodes at the tip, producer's remaining 1428 slots all
  forged and on chain.
