# Validation status — 2026-09-04

Consolidated state of `PLAN_FULL_VALIDATION.md` after the from-genesis proving
runs. The plan file keeps the chronological log; this page is the current
picture: what is verified, how, what is still open, and how to reproduce it.

## What the node verifies today (strict unless noted)

| Area | Rule | Status |
|---|---|---|
| Headers | KES signature, opcert cold signature, VRF proof (fast noble verifier, 600/600 agreement with the reference), Praos leader value `blake2b_256("L" ‖ vrf)`, overlay schedule, pool registration and VRF-key binding | strict |
| Headers | σ leader threshold, opcert counter monotonicity | report-only (see open items) |
| Withdrawals | must equal the local reward balance | report-only until the final from-genesis run shows zero disagreements (`WITHDRAWALS_STRICT`) |
| Epoch nonces | UPDN/TICKN evolver, Praos block nonce `blake2b_256(blake2b_256("N" ‖ vrf))`, ηh from the previous epoch's last block, rebuilt from stored headers on restart and rollback | strict; every preprod epoch 5–31 equals Koios |
| Byron | tx structure, witnesses (PkWitness/Redeem), value conservation, `txFeePolicy` on the witness-less tx bytes | strict |
| Shelley…Conway | witnesses (vkey, bootstrap, required signers), native scripts (timelocks), value conservation with deposits/refunds, min fee (+ ex-unit prices), validity interval, min UTxO (Shelley, Mary scaled, Alonzo per-word with datum, Babbage per-byte from original bytes), size limits, certificate sequence | strict |
| Alonzo+ | datums (hashed from original bytes), collateral (incl. phase-2-invalid transactions), ex-unit caps per tx and block, redeemer ↔ purpose, byte-exact `script_data_hash`, witness script hashes from original bytes | strict |
| Conway | tiered reference-script fee | report-only until checked on Conway history |
| Plutus phase 2 | evaluation shadow (buildooor script contexts + plutus-machine, everything rebuilt from bytes) | report-only; evaluates real V1/V2 transactions with matching verdicts, accumulating agreement over the preprod run before going strict |
| Ledger state | UTxO apply (strict presence), pool params/retirements, delegations, stake snapshots, reward pots and per-account rewards, protocol parameters (genesis → update proposals decoded from body bytes → era-genesis merges → Conway enactment), governance capture and ratification | local, no external source on a from-genesis sync |

## Verified against a reference (Koios)

| Check | Tool | Preprod result |
|---|---|---|
| Epoch parameters, every field incl. cost models | `scripts/verify-params.ts` | preprod epochs 4–54 all equal (clean resync); preview epochs 0–57 all equal |
| Epoch nonces | `scripts/verify-nonces.ts` (replay from the Shelley start, or from a recorded epoch start state) | preprod epochs 5–31 all equal; preview epochs 1–10 all equal |
| Stake snapshots (totals and largest pools) | `scripts/verify-stake.ts` | preprod: exact through epoch 29, then 1e-5…1e-3 off until the credential-type and retirement fixes (bugs 30–33); snapshot 62 still +3·10⁻⁵ from legacy reward balances; preview snapshot 58 +1.8·10⁻⁵ (was +0.52 % before the fixes), snapshot 222 +4.7·10⁻⁵ after the pointer-address fix (the remainder is reward balances from pre-fix epochs) |
| Treasury/reserves per boundary | `scripts/verify-pots.ts` | preprod: boundaries 6–54 within 0 ppm except 33/35/42/45 (−66…−114 ppm, the short-lived-pool snapshots); mainnet: epochs 209–211 equal to Koios within 2 lovelace, including the first ITN-reward MIR (593·10¹²) |
| Per-pool / per-account rewards | `scripts/recompute-rewards.ts`, `scripts/verify-rewards.ts` | pool totals equal Koios at boundary 47; leader/member split differs only where Koios books an owner's share as member reward |
| VRF verifier | `scripts/verify-fast-vrf.ts` | 600/600 proofs agree |
| Script data hash | `scripts/verify-sdh-koios.ts` | 8/8 real transactions (V1, V2) |
| Whole-chain replay | from-genesis runs (below) | preprod epoch 38 and counting, zero body-rule reports |

## Bugs found by the proving runs (all fixed, each with a fixture test where a block was involved)

1. Native scripts were evaluated on the ledger-ts `Script` wrapper (timelocks always false).
2. Pool registration deposits read the external `pool_distr` table instead of local pool state.
3. Praos leader value used SHA-256 (ledger-ts helper) instead of `blake2b_256("L" ‖ vrf)`.
4. Praos block nonce lacked the `"N"` tag and second hash: every Babbage epoch nonce had been wrong under the hood (external fetches masked it).
5. Inline datums and datum hashes were dropped from the UTxO set (`instanceof` across library copies); metadata now comes from the output bytes.
6. Outputs created earlier in the same block entered the in-block resolved set without their datum.
7. Update proposals lost fields ledger-ts has no model for (decentralisation, extra entropy); they are decoded from the body CBOR.
8. The Vasil proposal's cost models were serialised as `{}` (key-whitelist replacer).
9. Reward timing: the update applied into epoch e uses reserves(e−1), fees(e−2), blocks(e−2), the snapshot that led e−2 and the parameters of e−2; rewards land at that boundary.
10. Script stake registrations were required to carry a redeemer.
11. Witness scripts CBOR-wrapped twice by their author hash over both wraps; ledger-ts normalises and gets another hash.
12. A body listing the same input twice is a set pre-Conway.
13. Babbage `script_data_hash` uses `80` for "no redeemers" (Conway `A0`); empty datum lists count as absent.
14. Legacy script gates halted on their own decode/lookup errors (flat vs CBOR bytes, `referenceInputs` vs `refInputs`); they are report-only, the rules own those checks.
15. Header verification cost: ~170 ms CPU per header in the pure-BigInt VRF; replaced by an ECVRF draft-03 verifier on noble ed25519.
16. Ahead-of-boundary parameter reads now derive locally (quorum update, era-genesis merges) instead of carrying or fetching.
17. Native scripts supplied as reference scripts were taken for Plutus (redeemer and collateral demanded).
18. plutus-machine measured bytestrings and integers in bytes instead of words: CPU overcounts flipped 28% of Plutus verdicts (vendored patch, pinned by test).
19. Apparent pool performance was capped at 1; the ledger does not cap it (pools that out-produce their stake share earn above maxPool).
20. Rewards of unregistered reward accounts: not computed (stay in the reserves) before Babbage, forfeited to the treasury from protocol 7 on (`hardforkBabbageForgoRewardPrefilter`).
21. Rewards used current pool parameters instead of the ones in the snapshot that led the epoch; re-delegations left stale rows that the snapshot could pick.
22. Withdrawals were never debited from reward balances (an `Array.isArray` guard on ledger-ts's withdrawals object), inflating stake snapshots, σ and owner shares for every account that had withdrawn.
23. Pool re-registrations were applied immediately; the ledger applies them at the next boundary after the snapshot (`psFutureStakePoolParams`), which changed leader/member splits.
24. The reward η used a hard-coded 432 000-slot epoch (wrong on preview); header workers used the default slot→epoch geometry (wrong on preview and on mainnet from Shelley on).
25. The strict registration and VRF-binding leader checks read the live pool registry; Praos judges a header by the epoch's stake distribution, so a pool retired at the boundary still forges through the epoch (preprod epoch 47). The checks now read the epoch snapshot's pool parameters.
26. When a primary switch (or a rollback) reset the nonce evolver, the header stage fetched the next epoch's η0 from an external source instead of re-deriving it; on preview the fallback mirror was preprod's, so epoch 9 got preprod's nonce and every header of the epoch failed. The evolver is now re-activated from the applied tip before any lookup, an external value is never consulted when the local derivation is authoritative, a stored external row is re-derived and overwritten when it disagrees, and preview has no fallback mirror (`blockFrostFetchEra`).
27. `scripts/verify-nonces.ts` bootstrapped ηv = ηc = η0 at any start epoch and had no carried ηh; both are only right from the Shelley start. It now uses the recorded epoch start state and the label nonce of the previous epoch, and pins the slot geometry to `--network` (as do the other verify scripts).
28. Range scheduler: a reset (primary switch after a range failed) while a range was still applying advanced the apply sequence past the first range submitted afterwards, so that range was skipped; the next one applied on top of a 150-block hole and its inputs were "not in the UTxO set" (a false "ledger inconsistent" halt on preview at slot 1256352). Fixed in `applyInOrder`, with a regression test; the applier now also refuses any block whose previous hash is not the applied tip (or the previous block of the range), which resets and re-anchors instead of halting.
29. The Plutus shadow froze the node for good on preprod slot 21835905: two transactions run exponentiation by squaring on huge integers (9.3·10⁹ CPU declared). JavaScriptCore multiplies BigInts in quadratic time, so one `multiplyInteger` takes minutes and the wall-clock cap, checked only between budget charges, never fired (three builds stalled at the same tip). The evaluator patch now refuses a single builtin step above `maxStepCpu` before it runs (builtins charge before executing) and checks the deadline immediately after any heavy step; the shadow skips redeemers declaring more CPU than it can evaluate (`GEROLAMO_PLUTUS_SHADOW_MAX_CPU`, default 3·10⁹) and reports the reason.
30. Stake credentials were keyed by hash only in the `stake` and `delegations` tables and in the certificate rule; the ledger keys them by (type, hash). Preprod slot 22056654 registers a *script* credential whose 28 bytes equal a *key* credential registered at 22056832, so the key registration was rejected as a duplicate (strict halt). Both tables now carry `cred_type` (0 key, 1 script; NULL for rows written before the column existed, which match either type), the rule keys its sets by type and hash, and a test covers the twin credentials.
31. Thousands of "operational certificate counter below the last seen" reports were an artifact: a lagging verifier re-sends already-applied headers, which were compared with the counter the applied chain had reached later. The rule now only compares headers after the block that set the stored counter.
32. The UTxO stake index (`utxo.stake_key`) dropped the credential type too: 830 outputs at script-stake addresses (2.2·10⁹ lovelace) were attributed to the key account with the same hash (preprod account 0c6aa3ec…, pool 5cb14d2c…), which is where the +6·10⁻⁵ on the total active stake and the near-threshold σ reports came from. Stake credentials now use a typed key everywhere the snapshot, reward, withdrawal and governance paths key by credential (bare hash for keys, `01` + hash for scripts; 29-byte blobs in `rewards`), with a one-off migration that retags script-stake outputs (2 271 on the preprod database) and legacy untyped delegation rows matching either form. Test: `leaderState.typedStake.test.ts`.
33. Pool retirement (POOLREAP) had no ledger effects beyond dropping the pool: the pool deposit was never refunded to the reward account (preprod pools short by exactly 500 ADA of stake, e.g. 712de1a8…, 866b15a7…), and delegations to the retired pool survived, so when a pool re-registered its old delegators counted again (preprod account 086798ad… on pool efe2f45e…, +9.5·10⁹). Retirement now removes the delegations and refunds the deposit to a registered reward account, or to the treasury otherwise (test in `leaderState.poolParams.test.ts`).
34. Redeemers with the same purpose in one pre-Conway transaction were rejected; before Conway the list is decoded with Map.fromList (the last one wins), and preprod slot 24837046 carries six for mint 0. Report-only before Conway, failure from Conway on.
35. Databases written before credential types existed: a one-off migration rebuilds `cred_type` for every stake and delegation row from the certificate history in the stored blocks (skipping phase-2-invalid transactions); 2 738 + 2 249 rows on the preprod database in 4 minutes, 945 + 456 on preview.
36. The preprod config had no `shelleyGenesisHash`; the first Shelley epoch's η0 (= that hash) was silently fetched from the external mirror, which the nonce fix now refuses on a from-genesis sync, so a fresh preprod run stalled at epoch 4 with "nonce not derivable". Hash added (Koios epoch 4 nonce and the cardano-node config agree: 162d29c4…); a missing hash is now an explicit error.
37. Byron transactions may carry a zero-lovelace output (mainnet epoch 204, tx 73822c3b…, confirmed on Koios); the Byron rule rejected any non-positive output. Zero is a report now, negative a failure.
38. Network-id rule: a Byron bootstrap address in a Shelley-era output is decoded by ledger-ts as an `Address` of type "byron" whose `network` field is meaningless; the rule read it as "testnet" and rejected mainnet's first Shelley epoch (tx 2b240c39…, epoch 208). Type-"byron" addresses are exempt like `ByronAddress` instances.
39. The "malformed addresses" reported on preprod were the same ledger-ts quirk: a Byron bootstrap address in a Shelley-era output was stored as the bogus bech32 of a 28-byte truncation, so those outputs could not be witness-checked when spent (report-only "unparseable address"). Outputs now serialize to the real base58 form rebuilt from the CBOR slice (`utils/byronAddressString.ts`), a one-off migration rewrites already-stored unspent outputs from the block data, and a mainnet fixture test covers it.
40. ledger-ts could not decode any MIR certificate: its certificate dispatcher passes the whole `[6, [source, destination]]` array to the Conway MIR class, which expects the inner pair, so every Shelley transaction carrying a MIR failed to parse (mainnet slot 4563840, tx 35d2728e…, the first reserves MIR; the range pipeline reset in a loop). Fixed in the sibling ledger-ts source (`fromCborObj` accepts both forms) and vendored as 0.5.6; fixture test with that transaction.
41. The reserves/treasury a later reward update reads for an epoch were recorded right after the reward update, before MIR credits and retirement refunds; mainnet's update into epoch 210 used the pre-MIR reserves (593·10¹² too high) and put 356·10⁹ too much into the treasury. The snapshot is refreshed at the end of the boundary now; the mainnet database was corrected by hand to Koios's epoch-210 pots.
42. Rollbacks never reverted the UTxO set: `blocks.hash` is hex text and `utxo_deltas.block_hash` a blob, so the delta join matched nothing (every rollback logged utxoRestored=0). Mainnet's first rollback (slot 5753380) left the re-applied block's inputs missing. Deltas are now matched through hex() with an index on the delta table, and a one-off migration reverts deltas orphaned by earlier rollbacks.
43. Overlay schedule: the slot test used floor where Shelley's `isOverlaySlot` uses ceiling (`step x = ceiling(x·d)`), so with 0 < d < 1 the first slot of each epoch (and the whole pattern) was misclassified; mainnet epoch 211 (d = 0.9) rejected the genesis delegate's block at slot 5788800 as "not a registered pool". Also `ascInv` is floor(1/f). Preprod and preview never had 0 < d < 1 with our code, so only mainnet showed it. Tests with the mainnet keys.
44. A pool that produced no block in the performance epoch was still paid its full maxPool while d ≥ 0.8 (apparent performance 1). The ledger's `reward` skips pools absent from BlocksMade, which is why mainnet paid no staking rewards for epochs 208–210 (only genesis delegates issued blocks); we paid 4.37·10¹² for epoch 210. Pools without blocks now earn nothing at any d.
45. η counted every block, including the genesis delegates' overlay blocks (16 817 of 21 442 at mainnet epoch 213), so η = 1 instead of pool blocks ÷ (1 − d)·f·slots; the pot for epoch 213 came out 2.7 % high. Only blocks by registered pools count now.
46. Script data hash for a transaction using both PlutusV1 and PlutusV2 scripts: the language-views map must be in canonical CBOR key order (V2's one-byte key before V1's two-byte key); the cost-models library emits V1 first, so the hash was wrong whenever both languages appeared (preview slot 11663879). Views are now assembled per language and sorted canonically; fixture test.
47. Pre-Conway duplicate redeemers (bug 34) were still summed for the execution-unit limits and the minimum fee: preview slot 12925989 carries the same mint redeemer six times and was rejected for 19.9 M memory units against a 14 M limit. The effective redeemer set (last per purpose) is used for ex-unit limits, block limits and fees; fixture test.
48. Pointer addresses (Shelley types 4/5) name their stake credential by the position of its registration certificate. ledger-ts neither decodes the pointer nor keeps it when re-encoding the address, so we stored such outputs as a 29-byte address with no stake key and they never counted in the stake snapshot (preview account 0c90492b… held 35.55·10⁹ at one: −16 % of its stake and rewards, and the pool's σ reports). Registrations are now indexed by (slot, tx index, cert index), the pointer is read from the raw output bytes, the full address is stored, and outputs resolve through the index before Conway (Conway removed pointer stake rights); a one-off block scan retags existing outputs. Fixture test with the two preview blocks.
49. The ChainSync header batcher had no bound: each timer or full-batch flush chained another batch onto its promise queue, and only the header that filled a batch waited for consensus, so every other header handler kept the 32-deep RequestNext pipeline topped up. Whenever a peer delivered headers faster than the applier consumed them (mainnet Byron: 14 000 headers retained per 10 minutes) the queue grew without limit and took the process to 24 GB (OOM 2026-09-05 09:06 UTC). `push` now resolves only while at most two batches are chained (`maxQueuedBatches`), which stops the top-up until consensus catches up; test. Main heap flat at 36–48 MB after the fix, versus 299 → 574 MB in ten minutes before.
50. A witness set whose datum entry is an indefinite-length empty array (`04 9F FF`) was treated as carrying datums, so a script_data_hash was demanded and preview block 31023089 (epoch 359, one plain transaction) failed. The ledger tests the decoded collection (`nullDats`), so both `80` and `9F FF` (and `A0` / `BF FF` for redeemers) mean "none". Fixture test with the block plus the four encodings.

## Open items (in order)

1. Plutus phase 2 (note: the JS evaluator's BigInt arithmetic is quadratic, so a reference-speed evaluator or a WebAssembly/GMP-backed integer path is a hard requirement for strictness, not only a speed-up): the shadow now evaluates real transactions with the chain's verdict (buildooor objects rebuilt from bytes, plutus-machine size measures and hard budget limit patched). Two things block strictness: the pure-JS machine is ~1000× slower than the reference (heavy redeemers exceed the 2 s wall-clock cap and are skipped, ~15% on preprod epoch 46), so a native/WASM evaluator is needed for mainnet-scale strict evaluation; and the agreement over Babbage/Conway history has to be measured with that evaluator.
2. Rewards: fixed (uncapped apparent performance, treasury forfeits, snapshot-time pool params); the clean resync must reproduce every boundary from genesis.
3. σ threshold reports: eight canonical preprod blocks (epochs 46–54) fail our leader-threshold check by 1e-5…1e-4 relative. Recomputed offline: each leader value sits just above our threshold, and our snapshot differs from Koios by the same order (pool stake −4e-6, total active +6e-5, e.g. 186 054 761 670 632 vs 186 043 780 730 525 at snapshot 46), so the real threshold is above the value. The exact-arithmetic check is right; the snapshot is very slightly off. Find the missing/extra stake (per-pool comparison at epochs 44–54) before making σ strict.
4. Conway on preprod (epoch 163): governance ratification, reference-script fee, V3 cost models — the run has to get there.
5. Mainnet: reach Shelley, then run the same comparisons (the scripts take `--network mainnet`).
6. Flip σ, opcert counter, withdrawals (`WITHDRAWALS_STRICT`) and the reference-script fee to strict once 2–5 are clean.
6a. Two preprod snapshots (boundaries 30 and 32) each lack one pool that registered and retired within the same epoch (2bdbd083…, 92cd3fdd…; 1.02·10¹² lovelace each), although the pool row, the delegations and the outputs were all present and a unit test of the same sequence passes; the boundary now logs any registered pool with delegations but no snapshot stake so the next occurrence carries details. Those two snapshots make the rewards of performance epochs 31 and 33 0.29 % low for every pool (apparent performance uses the active total).
6b. MIR certificates (pre-Conway, type 6) are now queued when applied and take effect at the next boundary after the reward update (accounts credited from the pot if registered and the pot can pay; pot-to-pot transfers); untested against a real chain until mainnet reaches its first MIR (none on preprod/preview so far).
6c. Memory: the 24 GB OOM of 2026-09-05 was bug 49 (unbounded header batch queue), fixed. The node logs a `Memory:` breakdown every 5 minutes (rss, main heap, external, worker heaps, worker external, unaccounted native) and `scripts/run-supervised.sh` relaunches a node that exits and restarts it cleanly at 14 GB RSS. Remaining baseline is ~1.1 GB native (20 worker runtimes, SQLite page cache) and stable.
7. Stake credentials are typed (key / script) in the certificate rule, the tables, the UTxO index, the snapshot and the reward paths; `rewards` rows written before the change for script reward accounts are still 28-byte (conflated with a key twin, if any) until re-derived from genesis. A rollback within k does not revert registrations/delegations (only UTxOs): a fork carrying a registration certificate would leave it registered.

## Reproducing the proof

```
# from-genesis run (overlay: role data, syncFromGenesis, no N2N)
NETWORK=preprod GEROLAMO_CONFIG_PATH=$DIR/config.json GEROLAMO_DB_PATH=$DIR/preprod.db \
  GEROLAMO_PORT=3032 GEROLAMO_FAILED_BLOCK_DIR=$DIR/logs bun src/index.ts start-gerolamo
# comparisons against Koios
bun scripts/verify-params.ts  --db $DIR/preprod.db --network preprod
bun scripts/verify-nonces.ts  --db $DIR/preprod.db --network preprod --from 4 --to 40
bun scripts/verify-stake.ts   --db $DIR/preprod.db --network preprod
bun scripts/verify-pots.ts    --db $DIR/preprod.db --network preprod
bun scripts/verify-rewards.ts --db $DIR/preprod.db --network preprod
# one transaction through the Plutus shadow with Koios-resolved inputs
bun scripts/shadow-tx.ts --tx <hash> --network preprod --db $DIR/preprod.db
# offline replay of a halted block
bun scripts/validate-stored-block.ts --db $DIR/preprod.db --hex $DIR/logs/failed-block-<slot>.hex --slot <slot> --network preprod
```

Preview: `NETWORK=preview` with `src/config/preview/` (genesis files from the local cardano-node install, magic 2, 86 400-slot epochs, Conway since 2024) gives a from-genesis proof that reaches governance in hours instead of days.

Shadow tuning: `GEROLAMO_PLUTUS_SHADOW_MS` (wall-clock cap per redeemer, default 2000) and `GEROLAMO_PLUTUS_SHADOW_SAMPLE` (evaluate every n-th Plutus transaction) keep Plutus-heavy regions from slowing a report-only run.

A strict failure halts the sync, writes the block to `$GEROLAMO_FAILED_BLOCK_DIR/failed-block-<slot>.hex`, and drops incoming headers until restart.
