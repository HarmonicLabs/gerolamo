# PLAN: 10× genesis sync without trading away consensus or security

Date: 2026-09-03. Status: **design, slices 1–4 implemented (see §10)**. Written
after tracing the from-genesis sync path in `master` @ `847902a` (network,
consensus, storage). Line numbers refer to that commit. Companion docs:
`SYNC_PIPELINE_RESEARCH.md` (Dolos / Dingo / cardano-node comparison, Round 1
results) and `PLAN_MULTI_PEER_SYNC.md` (3-hot-peer design rationale).

The three ideas this document works out:

1. Keep a validated header fragment up to **k** headers ahead of the applier.
2. Keep on the order of **100+ block bodies** downloaded ahead of the applier,
   across all hot peers.
3. With that lookahead, **validate transactions in parallel** across cores,
   and commit ledger deltas in ordered batches.

The short version: 1 and 2 are correct and safe, and they are already half
built. Neither is the order-of-magnitude lever on its own; the measured caps
are elsewhere. They are the *precondition* for 3, and 3 together with the
storage changes in §6 is where 10× comes from. §2 is the part to read first if
you only read one section: the node today verifies less than its docs claim,
so "without sacrificing security" must be measured against the cost of the
validation we *should* be doing, not the validation we do.

---

## 1. What runs today during a from-genesis sync

`NETWORK=mainnet`, empty DB, `syncFromGenesis: true`. Everything below is on
the path of every header or every block.

### 1.1 Peers and ChainSync

- The governor promotes up to `peerGovernor.targetHot` (3) peers, one per
  15 s tick, sequentially (`src/network/peerManager.ts:652-657`). Every hot
  peer runs its own ChainSync; the first is `primary`, the others
  `verifier` (`src/consensus/ConsensusOrchestratooor.ts:576-581`).
- Genesis mode: `FindIntersect([])` leaves the producer read-pointer at
  origin and `RequestNext` streams from the first block
  (`src/network/PeerClient.ts:348-387`, `src/network/chainSyncStart.ts`).
- `RequestNext` is pipelined to `blockFetchBatch.pipelineDepth` (32) per peer
  (`src/network/ChainSyncPipeline.ts:38-45`).
- Headers are gathered into batches of `blockFetchBatch.maxBlocks` (32) by
  `RollForwardBatcher` and handed to the orchestrator. **`maxBlocks` is the
  header batch size, and that batch becomes the BlockFetch range size**; the
  BlockFetch layer does not size ranges itself (`PeerClient.ts:443-464`).

### 1.2 Header stage (`processRollForwardBatch`, orchestrator `:746-826`)

Per batch, in order:

| step | where | thread |
|---|---|---|
| parse: hex → `ChainSyncRollForward.fromCbor` → re-encode → lazy parse → era header decode → blake2b | `src/consensus/blockHeaderParser.ts:221-311` | main, `await` per header |
| epoch nonce lookup (memoised; SQLite, then Blockfrost on miss) | orchestrator `:352-388` | main, `await` per header |
| KES / op-cert / (nominal) VRF | `ValidationPool.validateAll` → `src/consensus/workers/` | worker pool, all cores |
| Byron OBFT signature + delegation + k-window | `src/consensus/byron/ByronOBFT.ts:130` | main |
| accept: dedupe LRU + `getBlockByHash`, contiguity, submit range | orchestrator `:887-978` | main, `await` per header |

Facts that matter for the plan:

- The header is parsed **twice**: on the main thread (`:768`) and again inside
  the worker (`src/consensus/workers/validationJob.ts:41`). Only the worker's
  boolean is used.
- Every hot peer's batches, including the verifiers', are serialised on one
  promise chain (`:561-571`). Verifier header work sits on the primary's
  critical path.
- With `logs.logLevel: "DEBUG"` in the mainnet config, there is an info log
  with an object payload per parsed header (`blockHeaderParser.ts:307-311`)
  which goes through `JSON.parse(JSON.stringify(...))` before being queued.

### 1.3 BlockFetch (`RangeScheduler`)

- `maxInFlight = blockFetchBatch.parallelRanges` (3); one range per
  connection (`busyPeers`, `src/consensus/RangeScheduler.ts:88,197`);
  `awaitingApply + inFlight < 3 × maxInFlight` (`:177-181`).
- A range may only go to a verifier that `agreesThrough(endSlot)`
  (`orchestrator :696-705`, `src/consensus/CandidateSet.ts:292-298`). During
  a genesis catch-up the verifiers are seldom matched that far, so the
  eligible set is usually just the primary. **`parallelRanges: 3` collapses to
  one range in flight on one socket.**
- Each fetched range is verified on the main thread, synchronously:
  header identity (lazy parse + blake2b) and full body-hash recompute
  (`:722-744`, `src/consensus/bodyHash.ts:237-257`).

### 1.4 Apply (`applyRange`, orchestrator `:980-1104`)

Strictly ordered, one range then one block at a time, `await` on almost every
line:

1. `blockParser`: `Cbor.parseLazy` (result unused) + `MultiEraBlock.fromCbor`
   full decode (`blockHeaderParser.ts:327+`).
2. `headerIdentityOfBlock` again (second time for this block).
3. `isAlreadyApplied`: LRU miss for any new block, so one `SELECT` per block.
4. `getEpochBodyParams`: memory cache, one DB read per epoch.
5. `validateBlock` → `BlockBodyValidator` (§2.2).
6. `applyBlock` → `applyTransaction` per tx (§1.5).
7. `feedNonceEvolver`, which **persists ηv/ηc with an upsert on every
   Shelley+ block** (`:303-317`).
8. Two CBOR re-encodes of bytes we already hold: `block.toCborBytes()` and
   `blockMessage.toCborBytes()` (`:1068-1069`), both stored.
9. `insertBlockBatchVolatile` + `insertHeaderBatchVolatile`, each called with
   **exactly one record** (the batch maps are cleared per iteration,
   `:1073-1077`), each row-by-row without a transaction, each followed by an
   info log (`src/db.ts:652-663`, `:696-722`).
10. `gcVolatile` every 2048 blocks.

The block CBOR is decoded four times (body hash, range verify, `blockParser`,
identity again) and re-encoded twice before it reaches SQLite.

### 1.5 Storage per transaction (`src/db.ts:1199-1422`, `applyMbTx`)

Roughly `3·inputs + 3·outputs + 2·addresses + 8` statements per tx, all
awaited serially, **each an implicit autocommit transaction**. The live path
never opens `sql.begin()`; the comments explain why (`db.ts:653`,
orchestrator `:185-190`: concurrent handlers used to race `BEGIN` on the
shared connection). Highlights:

- `SELECT ... FROM utxo WHERE utxo_ref IN (...)` per tx, then `utxo_deltas`
  insert per input, `DELETE` per tx, and per output **two** inserts (delta +
  `INSERT OR REPLACE INTO utxo`).
- `utxo.tx_out` is `JSON.stringify` of an object; the delta row embeds that
  JSON string inside another JSON document, so each output is JSON-encoded
  twice and stored twice (`db.ts:1057`, `:1333`).
- Three expression indexes over `json_extract(tx_out, ...)` on `utxo`
  (`db.ts:202-209`), evaluated on every insert and delete.
- MiniBF forward index (`tx_index`, `block_tx`, one `address_tx` per address,
  `mb_tx`, `mb_tx_in`, `mb_tx_out` with an `UPDATE ... spent_by_tx` per
  input, `mb_address_tx`, `mb_cursor`) is **on by default** on the hot path;
  only `APPLY_SKIP_INDEX=1` turns it off (`db.ts:36-46`).
- `pool_distr.pools` is a JSON document rewritten with `json_insert` on every
  pool certificate (`db.ts:1482-1488`).
- A third CBOR encode per tx just to measure its size (`db.ts:1396`).
- Pragmas: WAL, `synchronous=NORMAL`, 64 MiB cache. No `mmap_size`, no
  `busy_timeout`, no prepared statements on the sync path (`db.ts:97-105`).

No epoch-boundary ledger work (stake snapshot, rewards, pool reap) runs on
the sync path at all; those tables are only filled by the Blockfrost
importers.

### 1.6 Serialization points, in one list

| # | where | effect |
|---|---|---|
| S1 | orchestrator `:566` | one header batch at a time, across all 3 hot peers |
| S2 | orchestrator `:766-789` | `await` per header for parse and nonce |
| S3 | orchestrator `:905,932,939` | DB lookups awaited inside the per-header accept loop |
| S4 | `RangeScheduler.ts:184-197` + orchestrator `:696-705` | one range per connection; only the primary eligible → 1 range in flight |
| S5 | orchestrator `:722-744` | body hash + identity on the main thread, blocking |
| S6 | `RangeScheduler.ts:272-295` | ordered, one range at a time apply |
| S7 | orchestrator `:981-1104` | fully serial per-block loop, hundreds of autocommit statements per block |

Round 1 (see `SYNC_PIPELINE_RESEARCH.md`) reached ~200 blocks/s on preprod
with the main thread at ~25 % CPU and the public relay serving ~200 headers/s
per connection. On mainnet the blocks are an order of magnitude denser, so S5
and S7 will dominate long before the header rate does.

---

## 2. What is actually verified today

This section decides what "without sacrificing security" means. The claim in
`validationPolicy.ts` ("Full validation: headers, body hashes, peer agreement
and transaction rules are enforced") is aspirational. Verified in code:

### 2.1 Enforced now — must survive every change

- **Body hash** of every fetched block against the validated header
  (`bodyHash.ts`, orchestrator `:735`). This is the only thing that binds a
  body to a header, and the reason parallel BlockFetch across peers is safe.
- **KES Sum6** verify and **op-cert** ed25519 verify per Shelley+ header
  (`BlockHeaderValidator.ts:277-292`, `:521-536`), using the noble ed25519
  port (`src/consensus/fastEd25519.ts`).
- **Byron OBFT**: block signature, delegation certificate, k-window
  threshold, prev-hash chaining (`ByronOBFT.ts`, orchestrator `:490-548`),
  provided `byronGenesisFile` is configured.
- **Per-peer candidate agreement** and outvote with a distinct-host quorum
  (`CandidateSet.ts`).
- **Rollback bound at k** with the offending peer held as malicious
  (orchestrator `:1193-1207`).
- **Applied-block dedupe** (LRU + DB), which also prevents the treasury
  double-count on duplicate delivery (`:426-464`).
- For Alonzo+ only: lovelace and multi-asset balance, min fee, validity
  interval, collateral, certificate sanity, max tx size, reference-script
  presence (`BlockBodyValidator.ts:303-795`).

### 2.2 Not enforced now — the gaps the 10× design must leave room for

| gap | where |
|---|---|
| VRF proof is computed and the result discarded; only `hash(proof) == output` is checked | `BlockHeaderValidator.ts:168-190`, comment "Temporarily only check output match" |
| Pre-Babbage VRF is `correctProof = true` with the real check commented out | `:474-495` |
| Leader eligibility uses a faked stake distribution (`1n` for genesis delegates, `0` for every SPO) so it passes for anyone | `:254-269`; `RawNewEpochState` TODOs at `:49,107,324` |
| `isKnownLeader` computed but commented out of the verdict | `:313-319` |
| Shelley+ prev-hash contiguity is dead code: `prevHashHex` is hardcoded `null` | `blockHeaderParser.ts:322`, orchestrator `:918` |
| No protocol-version check | `epochParams.ts:63` parses it, nothing compares it |
| All ledger body rules skipped for era < 5 (Byron through Mary) | `BlockBodyValidator.ts:70` |
| No transaction witness signature verification anywhere | grep `verifyEd25519`: only header, Byron, Mithril |
| No Plutus execution; `scriptDataHash` never recomputed; `validateNoInvalidTxs` returns `true` | `BlockBodyValidator.ts:196-201`, `:715-775` |
| Pre-OBFT Byron SSC proofs not recomputed, and the `partial` flag is ignored by the caller | `bodyHash.ts:203`, orchestrator `:735-740` |
| Missing epoch params silently fall back to Shelley genesis params | `epochParams.ts:150-152`, `BlockBodyValidator.ts:371` |
| No stake snapshot, rewards, or pool reap at epoch boundaries | §1.5 |

Consequence for this plan: the genuinely expensive validation work (VRF with
the result honoured, per-witness ed25519, Plutus phase-2, real leader
eligibility from a real stake distribution) is **not in today's cost**. A
design that only makes today's pipeline faster will be eaten alive when
those land. The parallel design in §5 is chosen because it makes full
validation affordable, not because today's validation is slow.

Nothing in §2.2 is removed or weakened by anything below. Several items get
cheaper to add.

---

## 3. Idea 1: validated header fragment up to k ahead

### 3.1 Why it is safe

This is cardano-node's own design: the ChainSync client keeps a validated
candidate fragment k headers long per peer, and chain selection never
adopts more than k past the intersection ("Limit on Eagerness"). Header
validation needs only two pieces of ledger state, and both lag by less than
k:

- **Epoch nonce η0 for epoch e+1** is fixed from headers alone, one
  stability window (3k/f = 129 600 slots on mainnet) before the end of
  epoch e. The `NonceEvolver` already tracks ηv/ηc from applied headers.
- **Stake distribution for leader checks in epoch e+1** is the snapshot
  taken at the e−1 / e boundary. It is complete as soon as the applier has
  crossed into epoch e.

So the single hard rule: **do not validate a header of epoch e+1 until the
applier has entered epoch e.** With k = 2160 blocks (~43 200 slots in
Shelley+, 2160 slots in Byron) against a 432 000-slot (Byron: 21 600-slot)
epoch, a k-cap on header lookahead enforces this on its own: the fragment can
reach at most one epoch boundary ahead of the applier, and the state that
boundary needs is already history.

Byron is the same shape. Heavyweight delegation certificates arrive in
bodies and activate an epoch later, so the OBFT delegation map for the
fragment is known as long as the applier is within one epoch of it, which the
k-cap again guarantees. `ByronOBFT.validateMainHeader` is stateful (k-window,
`lastSignedSlot`), so it stays a sequential step, but it runs on headers and
is cheap.

Today the leader check is faked (§2.2), so there is no stake dependency at
all yet. When the real check lands, the rule above is what keeps it correct
with lookahead.

### 3.2 What changes

- `CandidateSet` already keeps `depth: 2160` per peer. The change is in the
  orchestrator: `acceptPrimaryHeaders` must stop blocking on
  `scheduler.submit(...).scheduled` (S3/S4) and instead append to the
  primary fragment up to k ahead of the applier's tip, with BlockFetch
  scheduling decoupled from header acceptance.
- Header batches from verifiers leave the primary's promise chain (S1).
  Give each peer its own chain; only the *adoption* step (candidate compare,
  outvote) needs a lock, and it is a hash comparison.
- Parse once. Send the raw rollforward bytes to the worker, get back the
  parsed identity (`slot`, `hash`, `prevHash`, `epoch`, era) with the
  verdict, and drop the main-thread parse. The worker already returns these
  fields; the orchestrator ignores them (`:807-813`).
- Move the per-header epoch nonce `await` out of the loop: the batch is
  within one or two epochs, so resolve at most two nonces per batch.
- Fix `prevHashHex` for Shelley+ so contiguity is enforced on the fragment,
  not just on the peer's stream order. **Done, see §10.**

### 3.3 What it does not fix

Round 1 measured ~200 headers/s from one public relay per connection,
regardless of pipeline depth. A k-deep fragment fills at that rate. Header
streams cannot be split across peers without knowing hashes ahead of the
fragment, which ChainSync cannot give. So the header side has a floor of
roughly (blocks / 200 per second) per connection; for mainnet's ~12 M blocks
that is on the order of 17 hours if nothing else were in the way. The point
of Idea 1 is not to raise that rate; it is to make sure the applier and the
body downloads are never waiting on headers.

Memory: k headers is a few MB.

---

## 4. Idea 2: bodies prefetched 100+ ahead across all hot peers

### 4.1 Why it is safe

A body is accepted only if its blake2b body hash matches the
`blockBodyHash` in a header that has already passed KES/op-cert (or Byron
OBFT) validation and sits on the primary fragment. That check is already run
on every fetched block. Therefore **any** hot peer may serve **any** range of
the validated fragment: a lying BlockFetch peer is caught on the first
mismatch and held as malicious, and nothing it sent is applied. The
`agreesThrough` eligibility rule is a stronger condition than needed for body
fetches; it is the right rule for *choosing a primary*, not for *serving
bodies*.

### 4.2 What changes

- **Eligibility**: any hot peer that has completed handshake and is not
  held malicious may serve a range whose end slot is on the primary fragment.
  Keep `agreesThrough` for primary selection and outvote only. This alone
  turns the current 1 range in flight back into 3. A peer that is merely
  behind answers `MsgNoBlocks`; that is a network failure, not a malicious
  one, and must never count toward holding the peer. **Done, see §10.**
- **Range size scales with distance to tip**, as Dingo does (256 far from
  tip, down to 2 near tip). Today `maxBlocks` doubles as the header batch
  size; split the two knobs. With 3 peers × 64-block ranges and a reassembly
  buffer of 2–3 ranges per peer, 300–600 bodies are in flight or waiting,
  which is the "100+" target with headroom.
- **Reassembly buffer** keyed by first slot, drained in order by the
  applier; a slow or failed range is reissued to another peer (already the
  design of `RangeScheduler`, just with a wider eligible set).
- **Verification moves off the main thread**: body hash + header identity
  per range go to the worker pool (§5.4). They are pure functions over bytes.
- **Shadow fetch near tip** (Dingo): the same ≤4-block range to a second peer
  when the primary is slow, first delivery wins. Cheap tail-latency win, not
  a genesis-sync concern.

### 4.3 Bound

Mainnet blocks are ≤ 90 kB; 600 bodies is ~55 MB worst case. Even a full k
of bodies is ~200 MB. The existing `awaitingApply` cap is the right
backpressure; raise it in proportion to range count, and stop counting
verifier header batches against it.

---

## 5. Idea 3: parallel transaction validation

### 5.1 The observation

Once inputs are resolved, almost every expensive check is a pure function of
`(tx bytes, resolved inputs, protocol parameters, slot)`:

| check | needs shared state? | parallel? |
|---|---|---|
| CBOR decode, tx hash, size limits, validity interval | no | yes |
| vkey witness ed25519 over the tx body hash | no | yes |
| native script evaluation (timelocks, multisig) | no (slot only) | yes |
| script hash ↔ witness matching, `scriptDataHash` recompute | no | yes |
| min fee `a·size + b` | pparams only | yes |
| value conservation, multi-asset balance | resolved inputs | yes, after resolve |
| collateral checks | resolved inputs | yes, after resolve |
| Plutus phase-2 (`plutus-machine`) | resolved inputs + ref inputs + datums + cost models | yes, after resolve |
| UTxO existence, double-spend | UTxO set + earlier txs in batch | **sequential** |
| certificates, delegation, withdrawals, deposits, governance | account / pool / gov state | **sequential** (cheap) |
| nonce evolution, stake snapshots, rewards | epoch state | **sequential** (cheap, per epoch) |

The sequential work is hash-map bookkeeping. The parallel work is where
the CPU goes, especially once §2.2 is closed.

### 5.2 The three stages

Operate on a **batch**: the next N blocks from the reassembly buffer, cut so
that a batch never crosses an epoch boundary (protocol parameters and cost
models may change there; Dolos bounds its work batches the same way). N in
the range 64–256 blocks is plenty.

**Stage A, resolve (main thread, sequential).**
Walk the batch in block order, tx order. For each tx:
- look up its inputs, reference inputs and collateral in (a) an in-memory
  map of outputs created earlier in this batch, then (b) the UTxO store,
  with one bulk `IN (...)` query per batch (or per block for the first cut);
- reject on missing input or double spend inside the batch, exactly as a
  sequential applier would;
- record `spent` / `created` for the batch;
- attach the resolved outputs (raw CBOR or compact struct) to the tx job.

This is the only place intra-batch dependencies (tx j spends an output of
tx i in the same block or batch) matter, and it handles them by construction.

**Stage B, validate (worker pool, parallel).**
Ship each block, or each tx for large blocks, with its resolved inputs and
the epoch's parameters to the pool. Workers run everything in the "yes"
rows above and return `{ ok, reason, isValidComputed, exUnits }`. Phase-2
does not need agreement in the sense of "all scripts pass"; it needs the
computed result to match the block's `isValid` flag, and on failure the
collateral path is what Stage C applies. Header validation and body hash
verification (§3, §4) are the same kind of job and share the pool.

**Stage C, commit (main thread, sequential, one SQLite transaction).**
Apply the batch's deltas in order: UTxO spends and creates, account
state, certificates, treasury, indexes. One `BEGIN`/`COMMIT` per batch. The
`legacy.ts` chunk importer already does exactly this for offline chunks and
its comment records why: without it "every statement was its own implicit
tx".

Stage C for batch n can overlap with Stage B for batch n+1 and Stage A for
batch n+2. The applier is then bounded by resolve + commit, both of which are
memory-bound bookkeeping, and validation scales with cores.

### 5.3 Rules that keep this equal to sequential validation

1. **Every check still runs for every transaction.** Parallelism changes
   *when* a check runs, never *whether*. Given the same resolved inputs and
   parameters, each check is deterministic, so the ordered commit yields the
   same ledger state a sequential validator would.
2. **Batches never cross an epoch boundary.** Protocol parameters, cost
   models, the nonce, and the delegation map are epoch-scoped.
3. **Resolve is strictly ordered and is the only stage that reads shared
   mutable state.** Workers get immutable snapshots. No worker touches
   SQLite (single writer, handle not shareable).
4. **A failing block halts the applier before Stage C**, as today
   (`BodyValidationFailure` → SYNC HALTED). Nothing from a failed batch is
   committed.
5. **Nonce evolution, Byron OBFT window, stake snapshots, rewards stay
   sequential.** They are per-header or per-epoch and cheap.

### 5.4 Worker data contract

- Transfer, do not clone: the block bytes as an `ArrayBuffer` in the
  transfer list, the resolved inputs as one packed CBOR/flat buffer, the
  epoch parameters as a small JSON blob cached per epoch in each worker
  (as `genesisCache` is today).
- Results are small: per tx `{ index, ok, reason?, isValid, exUnits? }`.
- Workers load the same modules as the main thread
  (`BlockBodyValidator`, `bodyHash`, `blockHeaderParser`), as the header
  pool does now, so no logic forks.
- Pool depth accounting: today dispatch is blind round-robin
  (`ValidationPool.ts:120`). Add a per-worker queue length and route to the
  shortest; large Plutus blocks otherwise pile up on one worker.
- Workers have their own module state: anything pinned per network on the
  main thread (`setEpochNetwork`, later epoch params and cost models) must be
  pinned in the job or on worker start as well.

### 5.5 Why not finer partitioning (Block-STM style)

Optimistic execution with conflict detection and re-run would let Stage A
itself run in parallel. It is not worth it here. Stage A's cost is hash
lookups; the crypto and script execution it unblocks are 100–1000× heavier.
Keep resolve sequential and simple; it is also where the security argument
lives.

---

## 6. Storage: from hundreds of autocommits per block to one commit per batch

Round 1 showed SQLite pragmas alone bought nothing, because the shape of the
writes, not the disk, is the cost. In order of effect:

1. **One transaction per batch** (Stage C). **Done per range, see §10.** Also removes the reason the
   header chain was serialised in the first place: only the applier writes,
   inside its own `BEGIN`. **Check first:** the MiniBF API reads through the
   same shared `sql` handle; confirm how Bun's SQLite adapter treats queries
   issued on `sql` while `sql.begin` is open on it (the `db.ts:653` comment
   records that this sharing already raced once). A second read-only
   connection for the API is the likely answer.
2. **Stop inserting the block twice** (stub row in `applyBlock`, then the
   full upsert) and **stop storing the body twice** (`block_data` and
   `block_fetch_RawCbor` are both re-encodes of `blockMessage.blockData`).
   Store the received bytes once; derive anything else on read.
3. **In-memory UTxO write-behind for the batch**: Stage A already holds the
   batch's created/spent sets. Flush them as bulk statements at commit
   instead of per-output `INSERT OR REPLACE` plus a delta row. A bounded
   in-memory LRU of hot UTxOs in front of SQLite removes most `SELECT`s;
   correctness is unaffected because SQLite remains the source of truth at
   commit.
4. **Store outputs as CBOR blobs, not JSON strings inside JSON**, and drop
   the three `json_extract` expression indexes from the sync path. Address
   and reference-script lookups belong in a side table written at commit,
   or in the MiniBF projection.
5. **Forward index off the bulk-sync path.** Set the equivalent of
   `APPLY_SKIP_INDEX` automatically while more than one epoch behind the
   tip, and run the existing offline backfill (`scripts/backfill-minibf.mjs`)
   once caught up. The index is a product feature, not a consensus one.
6. **Remove the full-table scans per block**: `getAllStake()` and
   `getAllDelegations()` run unconditionally on every Alonzo+ block
   (`BlockBodyValidator.ts:618-619`). Replace with keyed lookups for the
   credentials the block touches. On mainnet these tables grow to millions
   of rows; this one item will otherwise dominate everything else.
   **Done, see §10.**
7. **Query the UTxO set once per block**, not three times
   (`BlockBodyValidator.ts:320,427,556`). Stage A makes this automatic.
8. **Persist ηv/ηc per epoch (on TICKN), not per block**, and drop the
   per-block `epoch_nonces` upsert.
9. Prepared statements for the fixed-shape inserts, `mmap_size`,
   `busy_timeout`, and a larger `wal_autocheckpoint` during bulk sync, as
   `batch-hydrate.mjs` already does.

---

## 7. Cheap wins to take first

None of these change semantics; together they are likely worth 2–3× on
their own on mainnet's dense eras.

- Decode each block **once**: keep the lazy CBOR tree from the body-hash
  step and reuse it for identity, `blockParser`, and validation. Today: four
  decodes, two re-encodes, one `.slice()` of the header, one extra tx encode
  for size.
- Parse each header **once**, in the worker (§3.2). **Done, see §10.**
- Per-header and per-block info logs off the hot path: the "Parsed header
  successfully" log per header and the two "Committed 1 blocks" logs per
  block go through JSON serialisation before buffering. Log per batch.
- Move `verifyFetchedRange` (body hash + identity) to the pool (S5). **Done, see §10.**
- Move Byron block-signature and delegation-cert ed25519 to the pool; keep
  only the k-window update on the main thread.
- Give verifiers their own promise chain (S1). **Done, see §10.**
- Fetch eligibility rule (§4.2), which is a few lines and restores the
  configured parallelism. **Done, see §10.**

---

## 8. Order of work and how to measure

`/metrics.sync.profile` and the `Sync profile:` log line already break wall
time into `hdr.parse`, `hdr.nonce`, `hdr.validate`, `hdr.obft`, `blk.dedupe`,
`blk.params`, `blk.validate`, `blk.apply`, `blk.obft`, `blk.nonce`,
`blk.encode`, `blk.insert`, `blk.gc`, `blk.emit`. Add `blk.bodyhash`,
`blk.resolve`, `blk.commit`, and a `fetch.inflight` gauge, and measure each
step against a mainnet run from genesis, not preprod: preprod's blocks are
too sparse to show the body-side costs.

| step | depends on | expected effect (mainnet, dense eras) |
|---|---|---|
| §7 cheap wins | — | 2–3× on the applier |
| §4.2 fetch eligibility + range sizing | — | network side back to N peers wide; removes download stalls |
| §3.2 header fragment to k, verifiers off the primary chain | — | applier never waits on headers |
| §6.1–6.2 one commit per batch, single block write | §5.2 stage C shape | large; removes hundreds of autocommits per block |
| §6.6–6.7 keyed stake/delegation lookups, single UTxO query | — | removes O(table) work per block |
| §5 resolve / validate / commit | §3, §4 | validation scales with cores; makes §2.2 affordable |
| §6.3–6.5 UTxO write-behind, CBOR blobs, index off path | §5 | bounded per-block cost independent of DB size |

Do §7, §4.2 and §6.6 first; they are small, independent, and each removes a
cliff. Then §5 with §6.1–6.2, which is one refactor of `applyRange`. Then
close the §2.2 gaps inside Stage B, where they are cheap.

---

## 9. Non-goals and things never to remove

- No "trusted historical" mode that skips crypto below some slot. Dingo and
  Dolos do this; the doc `SYNC_PIPELINE_RESEARCH.md` already flags it as
  something that must stay explicit and opt-in if ever added. Not part of
  this plan.
- No Mithril dependency. Everything here works from origin over N2N.
- Never remove: body-hash verification on every fetched block, KES and
  op-cert checks, Byron OBFT signature and delegation checks, the k
  rollback bound with malicious hold, the distinct-host quorum, the dedupe
  LRU, strict halt on a failing body from genesis, and the slow-ed25519
  fallback (it degrades to slow, never to skip).
- Parallelism must never change *which* checks run, only *when*. If a check
  cannot be made a pure function of a snapshot, it stays in Stage A or C.

---

## 10. Status log

### 2026-09-03 — slice 1 (uncommitted at time of writing)

All claims in §1–§2 re-verified against `master` @ `f325516`; none had moved.

Implemented:

- **§4.2 fetch eligibility** (`ConsensusOrchestratooor.eligibleFetchPeers`):
  every non-divergent hot peer with a live connection may serve bodies;
  primary and agreeing verifiers are listed first. `agreesThrough` is now used
  only for primary selection / outvote.
- **`RangeScheduler` retry rule**: a range is no longer abandoned (and the
  pipeline poisoned) while an eligible peer has not been tried yet, so a
  verifier answering `MsgNoBlocks` costs one retry, never a restart. Two
  tests added.
- **§3.2 / §2.2 Shelley+ `prevHashHex`** is now populated by `headerParser`
  (`getHeaderPrevHashHex`), which makes the existing contiguity check at
  `acceptPrimaryHeaders` live for Shelley+ headers. Test added
  (`blockHeaderParser.shelley.test.ts`, preprod fixtures).
- **§6.6 keyed stake / delegation lookups**: `getStakeByCredentials` and
  `getDelegationsByCredentials` in `db.ts` (one indexed `=` per distinct
  credential; Bun's `IN ${sql([...])}` helper cannot take BLOB keys), plus
  indexes `idx_stake_credentials` and `idx_delegations_credentials`.
  `validateCertificatesValid` now looks up only the credentials the block
  touches. Test added (`db.stakeLookup.test.ts`).
- **Certificate ordering fix** (found while doing §6.6): the certificate
  check compared every cert against a pre-block snapshot, so a registration
  followed by a delegation of the same key in one tx (the normal wallet flow)
  failed and would halt a strict sync at the first such Alonzo+ block. The
  maps are now updated as certificates are applied in order within the block.

### 2026-09-03 — slice 2 (uncommitted at time of writing)

- **Certificates, all types.** `certificateRules.ts` (pure, unit-tested) gives
  every `CertificateType` 0–18 its stake-credential effect: Shelley and Conway
  registrations / deregistrations / delegations update the registered set and
  delegation map in order; pool, genesis, MIR and governance certificates are
  accepted without stake-state checks; unknown types still reject the block.
  `applyCertificates` in `db.ts` now also writes the Conway forms (7, 8, 10,
  11, 12, 13) to `stake` / `delegations`, so the validator's view matches the
  ledger writer's.
- **§6.1 one transaction per range.** `applyRange` runs the whole range inside
  `sql.begin`; block and header rows are flushed once at the end of the range.
  Bun's SQLite adapter runs statements issued on the shared `sql` handle inside
  the open transaction (pinned by `sql.txn.test.ts`), so `applyBlock` and
  friends did not need a handle threaded through. A second `sql.begin` on the
  connection throws, so `applyRange` and `rollbackChainTo` are serialised by a
  `SerializedMutationQueue` on the orchestrator. On a failed range the
  transaction rolls back and the in-memory state derived from applied blocks
  (dedupe LRU, nonce evolver, Byron OBFT window, nonce cache) is reset the same
  way a chain rollback resets it.
- **§7 parse-once headers.** The main thread parses only the first and last
  header of a batch (for the epoch range), resolves one nonce per epoch, and
  ships `noncesByEpoch` to the workers, which parse each header once and return
  its identity (`HeaderSummary`). A header whose epoch has no supplied nonce
  fails validation explicitly.
- **§7 decode-once bodies.** The header identity computed while verifying a
  fetched range is kept in a `WeakMap` and reused by the applier; the unused
  lazy parse in `blockParser` is gone. Measured on the fixtures,
  `block.toCborBytes()` returns the cached received bytes (0.01 ms), so the
  "two re-encodes" in §1.4 are not a real cost; `MultiEraBlock.fromCbor`
  (~1 ms/block) is the decode that remains and is needed.
- **§7 logs.** Per-header "Parsed header successfully", per-block "Starting /
  passed block body validation" and per-batch "Committed N blocks/headers" are
  debug level now.

Still open, noticed on the way: `block_data` stores the inner block bytes
(`block.toCborBytes()`), but `SqliteRelayChainStore.parseBlock` feeds that
column to `MultiEraBlock.fromCbor`, which expects the `[era, block]` wrapper
and throws, falling back to the `block_fetch_RawCbor` envelope every time.
Storing `blockMessage.blockData` (the wrapped bytes, as received) would fix
the reader and is what §6.2 wants anyway; not changed here because it is a
schema-semantics change for existing databases.

### 2026-09-03 — slice 3 (uncommitted at time of writing)

- **§4.2 range sizing.** New config `blockFetchBatch.maxRangeBlocks` (default
  128, clamp 1..256) is the BlockFetch range size; `maxBlocks` stays the
  ChainSync header batch size. Accepted primary points go into a buffer and
  ranges are cut from it by distance to the peer's tip (`rangeSizing.ts`,
  pure, tested): 128 far behind, then 64 / 16 / 4, single blocks at the tip. A
  200 ms timer flushes a partial tail so a slow header stream never leaves
  bodies unfetched. The primary-switch resubmit path uses the same size.
- **§3.2 header fragment to k.** The primary's stream is no longer blocked on
  a free download slot; it may run `blockFetchBatch.headerLookahead` validated
  headers (default k from the Shelley genesis, 2160) ahead of the applier.
  The wait happens outside the adoption lock, so verifiers keep comparing.
- **§3.2 verifiers off the primary's chain.** One promise chain per peer keeps
  a peer's batches ordered while peers parse and validate concurrently; only
  adoption (candidate compare, outvote, accepting primary headers) is
  serialised, and the peer's role is re-read under that lock because a
  primary switch can happen while a batch is being validated.
- **§7 S5 range verification on the pool.** Header identity + body hash per
  fetched range now run as a `RangeVerifyJob` on the validation workers (block
  bytes copied once and transferred; identities come back and feed the
  applier). New profile key `rng.verify`. Tested against the preprod fixtures,
  including tampering and undecodable bytes.
- **§5.4 pool dispatch** goes to the least-loaded worker (per-worker load in
  job units: 1 per header, 1 per block in a range) instead of blind
  round-robin.
- **§6.7 one UTxO query per block.** The balance, multi-asset and collateral
  checks read one map built from a single `getUtxosByRefs` over every input
  and collateral input of the block (was three queries per block).
- **§6.8 nonce snapshot per range.** ηv/ηc for mid-chain resume are written
  once per range inside its transaction instead of on every Shelley+ block;
  TICKN η0 is still persisted as it happens. Equivalent because a range
  commits atomically.
- **§6.5 forward index off the bulk path, opt-in.** `sync.skipIndexWhileBehind:
  true` pauses the MiniBF forward index while more than one epoch (432 000
  slots) behind the primary's tip and resumes it near the tip, with a warning
  naming `scripts/backfill-minibf.mjs`. Default off, so the index stays
  complete unless asked.

Measured on the preprod fixtures: `MultiEraBlock.fromCbor` ≈ 0.5–1 ms per
block; the re-encodes are cached bytes. Everything above is verified by unit
tests and the typecheck; **none of it has been measured on a mainnet
from-genesis run yet**, which §8 requires before the next phase.

Not done, and why:

- **§5 Stage A/B/C and §6.3 UTxO write-behind.** Resolving batch n+1 while
  batch n commits needs an in-memory overlay of batch n's created/spent
  outputs; without it Stage A must wait for the previous commit and there is
  nothing to overlap. That overlay is a rewrite of `applyTransaction` and its
  MiniBF projections in `db.ts`, and today's body checks are cheap enough that
  moving them to workers gains little until the §2.2 gaps (witness ed25519,
  Plutus) land. Groundwork is in: the validator takes a pre-resolved UTxO map
  and keyed stake/delegation state, so its checks are already a function of
  `(block, resolved inputs, params)`.
- ~~§6.2 / §6.4 storage shape~~ — done in slice 4 (databases deleted instead of migrated).
- **§7 Byron ed25519 to the pool.** Byron OBFT is stateful (k-window); the
  signature part alone is ~0.1 ms per block, not a bottleneck.

### 2026-09-03 — slice 4: storage shape (databases deleted; resync from genesis)

The existing `src/store/db/{mainnet,preprod}/Gerolamo.db` files were removed;
the schema below is only created fresh.

- **§6.2 block stored once.** `blocks.block_data` and
  `immutable_blocks.block_data` hold the BlockFetch payload `[era, block]`
  exactly as received (BLOB). The `block_fetch_RawCbor` column is gone from
  both tables; the relay store, N2C chain DB, `/block/:id` HTTP endpoint (which
  rebuilds the BlockFetch envelope on read, so its payload is unchanged) and
  the backfill / soak scripts read `block_data`. The stub row `applyBlock`
  used to insert before the full upsert is gone: one row per block, written
  inside the range's transaction. The reader bug noted in slice 2 is fixed by
  construction.
- **§6.4 UTxO side columns instead of expression indexes.** `utxo` keeps the
  `tx_out` JSON the MiniBF API and 90-odd call sites read, and adds real
  columns `address`, `lovelace`, `reference_script_hash` written by the single
  `upsertUtxoRow` writer. The two `json_extract()` expression indexes (evaluated
  on every insert and delete) are replaced by plain indexes on those columns;
  address, reference-script and amount lookups use the columns. The Blockfrost
  and stream-table importers fill the columns after their bulk inserts.
- **`create` deltas no longer embed the output.** Rolling back a create only
  needs the ref, so the output JSON is stored once (in `utxo`) instead of twice;
  `spend` deltas still carry the full output for restore. `parseUtxoDelta`
  accepts both shapes.

Why side columns rather than the CBOR blob §6.4 proposed: the JSON shape is
what the API layer and ~94 call sites consume, and the measured cost was the
expression indexes and the double encoding, both of which are gone. A CBOR
column can be added later without touching readers.

### 2026-09-03 — first mainnet measurements (from genesis, Byron, 3 hot peers, 20 workers)

Baseline after slices 1–4, 100 s window:

| | blocks/s | per block on the main thread |
|---|---|---|
| slices 1–4 | 212 | `hdr.obft` 2.8 ms/header + `blk.obft` 1.1 ms/block ≈ 85 s of 102 s wall |
| + Byron signatures on workers | 258–297 | `hdr.obft` 0.05 ms, `blk.obft` 0.11 ms; main thread mostly idle |

So the applier and the database were not the Byron bottleneck; the two
ed25519 verifies per header on the main thread were (the earlier "~0.1 ms"
estimate was wrong by 30×, partly from CPU contention with 20 busy workers).
Fixed in this slice:

- **Byron block signature + delegation certificate verify on the workers**
  (`byronProtocolMagic` on the header job; `HeaderSummary.byronSig`). The main
  thread keeps only the stateful OBFT half: `validateSignedMainHeader`
  (genesis key, registered delegation, monotonic slots, k-window) and
  `noteAppliedIssuer`. Tested equal to the full check.
- **Shared-slot false fork.** With verifiers no longer queued behind the
  primary, a verifier often reports the first main block of an epoch before
  the primary's copy is observed; the candidate set called that a divergence
  at slot 0 and held the honest peer as malicious. A mismatch at the primary's
  tip slot is now deferred while that tip is an EBB (`CandidatePoint.ebb`) and
  settled when the primary moves on; non-EBB tips still diverge immediately
  (Shelley fork detection unchanged). Tests added for both.
- **Config overlay** (`GEROLAMO_CONFIG_PATH`) now merges `sync` and
  `validation` deeply.

Also seen: with `syncFromPoint` at the mainnet tip and `scriptValidation`
defaulting to `strict`, the first Plutus block halts sync (`UPLC decode
failed: unknown tag: 12`, Babbage era). Pre-existing; the UPLC decoder in
use cannot read those scripts. Unrelated to genesis sync, but `strict` script
validation is not usable at the tip today.

Measured but not adopted: Bun's native ed25519 (`node:crypto` verify) runs
in 0.035 ms vs 0.336 ms for the noble port, a 10× on the crypto itself. Its
edge-case semantics (small-order points, non-canonical encodings) differ from
libsodium, so switching would need explicit canonicality checks first; noted
as a follow-up, not done.

After the change the remaining Byron cost is off the main thread; the next
limits are the per-connection header rate and range download parallelism.

### 2026-09-03 — runs 3–6: the header side, measured and fixed

With Byron crypto off the main thread the scheduler sat idle (`inFlight 0,
queued 0`) while one verifier was 24k headers ahead of the primary on the
same chain: the primary connection's header rate was the whole limit (plan
§3.3), and it varies 2× between relays.

- **Throughput promotion.** `CandidateSet.fasterAgreeingVerifier(minLead)`
  picks the verifier that agrees with the primary through the primary's tip
  and has ≥ 1024 validated headers beyond it; the orchestrator makes it
  primary (60 s cooldown) and restarts its ChainSync from the DB tip so every
  header still passes `acceptPrimaryHeaders`. Nothing is adopted from the
  verifier fragment. Gated on header starvation: it only fires while
  `pendingHeaders` is below half the lookahead cap, because a primary blocked
  on the cap is not slow and every verifier (uncapped) would look ahead of it
  (run 5 flapped every cooldown for exactly that reason).
- **Governor must not demote the primary.** The excess-hot demotion picks the
  most recently promoted hot peer, which after a throughput promotion is the
  new primary (run 4: promoted and demoted in the same second). Both demotion
  paths skip `primaryPeerKey()`, and demotion now logs.
- **Range size at the cap.** Once the header cap was hit, room freed one range
  at a time, the primary accepted a trickle, and the 200 ms flush timer cut
  ~27-block ranges at a 128 target (run 4: 1575 ranges for 42k blocks). Room
  now has hysteresis (resume below cap − 2 ranges) and the idle flush is 1 s
  when far from the tip. Run 5: 125.7 blocks per range.

Rates (Byron, mainnet, 3 hot peers): run 3 202 blocks/s flat; run 4 ~400
average; run 5 39 → 443 blocks/s as the promotion settled, 460 at the end.
Every run applied 20–42k blocks with zero validation failures, zero
malicious holds after the shared-slot fix, and zero rollbacks.

### 2026-09-03 — run 6: two stalls traced to their causes

Run 6 fell from 271 to 5 blocks/s for the last minute. Forensics from the log:

- **Multiplexer framing bug (library).** Peers were terminated every minute or
  two with `Multiplexer error … unwrapped Multiplexer header was not a mini
  protocol`, and the offending "header" bytes were plainly mid-payload CBOR.
  `unwrapMultiplexerMessages` in ouroboros-miniprotocols-ts loops
  `while (length >= 8)` and silently drops a trailing partial segment header,
  so the next TCP chunk is parsed from the middle of a header. Larger
  BlockFetch ranges made chunk boundaries inside headers common. Fixed in the
  vendored patch (`patches/@harmoniclabs%2Fouroboros-miniprotocols-ts@…`):
  `unwrapMultiplexerMessagesRest` returns the leftover bytes and
  `forwardMessage` carries them into the next chunk; the `DataView` now
  honours `byteOffset`. `multiplexerFraming.test.ts` drives a Multiplexer over
  a fake socket and checks every split point of a three-segment stream plus
  byte-by-byte delivery.
- **Head-of-line stall on a dead peer.** A range in flight on a terminated
  connection waited out its full 55 s BlockFetch timeout while the ordered
  apply queue (and the awaiting-apply cap) held everything behind it.
  `PeerClient.terminate` now rejects in-flight `fetchBlock*` promises at once
  (lazy termination signal, raced against the request), so the scheduler
  re-issues the range to another peer within a tick. Termination reasons are
  logged at info.
- **Stale batches after a promotion.** A verifier promoted to primary still
  had its far-ahead verifier header batches queued; under the adoption lock
  they were re-read as primary batches and tripped the Byron continuity check
  ("Byron chain break … expected=…"), terminating the new primary. ChainSync
  now has a stream `generation`, bumped synchronously at the start of
  `restartChainSync`; batches carry it and the orchestrator drops any batch
  from a superseded generation.

### 2026-09-03 — runs 7–8: where Byron stands

Run 7 (all fixes above, 254 s from genesis): **107 520 blocks, 422 blocks/s
overall, 470–535 blocks/s while running alone**, ranges exactly 128 blocks,
no peer terminated, no promotion needed, no validation failure, no rollback.
The scheduler sat idle (`inFlight ≤ 1, queued 0, awaitingApply 0`) the whole
time: the applier and downloads have headroom; the primary relay's header
rate is the limit, as §3.3 predicted. Run 8 with `pipelineDepth: 128` against
the same relay gave the same ~470 headers/s, so our pipelining is not the
cap either; the relay is. Throughput promotion picks the fastest agreeing
relay when the initial primary is slow (runs 4–6 showed 2× spreads between
relays).

Byron at ~470 blocks/s is 2.3× the 200 blocks/s baseline this document
started from; mainnet's 4.5 M Byron blocks take ~2.7 h instead of ~6 h.
Shelley+ has not been measured: reaching it from genesis takes that long,
and `syncFromPoint` into Shelley without the UTxO set only exercises the
apply path on a garbage ledger. The dense eras are where §6.3 (write-behind)
and §5 (parallel body validation) matter, and the profile keys to watch there
are `blk.apply`, `blk.validate` and `blk.insert`.

### 2026-09-03 — why the node "exits" on mainnet (two OOM kills)

The kernel log has two OOM kills (01:30 and 07:39 local), both of a `bun`
process at 32–34 GB anon RSS. In both process tables the node itself (the
`bun` with 20 worker threads) sits at ~2.3 GB; the killed process is the
**desktop app's Bun runtime**, spawned just before the node, and the node's
log stops in the same second. Cause: the Control Center tailed the node's
`daemon.log` with `readFileSync(path).split("\n").slice(-n)` every 2 s. At
debug level that file reaches gigabytes within minutes (the old code logged
every parsed header as an object: ~20k lines/s), so each poll allocated
several GB of strings. Fixed:

- `desktop/src/bun/tailFile.ts` reads a bounded window from the end of the
  file (grown only when lines are very long) for both the node log and the
  Mithril bootstrap log; tested against the whole-file behaviour.
- Per-header, per-block and per-tx debug logging removed from the sync hot
  path (`Parsed … header successfully`, `Parsed block successfully`,
  `Applied Block`, `Applying transaction`, `Input refs`, body-validation
  start/pass). Debug level is now a few hundred lines/s, not 20k.
- Node crash guards: Bun exits on an unhandled promise rejection or uncaught
  exception; `installCrashGuards()` in `network/index.ts` logs them and keeps
  the node running. `SIGUSR2` writes a heap summary (bytes and count per
  class) to `GEROLAMO_HEAP_DIR`, which is how the node's JS heap was shown to
  be ~100 MB live and stable while RSS grew elsewhere.

Also in the kernel log: one `Worker[…] trap invalid opcode … in bun` (02:52),
a SIGILL inside the Bun binary on a validation worker thread. That kills the
process and cannot be caught in JS; only a Bun upgrade or fewer workers
mitigates it. Seen once.

### 2026-09-03 — the node's own leak (mine), found with SIGUSR2

A 10-minute debug-level run of the node alone still climbed (RSS 1.9 → 2.8 GB)
and its rate fell 470 → 200 blocks/s. The forced-GC heap summary at six
minutes held **130 304 `BlockFetchBlock`** objects, one per applied block,
with their buffers (~300 MB live and growing). Cause: the fail-fast fetch from
run 6 raced every BlockFetch request against one never-settling "terminated"
promise. Each `Promise.race` leaves a reaction on that promise, and the
reaction pins the settled race promise and its value, the range's block
array, until the peer terminates. Replaced by a per-peer set of in-flight
rejecters that `terminate()` fires and every settled request removes; a test
checks the set is empty after 50 ranges and that termination still rejects an
in-flight range at once.

Verification run (debug level, 6.5 min): RSS levelled at 1.9–2.0 GB from
three minutes on (20 workers ≈ 1.7 GB of that), live JS heap 36 MB after
GC, `BlockFetchBlock` retained: 912 (the in-flight/awaiting ranges), rate
500–570 blocks/s with no decline.

### 2026-09-03 — log rotation and the Byron stream-gap false positive

- **Rotation.** The node's per-level `.jsonl` files rotate at
  `logs.maxFileBytes` (default 64 MiB, 0 disables) keeping `logs.keepFiles`
  (default 5) generations (`utils/logRotate.ts`). The desktop no longer hands
  the node a shared fd for `daemon.log`; it pipes stdout/stderr through a
  `RotatingLog` (50 MB × 5). Both tested.
- **Byron stream gap.** On the info-level restart the freshly promoted primary
  delivered a header 1300 blocks past our tip (a stale pipelined reply after
  its ChainSync restart); `assertByronContinuity` threw and the honest peer was
  terminated. That case is a discontinuous stream, not a fork: it is now
  handled like the Shelley path, by restarting the peer's ChainSync from the
  DB tip.

### 2026-09-03 — clean exit, review pass, housekeeping

- **Clean exit.** SIGINT/SIGTERM (and the TUI's `q`) now run one shutdown:
  stop N2N, stop the orchestrator (drop queued ranges, let the range being
  applied finish its transaction, close the workers), terminate peers, stop
  N2C, close SQLite (WAL checkpointed), flush the logger, exit 0; a 30 s
  deadline exits 1 instead of hanging, and a second SIGTERM (the desktop sends
  two) no longer interrupts the first. The logger's own signal handlers, which
  used to `process.exit(0)` right after flushing, are gone. The desktop waits
  up to 30 s for the exit before SIGKILL (was 800 ms). Verified: exit 0 in
  0.3 s mid-sync, `integrity_check` ok, no `-wal` left.
- **Review-driven fixes.** Verifier `pending` comparisons are bounded (k) and a
  verifier's stream is paused past ¾·k, so a body-bound primary no longer lets
  uncapped verifiers grow memory; the primary-header drain no longer copies
  the map per header. Log rotation tracks size in memory (no `statSync` per
  line). `ensureInitialized` migrates a pre-side-column `utxo` table (ALTER +
  backfill) instead of failing on the first insert. `applyCertificates` now
  takes its stake effects from `certStakeEffect`, the same table the validator
  uses, so validate and apply cannot drift (tested for the Conway forms).
  One demotion guard, in `demoteHotToWarm`. One `txOutColumns` mapping for
  every `utxo` writer, one backfill SQL constant, one `fresh()` copy helper.
- **Logger default.** `logToFile` is off until the node applies its config:
  with it on by default, every `bun test` run appended debug output to
  `src/store/logs/preprod/` — a 103 GB `debug.1.jsonl` was found and deleted
  (101 GiB freed, plus old restart and Mithril logs).

- **Crash supervision (desktop).** A non-zero exit the user did not ask for is
  restarted with backoff (5 s doubling to 60 s, at most 5 crashes per 10 min,
  then it stays down with the reason in `lastError`). The `invalid opcode`
  trap seen once in the kernel log is a `ud2` inside the Bun binary (a
  compiled-in assertion on a worker thread), most likely under the memory
  pressure of the old leak; Bun's crash report now lands in `daemon.log`
  through the piped stderr if it ever recurs.

### 2026-09-03 — desktop graphs and transaction submission

- **Resources over time.** The Control Center keeps the last 30 minutes of
  status polls (one per 2 s) and draws three dependency-free SVG charts: CPU
  (node cores busy vs host), memory (node RSS and JS heap) and blocks/s.
- **Transaction submission.** `POST /api/v0/tx/submit` now decodes the tx
  first (400 on undecodable CBOR instead of a fire-and-forget 202), returns
  the real tx id (body hash) and the shared mempool's verdict, and 503s when
  no hot peer exists; `GET /api/v0/mempool/{hash}` tells whether a tx is
  still queued. The desktop Node page has a "Submit transaction" card (hex
  CBOR → node → tx id + mempool state). Tested with a synthetic decodable tx.

### 2026-09-03 — two regressions from the review batch, found on the live run

- **Infinite loop in `CandidateSet.observe`.** The review's "no per-header
  copy" change iterated a verifier's `pending` Map while `compareAgainstPrimary`
  could re-insert the same entry (the EBB deferral). A Map for-of visits
  entries added during iteration, so at mainnet slot 0 (EBB + block 1 share
  the slot) the primary-advance drain never ended: main thread pegged, HTTP
  listen queue full, no blocks applied. Fixed by snapshotting the due entries
  first; regression test reproduces the exact genesis sequence.
- **Startup height backfill too slow.** One `UPDATE` per row (3.4 M rows on
  the mainnet DB) before the servers started: an hour with the node unusable.
  Replaced by a set-based pass (temp table with `ROW_NUMBER() OVER (ORDER BY
  slot)` + index + one `UPDATE`).

Next: a from-genesis mainnet run into Shelley/Alonzo with `Sync profile:`
lines kept, then §6.3 → §5 against those numbers.
