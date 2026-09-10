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
- 2026-09-05 20:45 UTC mainnet run 2 entered Shelley (slot 4 492 800) on the
  fixed code: Praos headers validate, no halt, epoch 208 parameters equal
  Koios, η0(208) = 1a3be38b… (the Shelley genesis nonce). The clean-state
  pots/params/stake/rewards comparison for 208–215 runs once the tip passes
  epoch 216 (slot 7 948 800).
- 2026-09-05 21:20 UTC Sync pipeline: (a) header throttle hysteresis reduced
  from two ranges to one batch (`headerResumeBelow`), and partial ranges are
  not flushed while the pause is ours, so the worker pool no longer alternates
  2 s bursts with 4 s idle; (b) every Shelley+ block's witness signatures are
  now verified by a worker as soon as the range arrives
  (`ValidationPool.verifyBlockWitnesses`, `BlockWitnessJob`), and the apply
  loop takes the verdicts instead of waiting on a per-block round trip
  (`preVerified` in the rule context). Mainnet Shelley: main-thread
  blk.validate 8.4 → 2.7 ms/block, main thread 50 % → 76 % busy,
  58.9 → 77 blocks/s (+31 %); GC helpers ≈ 5 % of a core. Tests:
  blockWitnessJob.test.ts (verdicts equal the inline path, tampered
  signature fails the same index).
- 2026-09-05 21:30 UTC mainnet run 2 stopped at the user's request (tip
  6 470 904, epoch 212; DB kept, 23.5 GB) to put the machine behind preview.
  The 208–215 clean-state comparison resumes when mainnet is restarted.
- 2026-09-05 22:30 UTC CPU profile of the preview applier (`bun --cpu-prof`,
  4 min): the hot leaves were not ledger rules but (a) the hex encoder in
  @harmoniclabs/uint8array-utils (array-of-padStart + join, ~15 %), (b) full
  CBOR parsing of every BlockFetch MsgBlock in the miniprotocols client just to
  take the block bytes out (~10 %), (c) Bun.SQL row-by-row INSERT plumbing
  (~25 % inclusive), (d) re-parsing stored bech32 addresses per tx (~7 %).
  Fixes: Bun patches for uint8array-utils (table-driven hex; equivalence test
  src/utils/fastHex.test.ts) and ouroboros-miniprotocols-ts (lazy MsgBlock
  decode); batched multi-row UTxO/delta writes flushed at tx starts and block
  end (`flushPendingUtxoWrites`, 11× cheaper per row); parsed-address caches;
  ChainSync header bytes passed without a hex round trip. Preview at epoch
  ~463 went from ~20 to 34 blocks/s; the applier is now download-bound
  (3 hot peers, 3 ranges in flight) with the main thread at ~50 %.
- 2026-09-05 Preview topology seeded with 24 reachable pool relays from the
  peer snapshot (publicRoots) so the governor reaches its hot target (was one
  peer); `/stats` gained a Resources panel (CPU, memory, blocks/s over 5/10
  min, fed by the new lightweight `GET /resources`).
- 2026-09-05 22:38 UTC preview halted at 41735103 after a rollback: the
  batched-write change had turned the rollback's spend restore into a queued,
  never-flushed write (bug 51). Fixed (flush in rollbackChainTo and
  ensureOrphanedDeltasReverted, regression test); the lost outputs were
  rebuilt from the creating blocks with `scripts/repair-missing-inputs.ts`,
  looping per halted block until the tip passed the rolled-back window.
- 2026-09-05 23:30 UTC preview fetch concurrency raised (parallelRanges 3→6,
  targetHot 3→6, targetWarm 6→10 in src/config/preview/config.json):
  34 → 87.5 blocks/s at epoch ~524, main thread 76 % busy, 6 ranges in
  flight, the applier no longer starves. Remaining serial-stage ideas:
  tx-rule evaluation and Plutus shadow in workers, per-block range verify,
  index writes off the apply path.
- 2026-09-05 23:45 UTC both mainnet validation databases deleted at the
  user's request (disk at 86 %); the desktop instance's mainnet DB is the
  only mainnet copy. The 208–215 clean-state comparison will need a fresh
  genesis sync when mainnet validation resumes.
- 2026-09-06 00:30 UTC Transaction rules pipelined: the Shelley+ block rules
  split into a database gather (`gatherShelleyBlockInputs`: resolved inputs,
  registered pools, reward balances) and a pure evaluation
  (`blockRulesPure.ts`, no SQL import so workers can load it). While block N
  applies, block N+1's rules run on a worker (`ValidationPool.evaluateBlockRules`)
  against inputs adjusted with N's effects (`shelleyBlockOverlay`: outputs
  created/spent, pools registered); skipped at epoch boundaries and when both
  blocks withdraw from the same reward account. Worker and main-thread
  outcomes equal on a 30-tx fixture; 86 tests pass.
- 2026-09-06 01:14 UTC preview stalled at 51361220: a mint map with duplicate
  policy keys that ledger-ts refused to decode (bug 52); fixed in the vendored
  ledger-ts 0.5.7 with a fixture test. The no-op rollback that followed took
  minutes because the rollback counted deltas with a full-table scan; it now
  uses the block-hash index and skips when nothing is above the slot. Parse
  failures now dump the block bytes like validation failures do.
- 2026-09-06 01:35 UTC A/B of the pipelined rules on preview (epochs 586–597,
  light Babbage blocks, rules ≈ 1.9 ms/block inline): inline 76.7 blocks/s at
  9.8 ms main-thread CPU per block; ahead-of-time 65.9 blocks/s at 11.4 ms.
  Worker compute was 2 ms but results waited ~20 ms for the main thread to turn
  its event loop, and posting the job (structured clone of the resolved inputs)
  cost more than the rules it removed. Left opt-in (GEROLAMO_RULES_AHEAD=1),
  code and tests kept. The design that should pay: workers resolve inputs
  themselves over a read-only SQLite connection (WAL readers), so the main
  thread ships only block bytes and the small overlay.
- 2026-09-06 02:36 UTC preview entered Conway (epoch 646: era 7, protocol
  9.0, Conway genesis parameters merged, Praos headers pass) and halted on the
  first governance proposal: the library never decoded body keys 19–22
  (bug 53). Fixed in vendored ledger-ts 0.5.8 with full governance decoders;
  this also makes the existing proposal/vote recording code live for the first
  time, so governance ratification on preview is now actually exercised.
- 2026-09-06 02:44 UTC preview halted on the first PlutusV3 transaction
  (bug 54: V3 language view padded to 350 entries by the cost-models library;
  now encoded from the 251-entry parameter list). Vote recorder fixed. Conway
  governance decoding, proposal deposits, V3 language views and the vote/proposal
  tables are all exercised for the first time from here on.
- 2026-09-06 02:50 UTC preview rejected the whole of epoch 647 (bug 55: the nonce
  freeze window is 4k/f from Conway, we used 3k/f). Verified by recomputing the
  epoch 647 nonce from stored headers against Koios; fixed in the evolver with a
  per-epoch protocol version. The node looped restore → reject → drop peer for
  20 minutes and marked good relays malicious, so an all-headers-fail epoch start
  should probably halt like a body failure does (open item).
- 2026-09-06 03:38 UTC preview halted at slot 57454191 (bug 56: witness datum
  slicer ignored the Conway set tag 258 → "datum not in the witness set"). Fixed
  with a fixture test; the same unwrapping now covers witness scripts. Also this
  window: HTTP GET handlers moved to a read-only SQLite connection
  (`withReadOnlyConnection`), Blockfrost `/blocks/{number}` now means height with
  `/blocks/slot/{n}` added, genesis-funded inputs resolve from the genesis registry.
- 2026-09-06 04:00 UTC explorer/mini-Blockfrost latency while syncing traced to
  three causes and fixed: (1) GET handlers queued on the writer connection behind
  range transactions → read-only connection; (2) the applier's SQLite awaits resolve
  as microtasks, so a range ran as one unbroken chain → `yieldToEventLoop` every 25 ms;
  (3) `hex(block_hash) = ?` in tx counts/listings and COUNT(*) on 17 M-row index
  tables scanned whole tables (a minute cold) → primary-key probes and MAX(rowid).
- 2026-09-06 04:20 UTC preview halted at slot 58809651 (bug 57: datum-less
  PlutusV3 spend rejected; CIP-69 makes the datum optional for V3). Fixed with
  per-script language tracking. Three Conway halts in the first 40 epochs of the
  era (54–57); each fixed from the dumped block within the hour.
- 2026-09-06 04:38 UTC preview halted at slot 61206431 (bug 58: list-form redeemer
  duplicates are legal under Conway too). Also: leader-rule verdicts cached by header
  hash (85 % of checks were repeats from verifier peers; was half the main thread).
- 2026-09-06 04:52 UTC rules-ahead A/B on preview Conway blocks (epochs 712–720):
  off 37 blocks/s at 3 cores, on 89 blocks/s at 4 cores; main-thread blk.validate
  2.3 → 0.1 ms. Now on by default (GEROLAMO_RULES_AHEAD=0 opts out). The earlier
  "no win" measurement was on light early-era blocks.
- 2026-09-06 05:02 UTC preview halted at slot 63616305 (bug 59: an enacted cost-model
  change was lost because the libraries drop lists with negative entries). First
  governance-enacted parameter change on preview handled end to end after the fix.
- 2026-09-06 05:17 UTC preview halted at slot 64848165 (bug 60: UpdateCommittee
  threshold decode, ledger-ts 0.5.9). Applier now spends from the rows the rules
  stage read (`knownInputs`), reading only in-range outputs from the UTxO set; the
  bulk DELETE count guards against stale rows.
- 2026-09-06 05:30 UTC known-inputs apply live: blk.apply 3.0 → 1.6 ms per block,
  preview 89 → 102 blocks/s at epoch ~760. ledger-ts 0.5.10.
- 2026-09-06 05:56 UTC preview halted at slot 68390403 (bug 61: language view included
  an unneeded reference script). Profiling showed the applier's remaining stall was the
  Plutus shadow evaluation inside the ahead-of-time rules job (374 of 17,664 blocks waited
  ~120 ms each); shadow evaluation now runs as its own detached job on a general worker
  (`phase: "shadow"`), the ahead job runs `phase: "rules"`. Rules lookahead now spans
  range boundaries (depth 6). Range sizer output logged (`Range target …`) to explain the
  ~46-block ranges seen despite a 256 target.
- 2026-09-06 06:06 UTC preview halted at slot 68911489 ("languages none": proposing
  purpose missing from the needed-script set) — fixed with voting/proposing purposes
  and a witness-set fallback. Idle range flush now emits the tail as one range instead
  of single-block ranges (680 of 830 ranges were singles).
- 2026-09-06 06:20 UTC main-thread budget per block on preview epochs 795–805 (13 ms
  wall): apply 2.9, epoch boundary amortised 1.8, rules gather 1.0, insert 0.4, small
  stages 0.8, ~3.6 unlabeled (worker message plumbing, network decode, GC), plus 1.4 ms
  idle waiting for slow rules results (heavy blocks after light ones). Changes: rules
  window 6 → 16, shadow jobs sampled on the main thread (one structured clone less per
  Plutus block). Remaining levers, largest first: epoch-boundary SQL (13 % on preview,
  amortises 10× better on mainnet), the gather on a worker-side read-only connection
  (~8 %), MiniBF index writes inside apply.
- 2026-09-06 06:30 UTC Plutus shadow: with evaluation detached, the per-redeemer budget
  goes back to 2 s and one Plutus block in ten is sampled (supervisor defaults). Budget
  and decoding gaps are now reported as skips (`note`), not as verdict mismatches — the
  earlier "77 mismatches" on preview were all 100 ms timeouts.
- 2026-09-06 07:55 UTC preview throughput collapse (bug 62): peers dropped on
  "Missing epoch nonce" and on false divergence verdicts left one hot peer. Held
  batches and a non-verdict for missing slots; per-header logging to debug.
- 2026-09-06 08:10 UTC after the peer fixes the applier was still at 2 blocks/s: inline
  rules evaluation ran Plutus shadow on the main thread (2 s budget) for the 80 % of
  blocks the ahead scheduler skipped over withdrawal conflicts. Inline path is rules-only
  now; the overlay zeroes withdrawn reward accounts so those blocks are scheduled ahead.
  Skip reasons are counted (`rules.skip.*`). Real Plutus finding to follow up: on several
  V3 transactions our evaluator's memory use exceeds the declared budget by ~50–80 units
  (reported as verdict mismatches; the chain accepted them) — a cost-model accounting gap.
- 2026-09-06 08:20 UTC preview at 0 blocks/s from a promotion loop: a verifier promoted
  to primary re-anchors, a late reply from its old stream (already past the drain, tagged
  with the new generation) fails the contiguity check, the stream restarts, the other peer
  looks 1600 headers ahead and is promoted back a minute later. Fix: a header whose
  predecessor we hold is dropped as a late reply (`hdr.late.drop`), not a restart; speed
  promotion cooldown 1 → 5 min.
- 2026-09-06 08:30 UTC bug 63: a false unconditional rollback of 164 blocks, then a halt
  on re-apply because certificate state is not rolled back. Rollbacks from the primary
  are now deferred until the next headers show a fork. Open: journal non-UTxO ledger
  state per block so real fork rollbacks revert it too (before mainnet).
- 2026-09-06 08:35 UTC preview halted at slot 78658821 (bug 64: script-address collateral
  on a script-free transaction required its script). Collateral contributes key witnesses only.
- 2026-09-06 08:45 UTC promotion churn closed out: late headers far beyond the stream
  position are dropped even when their predecessor is past our pending window, and speed
  promotion requires the primary to have been quiet for 5 s (a verifier lead alone is
  normal while the primary is throttled by the header cap).
- 2026-09-06 09:20 UTC ledger journal live (PLAN_LEDGER_INTEGRITY.md workstream A):
  non-UTxO state writes are journaled per block by triggers and undone on rollback;
  boundary-crossing rollbacks are refused. Next: B (pot drift ~150 ppm/epoch), C (Plutus
  +1453 cpu).
- 2026-09-06 11:10 UTC preview at epoch 1057; pots 0 ppm vs Koios for epochs 1051–1057
  (1054: −146 ppm, one epoch, under investigation) — workstream B acceptance holding.
- 2026-09-06 12:20 UTC bugs 66/67 (PLAN_LEDGER_INTEGRITY.md C): the Plutus mismatches were
  the evaluator's V1/V2 division costs (V3 defaults substituted), a `c02·y` typo in the V3
  quadratic, V3 multiplyInteger sizes, and two script-context encodings (interval closures,
  V1/V2 stake credential). Reference tooling in tools/uplc-ref; contexts identical to aiken's.
- 2026-09-06 11:51 UTC preview halted at slot 94710858 (epoch 1096): the chain's
  max_tx_ex_mem rose to 16.5 M by governance and we never enacted it (bug 68: committee
  updates required a committee vote; Conway governance-group parameters not decoded).
  Governance rules fixed, byte-level parameter decoder, `scripts/repair-governance.ts`
  applied at epoch 1096 (statuses, enactments, committee, pointers, refunds, params), restarted.
- 2026-09-06 13:35 UTC preview stalled 45 min at slot 98358104 (epoch 1138, 40 %): every
  peer's header batch crossed the epoch-1139 boundary before the nonce was derivable and
  was held whole, so the blocks the applier needed to reach the freeze point were never
  requested (bug 69). Batches are now split at the boundary (headers before it are
  validated and fetched first, the rest held); the hold warning is throttled to 30 s.
- 2026-09-06 13:36 UTC preview halted at slot 98785139 (bug 70: pool relay with a port and
  no address rejected by ledger-ts). Vendored ledger-ts 0.5.12 accepts it; restarted.
- 2026-09-06 14:35 UTC second boundary stall (epoch 1148→1149, 30 min): the split alone did not
  get the pre-boundary blocks fetched; forced range flush after the pre-boundary part, slot
  ranges logged, restarted (bug 69 addendum).
- 2026-09-06 15:10 UTC third boundary stall (epoch 1170): root cause found — a promoted
  primary's restarted stream queued behind its own held verifier batch. Held batches now
  abort on stream restart/termination. Restarted.
- 2026-09-06 15:40 UTC UI: the epoch badge shows "current / target" while syncing in all
  three surfaces — node's built-in /dashboard (`targetEpoch` in /metrics from the best peer
  tip), the Solid web dashboard (`tip.targetEpoch` from dashboard-server, whose epoch math is
  now per-network instead of preprod-only) and the desktop Control Center (clock epoch).
- 2026-09-06 17:22 UTC preview halted at the epoch-1270 boundary: cost-model change enacted on
  chain, not by us (bug 71: expired DReps counted in the tally denominator). Fixed with dormant
  epoch tracking; restarted, boundary re-run.
- 2026-09-06 17:45 UTC deferred VRF landed (bug 69 follow-up): headers of an epoch without a
  derivable nonce are accepted with KES/op-cert/chaining checked and the VRF + leader rule
  verified in bulk once the applier reaches the freeze point. Preview steady state 55 →
  97 blocks/s, hold time 0, about 4 cores (the applier's serial ~10 ms/block is now the
  next ceiling; a CPU profile of the main thread is the right tool from here).
- 2026-09-06 18:10 UTC at ~97 blocks/s the main thread is saturated: /health latency 0.2–3 s,
  one 17 s outlier (epoch-boundary work, ~6 s stake snapshot + rewards, blocks the loop; an
  epoch now passes every ~45 s). The monitor's "slot 0" reports are those timeouts, not a
  restart. Next perf items: boundary work off the main thread or chunked; applier ~10 ms/block.
- 2026-09-06 18:40 UTC boundary cost found: `rewards` had no index on `stake_credentials`, so
  every reward lookup scanned the table — 53 k payouts × 2 statements per boundary took
  12–165 s (variance = page cache under host memory pressure). Unique index added, payouts and
  payout records written as JSON-driven batch upserts, reward phases timed in the log.
- 2026-09-06 19:30 UTC main-thread SQL profile (`GEROLAMO_SQL_PROFILE=1`, per-statement timing at
  the `sql` proxy, top list every minute) after a Bun CPU profile showed 62 % of the main
  thread inside synchronous SQLite: (1) two COUNT(*) queries per /metrics poll (215 + 101 ms,
  every second) = a third of the thread → 30–60 s caches; (2) applied-block checks fetched the
  whole block blob → existence-only query, skipped when the header is pending; (3) legacy
  explorer dual-writes (tx_index / block_tx / address_tx) dropped, readers already prefer mb_*;
  (4) explorer per-row inserts folded into one JSON statement per table (little gain: the cost
  is B-tree page misses in huge tables, not statement count); (5) stake snapshot reads a
  trigger-maintained `stake_balance` table (3.7 s → 0.8 s per boundary; verified equal to the
  UTxO aggregate to the lovelace). Write counts from Bun include trigger changes: the strict
  known-inputs check and the restore count now use RETURNING. Per-block main-thread SQL
  ~11.6 → ~5.5 ms; preview ~100 blocks/s when the host is quiet.
- 2026-09-06 20:30 UTC explorer projection moved to its own worker and database file
  (`<db>.explorer.db`, src/db/minibf/explorerWorker.ts + explorerIndexer.ts): the applier posts
  per-tx deltas in ledger order, the worker applies them and rollbacks, mini-Blockfrost reads
  the explorer file (genesis-input join split into two queries). History is copied from the
  ledger DB in the background, paused while the node bulk-syncs (>20 tx/s), spent marks
  repaired after the copy. First deploy died on `BEGIN IMMEDIATE` (it also reserves the
  attached ledger DB the applier holds → SQLITE_BUSY): deferred BEGIN + busy_timeout, the loop
  survives errors. The ~20 min of blocks applied while that worker was dead have no explorer
  rows in either DB (gap, slots ≈118.75M–119.49M; needs a backfill from blocks).
  Rules-ahead prep no longer awaits the witness verdict on the main thread (4 ms/block).
- 2026-09-06 20:35 UTC explorer gap backfilled (scripts/explorer-backfill.ts, 7 724 blocks / 10 653 txs
  in 18 s with the node stopped); the history copy resumes from a saved position across
  restarts; mini-Blockfrost verified against the explorer file for recent, old and gap
  transactions. Preview at epoch 1411 of 1412.
- 2026-09-06 20:35 UTC **PREVIEW AT TIP** (epoch 1412, slot 122 070 900) from genesis under strict
  validation. Pots at tip: treasury −21 ppm/epoch relative, reserves −160 k ADA (−22 ppm): a fixed
  leak of ≈480 ADA/epoch since the alignment at 1050 — our reward payouts exceed the chain's by
  ≈1 000 ADA/epoch (chain returns undistributed rewards to reserves). verify-pots now also
  prints the actual pot movements (the per-epoch "spikes" were deposit/donation flows that the
  reward-cut column does not carry). Per-account comparison for epoch 1393 running.

- 2026-09-06 23:00 UTC reward leak at the tip explained (bug 72): the formula is exact with the
  chain's inputs (operator 30 282 766 458 and member 1 042 038 for perf epoch 1391 reproduced to the
  lovelace); our inputs were stale — reward balances carry the excess of long-fixed bugs (+2.93 M ADA
  over Koios' reward total), balances count as stake, so every snapshot total, every β and every
  reward came out +0.13 %. Repair script `scripts/repair-reward-balances.ts` (Koios snapshots →
  `epoch_stake_cred` 1410–1412, balances −= snapshot excess, pots = `totals`). Pot floor fixed
  (single floor over η·ρ·reserves).
- 2026-09-07 02:50 UTC found the node stalled since 22:30 UTC on a dead one-block fork (bug 73,
  slot 122 077 808): outvote rollback only deferred, single-point FindIntersect, origin fallback
  banning every honest peer. Fixed (immediate k-guarded rollback, multi-point intersect, no origin
  fallback when resuming). The Claude session itself was OOM-killed meanwhile; the node's RSS stayed
  ≈1 GB. Koios `pool_delegators_history` needs `order=stake_address.asc` to paginate (unordered pages
  overlap: 15 416 of 69 985 rows lost on the largest preview pool).
- 2026-09-07 03:35 UTC node back at the tip (epoch 1413) after two restarts with the bug-73 fixes; the
  fork at 122 077 808 resolved by the node itself (1 block, 22 deltas, 5 journal updates undone).
  Repair of bug 72 not applied yet: Koios quota spent (429) before snapshot 1412 and the balances
  were fetched, and the session's permission classifier refused the DB-writing scripts — the
  operator has to run `scripts/repair-reward-balances.ts … --apply` (node stopped) once Koios
  answers again; see open item 10. New open item 11: Plutus shadow mismatches on one script family
  since the 1413 boundary (costs shifted for builtins ≥ `d`).
- 2026-09-07 04:45 UTC bug 74: V1/V2 cost-model arrays of 332 entries were read with V3 names by
  the machine (language inferred from array length, V3 tested first) — since epoch 1270. Fixed in
  `machinesFor` (named V1/V2 conversion, first 166/175 entries as aiken maps them), regression
  test with the epoch-1413 cost models; node restarted 04:44 UTC. Official Blockfrost preview
  (project id from the user) now feeds `repair-reward-balances.ts --blockfrost`; Blockfrost has
  no `/epochs/1414/stakes` yet, so the balance phase waits for it (guard added; snapshots
  1411/1412 dry-run from Blockfrost in progress).
- 2026-09-07 05:45 UTC user decision: rebuild preview from a Mithril snapshot instead of repairing
  the balances (the errors are historical state; a replay with the fixed code is the honest proof).
  Mithril-fed full replay: `mithril-bootstrap --network preview --blocks-only` (preview aggregator
  added; certificate chain walk needs > 128 hops — 8192 now; 8 parallel chunk downloads ≈ 10/s;
  block store ≈ 20 chunks/s) fills `gerolamo-preview-chain/chain.db` with the certified chain
  (epoch 1413, immutable file 28 260, 15.4 GB), `scripts/serve-chain.ts` serves it over N2N on
  127.0.0.1:3101, and a fresh node in `gerolamo-preview-mithril/` (topology: that local root plus
  the public roots) replays it under the normal full validation. Progress file
  `mithril-preview/progress.json` → dashboard card (scripts/dashboard-server.ts
  `--mithril-progress`, port 3050). Old preview DB (156 GB) to be wiped when the block store is
  ready; the Koios/Blockfrost balance repair is dropped.
- 2026-09-07 06:10 UTC Mithril progress surfaced everywhere: `mithril-bootstrap` writes
  `<download-dir>/progress.json` (phase, chunks, blocks, rate, ETA); the node's `/metrics` and
  `/stats` carry it when `GEROLAMO_MITHRIL_PROGRESS` names the file and add the replay state
  ("replaying certified chain: slot x of y (N %)", then "live") from the DB tip; the web dashboard
  (scripts/dashboard-server.ts `--mithril-progress`) shows the same card. The desktop app reads
  `/metrics.mithril` (user wires its own card).
- 2026-09-07 07:30 UTC cutover done: block store complete (4 638 662 blocks, slot 122 087 503,
  23.3 GB; download 12 chunks/s, store 7.7 chunks/s, 1 h 38 min in total), old preview DB and
  scratch DBs wiped (212 GB free), `serve-chain.ts` on 127.0.0.1:3101, fresh node in
  `gerolamo-preview-mithril/` under the supervisor with `GEROLAMO_MITHRIL_PROGRESS`. Two snags:
  the topology file needs `useLedgerAfterSlot` (validator rejects it otherwise) and the relay
  script must not call `ensureInitialized()` on a block store (its once-per-database ledger
  repairs scan the certificate history of every stored block — minutes of CPU for nothing).
  The local root is dialed first at start; a restart was needed once because the hot set had
  filled with public peers before the relay came up. First 30 000 blocks (Alonzo-era preview):
  ≈190 blocks/s.
- 2026-09-07 07:45 UTC per user: the explorer / mini-Blockfrost projection is not a priority
  during the replay — `sync.skipIndexWhileBehind: true` in the fresh node's overlay pauses it
  while > 1 epoch behind (paused at slot ≈ 2.4 M) and resumes near the tip; the gap gets
  `scripts/explorer-backfill.ts` afterwards. Direction confirmed: ledger DB standalone, explorer
  and Blockfrost share `preview.explorer.db` (already the layout).
- 2026-09-07 07:50 UTC bug 75: our relay dropped the first > 64 KB block (mux segment length is
  16-bit; no segmentation in the library's send) — `sendN2NResponder` now splits at 12 288 bytes.
  Relay and node restarted; relay primary again at slot 2.9 M (epoch 33). The dashboard-server
  monitor's "node unreachable" lines were a quoting bug in the monitor, replaced by a helper.
- 2026-09-07 08:30 UTC profiling round on the local-relay replay (bugs 76/77): main-thread CPU
  profile (3 min) attributed with `scripts/cpuprofile-top.ts --callers`: cbor eager assert
  messages 8 %, WebSocket publish for nobody 2.7 %, leader math per header 2.6 %, candidate
  BigInt sweep 4 %, main-thread UPLC decode 2 %, SQL run/prepare 6 % (left), bech32 address
  strings for utxo rows 2 % (left: storage format), postMessage 1.9 % (left). Fixed the first
  five, cut hot peers to 3 for the replay, gated the per-header DEBUG line. 31 → 57 blocks/s in
  epochs 48–49. `bun --cpu-prof` itself balloons memory (15 GB in 4 min, 9.7 GB in 2 min):
  windows ≤ 2 min, supervisor `GEROLAMO_BUN_FLAGS` passthrough, guard on RSS. Bun's heap
  snapshot (SIGUSR2 summary) walks the whole heap — hourly is too often during a sync.
- 2026-09-07 08:45 UTC SQL pass on the replay (bug 76, second part): per-transaction pot
  updates → per block, opcert counter cache, debug-only reference-script count gated. Header
  DEBUG spam gone (0 lines since 08:24; the log stopped growing). Rates on the same chain:
  31 → 57 blocks/s (epochs 48–49) after the first pass; 131 blocks/s in epochs 52–59 before
  the SQL pass. Next candidates left in the profile: UTxO row lookups (rules gather + apply),
  bech32 address strings for utxo rows, worker postMessage payloads, per-block blockExists.
- 2026-09-07 09:05 UTC SQL pass results (bug 76, second part): main-thread SQL 12.5 → 6.4 s per
  minute, 164 k → 57 k statements. Spends are now served from the rules pre-read plus a
  recent-outputs cache (60 000 entries, cleared on rollback): 69 632 known / 107 007 recent / 91
  database lookups in the first minutes — the pre-read never held outputs of earlier in-flight
  blocks (the overlay only deleted spent rows), so two thirds of preview spends hit a SELECT per
  transaction. Left: the per-transaction DELETE … RETURNING (inherent unless batched per block),
  the rules pre-read SELECT, one fee-pot UPDATE per block, block/header inserts.
- 2026-09-07 09:00 UTC third applier pass (bug 76): per-block DELETE + one flush per block,
  rules-job payload without the per-block copy of params/genesis (once per worker), bech32
  address cache, `isHex` regex (ledger-ts vendored 0.5.13 — `bun patch` cannot target a
  `file:` tarball; fixed in the sibling repo and repacked). Profile before this pass (epoch 95):
  SQLite run 14 % + values 4.7 % + prepare 2 %, postMessage 8.4 %, bech32 6 %, blake2b 2.7 %,
  isHex 2.3 %.
- 2026-09-07 09:05 UTC after the third pass: 120–137 blocks/s in epochs 108–113 (local relay,
  three hot peers, projection paused), apply 1.75 ms/block (was 2.6–3.4), validate 0.07 ms (was
  2.8), rules prep 1.7 ms; spends served 124 678 known / 59 474 recent-cache / 267 database;
  RSS 3.4–3.8 GB with 20 workers, no growth trend yet. Fresh CPU profile being taken for the
  next targets (blake2b on the applier, mux/cbor copies, rules-job resolved-input maps).
- 2026-09-07 09:12 UTC fourth profile (epoch ≈ 120, 112 s): SQLite layer ≈ 20 % (run 10 %,
  values 3 %, prepare 2 %, template parse 1.5 %, bun:sql 1.7 % — one range is already one
  transaction), worker postMessage 5 % (rules jobs 3.7 %: the resolved-input maps), CBOR parse
  ≈ 5 % (needed once on the applier for gather + apply), blake2b 2.2 % (tx hashes), `os.cpus()`
  1.4 % (every /metrics poll — throttled to one sample per 5 s), mux segment loop copying the
  remainder per segment 1.1 % (subarray now, ouroboros patch). bech32, isHex, UPLC decode and
  the cbor asserts are gone from the profile. Left on the table: send resolved inputs to the
  rules workers in a compact form (or let workers read them), tx hashing on the workers.
- 2026-09-07 09:16 UTC rate is now density-bound: 63 blocks/s at epoch 128 with 86 UTxO deltas
  per block (15 per block at epoch 113, where it ran 120–137 blocks/s) — 4.4 ms apply per
  block, ≈ 50 µs per delta. Heap: 703 MB JS heap / 4.7 GB RSS one hour into a process (parsed
  in-flight blocks, recent-outputs cache, pending headers); leak check needs two summaries
  from one undisturbed process — the node now runs without further restarts.
- 2026-09-07 09:50 UTC synchronous SQL writer (bug 76, fourth pass): `src/sqlSync.ts` replaces
  Bun.SQL on the writer — bun:sqlite prepared statements (LRU 512), no query object or promise
  per statement, `${sql(list)}` lists longer than 8 bound as one JSON parameter through
  `json_each` (a per-length `IN (?, ?, …)` text re-prepared a huge statement per block and
  thrashed the cache: the first window ran 87 µs/delta against the 51 µs Bun.SQL baseline).
  Measured: applier statement mix in isolation 0.77–0.92 ms → 0.30–0.43 ms per block-like
  transaction; on the replay 604 µs (Bun.SQL, slots 10.69–11.98 M) → 450 µs (slots
  12.10–13.10 M) of apply per KB of block, at lower density, which penalises the new number.
  SQL is now 0.23 ms of the 1.94 ms apply per block (the rest is CBOR, hashing, bookkeeping).
  Default now (`GEROLAMO_SYNC_SQL=0` restores Bun.SQL); 278 DB tests pass. Node relaunched
  without `GEROLAMO_SQL_PROFILE`. The earlier four entries of today were stamped ~40 minutes
  ahead of the clock and are corrected above.
- 2026-09-07 11:10 UTC leak check, one undisturbed process (pid 3477122, hourly SIGUSR2 class
  summaries 10:06 → 11:06, `scripts/heap-diff.ts`): main JS heap 107 → 105 MB, largest class
  growth Uint8Array +2 MB, nothing else above 1 MB — no leak on the applier. RSS swings 3.6–5.2 GB
  with the 20 worker heaps (0.8–1.6 GB) and the unaccounted native pool (2.0–2.9 GB), both
  tracking the number of parsed blocks in flight at the current density; no upward trend over
  65 minutes of five-minute samples. Replay at epoch 283 (20 %), 98 blocks/s.
- 2026-09-07 14:45 UTC fifth applier pass (bug 76). At epoch ~500 (preview's dense dApp
  period) the replay had dropped to 34 blocks/s with the applier saturated at ≈ 29 ms per
  block (rules prep 7.9, apply 6.0, witness wait 5.75, the rest header handling and GC). CPU
  profile (120 s, pid 3565155): `rememberRecentOutput` 11.5 % self + `stakeKeyOfAddress`
  8.3 % self — both caches evicted with `map.delete(map.keys().next().value)`, and JSC keeps
  deleted Map entries as tombstones a fresh iterator walks first: 37 µs per eviction at a
  steady 60 000 entries (0.8 µs with a queue). `Address.fromString` for the stake key of every
  output (bech32 `isBech32` indexOf 9.6 %, `decodeBase32` 8 %) ≈ 20 %: the output's raw
  address bytes were already in hand. Fixed: `src/utils/boundedMap.ts` (queue eviction) for
  the recent-outputs, stake-key and parsed-address caches; `stakeKeyOfRawAddress` reads the
  stake part from the 57-byte address. Left: rules-job `postMessage` 9.4 % (a JSON string
  clones no faster than the Map — measured), SQLite 5.2 %, bech32 *encoding* of output
  addresses ≈ 9 % on cache misses (`buffToUint5Arr`, polymod), `applyOverlay` copying the
  resolved map per block 2.6 %. Measured after the two fixes: 56.6 blocks/s over
  14:46–14:50 UTC (33.6 before), apply 6.0 → 2.7 ms, rules prep 7.9 → 2.8 ms. Then the bech32
  encoding: output address strings went through ledger-ts `toString` → the library's bit-string
  encoder (32 µs per address); `bech32Encode` in db/stakeCred.ts is typed-array now (2.7 µs,
  checked against ledger-ts for every address form on both networks) and every Shelley output
  address is encoded from its raw bytes. The remaining "witness wait" (8 ms/block) is not the
  worker: signature verification costs 11 ms of worker CPU per block here (13 signatures at
  0.83 ms); it is other main-thread work (header batches, mux, GC) interleaving at that await.
  Profile after those (pid 3570967, 116 s): SQLite `values` 15 % — the rules pre-read decoding
  tx_out rows for inputs the recent-outputs map already held (chained spends) — now served
  from the map (`spentRowsStats.preread`), with a known hit at apply also dropping the map
  entry; `os.cpus()` 2 % (the sampler every 5 s plus the CPU model re-read from /proc on every
  /metrics poll) — /proc/stat and a cached model; overlay copies folded into one per
  scheduled block (`applyOverlays`). Left: CBOR parse ≈ 10 % (one parse per block on the
  applier), `postMessage` 5 %, blake2b 3 % (tx hashes), header pipeline ≈ 4 %.
  Observation: stopping the node while an epoch's VRF checks are deferred (nonce not yet
  derivable) logs "Deferred VRF verification … failed: ValidationPool closed"; the headers
  of that window were applied and are not re-verified after the restart. Harmless on the
  Mithril-certified chain; for live sync the resume should re-run the deferred check.
- 2026-09-07 15:10 UTC sixth pass measured: 77.2 blocks/s over 14:58–15:07 UTC (44 544
  blocks; 33.6 at 14:21–14:36 in a slightly denser stretch, 56.6 after the fifth pass), apply
  1.34 ms/block, rules prep 1.5 ms; the pre-read takes ~99 % of its rows from the
  recent-outputs map (10 108 map / 24 SQLite in the first minute). Replay at 38 % (epoch 533);
  the node runs on this build without further restarts.
- 2026-09-07 16:20 UTC bug 78: the 15:56 UTC "range pipeline failed" (strict per-block delete
  count 14 vs 13) was a transaction listing one input twice (slot 50 778 243); refs are
  deduplicated per transaction now. The reset dropped the local relay for one re-dial and the
  retry passed. Also on the log: 143 Plutus-shadow budget mismatches of one kind (our units a
  little above the declared budget) — noted under open item 11. The 15:21–15:52 slowdown to
  41 blocks/s was two Playwright Chromium GPU processes of another project saturating all 20
  cores, not the node.
- 2026-09-07 17:40 UTC Plutus shadow mismatches resolved (bugs 79, 80). Method: one transaction per
  mismatch family through `scripts/shadow-tx.ts` (Koios quota back) with `GEROLAMO_PLUTUS_DUMP_DIR`,
  `scripts/aiken-simulate.ts` + `tools/uplc-ref` (built; `eval-tx` reproduces every declared unit,
  `eval-prog` costs *our* dumped program, `show-prog`, `eval-text` with result and logs), and
  `scripts/data-diff.ts` on the two contexts. Context bugs: signatories unsorted, redeemers in
  witness order, Rewarding purpose without StakingHash (buildooor patch). Machine bugs, found with
  the new per-builtin harness (`scripts/builtin-cost-diff.ts`, 275 programs, budgets and results
  vs aiken) and a builtin-call trace on both machines (env `GEROLAMO_BUILTIN_TRACE`,
  `UPLC_BUILTIN_TRACE` in the vendored crate): heap deduplication by a buggy deep equality bound
  variables to older values (also O(heap) per binding); lambda left-application mutated the
  captured environment; string size in bytes/8 instead of characters; Ed25519 cost linear in the
  wrong argument; consByteString V1/V2 wrap; serialiseData map/chunk/bignum encoding. All 12
  families and the harness are exact now. Validity-interval upper bound: aiken's crate always emits
  an open bound; the ledger closed it before protocol version 9 — kept ours (pv-dependent), it did
  not affect any of these units.
- 2026-09-07 17:35 UTC halt at slot 63 504 075 (first block of preview epoch 735): V3
  `script_data_hash` mismatch right after our boundary enacted cost-model action 1f47f3cf…
  Koios: ratified 735, enacted 736; epoch 735 still carries the 251-entry V3 model, 736 the
  297-entry one. Bug 81: enactment is one epoch after ratification (pulser set up at E,
  completed at E+1) — implemented as a pending record in gov_state; governance tests adapted
  (13 pass). The failed range's transaction had rolled the 735 boundary back, so the node
  simply redoes it with the fix. Also explains why the earlier from-genesis run never saw
  this: it validated these epochs with externally fetched parameters.
- 2026-09-07 18:40 UTC bug 82 (governance tally snapshot): our replay enacted the pv-10 hard
  fork at 744, the chain at 743 (Koios: ratified 742). Recomputing the tally offline
  (`scripts/gov-tally.ts`) with the boundary's own snapshot reproduces the chain (62 % vs 46 %
  with the previous snapshot). The tally now runs after the snapshot with the epoch's
  parameters; the pending result is enacted at the next boundary as before. Governance tests
  13/13, broader suites 425/425. Every other enactment up to the current epoch matches Koios.
- 2026-09-07 19:25 UTC bug 83: committee hot-key authorisations recorded only for current
  members; preview's seven members added at 994/998 authorised at 993 and their votes were
  dropped — parameter change 602d8572… (committee_min_size 3, chain: ratified 998 / enacted
  999) never ratified by us. `gov_committee_auth` keeps authorisations apart from membership;
  the seven were restored from stored blocks (scan of epochs 980–1002) with the node stopped.
  It will ratify late (next boundary) — the records for 999–enactment get corrected afterwards.
  Open item 13: 35b81b42… ratified by us at 962, by the chain at 963 (DRep 3/4 threshold);
  per-credential snapshots are pruned, so the node now logs every tally for the next case.
- 2026-09-07 21:10 UTC PREVIEW REBUILT FROM GENESIS TO THE TIP. The Mithril-fed replay (block
  store served by the local relay, fresh node under strict validation, 05:42 → 21:07 UTC for
  4.64 M blocks) reached the certified tip (slot 122 087 503, epoch 1413); the relay was
  stopped, the local root removed from the topology, and the node caught up to the live tip
  from the public roots within a minute. Bugs 78–83 were found and fixed on the way (duplicate
  inputs, script context and machine, governance enactment timing, tally snapshot, committee
  hot keys); every governance enactment agrees with Koios, two record sets corrected by hand.
  The local-root promotion guard now yields after 60 s without a header (the block store ends
  at the certificate). Next: pots/stake/rewards vs Koios for the epochs after the old proof.
- 2026-09-07 22:10 UTC pots/stake/rewards vs Koios after the rebuild: treasury +12 ppm per
  epoch, rewards −300 ppm per epoch, active stake −316 ppm at the tip. Traced (Koios
  pool_list for every pool, delegator diffs, account_info via POST for script stake
  addresses): 383 B of the 488 B gap in two pools, both script stake credentials whose stake is
  entirely reward balance — a pool's script reward account never credited (bug 84) and a
  script return account whose 100 000-ADA deposit refund went to its key twin (bug 85, ten such
  refunds). The remainder is the compounding lag those seeds cause through the performance
  term. Fixed both (`rewardAccountTypedHex`), 19 governance/pool tests pass. Dingo (Blink Labs)
  does not compute rewards natively — it imports reward inputs from a snapshot — so no
  reference there; Koios remains the oracle. Decision: a third from-genesis replay with the
  fixes, in a second directory beside the running node, is the only route to an exact state.
- 2026-09-07 22:15 UTC tip-sync note: at slot 122 162 229 the tip node rolled back one block
  and followed the branch a second peer confirmed (chain agrees with Koios afterwards); the
  peer that served the losing branch is held as malicious for `maliciousHoldMs` (1 h). A
  short fork is not misbehaviour — on mainnet that hold would churn honest peers; tune the
  hold (or exempt confirmed-fork losers) before production. Third replay at 0.7 % after 16 min,
  same pace as the first.
- 2026-09-07 22:50 UTC third replay halted at slot 894 594 (epoch 10, V1 script_data_hash):
  bug 86 — the startup repair (run by my restart at epoch 10) merged the Alonzo genesis cost
  models over the epoch-8 update because derived records were incomplete (preview starts at
  protocol 6, so the era-transition merge never runs). Fixed both sides; replay 3 restarted from
  scratch with the fix. This one was invisible in replay 1 only because of a lucky restart time.
- 2026-09-08 00:10 UTC bug 87 (verifier re-streams validated before the duplicate check; leader
  check on a pruned epoch fell back to the live registry). Fixed in the header batch path; the
  replay keeps running (its primary is the relay), the tip node gets the build on restart.
- 2026-09-08 01:00 UTC tip node observation (not resolved): relaunched at 00:01, within a
  minute of the epoch-1414 boundary, it looped for 50 min — every ~30 s the primary's ChainSync
  restart reported "drain timed out", the peer was dropped and the next verifier promoted (52
  switches, no blocks applied, 760 slots behind). A second relaunch at 00:53 (same code apart
  from an indexed height lookup in the bug-87 filter) is clean: no switches, at the tip. The
  drain waits on the network pipeline's in-flight count, not on our batch processing. Cause
  not established; suspect a boundary-time race in re-anchoring. Watch for recurrence at the
  next live boundaries (every 24 h on preview, 00:00 UTC).
- 2026-09-08 06:10 UTC bugs 89 and 90 from replay 3's epoch-962 tally: 35b81b42… ratified at 962
  again (chain 963). Traced with Koios' DRep power history: at 962 the chain had ≈ 73.5 % yes
  against our 93 % because its denominator holds ≈ 15 T of unvoted stake we never saw. Our DRep
  distribution came from the pool stake snapshot, so credentials that delegate a vote but no
  stake, and every proposal deposit, were missing (Koios 2 415 DReps / 146.8 T at 1048, ours
  216 / 117.3 T). Bug 90: a per-boundary `epoch_drep_stake` snapshot from balances, rewards and
  live deposits; bug 89 (found on the way): deregistration now drops the DRep delegation too.
  Governance tests 8/8. Replay 3 keeps running on the old build (effect limited to that one
  tally); records to correct by hand, proof on the next replay. Replay 3 at 06:10: epoch ≈ 1 060.
- 2026-09-08 07:15 UTC bug 90 checked numerically on replay 3's live state (read-only, epoch
  1343): the new query's amounts for the 26 DReps our activity filter keeps match Koios'
  `drep_voting_power_history` to ≤ 11 ppm (18.42 T, 12.28 T, 0.30 T; one 0.5 T DRep −0.3 %,
  mid-epoch drift). Koios lists power for expired DReps as well (115 T, 30 T, 20 T giants
  expired at 814/692/1036 — the same expiry epochs we compute), which the ledger excludes.
  The old database's always-abstain total (255 T vs 119 T) carries deregistered credentials'
  stale delegations — bug 89's territory; gone on a fresh replay.
- 2026-09-08 08:20 UTC replay 3 reached the certified tip 07:41 (9 h 06 from genesis). Not exact:
  pots per-epoch exact from 1400 but treasury −504 k ADA (bug 91: deposit refunds to
  unregistered return accounts belong to the treasury; also enacted withdrawals — fixed, with
  bug 92: treasury donations never reached the treasury — fixed, tests 10/10). Stake ±2 ppm and
  rewards +1.8 ppm at 1405–1412, and the DRep tally aside, everything traces to one thing:
  whole credentials counted differently from the chain in some epochs (+35.5 k ADA from the
  first Conway epoch, +700 k at 767, −400 k at 1014–1288, +4.8 M for the single epoch 1029);
  each pool's reward error equals that epoch's total-stake error. Local relay and replay 3
  stopped (DB kept for diagnostics, read-only); the tip node stays up. A Koios pool-history
  sweep over all 386 pools is running to place each credential; then Koios `account_updates`
  on the candidate credential gives the certificate we mishandle. Replay 4 after that.
- 2026-09-08 08:45 UTC bug 93: the +35.5 k ADA from epoch 647 is the one preview output at a
  pointer address (35 553 ADA, credential 0c90492b…) that Conway stops counting; dropped at the
  Babbage→Conway boundary now (tests 2/2). Remaining unexplained stake differences: +700 k ADA
  at 767, −400 k ADA at 1014–1288, +4.8 M ADA at 1029 only — sweep running.
- 2026-09-08 09:30 UTC the sweep placed every remaining stake difference: all multiples of the
  100 k ADA governance deposit. Multi-epoch deficits = proposals the chain dropped at an
  enactment (orphans/siblings) that we kept to expiry (bug 94, `dropOrphans`); single-epoch
  surpluses = refunds we credited before the boundary's snapshot while the ledger credits after
  it (bug 95, `applyBoundaryCredits` after snapshot + DRep tally). A deposit does not count as
  pool stake while the proposal lives (Koios account history of 104b7df27a…: −200 k the epoch
  after submission), only as DRep stake (bug 90, unchanged). Governance tests 11/11, pointer 2/2,
  rewards 7/7, db 3/3, tsc clean. Seven bugs from replay 3 (89–95); replay 4 next.
- 2026-09-08 09:50 UTC replay 4 (started 08:15 from a wiped DB, same relay/topology, with
  GEROLAMO_MITHRIL_PROGRESS): 538 k blocks after 5 480 s against replay 3's 1 000 k at the same
  wall time. Every CPU phase is ≈ 2× slower (weval 5.5 vs 2.4 ms, apply 2.9 vs 1.6, deliver 147
  vs 76), worker and applier alike, with load 22 on 20 cores and a Brave + headless Chrome using
  ≈ 7 cores — machine contention, not the new boundary code (which runs once per epoch). ETA at
  the tip slips from ≈ 17:30 towards 02:00 UTC if the load stays. Both preprod databases were
  deleted on Mike's instruction (6.9 GB); 155 GB free.
- 2026-09-08 13:05 UTC replay 4 crossed Conway: pointer stake dropped at 646 (35 553 ADA),
  a 1 ADA donation credited at 647. verify-stake: 646 exact, 647 (snapshot 646) +35 553 ADA,
  648 exact — the drop must precede the hard-fork boundary's snapshot; moved. Replay 4 keeps
  going (every other fix still gets its proof); its only known residual is that one pool's
  epoch-647 rewards at +75 ppm. Decide at the tip whether that needs replay 5 before the swap.
- 2026-09-08 13:45 UTC replay 4 through 775: bug 91 fired at 707/728/736/743 (200 k + 3 × 100 k
  ADA to the treasury), bug 92 at 647/697, bug 95 confirmed (767 now +5 ADA instead of
  +700 k). Pots exact to < 1 ADA at 758; the per-epoch pot record lagged the deferred credits by
  one boundary (record only; `refreshPotSnapshot` after `applyBoundaryCredits` now). The only
  residual is the pointer-order slip at 646: credential 0c90492b… earned ≈ 12.3 ADA for
  performance epoch 647 that the chain did not pay (+12.3 M lovelace of stake 650–690, +5.2 M
  from 700), plus +75 ppm on that pool's other members for that one epoch.
- 2026-09-08 14:50 UTC replay 4: 35b81b42… ratified 963 / enacted 964 = chain (bug 90 proved); donations at 882/907/943/969 match replay 3's small treasury gaps (bug 92).
- 2026-09-08 15:25 UTC replay 4: bug 94 fired (26 dropped at 994, 4 at 998), stake at 996 within
  6 ADA. New: bug 96 (delaying actions: the parameter change behind the 997 committee update
  ratified one epoch early; chain 998/999) — fixed, tests 12/12. The pointer credential
  0c90492b… delegates to pool cb8ccb08…: its 12.3 ADA of unearned epoch-647 rewards and the
  −6 ADA on that pool's other members are the whole 646 residual.
- 2026-09-08 15:40 UTC bug 97 (leader/member rounding: one floor over the exact rational; our
  floored-margin split paid the operator 1 lovelace short on a third of the epochs). Probably
  the −3.5 k lovelace stake residual seen since Babbage. Rewards tests 9/9. Replay 4 continues
  for the remaining proof points (1096, 1270, 1291, 1330, 1361–1370, the tip); replay 5 with
  bugs 93-order, 96 and 97 afterwards is the exactness run.
- 2026-09-08 17:10 UTC replay 4 at the certified tip (8 h 48 from genesis under heavy machine
  load): all checkpoints on the chain's epochs; pots −13 / −65 ADA, stake +64 ADA, rewards
  within 0.03 ppm — exactly the three residuals fixed during the run (pointer order, bug 96,
  bug 97). Replay 5 started 17:07 from a wiped DB on the current tree (nothing else changed);
  ETA at the certified tip ≈ 02:00 UTC. If exact: swap the tip node onto it in the morning.
- 2026-09-08 21:50 UTC replay 5 through 649: total active stake EXACT (to the lovelace) at
  645, 646, 647 and 648 — the pointer drop now precedes the hard-fork snapshot, and the
  −3.7 k lovelace residual carried since Babbage is gone (bug 97 rounding). First lovelace-exact
  Conway snapshots in the project.
- 2026-09-08 22:15 UTC replay 5 through 738: pots EXACT at 737 (reserves and treasury diff 0),
  every per-epoch treasury delta 0 ppm including the deposit forfeits at 707/728/736 and the
  donations at 715; stake exact at 730/736/737. Tip node untouched at the live tip.
- 2026-09-09 00:20 UTC replay 5 exact through snapshot 999 (stake, pots, 997/998/999
  governance = chain). At 1000 +100 k ADA: bug 98, a double refund of a proposal that expired and
  was orphaned in the same boundary (the bug-94 sweep ran before the expiry marking). Fixed,
  tests 13/13. Replay 5 continues to the tip as a scout for 1000–1413 under the new rules;
  replay 6 (the exactness run) starts when it gets there, ≈ 03:00 UTC.
- 2026-09-09 00:10 UTC tip node (old build + bugs 87/88) crossed the live 1415 boundary cleanly: no primary promotion, reward update and snapshot in 4 s. The 2026-09-08 00:01 churn loop did not recur (it followed a relaunch at the boundary; still unexplained, watch the next relaunch-at-boundary).
- 2026-09-09 02:20 UTC replay 5 at the certified tip (9 h 05): exact through snapshot 999,
  bug 98 only after (+109 k ADA stake, reserves −9.4 k ADA, rewards +36…73 ppm at 1405–1410);
  all checkpoints 1096/1270/1291/1330/1361/1367/1370 on the chain's epochs. Replay 6 started
  02:15 from a wiped DB (bug 98 fixed, nothing else changed); ETA ≈ 11:30 UTC. If exact: swap.
- 2026-09-09 07:05 UTC replay 6 (started 02:15, bug 98 fixed): exact at 646–676 and 700, pots
  exact at 706 (reserves −1 lovelace, being located). At 06:46:06 the applier hit SQLITE_BUSY
  on a plain write (the sync writer had no busy_timeout; the only concurrent access was a
  read-only verify-stake run), reset the range pipeline, re-anchored on the DB tip and promoted
  a public verifier to primary; the relay reconnected as a verifier. No data lost (stake and
  pots verified after). `PRAGMA busy_timeout = 10000` added to the sync client for the next
  process; the running replay keeps going on the public primary at ≈ 170 blocks/s.
- 2026-09-09 08:20 UTC replay 6 through 1048: stake exact at 999/1000/1001/1003/1010/1020/1030/1040, reserves and treasury diff 0 at 1040 (bug 98 confirmed: 999 'expired 4, dropped 0'); 997/998/999 and 1012/1013 on the chain's epochs. First replay exact past 1000.
- 2026-09-09 09:50 UTC REPLAY 6 EXACT at the certified tip (7 h 29 from genesis): pots diff 0,
  stake OK at every check, rewards 48/48 OK, all checkpoints on the chain's epochs. Ten ledger
  bugs (89–98) between replay 3 and this one. Relay stopped; the node catches the live tip from
  public peers, then its database replaces the tip node's (3035).
- 2026-09-09 10:20 UTC SWAP DONE. Replay 6 caught the live tip from public peers (after the
  local-root promotion bug 99 and the migration-marker bug 100 surfaced on its relaunch —
  both fixed in the tree, state verified untouched), its live 1414 and 1415 boundaries were
  exact, and its database replaced the tip node's: gerolamo-preview-mithril/preview.db is the
  lovelace-exact ledger, node 3035 relaunched on it, dashboard 3050 relaunched, old 58 GB DB
  deleted (153 GB free). gerolamo-preview-mithril2 keeps config/topology and the
  replay3/4/5-history.db extracts for future proof replays. Next: preview pool registration.
- 2026-09-09 21:50 UTC snapshot bootstrap phase C done: `import-state` decodes the Mithril
  ancillary `state` (NewEpochState + Praos state) into our tables; verified table by table
  against the replay-6 ledger at epoch 1415 (all boundary-frozen tables exact, see
  PLAN_SNAPSHOT_BOOTSTRAP.md). The comparison with the node's own state found two more ledger
  divergences — bug 101 (DRep unregistration must clear the delegations to it: 1 339 stale rows
  in the live DB), bug 102 (DRep expiry is materialised at activity time) and bug 103 (certificate
  effects of one tx applied out of order: one lost vote delegation) — all fixed with tests; the live database's stale rows and the epoch-1415 DRep distribution are corrected from
  the snapshot and the tip node relaunched on the fixed code. Next: phase D (ancillary
  signature, `mithril-bootstrap --ledger-state`), then phase E acceptance.
- 2026-09-09 23:05 UTC phase D done (ancillary manifest verification, `mithril-bootstrap
  --ledger-state`), phase E started: a fresh preview node (3036, gerolamo-preview-mithril2)
  built in 8 minutes from the certified chunks plus the verified ancillary state at slot
  122 316 253 is at the live tip under strict validation. Its 1416 and 1417 boundaries decide the
  acceptance (Koios + the tip node's replay-6 database). Dashboard 3051.
- 2026-09-10 00:45 UTC phase E, boundary 1416: after a rebuild of the imported database (the
  importer's stake balances doubled on a repeated import — fixed), the snapshot-bootstrapped
  node's 1416 boundary is identical to the tip node's: reward update for 1414 to the lovelace,
  stake snapshot 1 543 271 529 766 798, pots, parameters, nonces, DRep stake, governance tallies.
  The comparison exposed bug 104 on the *replay* side (rolled-back blocks stayed counted: 23
  phantom blocks in 1415); both nodes corrected from their stored headers and relaunched on the
  fix. Remaining acceptance: boundary 1417 (2026-09-11 ≈ 00:00 UTC) with Koios.
- 2026-09-10 03:20 UTC preview pool registration started (PLAN_BLOCK_PRODUCTION.md): keys
  generated in /media/bakon/data/cardano/gerolamo-preview-pool (pool id
  8df215df1a762e84d826bae39516a424a76e81e649001a3f903eda12, VRF key hash a823dd1c…), operational
  certificate issued from the tip node (counter 0, KES period 944). Waiting on two things only
  Mike can do: fund payment.addr from the preview faucet, and forward a TCP port (3001) on the
  router to this machine (public IP 50.202.37.130) so relays can pull our blocks — without inbound
  reachability (or duplex on our outbound connections, not implemented) a forged block never
  leaves this host.
- 2026-09-10 05:00 UTC PREVIEW POOL REGISTERED: pool 8df215df… (stake registration, pool
  registration, owner delegation) in tx 5beecbaf… at slot 122 359 348, recorded identically by
  both nodes. Getting it there exposed three networking defects, all fixed and deployed on both
  nodes: the shared mempool's buffer was never initialised (every local submit failed with
  "insufficient space"), nothing ever sent tx-submission's MsgInit (peers never pulled our
  transactions; the registration went through Koios in the end), and a ChainSync restart at
  the tip dropped its peer after 30 s when the outstanding reply was the next block — both nodes
  looped on that for 15 minutes without applying a block (the import node also sat on a losing
  one-block fork and was rolled back by hand). Also in the tree: the once-per-network
  "Gerolamo was here!" metadata transaction in the first forged block (PLAN_BLOCK_PRODUCTION.md).
