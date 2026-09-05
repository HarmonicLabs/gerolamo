# Plan: close the validation gaps (make "full validation from genesis" true)

Source: `docs/VALIDATION_AUDIT_DINGO_VS_GEROLAMO.md` (2026-09-04). Ordered by
what buys the most honesty per hour. Each phase is independently shippable and
keeps the current behaviour of halting the sync on a strict failure.

## Principles

- Rules are pure functions over (tx, witnesses, resolved inputs, params, slot);
  the DB only resolves inputs. Every rule has a unit test with a hand-built tx.
- Crypto (ed25519 witness signatures) runs on the existing validation worker
  pool as a new job kind; the main thread decides, never hashes.
- Strict policy (`ledgerComplete`) halts; tip-sync policy reports. No new knobs.
- No Blockfrost on the consensus path once Phase 4 lands; until then the
  fallbacks stay but are logged as such.

## Phase 0 — cheap, immediate

| Gap | Fix | Where |
|---|---|---|
| VRF proof result discarded | Honour `proof.verify()`; find why it was disabled (pre-Babbage vs Praos input) with real headers from the fixtures | `BlockHeaderValidator.ts:verifyVrfProof` |
| Slot monotonicity Shelley+ | header slot > parent slot | `ConsensusOrchestratooor.ts` contiguity check |
| Block body / header size | `maxBlockBodySize`, `maxBlockHeaderSize` from epoch params | `BlockBodyValidator.ts:validateSizeLimits`, header path |
| Missing input silently skipped on apply | strict policy: throw → SYNC HALTED; soft policy: keep skipping, count it | `db.ts:applyTransaction` |

## Phase 1 — transaction witnesses and rules for every era (the big honesty gain)

1. **Witness verification** (`consensus/txWitness.ts` + worker job `witnesses`):
   vkey and bootstrap witnesses are ed25519 signatures over the tx body hash;
   verified on workers in batches per block; result = set of verified key hashes
   (bootstrap: key hash = Byron address root of the witness).
2. **Required signers** (`consensus/requiredSigners.ts`): payment key hash of every
   spent input (from the resolved UTxO address, incl. bootstrap addresses),
   stake credentials of certificates, pool cold key + owners on registration,
   withdrawal reward accounts, `requiredSigners`, Conway votes (DRep / CC / SPO
   keys). Rule: required ⊆ verified.
3. **Native scripts** (`consensus/nativeScript.ts`): evaluate `sig/all/any/atLeast/
   before/after` against the verified key set and the validity interval;
   script-locked inputs, minting policies, script certificates and withdrawals
   must be witnessed by a native or Plutus script with the matching hash.
4. **Era rule set** (`consensus/txRules.ts`) applied Shelley → Conway:
   inputs non-empty, exist, no duplicates; value conserved on the full Value
   (inputs + withdrawals + refunds + mint = outputs + fee + deposits);
   min fee `a·size + b`; TTL / validity interval; min UTxO per output; max tx size;
   network id; withdrawals against local reward balance when known.
5. **Byron rules** (`consensus/byronTxRules.ts`): inputs/outputs non-empty,
   outputs positive, no duplicates, inputs exist, value conserved, fee policy,
   PkWitness / RedeemWitness signatures over the Byron signing tag + magic + tx id,
   witness key matches the spent address root.

Wired into `BlockBodyValidator.validate` for every era (today era < 5 returns
null). Halts under strict policy.

## Phase 2 — headers against real stake

- Epoch stake snapshots (mark / set / go) taken at epoch boundaries from the
  stake + delegation tables; pool params table with registered VRF key hash.
- Leader eligibility with σ = pool stake / total from the "go" snapshot; drop
  the genesis-delegate stand-in. Registered VRF key must match the header's.
- Operational certificate counter monotonic per pool.

## Phase 3 — Alonzo+ integrity and Plutus

3a. **Integrity rules** (`rules/alonzoRules.ts`, strict unless noted):
   datums present for spent Plutus-script inputs (witness datum by hash, or
   inline datum); collateral inputs are key-address ADA-only outputs (or carry
   a collateral return), total collateral ≥ ⌈fee · collateralPercent / 100⌉,
   `total_collateral` consistent with the return; Σ redeemer ExUnits ≤
   `max_tx_ex_*`, block Σ ≤ `max_block_ex_*`; every script purpose (spend of adoc.babylonjs.com/toolsAndResources
   Plutus input, Plutus mint policy, script cert / withdrawal) has exactly one
   redeemer and no redeemer is extra; script data hash recomputed from the
   redeemers, datums and cost-model language views (report-only: the encoding
   is byte-sensitive and the redeemer slice is not kept).
3b. **Phase-2 execution** (`rules/plutusEval.ts`): the block tx is rebuilt as a
   ledger-ts `Tx` with inputs resolved from the ledger (address, value, datum,
   reference script), the script context comes from buildooor's `getTxInfos`
   (V1/V2/V3), scripts are found in the witness set or in reference outputs,
   cost models come from the epoch parameters, and `plutus-machine` evaluates
   each redeemer. Shadow mode first: the outcome is compared with the block's
   `isValid` flag and the budget with the redeemer's units; mismatches are
   reported and counted, never halting. Strict once the shadow agrees over
   real history.

## Phase 4 — local epoch rollover (no Blockfrost)

4a. **Nonces**: the evolver already derives η0 locally; the Blockfrost fallback
    becomes a report ("nonce unavailable") and the from-genesis path seeds the
    first Shelley epoch from the genesis hash.
4b. **Protocol parameters**: per-epoch records produced locally — Shelley
    genesis, then Shelley…Babbage update proposals from tx bodies
    (`protocolUpdate`, genesis-delegate quorum, applied at the boundary) and
    Conway parameter-change actions once enacted — stored in `epoch_params`
    with source `local`; Blockfrost only fills gaps and is reported.
4c. **Rewards**: blocks-made per pool per epoch counted at apply; the Shelley
    reward calculation (rho/tau pots, pool performance, margin/cost/pledge,
    member and leader rewards) run at the boundary two epochs after the
    snapshot; reserves and treasury tracked; withdrawals then checked against
    local reward balances.
4d. **Conway governance**: DRep/SPO/CC vote tallies, ratification and
    enactment of parameter changes, hard-fork initiation, treasury withdrawals.

## Order of execution

Phase 0 → Phase 1 (2 → 1 → 3 → 4 → 5) → measure blocks/s from genesis with the
profile → Phase 2 → Phase 3 → Phase 4. Status log at the bottom of this file.

## Status

- 2026-09-04: plan written; execution started with Phase 0 and Phase 1.
- 2026-09-04 Phase 0 done: VRF proofs verified in both eras (TPraos seeds
  `blake2b(slot‖η0) XOR blake2b(u64be 0|1)`, checked on real preprod headers with
  Koios nonces, `vrfInputs.test.ts`); Shelley+ slot monotonicity; block body size;
  strict missing-input apply under a complete ledger.
- 2026-09-04 Phase 1 code landed: `workers/witnessJob.ts` (ed25519 on the pool),
  `rules/witnesses.ts` (vkey, bootstrap, Byron per-input witnesses; address roots
  from raw CBOR), `rules/requiredSigners.ts`, `rules/nativeScript.ts`,
  `rules/txRules.ts` (Shelley→Conway), `rules/byronTxRules.ts`,
  `rules/blockRules.ts` (one UTxO query + one witness job per block), wired into
  `validateBlock` for every era. Unit tests green (224 total). Live from-genesis
  soak in progress; `scripts/validate-stored-block.ts` replays a stored block
  against a ledger DB inline for debugging.
- Deferred inside Phase 1 (report-only until confirmed on mainnet history):
  Mary/Alonzo multi-asset min-UTxO formula, Byron fee-policy size basis,
  Conway reference-script fee tier, invalid-marked (phase-2) transactions.
- 2026-09-04 live soak findings (mainnet from genesis, scratch DB):
  1. Byron inputs are `{txId, index}` not `{utxoRef}`: the first mainnet tx
     (slot 3313) read as "malformed input" — `utxoRefOf` now accepts both.
  2. **Pre-existing ledger bug.** `applyByronTxPayload` used `tx.hash` as a
     property; on `ByronTx` it is a method, so every Byron transaction output
     was stored under the method's *source text* as its utxo_ref. No Byron
     output was ever spendable; every later Byron tx spending one was applied
     with the input silently skipped. The strict rules caught it at the second
     mainnet transaction (slot 3336). Fixed; `byronRealTx.test.ts` replays the
     real slot-3313 tx (witness verifies, output stored under the real id).
     Every existing from-genesis DB is wrong for the Byron era and must be
     resynced.
  3. Redemption transactions (AVVM) are fee-exempt; the fee report skips them.
  4. **Second pre-existing ledger bug.** Byron outputs were stored with
     address `"[object Object]"` (ByronAddress has no `toString`), so Byron
     addresses were never indexed and the required-signer rule could not read
     the spent address. `addressToString` now stores base58 for Byron and
     bech32 for Shelley addresses on both apply paths; the regression test
     checks the stored address parses back to a Byron address.
- 2026-09-04 Phase 2 code landed:
  - `rules/overlay.ts`: TPraos overlay schedule (exact rationals), tested.
  - `rules/leaderMath.ts`: leader threshold with the bound following the value
    length (2^256 Praos, 2^512 TPraos — the old constant was 2^256 for both).
  - `db/leaderState.ts`: `pool_params` (VRF key, retirement epoch),
    `opcert_counters`, `genesis_delegs` (effective after the stability window),
    `epoch_pool_stake` / `epoch_stake_totals` snapshots; `utxo.stake_key`
    column (+ backfill) feeds the snapshot: UTxO by stake credential joined to
    delegations to registered pools, plus reward balances.
  - `rules/leaderCheck.ts` on the main thread after the worker's crypto:
    overlay slot → scheduled genesis delegate with its VRF key, inactive slot →
    no block; Praos slot → registered pool, VRF key binding, σ threshold;
    opcert counter monotonic. Strict: schedule, registration, VRF binding.
    Report-only until the snapshot is proven against a reference: σ threshold,
    opcert counter.
  - Orchestrator: epoch-boundary hook (retire pools, take snapshot) inside the
    range transaction; opcert counters recorded after apply; the header
    validators no longer gate on the genesis-delegate stand-in.
  - Soak: preprod from genesis (Shelley at epoch 4, d = 1 → overlay path first).
- 2026-09-04 preprod soak (Phase 2) first findings:
  - `Value.toUnits()` in ledger-ts labels the ADA entry `""` when the policy is a
    Hash object; the rules now read `Value.map` directly (`rules/value.ts`).
  - The Shelley apply path stores the ADA entry of a Value under the empty
    policy in the `assets` JSON as well as in `amount`; the stored-value parser
    counts it once. Strict conservation caught it on the second Shelley
    transaction of preprod (slot 86440).
  - Strict failures now dump the offending block to
    `$GEROLAMO_FAILED_BLOCK_DIR/failed-block-<slot>.hex`; the replay harness
    accepts `--hex` for offline debugging without a network.
- 2026-09-04 Phase 3 code landed: `rules/alonzoRules.ts` (datums, collateral,
  ex-unit caps, redeemer ↔ purpose, script-data-hash presence) wired for era ≥ 5;
  block-level ex-unit caps; `rules/plutusEval.ts` Phase-2 shadow (buildooor
  script contexts + plutus-machine) reporting mismatches only. Library note:
  buildooor bundles its own ledger-ts and plutus-data copies; the shadow feeds
  it root-ledger objects and reports anything it cannot evaluate.
- 2026-09-04 Phase 4 code landed: 4a external nonce use now warns (from-genesis
  sync already derived every preprod epoch locally); 4b `consensus/pparams.ts`
  records Shelley…Babbage update proposals at apply and derives each new
  epoch's parameters locally at the boundary (genesis → carry-forward + quorum
  updates), parameter reads are local-first; 4c `consensus/rewards.ts` (pure
  Shelley reward calculation, tested) + `epochRewards.ts` boundary accounting:
  reward pots (reserves from max supply − UTxO, treasury, fee pot), blocks
  made per pool per epoch, per-credential stake snapshots, rewards computed
  from the "go" snapshot and paid one boundary later. Amounts are informational
  until verified against a reference; withdrawals are not yet checked against
  them. 4d Conway governance not started.
- 2026-09-04 Phase 4 additions: withdrawals are compared with the local
  reward balances (report-only, `rules/txRules.ts` 8b); the first Shelley
  epoch nonce is seeded from `shelleyGenesisHash` (equal to the mainnet epoch
  208 nonce per Koios) so no epoch nonce needs an external source on a
  from-genesis sync. Phase 3 preprod soak (Shelley→Mary, 30 min): zero
  failures, zero reports; Plutus shadow not yet exercised (Alonzo begins at
  preprod epoch 7). Phase 4 soak running from epoch 6 to exercise the boundary
  accounting.
- 2026-09-04 Phase 4 soak incident (preprod 6→7 boundary, after a mid-epoch
  restart): the nonce evolver was restored with ηv/ηc but not ηh, so TICKN
  produced η0(7) = ηc alone; that value replaced the correct one in the cache,
  every epoch-7 header failed and all six peers were flagged malicious.
  Fixes: the bootstrap now restores ηh from the previous hash of the last block
  before the epoch (`getLastBlockBefore`), and a TICKN result that disagrees
  with a value already known (DB / validated) is logged and dropped, resetting
  the evolver instead of poisoning the cache. `nonceEvolver.restore.test.ts`
  proves restart equivalence. Also seen: pools registered before the
  `params_json` column carry no reward parameters (fresh syncs are unaffected).
- 2026-09-04 Phase 4 soak, epoch 7→8 (Alonzo): evolver restored with ηh,
  TICKN agreed with the known nonce, rewards computed at the boundary
  (idempotent across restarts now). Two false halts fixed on the way:
  the fee size must exclude the `isValid` byte from Alonzo on
  (`feeSizeBytes`, checked against a real preprod tx), and the legacy
  validator's multi-asset balance check disagreed with the exact conservation
  rule — the legacy class now only keeps what the rules do not cover
  (tx count, script decode policy, certificate sequence, size limits).
- 2026-09-04 Phase 4 soak, epochs 8 and 9 (Alonzo): zero failures, zero
  reports; a real quorum update (protocol version) applied locally at epoch 9;
  TICKN agreed with the known nonces; rewards computed once per boundary.
  Headers of the next epoch arriving before the boundary block now get η0 from
  the evolver's frozen candidate (`peekNextEpochNonceHex`) instead of an
  external fetch.
- 2026-09-04 Phase 4 soak, epochs 10 and 11 (Alonzo): zero failures, zero
  reports; next-epoch nonces derived locally ahead of the boundary and confirmed
  by TICKN. The Plutus shadow now logs cumulative evaluated / skipped /
  mismatch totals so its coverage is visible; preprod's first Plutus
  transactions are still ahead of the soak.
- 2026-09-04 UTxO metadata. The race soak halted on "locked by a Plutus script
  but carries no datum": every Babbage inline datum had been dropped at apply
  because `extractLedgerTxOutMetadata` tested `instanceof Hash32` / `isData`
  against objects built by ledger-ts's nested plutus-data copy. It now reads
  datum options and reference scripts from the output's own CBOR (map and
  legacy array forms, script hash = blake2b_224(lang ‖ script)); fixture test
  from the halting block. The race-soak DB (synced with the old extractor) is
  therefore inconsistent for inline-datum outputs and is retired; the
  from-genesis run carries the proof from here on.
- 2026-09-04 Parameter updates decoded from the body bytes. The from-genesis
  run rejected the first block of preprod epoch 6 as "inactive overlay slot
  (d=1)": Koios has d = 0 from epoch 6, our local record still had d = 1.
  The epoch-5 proposal carries only `d := 0` and protocol 4.0, and ledger-ts's
  partial-parameter decoder has no model for decentralisation (or extra
  entropy), so the recorded proposal was protocol-version-only.
  `updateProposalsFromBodyBytes` now decodes the `protocol_param_update` map
  (keys 0–24, Shelley…Babbage) straight from the body CBOR, so no field can be
  dropped (fixture test on the real epoch-5 proposal). Headers that arrive
  ahead of the boundary are now judged with the coming epoch's derived
  parameters (quorum update + era genesis) instead of a plain carry-forward.
  The from-genesis run was wiped and restarted on this build.
- 2026-09-04 Verification tooling against Koios for the from-genesis run:
  `scripts/verify-params.ts` (every local epoch record vs `epoch_params`,
  including cost-model arrays), `scripts/verify-stake.ts` (per-epoch total
  active stake and the largest pools' stake vs `epoch_info` /
  `pool_history`), `scripts/verify-pots.ts` (per-boundary treasury deltas and
  the reserves/treasury pots vs `totals`), `scripts/verify-fast-vrf.ts`
  (VRF verifier agreement on stored headers). The σ threshold, opcert counter
  and withdrawal rules flip to strict once these agree over the run.
- 2026-09-04 Reward timing aligned with the ledger. The first from-genesis
  run reproduced Koios's treasury deltas one boundary late (our +9T landed
  into epoch 6, the chain's into epoch 5). `runEpochRewards` now follows
  NEWEPOCH/RUPD exactly: the update applied at the boundary into e uses the
  reserves at the start of e − 1 and the fees collected during e − 2 (both
  kept per epoch in `pot_snapshots`), the blocks of e − 2, the stake
  distribution that led e − 2 and the parameters of e − 1; the treasury cut,
  reserves movement and member/leader rewards all land at that boundary (no
  pending queue). Pre-Shelley performance epochs contribute no blocks and no
  stake, which is how the chain's first cut (9T into preprod epoch 5) arises.
  Shelley genesis mapping completed (e_max, n_opt, a0, rho, tau,
  min_pool_cost, minor version, extra entropy) with a startup repair. Run
  restarted from genesis for the numeric check.
- 2026-09-04 From-genesis preprod run (build with all of today's fixes),
  epochs 4–10: treasury deltas per boundary equal Koios `totals` to the
  lovelace (0 ppm, incl. the Alonzo boundary once the update used the
  parameters of e − 2 as `esPrevPp` does), reserves and fee snapshots equal
  Koios per epoch, every local parameter record equals Koios `epoch_params`,
  stake snapshots equal Koios active stake, zero rule reports, zero halts,
  ~300 blocks/s. Mainnet from-genesis run started in parallel
  (`/media/bakon/data/cardano/gerolamo-mainnet-genesis`, port 3033).
- 2026-09-04 (later) Preprod from-genesis run reached epoch 29 with zero
  body-rule reports, then halted on the *legacy* script-provision gate, which
  reads `body.referenceInputs` (ledger-ts: `refInputs`) and so never sees
  reference scripts — the rules had already resolved the reference input and
  passed. That gate is report-only now (the rules own the check). Second
  finding from the same block: "cost model missing for PlutusV2" — the Vasil
  proposal was recorded as `{"cost_models":{}}` because `JSON.stringify` was
  called with a key-whitelist replacer, which strips nested keys; proposals
  are now serialised with `canonicalJson` and the Vasil block is a fixture
  test (166 V1 + 175 V2 values survive). Preprod resynced from genesis on
  this build; mainnet restarted on it while still in Byron. Also seen once:
  a σ = 0 leader report for a genesis pool right after an epoch boundary
  (single header, pool made 7185 blocks that epoch) — kept report-only until
  the from-genesis run shows whether it recurs. Open: from preprod epoch 14
  (≈60 blocks/epoch, η ≈ 0.003) our reward pot is 3.3% below Koios's while
  blocks, reserves, fees and parameters all agree; mainnet (η ≈ 1) will show
  whether the formula or a preprod-specific detail is behind it.
- 2026-09-04 (evening) Preprod epoch 30 halt: a transaction spent, in the
  same block, a script output created by the previous transaction; the
  in-block resolved set only carried address/value/hasDatum, so the datum
  rule saw "no datum". Outputs created earlier in a block now enter the
  resolved set with datum hash, inline datum and reference script (same
  extractor as the UTxO writer). Also: per-pool stake snapshots are kept for
  every epoch so headers replayed by lagging verifier peers can still be
  checked (σ = 0 reports were for the genesis pools' own headers, so the
  lookup — not the stake — is what fails; the report now names the issuer and
  snapshot size); the Plutus shadow summary lists its top skip reasons.
- 2026-09-04 (evening) Preprod epoch 30, second halt: "missing redeemer:
  cert index 0" for a script stake *registration* — registrations, pool
  certificates, genesis delegations and MIRs need no witness from their
  credential and therefore no redeemer (the delegation that followed had
  its redeemer at index 1). Fixed with a test. Headers that run several
  epochs ahead of the applier now derive their parameters from the nearest
  stored record instead of fetching externally; Babbage records use the
  Blockfrost naming for the per-byte price so the local/external comparison
  stays quiet.
- 2026-09-04 (night) Epoch nonces in the Praos era. Epoch-31 headers failed
  their VRF check: the local evolver had produced wrong η0 for every Babbage
  epoch (external fetches had masked it since epoch 13). Cause: the Praos
  block nonce is `blake2b_256(blake2b_256("N" ‖ vrf_output))` (`vrfNonceValue`
  then `mkNonceFromOutputVRF`); the evolver hashed the raw output once, as
  TPraos does with its separate nonce VRF. With the fix a replay of all
  stored headers from the Shelley start (`scripts/verify-nonces.ts`,
  `utils/nonceReplay.ts`) reproduces every preprod epoch nonce 5–30 exactly.
  The evolver's state is now rebuilt from stored headers on restart (from the
  epoch-start ηv/ηc persisted at TICKN, or from the Shelley start when absent)
  and after every rollback, instead of trusting a persisted mid-epoch state
  that a fork can invalidate.
- 2026-09-04 (night) Preprod epoch 34 halt: "script … required but not
  provided" for a PlutusV1 script that its author had CBOR-wrapped twice
  (19 bytes on chain). The ledger hashes witness scripts over the bytes as
  given; ledger-ts normalises the wrapping and hashes 18 bytes, so its hash
  can never match the address. `witnessScriptHashes` now hashes every
  witness script from the original witness-set bytes (native: tag 0 over the
  script CBOR; Plutus: tag 1/2/3 over the bytestring content) and the rules
  accept either hash. Fixture test from the halting block.
- 2026-09-04 (night) Preprod epoch 35 halt: a body listing every input twice.
  Up to Babbage the inputs field decodes into a set, so the repeats collapse
  and the transaction is valid; Conway rejects repeated set elements.
  `ledgerInputs(inputs, era)` applies that in the value, Alonzo and Plutus
  paths (tested).
- 2026-09-04 (night) Plutus shadow: it had skipped every transaction since
  Phase 3 — buildooor bundles its own ledger-ts/plutus-data and rejects the
  root copies' objects (`hashData only works with Data`). `rules/plutusEval.ts`
  now rebuilds the body, witness set, resolved UTxOs, datums and scripts from
  raw bytes with buildooor's classes, converts every Data for the UPLC machine
  through CBOR into the root copy, takes script hashes from the bytes as
  carried and strips extra CBOR wraps before decoding flat programs.
  `scripts/shadow-tx.ts` runs one on-chain transaction through it with
  Koios-resolved inputs: real preprod V1 and V2 spends evaluate with the
  chain's verdict. Consolidated picture: `docs/VALIDATION_STATUS.md`.
- 2026-09-04 (night) Preprod epoch 40 halt: a mint whose policy is a *native*
  script supplied as a reference script (`[0, script]` in the referenced
  output). Reference scripts were all taken for Plutus, so the rules demanded
  a redeemer and collateral. Native reference scripts are now decoded and
  evaluated like witness native scripts. The in-node Plutus shadow also
  failed on a network-name lookup (`g.shelleyStartSlot`); it uses the
  process-wide geometry now.
- 2026-09-04 (night) Plutus shadow over real history: 1024 redeemers
  evaluated, 0 skipped, every script succeeded, but 28% of transactions were
  flagged "exceeded its declared budget" by a few thousand CPU units (memory
  exact). Cause in `@harmoniclabs/plutus-machine`: bytestrings and integers
  were measured in bytes where the ledger uses 8-byte / 64-bit words
  (`((n − 1) quot 8) + 1`, `integerLog2 quot 64 + 1`); two `equalsByteString`
  calls on 32- and 12-byte strings account for the exact overcount. The
  library is patched via `patches/@harmoniclabs%2Fplutus-machine@2.1.3.patch`
  (3.0.3 has the same measures); `rules/plutusMachineSizes.test.ts` pins the
  measures and the flagged transaction now evaluates within budget.
- 2026-09-05 Rewards verified pool by pool against Koios (preprod boundary
  into 47, `scripts/recompute-rewards.ts`). Three corrections: (1) apparent
  performance is β/σ_a *uncapped* (`mkApparentPerformance` in the ledger),
  so a pool that out-produced its stake share earns above maxPool — our cap
  at 1 was the "2.4% pot gap"; (2) rewards of unregistered reward accounts
  go to the treasury (Δt2), not back to the reserves — on preprod that is the
  three genesis pools' operator rewards, and the per-boundary treasury delta
  now matches Koios to 0.02%; (3) pool parameters are snapshotted with the
  stake snapshot and the reward for an epoch uses the parameters of the
  snapshot that led it. Also: a re-delegation now replaces the previous
  delegation row (the snapshot picked an arbitrary one before). Per-pool
  totals equal Koios; the leader/member split differs only where Koios
  reports an owner's share as a member reward. A clean preprod resync
  (`gerolamo-preprod-genesis2`, port 3034) carries the from-genesis proof of
  the corrected accounting while the first run continues toward Conway.
- 2026-09-05 Plutus shadow hang: the original preprod run spun for 25 minutes
  on one block after a burst of big-integer CBOR warnings. The machine had
  no budget limit, so a script the chain rejected for exhausting its budget
  ran on without bound. The vendored plutus-machine patch adds a hard limit
  (`machine.maxBudget`) that aborts at the redeemer's declared ex-units, the
  shadow treats that as a failed script, and Data objects now cross library
  copies by structural clone instead of a CBOR round trip.
- 2026-09-05 Clean resync, boundaries 8–13 came out +3.3%: before Babbage
  the ledger *prefilters* rewards (`hardforkBabbageForgoRewardPrefilter`) —
  a reward for an unregistered account is not computed, its share stays in R
  and returns to the reserves; from protocol 7 it is computed and forfeited to
  the treasury. Implemented on the protocol version of the parameters in
  force (tests for both sides). The block that stalled the original run is
  not a loop: the JS machine needs ~30 s for nine heavy redeemers the
  reference runs in milliseconds. The shadow now caps each redeemer at 2 s
  wall-clock (patched `maxBudget.deadlineMs`) and reports the skip; a faster
  (native/WASM) evaluator is a prerequisite for strict phase 2 on mainnet.
  All three runs restarted; the clean resync from genesis again.
- 2026-09-05 σ-threshold reports explained: with issuer and snapshot in the
  report, every remaining case is a canonical block (hash equal to Koios)
  that won its slot by a tiny margin — e.g. preprod slot 13858152, margin
  1.8 × 10⁻⁴ of the threshold — while our snapshot stake for the pool was
  0.13% below the chain's (2,307,768,691,403 vs 2,310,672,552,949), the
  residue of the reward differences fixed today. The threshold arithmetic
  itself agrees with an 80-digit reference on 400 random cases. σ can only
  go strict once per-delegator snapshots are exact, which the clean resync
  will show (`scripts/verify-stake.ts`, per-delegator comparison).
- 2026-09-05 The original preprod run (port 3032) was stopped at slot
  18.46M: in the Plutus-heavy epochs 46+ it managed ~2 blocks/s while
  sharing the machine with the clean resync, which will pass it within the
  hour and continues as the single preprod run toward Conway.
- 2026-09-05 Clean preprod resync, genesis → epoch 30, zero halts: treasury
  delta of every boundary 6–29 equals Koios to the lovelace (0 ppm), all 26
  parameter records equal, all 24 epoch nonces equal. Next checkpoints on the
  same run: per-delegator stake and pool-by-pool rewards in the Babbage
  epochs (from epoch 40), Conway at 163.
- 2026-09-05 Shadow cost: with the shadow sampling every second Plutus
  transaction at a 300 ms cap the resync ran ~26 blocks/s in Babbage,
  main-thread bound; sampled 1-in-50 at 100 ms it runs ~90 blocks/s. The
  shadow's remaining disagreements are budget accounting details (e.g. a
  memory overcount of 98 units on preprod slot 12005351 with CPU under the
  declared budget), to be settled with a reference-speed evaluator before
  phase 2 goes strict.
- 2026-09-05 Clean resync, Babbage epochs 30–41: treasury deltas exact except
  −68 / −66 ppm at boundaries 33 and 35; per-delegator stake exact for most
  accounts, but accounts that had *withdrawn* rewards carried far too much
  stake (Koios 95 818 vs ours 65 957 107 lovelace): `applyTransaction`
  guarded the withdrawal debit with `Array.isArray` on ledger-ts's
  `TxWithdrawals` object, so no withdrawal was ever applied and reward
  balances only grew — inflating snapshots, σ and owner shares. Fixed
  (`withdrawalEntries`, tested); preprod resync and preview restarted from
  genesis, mainnet resumed.
- 2026-09-05 Preview run failed its first Shelley header ("no epoch nonce for
  epoch 1" at slot 21 600): header validation jobs did not carry the network
  name, so worker threads used the default (preprod) slot→epoch geometry —
  harmless on preprod, wrong on preview (86 400-slot epochs from slot 0) and
  on mainnet from Shelley on. The job config now pins the active geometry in
  every worker. Preview restarted from genesis; mainnet restarted (still in
  Byron, where the geometry coincides).
- 2026-09-05 Clean resync, epoch 41 after the withdrawal fix: zero withdrawal
  disagreements over 41 epochs (rule 8b is strict now), treasury deltas exact
  (−68/−66 ppm at 33/35), per-delegator stake exact to 0.0005% for pool
  baba8f, pool reward totals equal Koios for every pool checked. The
  leader/member split still differed where a pool had re-registered: we
  applied re-registrations at once, the ledger applies them at the next
  boundary (`psFutureStakePoolParams`, POOLREAP after SNAP). Re-registrations
  now wait in `pool_params_pending` and the boundary runs in ledger order
  (reward update → snapshot → pending params → retirements). The reward η
  also used a hard-coded 432 000-slot epoch; it takes the genesis epoch
  length now (preview: 86 400). Preview restarted from genesis; the preprod
  resync continues toward Conway and gets a final from-genesis proof run
  after the remaining fixes.
- 2026-09-05 Withdrawal rule back to report-only: strict, it halted at once
  on a 363-lovelace difference for one account (reward paid before the
  re-registration timing fix). Per-account exactness needs the final
  from-genesis run; the rule flips (`WITHDRAWALS_STRICT`) when that run shows
  zero disagreements.
- 2026-09-05 Known limitation: a few preprod outputs carry malformed
  addresses (e.g. `addr_test1prvpskpgsd…`, 29 bytes: header 0x08 then CBOR
  fragments of a Byron-style structure) that neither ledger-ts nor db-sync
  (Koios `address_info` returns nothing) can decode; the chain accepted
  spending them. The rules report "unparseable address" and require no
  witness for such inputs. A lenient decoder now handles addresses whose only
  defect is an out-of-range network nibble.
- 2026-09-05 Preprod epoch 47, strict header failure "not a registered pool"
  on a canonical block: the pool had retired at that boundary, but Praos
  judges a header by the epoch's stake distribution (stake and VRF key from
  the snapshot that leads the epoch), so a pool retired at the boundary still
  forges through the epoch. The registration and VRF-binding checks now read
  the epoch snapshot's pool parameters (`epoch_pool_params`), with the live
  registry only as a fallback for older databases.
- 2026-09-05 Preview stalled at the epoch 9 boundary: every header of the
  epoch failed the VRF check. The applied nonce (`d135d1…`) was preprod's
  epoch 9 nonce: a verifier had just been promoted to primary, the
  re-anchoring reset the nonce evolver, the header stage asked for the next
  epoch's η0 while the evolver was inactive, and the external fallback went
  to the preprod mirror (Blockfrost preview answered 403). Fixes: the
  evolver is re-activated from the applied tip before any lookup; when the
  local derivation is authoritative (sync from genesis, live evolver, or a
  locally derived previous epoch) no external value is consulted and the
  batch waits for the applier instead; a stored external row is re-derived
  and replaced when the evolver disagrees; preview has no fallback mirror.
  After the restart epoch 9 re-derived to `9aebf0…` (Koios agrees), epoch 10
  too, and the run continued. `verify-nonces.ts` also had two defects that
  only showed on preview (ηv = ηc = η0 at any start epoch, no carried ηh,
  preprod geometry): fixed; preview epochs 1–10 replayed from the Shelley
  start all equal Koios, and a replay from the recorded epoch 8 start state
  reproduces 9–10.
- 2026-09-05 Preview halted at slot 1256352 with three inputs "not in the
  UTxO set". The ledger was right: the blocks that created them (slots
  1256247–1256306) were never applied. A range had failed on every peer,
  the pipeline reset and switched primary while the previous range was
  still applying, and the scheduler then advanced its apply sequence past
  the first range re-submitted after the reset (a 150-block hole); the next
  range applied on top of it. Fixed in `RangeScheduler.applyInOrder`
  (regression test). The applier now also checks that every block extends
  the applied chain (previous hash = DB tip, or the previous block of the
  range) before touching the ledger, so a hole can only ever cause a reset
  and a re-anchor, never a ledger halt. The transaction had rolled back, so
  the preview database is intact through slot 1253219; resumed from there.
  The preprod resync and mainnet runs restarted on the fixed code.
- 2026-09-05 Preprod resync stopped applying at slot 21835891 while the main
  thread ran at 100 %: the next block carries two transactions whose 166-byte
  V2 script exponentiates by squaring (9.3·10⁹ CPU declared). Reproduced
  offline with `scripts/shadow-tx.ts`: the evaluator charged the startup cost
  and never charged again, i.e. it was inside one `multiplyInteger` on
  integers of ~10⁶ words, which JavaScriptCore multiplies in quadratic time.
  The wall-clock cap is checked between budget charges, so it could not fire.
  Fixes (vendored patch + shadow): a per-step CPU cap refused before the
  builtin runs, an immediate deadline check after any heavy step, and a
  prescreen on the declared CPU. The same transaction is now skipped in 3 s
  with the reason recorded; strict phase 2 needs a different integer
  implementation, noted under the open items. Preprod resumed from its tip.
- 2026-09-05 Preprod resync halted at slot 22056832: "stake key already
  registered". Koios shows that block's transaction as the key's first
  registration; the twin is a *script* credential with the same 28 bytes,
  registered 178 slots earlier (tx 38951271…). Our tables and the
  certificate rule keyed credentials by hash alone. Fixed with a credential
  type column and typed rule keys (bug 30). The opcert-counter reports
  (bug 31) turned out to be lagging-verifier replays of applied history;
  the rule now ignores headers at or before the block that set the counter.
  Resumed from the tip; the stake table now records the type for new rows.
- 2026-09-05 σ reports explained: the eight failing headers are all within
  1e-4 of the threshold and our snapshot deviates from Koios by that much
  (pool stake slightly low, total active slightly high). Not a rule bug; a
  small stake-snapshot difference to hunt with `verify-stake.ts` at epochs
  44–54 (running).
- 2026-09-05 Stake snapshot deviation found: per-delegator comparison with
  Koios (`pool_delegators_history`, epoch 54) showed the same delegator sets
  with a few accounts far too high on our side; account 0c6aa3ec… had 830
  UTxOs at script-stake addresses (`addr_test1x…`) whose stake part is the
  *script* hash, not the delegated key credential. `utxo.stake_key` kept the
  hash only. Typed credential keys now run through the UTxO index, the
  snapshot join, registered/reward sets, withdrawals and governance return
  accounts (bug 32); the migration retagged 2 271 preprod outputs at restart.
  The remaining small per-pool deficits (−1e-6…−5e-6) are the reward split
  differences already known; the final from-genesis run settles them.
- 2026-09-05 Stake and reward accounting, continued. The per-delegator
  comparison at snapshot 60 (after typing the credentials and rebuilding
  the types of legacy rows from the certificate history) left +8·10⁹ on the
  total: one account still counted as delegated to a pool that had retired
  and re-registered (delegations survived retirement), and several pools
  short by exactly 500 ADA (pool deposit refunds never credited). Both are
  Shelley POOLREAP effects, now implemented (bug 33). The reward deficits at
  boundaries 33 and 35 (−68 / −66 ppm on the treasury delta) are the two
  snapshots that lack a short-lived pool (open item 6a): with the ledger's
  larger active total every pool's apparent performance is 0.29 % higher.
  Also fixed: duplicate redeemers in a pre-Conway transaction (bug 34,
  preprod slot 24837046). MIR certificates remain unapplied (6b).
- 2026-09-05 Why rewards drift with the snapshot: apparent performance is
  n·activeTotal/(N·poolStake), so an error on the active total moves every
  pool's reward by the same factor. Preview's snapshot 55 was +0.52 % (script
  stake conflated, delegations to retired pools kept) and every pool reward
  of performance epoch 56 came out +0.52 %; preprod's snapshots 30/32 were
  −0.29 % and the rewards of epochs 31/33 −0.29 %. The reward formula itself
  is confirmed once more (pot, τ·pot, fees, blocks all equal). After the
  typed-credential and retirement fixes the preview snapshot 58 is +1.8·10⁻⁵
  and preprod's 62 +3·10⁻⁵, both now dominated by reward balances that carry
  the earlier over-payments — the final from-genesis run resets those.
  MIR certificates are implemented (queued at application, applied at the
  boundary after the reward update, before the snapshot; unit-tested; not
  yet exercised by a real chain). Preview: parameters 0–57 and nonces 1–56
  equal Koios.
- 2026-09-05 Preprod snapshot 65 (after the delegation rebuild) is −5·10⁻⁶
  from Koios, the closest so far; the remainder is reward balances. A fresh
  preprod from-genesis run (`gerolamo-preprod-genesis3`, port 3036) starts
  on the current code for the exact proof while the resync continues toward
  Conway.
- 2026-09-05 σ reports after the fixes: preprod's two (snapshot 64, taken
  before the delegation rebuild) sit 3·10⁻⁵ above the threshold, preview's
  (snapshot 56, before the credential fixes) up to 5·10⁻³ — both inside the
  stake error of the snapshot they used. No opcert-counter reports since the
  rule was scoped. Both rules stay report-only until the fresh preprod run
  shows a clean epoch on exact snapshots; then they flip to strict. Work
  continues on branch `full-validation-2026-09` (nothing committed).
- 2026-09-05 Mainnet entered Shelley and stopped twice within its first
  epoch: a Byron block with a zero-lovelace output (bug 37, Byron allowed it)
  and a Shelley transaction paying to a Byron bootstrap address, which
  ledger-ts decodes as an `Address` of type "byron" with a meaningless
  network (bug 38). The same decoding truncates the address to 28 bytes, and
  that bogus bech32 is what we had been storing for such outputs — the
  "malformed addresses" seen on preprod, whose spends could not be
  witness-checked. Outputs now serialize to base58 rebuilt from the CBOR
  slice (bug 39); a one-off migration rewrote 546 unspent mainnet outputs.
  Fixture test with the mainnet block at slot 4493980.
- 2026-09-05 Mainnet's first MIR (ITN rewards, tx 35d2728e… at slot 4563840,
  200 entries per certificate) could not be decoded by ledger-ts: the
  certificate dispatcher hands the whole `[6, [source, destination]]` to a
  decoder that expects the inner pair, so the range pipeline reset in a loop.
  Fixed in the sibling `../cardano-ledger-ts` source (uncommitted there),
  vendored as 0.5.6 (bug 40). After the restart the node queued 22 674 MIR
  entries totalling 593 529 326 186 446 lovelace, against Koios's reward pot of
  593 536 826 186 446 at epoch 209 — the boundary into 210 will show whether
  the credit and the reserves match.
- 2026-09-05 Mainnet epoch 209/210: the MIR credit landed exactly (our
  reserves after it equal Koios to 1 lovelace), but the next reward update
  read the pre-MIR reserves because the pot snapshot was recorded before the
  MIR and POOLREAP steps (bug 41; snapshot now refreshed at the end of the
  boundary, mainnet pots corrected by hand to Koios's epoch-210 values). The
  first mainnet rollback then exposed that rollbacks never reverted the UTxO
  set — hex-text block hashes joined against blob delta hashes (bug 42) — and
  the re-applied block failed on its own inputs. Fixed with hex() matching,
  an index on the delta table, and a one-off revert of orphaned deltas.
- 2026-09-05 Mainnet epoch 211 (d = 0.9, the first epoch with pool blocks):
  the overlay schedule used floor where the ledger uses ceiling, so the
  genesis delegate's block at the first slot was judged a Praos slot and
  rejected (bug 43). Preprod and preview never went through 0 < d < 1 on our
  code, which is why the mainnet run was needed. Fixed with tests built on the
  mainnet genesis keys; the run continues.
- 2026-09-05 Mainnet epochs 212–215 against Koios: parameters 208–215 equal;
  pots exact through 212 except the boundary we corrected; then two reward
  rules surfaced that only the d > 0 era exercises — pools without blocks
  were paid (bug 44) and η counted genesis-delegate blocks (bug 45). Koios's
  leader/member split differs from ours only in presentation (it books the
  owner's stake share as delegator reward; pool totals agree to the pot
  difference). The mainnet ledger now holds 4.37·10¹² of rewards the chain
  never paid, so the run restarts from genesis on the fixed code; the old
  database is kept as `mainnet-run1.db` for a while.
- 2026-09-05 Preview epoch 134: a transaction with both PlutusV1 and
  PlutusV2 scripts failed the script-data-hash check. The language-views map
  must be in canonical CBOR key order, V2 (`01`) before V1 (`4100`); the
  cost-models library emits V1 first (bug 46). Fixed by assembling the views
  per language and sorting them; fixture test from the block. Preview
  resumed.
- 2026-09-05 Preview epoch 149: a transaction listing the same mint redeemer
  six times breached the execution-memory limit in our sum. Pre-Conway the
  last redeemer per purpose is the effective one (bug 34 covered the
  duplicate check but not the sums); ex-unit limits, block limits and the
  minimum fee now use the effective set (bug 47). Fixture test; preview
  resumed.
- 2026-09-05 Preview snapshot 205 was −2.4·10⁻⁴ from Koios; one account
  explained it: 35.55·10⁹ at a pointer address, which ledger-ts stores
  truncated and we never resolved (bug 48). The pots script also compared
  the wrong quantity (reward-update delta vs actual treasury change) and
  fetched only Koios's first page; fixed. Preview's per-epoch treasury delta
  is within −2 ppm of Koios apart from the retirement-refund epochs.
- 2026-09-05 16:06 UTC the kernel killed the mainnet node at 24 GB anonymous
  RSS with under 1 GB of JS heaps: native growth (open item 6c). Both nodes
  relaunched under `scripts/run-supervised.sh` (clean restart at 14 GB, resume
  from the DB), the node logs a `Memory:` breakdown every 5 minutes, and a
  kernel-side sampler records anon RSS per node every 5 minutes. Worker
  message transfer ruled out in isolation. Preview 29.2M (epoch 338),
  mainnet run 2 at 3.89M (Byron) after the restart.
- 2026-09-05 17:05 UTC OOM root cause found and fixed (bug 49): two heap
  summaries ten minutes apart showed every class doubling, led by retained
  ChainSyncRollForward messages (7 050 → 14 149) and suspended async
  functions. The header batcher's flush chain was unbounded and the
  pipeline top-up never paused; `RollForwardBatcher` now holds pushes while
  more than two batches wait for consensus. On the fixed code the mainnet
  node's main heap stays at 36–48 MB and it applies ~100 Byron blocks/s
  (was ~50). Both nodes relaunched via their supervisors. Preview 31.0M
  (epoch 359), mainnet run 2 at 4.02M.
- 2026-09-05 17:04 UTC preview halted at slot 31023089 (epoch 359): a
  transaction with an indefinite-length empty datum list and no
  script_data_hash; our emptiness check knew only the definite `80` (bug 50).
  Fixed with a fixture test; preview restarted by its supervisor.
- 2026-09-05 Block production started in parallel with the preview sync
  (user: keep preprod paused, mainnet stays since it does not slow preview).
  Keystore (`src/pool/keystore.ts`, cardano-cli TextEnvelope interop, opcert
  issue byte-identical to `cardano-cli`) and read-only leader schedule
  (`src/pool/leaderSchedule.ts`, fast draft-03 VRF prover) with tests.
- 2026-09-05 Block production: slot ticker + forge decision
  (`src/pool/slotClock.ts`) and header/empty-block forging (`src/pool/forge.ts`)
  done; a forged block passes our own header validator and body-hash check.
  Next: private cardano-node testnet to have a Haskell node accept a forged
  block, then mempool body assembly. Preview epoch 385+, mainnet 4.2M.
- 2026-09-05 Block producer service (`src/pool/BlockProducer.ts`,
  `config.producer`, `role: "producer"`): keys, opcert check, per-epoch
  schedule in a worker, slot ticker, mempool body assembly (byte-identical
  rebuild of a real 30-tx block), forging and self-adoption through the
  node's strict path. 22 pool tests. Next: a preview pool once preview is at
  tip (register from the faucet), or a private testnet if custom geometry is
  added first.
- 2026-09-05 Operator tooling (`src/pool/operator.ts`, `scripts/pool-register.ts`):
  certificates and signed registration transaction byte-identical to
  cardano-cli; keygen/opcert/register exercised against the live preview node.
  Waiting on preview reaching the tip (epoch ~427 of 1411) to fund and register.
