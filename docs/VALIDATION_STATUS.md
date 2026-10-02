# Validation status — 2026-09-04

Consolidated state of `PLAN_FULL_VALIDATION.md` after the from-genesis proving
runs. The plan file keeps the chronological log; this page is the current
picture: what is verified, how, what is still open, and how to reproduce it.

## What the node verifies today (strict unless noted)

| Area | Rule | Status |
|---|---|---|
| Headers | KES signature, opcert cold signature, VRF proof (fast noble verifier, 600/600 agreement with the reference), Praos leader value `blake2b_256("L" ‖ vrf)`, overlay schedule, pool registration and VRF-key binding | strict |
| Headers | opcert counter never decreases (`CounterTooSmallOCERT`, bug 183) | strict |
| Headers | σ leader threshold (exact σ of the epoch's pool distribution), Praos `n ≤ m + 1` (`CounterOverIncrementedOCERT`, judged by the counters as of the header's parent) | strict on an exact ledger store (lmdb mode, store imported from a NewEpochState — `ledgerStateExact`); report-only in sqlite / dual mode and on a store seeded from SQLite (bugs 275, 276) |
| Withdrawals | account registered (`*WithdrawalsMissingAccounts`, bug 180); Conway PV ≥ 10 key accounts DRep-delegated (`ConwayWdrlNotDelegatedToDRep`) | strict |
| Withdrawals | must equal the reward balance (`ConwayIncompleteWithdrawals` / `WithdrawalsNotInRewards…`), earlier transactions of the block draining it | strict on an exact ledger store; report-only (with the reason) in sqlite / dual mode and on a SQLite-seeded store (bug 272) |
| Epoch nonces | UPDN/TICKN evolver, Praos block nonce `blake2b_256(blake2b_256("N" ‖ vrf))`, ηh from the previous epoch's last block, rebuilt from stored headers on restart and rollback | strict; every preprod epoch 5–31 equals Koios |
| Byron | tx structure, witnesses (PkWitness/Redeem), value conservation, `validateTxAux` size limit and fee policy on the on-chain `ATxAux` bytes with the adopted parameters (bugs 297–299) | strict |
| Byron | chain-validation state (`consensus/byron/ByronLedger`): update proposals / votes / endorsements / adoption, heavyweight delegation, header / block / EBB size limits, era of the block against the Byron→Shelley transition; persisted per block with rollback (bugs 296–301) | strict |
| Shelley…Conway | witnesses (vkey, bootstrap, required signers), native scripts (timelocks), value conservation with deposits/refunds, min fee (+ ex-unit prices), validity interval, min UTxO (Shelley, Mary scaled, Alonzo per-word with datum, Babbage per-byte from original bytes), size limits, certificate sequence | strict |
| Alonzo+ | datums (hashed from original bytes), collateral (incl. phase-2-invalid transactions), ex-unit caps per tx and block, redeemer ↔ purpose, byte-exact `script_data_hash`, witness script hashes from original bytes | strict |
| Conway governance | GOV (proposal deposit, return account, network ids, guardrail script, previous-action chain, hard-fork succession, committee-update bounds, well-formed parameter updates, voters and actions that exist, expired actions, voters an action admits, bootstrap-phase and protocol-11 restrictions), GOVCERT (DRep deposit / re-registration / refund, committee cold keys), DELEG / POOL (deposits, delegatee registration, pool cost / network / metadata / retirement epoch / protocol-11 VRF uniqueness), LEDGER (declared treasury, withdrawing key accounts delegated to a DRep) — against the ledger state before each transaction (bug 150) | strict (`GEROLAMO_GOV_RULES=report` to relax); the zero-balance-on-deregistration predicate and the declared treasury strict on an exact ledger store only (bugs 273, 274); report-only on tip sync |
| Plutus phase 2 | every redeemer evaluated within its declared units by Gerolamo's evaluator (`src/consensus/plutus`: flat decoder, CEK machine, builtins, per-variant cost models, V1/V2/V3 script contexts incl. governance), verdict = is_valid (`rules/phase2.ts`, bugs 200–214) | `GEROLAMO_PLUTUS_PHASE2` (enforce / report / off), default `enforce`; preview full-history replay: 3 191 175 valid transactions pass, 241 invalid fail, 0 mismatches (bug 214) |
| Conway | exact minimum fee incl. tiered reference-script fee, reference-script size per tx (200 KiB) and per block (1 MiB, PV 11 accumulation), inputs ∩ reference inputs (PV 9–10), header protocol version (mainnet) | strict (bugs 170–175) |
| Conway | `current_treasury_value` against the local treasury | strict on an exact ledger store, report-only otherwise (bugs 182, 273) |
| All eras | the UTXO/UTXOW/LEDGER predicate checklist below (bugs 170–184) | see "Conway predicate checklist" |
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
| Conway governance history | `scripts/gov-replay.ts` (the node's governance code over the chunk store; Koios `proposal_list`, `totals`, `drep_history`, `pool_voting_power_history`; decoded NewEpochStates) | preview 646–1434: 218 325 governance transactions through the GOV/GOVCERT/DELEG/POOL/LEDGER checks, 0 failures; every epoch's ratified / expiring / enacted / expired / dropped set equal to Koios; NewEpochState at slots 122 316 253, 122 735 066 and 123 980 824: DReps (expiry, deposit), committee members and typed committee state, proposals, votes, roots, pulser result, dormant count and all vote delegations equal (bugs 150–165) |
| Governance rules on the LMDB store | `scripts/gov-rules-shadow.ts` (read-only, the view pinned to each block's parent) | both preview nodes: 432 blocks, 58 governance transactions, 0 failures |
| Reward balances, pots, pool distributions, opcert counters | `scripts/reward-accounts-compare.ts` (every registered account, query 10), `scripts/n2c-compare.ts --only …` | both preview nodes at block 124 163 389: 111 805 accounts' delegations and reward balances byte-identical with cardano-node; GetAccountState, GetPoolDistr(2), GetStakeSnapshots, DebugChainDepState byte-identical (bugs 272–276) |
| Balance rules on the LMDB store | `scripts/ledger-rules-shadow.ts` (body + governance rules, view pinned to each block's parent), `scripts/balance-history-check.ts` (balances rebuilt from the chain and the recorded boundary credits since the import) | volatile windows of both nodes: 0 failures; epochs 1421–1437: 40 247 withdrawals and 32 deregistrations checked, 0 mismatches; all 17 Conway treasury claims equal the recorded treasury (bugs 272–274) |
| Header rules over the whole chain | `scripts/header-rules-replay.ts` | 4 713 292 preview headers: OCERT 0 failures, the ahead-of-apply counter state equal to the chain's for every header; σ: 65 550 headers of 22 epochs with exact snapshots, 0 failures (bugs 275, 276) |
| Voting / proposing redeemers | `scripts/gov-redeemers-replay.ts` | preview 500 transactions (70 vote, 495 propose redeemers), preprod 500 (431 vote incl. 3 multi-voter, 93 propose): 0 match messages; preview phase 2 equal to is_valid on all 467 (bug 277) |

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
14. RESOLVED. Sixth replay (2026-09-09 02:15 → 09:44 UTC, certified tip 122 087 503, epoch 1413): EXACT against Koios — reserves and treasury to the lovelace at 1413, every per-epoch treasury delta 0 ppm, total active stake and every sampled pool stake exact at 1405–1410, 48/48 sampled rewards (leader and member) exact at performance epochs 1403–1408, every governance checkpoint on the chain's epoch. One SQLITE_BUSY pipeline reset at 06:46 (re-anchored, no data effect; busy_timeout added to the sync writer). This database becomes the tip node's. History tables of replays 3–5 kept beside it for reference. Swapped 2026-09-09 10:17 UTC: the tip node (3035) now runs on it; the live boundaries 1414 and 1415, computed from public peers past the certified chain, were exact as well (pots diff 0, stake OK).
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
51. Self-inflicted (2026-09-05, same day): the batched UTxO writes made `upsertUtxoRow` queue rows, but `rollbackChainTo` and `ensureOrphanedDeltasReverted` restore spent outputs through it and never flushed, so a 5-block rollback on preview "restored" 30 outputs that never reached the table and the re-applied block halted on missing inputs (slot 41735103). Both paths now flush; regression test `db.rollbackRestore.test.ts`; `scripts/repair-missing-inputs.ts` rebuilt the lost rows from the creating transactions in our own blocks.
52. Preview block 51361220 (Babbage) could not be decoded: one transaction's mint map lists each policy twice. cardano-node's decoder (protocol < 9) builds a `Map`, so the later entry replaces the earlier one, while ledger-ts's `Value` constructor rejected the duplicate and the whole block failed to parse; the range was blamed on the peer and retried forever. ledger-ts 0.5.7 (vendored) applies last-wins for duplicate policies and asset names; fixture test `duplicateMintPolicy.test.ts`. Undecodable blocks are now a `BlockDecodeFailure` halt: the bytes are dumped, the log says the decoder is at fault and the ledger is intact (no resync), and no peer is terminated — the block already passed header-hash, body-hash and peer-agreement checks, so it is real by construction.
53. First Conway block with a governance action (preview 55835715, epoch 646): value not conserved by exactly the 100 000 ADA proposal deposit. ledger-ts's Conway body decoder left keys 19–22 (voting procedures, proposal procedures, current treasury value, donation) undecoded — a leftover TODO — so the deposit, and every vote and proposal, never reached our rules or the governance tables. ledger-ts 0.5.8 (vendored) adds decoders for the seven governance actions, proposal procedures, voters, votes and voting procedures and fills the four fields; fixture test `conwayProposalDeposit.test.ts`.
54. First PlutusV3 transaction on preview (slot 55870734, epoch 646): script_data_hash mismatch. The language view for V3 came from the cost-models library, which pads V3 to its full 350-parameter list; the chain hashes the list exactly as the protocol parameters carry it (251 entries at protocol 9). V2 and V3 views are now encoded directly from the parameter lists (V1 keeps the legacy bytes-key form); fixture test `conwayV3ScriptDataHash.test.ts` with the block and the epoch-646 parameters. Also fixed with 0.5.8 going live: the vote recorder read the vote from the wrong field and failed a NOT NULL constraint on every vote (warning only).
55. First block of preview epoch 647 (slot 55900879), the first epoch whose nonce was computed under Conway: every header failed the VRF check because our epoch nonce was wrong. Conway (protocol major ≥ 9) freezes the candidate nonce at the RandomnessStabilisationWindow, 4k/f slots before the epoch ends; earlier eras froze it at the 3k/f stability window. Recomputing the epoch 647 nonce from the stored epoch 646 headers with 4k/f reproduces Koios exactly (de82acf4…); 3k/f gives 8df0c4c2…. The evolver now takes the protocol major per epoch from the stored parameters (`NonceEvolver.setProtocolMajor`), fixture test `nonceEvolver.conwayWindow.test.ts`. Side effect worth noting: the node classified the peers serving the correct headers as malicious and held 29 of them cold before the restart.
56. Preview slot 57454191 (Conway, epoch 664): "datum d9c38f56… not in the witness set" for a PlutusV2 spend whose datum was present. Conway encodes witness datums, scripts and key witnesses as `nonempty_set` (CBOR tag 258); the byte slicers in scriptDataHash.ts (`witnessDatumBytes`, the witness-script hash collector) read `.array` off the tag and saw empty lists. They now unwrap the tag; fixture test `conwayWitnessDatums.test.ts` (block preview-block-57454191.hex).
57. Preview slot 58809651 (Conway, epoch 680): "input … is locked by a Plutus script but carries no datum" for a PlutusV3 spend. Conway (CIP-69) makes the datum optional for V3 spending scripts; V1/V2 still require one. txRules now records each Plutus script's language (witness set keys 3/6/7 and reference scripts) and the Alonzo rule only fails for V1/V2, reporting (not failing) when the version is unknown. Fixture test on preview-block-58809651.hex.
58. Preview slot 61206431 (Conway, epoch 708): "duplicate redeemer for purpose 3:0". The witness set uses the legacy list form and repeats the reward redeemer; we failed duplicates from Conway on, assuming the map form. The ledger decodes the list form with Map.fromList in every era (last one wins) and only the map form is duplicate-free by construction. Duplicates are now a report in every era; fixture test on preview-block-61206431.hex.
59. Preview slot 63616305 (Conway, epoch 736): V3 script_data_hash mismatch because the epoch 736 parameters kept the 251-entry PlutusV3 cost model while the chain enacted a 297-entry one (ParameterChange 1f47f3cf…:0, ratified 735). The cost-models library ignores a language list containing a negative integer (the new V3 list has four), so ledger-ts reported no cost models and the proposal was stored with empty changes. Cost models are now read from the body bytes (`costModelsOfProposal`) and merged per language at enactment (Conway replaces only the named languages). The stored epoch 736 parameters and proposal record were repaired from the on-chain action, which equals the Koios record. Fixture tests on preview-block-63146776.hex and preview-costmodels-736.json.
60. Preview slot 64848165 (Conway, epoch 750): block undecodable, "update_committee: threshold is not a rational". The ledger-ts governance decoder demanded a CborPositiveRational instance where the parser yields a plain tag-30 CborTag; it now goes through fromCborObjOrUndef, and `CborPositiveRational.clone()` (which returns a plain CborTag) is no longer used when the action object is rebuilt. cardano-ledger-ts vendored at 0.5.10. Fixture test conwayGovDecode.test.ts on preview-block-64848165.hex.
61. Preview slot 68390403 (Conway, epoch 791, protocol 10): script_data_hash mismatch "(languages V3,V2)". The language view must cover only the Plutus scripts the transaction needs; we added the language of every reference script on the inputs and reference inputs, and this transaction referenced an unrelated PlutusV2 script next to its V3 spend. `scriptDataLanguages` now derives the set from the needed script hashes (spend, mint, certificate, withdrawal). Fixture test scriptDataLanguages.test.ts (block + epoch 791 parameters): the V3-only view reproduces the hash. Follow-up the same hour (preview slot 68911489): the needed set also has to cover Conway purposes — votes by script credentials and proposals guarded by the policy (guardrail) script — and falls back to the witness-set languages when redeemers exist but no purpose is recognised.
62. Preview epochs 880–898 collapsed to 2 blocks/s with one hot peer. Two causes, neither a ledger bug: (a) header batches reaching into the next epoch before its nonce was derivable threw "Missing epoch nonce" and dropped the peer; the batch now holds (ChainSync back-pressure, up to 15 min) until the applier makes the nonce derivable. (b) Verifier headers at a slot the primary's window had no header for were ruled "divergent … primary=∅" and the peers held cold, although Koios shows those blocks canonical; the primary's window is kept in arrival order and a re-anchored promoted peer replays older slots, so the gaps were ours. A missing slot is now no verdict; a fork is still detected at the next shared slot. Also: per-header "Header validation PASSED" objects were logged at info (half of a 4 GB log); now debug. Second finding from the same collapse: the inline (non-ahead) rules path still ran the Plutus shadow evaluation on the main thread, and with the budget raised to 2 s it stalled the applier at 325 ms per block while 80 % of blocks were inline because withdrawal conflicts made the scheduler skip them; the inline path now runs rules only and the overlay carries emptied reward accounts.
63. Preview slot 78301164 (epoch 906): "Stake credential already registered" for a script credential Koios shows registered for the first time in that very block. Cause: a minute earlier two ChainSync restarts within one second let the second stream's positioning RollBackward miss the intersect check, and the orchestrator ran an unconditional rollback of 164 valid blocks; rollbacks revert blocks, UTxOs and deltas but not certificate state (stake registrations, delegations, pools, DReps, governance, deposits), so re-applying the same blocks collided with their own registrations. Fixes: a primary's RollBackward is now deferred until its next headers either prove they are our own blocks (cancelled) or extend the rollback point with a block we do not hold (fork: rollback runs then). Fixed the same day (PLAN_LEDGER_INTEGRITY.md A): SQLite triggers journal before-images of every block-time write to the 14 state tables (`ledger_journal`, `src/db/ledgerJournal.ts`); `rollbackChainTo` undoes them newest first and refuses a rollback that crosses an epoch boundary (boundary work is not journaled). Tests: ledgerJournal.test.ts, db.rollbackRestore.test.ts. Repair: the 11 stake rows registered by the rolled-back blocks (ids 27798–27808, confirmed against Koios first-registration slots) and one DRep registration were deleted by hand before restarting; delegations are delete-then-insert on re-apply. Deposits counted twice by the double apply were not corrected (pot drift to check against Koios).
64. Preview slot 78658821 (epoch 910): "script 95726d53… required but not provided" on a transaction with no scripts, no redeemers and only vkey witnesses. Its collateral input sits at a script address; the ledger never consumes or checks it when no Plutus script runs (the collateral rules are guarded by the presence of redeemers, and scripts are needed for spending inputs only), but our required-witness set treated collateral inputs like spending inputs. Collateral inputs now contribute key witnesses only. Fixture test on preview-block-78658821.hex.
65. Treasury/reserves drift against Koios of 66–258 ppm per epoch on preview (PLAN_LEDGER_INTEGRITY.md B). Root cause: `withdrawalEntries` typed every script reward account as a key account (the ledger-ts StakeAddress carries `type: "script"` on itself, its `credentials` is a bare hash), so a withdrawal from a script account debited a 28-byte row that did not exist (or a key account with the same hash) while the script account's 29-byte balance grew forever: 1 767 script accounts held 40.8 T of "rewards", 47 key rows went negative. Inflated balances inflated pool stake (per-pool active stake +1.3 % at epoch 637, +2.8 % at 965), apparent performance and pool rewards, which fed the balances again. Fixed in `withdrawalEntries`; fixture test db.withdrawalEntries.test.ts (preview block 61206431, a script reward withdrawal). Repair (`scripts/repair-script-rewards.ts`, 2026-09-06 10:30 UTC): replayed our own 152 623 withdrawal deltas onto the 1 767 script rows (397 subtractions, 66 merges of mistyped twin rows, 20 clamped at 0 where we had under-paid); script balances 42.27 T → 12.65 T. Acceptance is `verify-pots.ts` at ≈0 ppm for the epochs after the repair; a residual would point at the remaining distribution differences (some script accounts received less than Koios shows).

66. Plutus shadow: every "over budget" verdict mismatch on preview epochs 820–1060 was the evaluator's cost model, not the chain (PLAN_LEDGER_INTEGRITY.md C). Three defects in `@harmoniclabs/plutus-machine` 2.1.3, found by evaluating the same applied program with aiken's `uplc` crate (which reproduces cardano-node's execution units on preview to the unit): (a) V1/V2 scripts were costed with the Plutus V3 division functions — the fake-V3 conversion deletes `divideInteger`/`modInteger`/`quotientInteger`/`remainderInteger` parameters and substitutes V3 defaults, so a V2 `modInteger` on two-word integers charged memory 2 instead of 1 (memory over by Σ(y−1)) and cpu 132 k instead of 308 k (cpu under by 5 %); the machine now keeps the V1/V2 models (constant above the diagonal, else intercept + slope·x·y; memory max(min, x − y)) from the language's own parameters; (b) the V3 two-variable quadratic used `c02·y` instead of `c02·y²` (+1800 cpu per two-word division); (c) V3 `multiplyInteger` cpu used added instead of multiplied sizes (+519 per one-word product). Vendored patch `patches/@harmoniclabs%2Fplutus-machine@2.1.3.patch`; `src/consensus/rules/plutusCostModel.test.ts` checks a real V2 redeemer (preview tx 8fffef38…, 494 407 913 / 1 621 146 exactly) and 126 integer-builtin cases per language against the reference. Tooling: `GEROLAMO_PLUTUS_TRACE=1|2` (per-builtin, per-size cost trace on mismatches), `GEROLAMO_PLUTUS_DUMP_DIR` (applied programs and our script contexts as CBOR), `scripts/aiken-simulate.ts`, `scripts/data-diff.ts`, `tools/uplc-ref/`.
67. Plutus script context (buildooor `getTxInfos`): the +1453 cpu family (V2 scripts of one preview dapp, epochs 820–1060) came from our context, not the evaluator — aiken's own context reproduced the declared budget exactly while our program cost 1453 more. Two differences against aiken's context: (a) the validity interval's lower bound was encoded as open (`False`) and a finite ttl as closed; the ledger has the lower bound inclusive and, from protocol version 9 on, the ttl exclusive (missing bounds stay inclusive) — `getTxIntervalData` now takes `upperBoundClosed` and `plutusEval` passes `pv < 9`; (b) a stake credential of a base address was `Credential` instead of `StakingHash Credential` for V1/V2 contexts (`StakeCredentials.toData` inverted its version test) — fixed in cardano-ledger-ts 0.5.11 (vendor/) and patched in buildooor's nested 0.4.8. `src/consensus/rules/scriptContext.test.ts`; fixture `preview-scriptcontext-167a49fe-0-0.aiken.hex` is aiken's context for that transaction.
68. Preview slot 94710858 (epoch 1096): "execution memory 16500000 > max 14000000" — the chain raised `max_tx_ex_mem` (16.5 M) and `max_block_ex_mem` (72 M) at epoch 1096 through governance action 69c948cd…:0 and our ledger never enacted it. Two governance defects: (a) `ratifyAndEnact` required a committee vote for UpdateCommittee actions (cardano-ledger's `votingCommitteeThreshold` is Nothing for NoConfidence and UpdateCommittee), so none of preview's five committee updates (epochs 994, 998, 1013, 1361, 1370) was ratified; the genesis member expired at epoch 1000 and, with an empty committee, nothing could be ratified afterwards (every later action "expired"); (b) parameter changes were decoded through the ledger-ts field map, which has no entry for the Conway governance group (`committee_min_size`, `drep_activity`, deposits, lifetimes, thresholds) — the enactments of epochs 964 (`drep_activity` 31) and 999 (`committee_min_size` 3) were recorded as empty. Parameter changes are now decoded from the proposal bytes for every key (`paramChangesOfProposal`, tests with the three preview proposals). Repair (node stopped): `scripts/repair-governance.ts --epoch 1096 --apply` — Koios as the reference for decisions and dates, our recorded payloads for the content: 45 proposal statuses corrected, 8 enactments recorded, committee rebuilt (3 members, hot keys matching the votes we recorded), prev-action pointers set, 6 pending deposits (100 k ADA each) refunded, `epoch_params` rows 964–1096 corrected. Balances differ from the chain only in the timing of earlier refunds (same totals by 1096).

69. Preview slot 98358104 (epoch 1138): 45-minute stall, no halt. The applied tip was 40 % into the epoch while the header stream stood at the epoch-1139 boundary, and every peer's header batch spanned that boundary. Such a batch is held until the applier derives the next nonce (candidate frozen 4k/f before the boundary), but the blocks the applier needed to get there were referenced only by the held headers — a deadlock that recurred on redelivery from every peer (111 k hold warnings). `processRollForwardBatch` now splits a batch whose later epoch has no nonce yet: the headers before the boundary are validated, their range buffer is flushed unconditionally (the idle flush timer is reset by every batch and skipped while the stream is throttled), and only the remainder is held. Warning throttled to once per 30 s per epoch. A second stall of the same shape at epoch 1148 (split without the forced flush; the 15-minute hold timeout then terminated every peer in turn) was cleared by a restart; the split now logs the slot ranges and a primary that only re-streams headers we hold while the scheduler is idle, so a recurrence is diagnosable from the log. Third occurrence (epoch 1170) showed the real mechanism: a verifier promoted to primary has its ChainSync restarted from the DB tip, but the verifier-era batch it was already holding kept its per-peer batch queue blocked, so the restarted stream never delivered a header ("Silent hot→warm" for the primary, forever) while the applier waited for exactly those headers. A held batch now aborts as soon as the peer's `chainSyncGeneration` changes or the peer terminates. Then the hold itself was removed: at 55 blocks/s the header stream stopped ~30 s per epoch waiting for the next nonce (4k/f before the boundary), which capped the sync at 5 cores. Headers of an epoch whose nonce is not derivable yet are now accepted with the VRF proof and leader rule deferred (KES, op-cert, chaining and body-hash binding verified as before), their bodies are fetched, and the deferred checks run in bulk on the workers as soon as the applier reaches the freeze point — always before the block applies; a failure marks the header, the applier refuses it and the peer is held as malicious. `GEROLAMO_DEFER_VRF=0` restores the hold. Tests: `workers/deferredVrf.test.ts` (real preview header, epoch-841 nonce).

70. Preview slot 98785139 (epoch 1143): "invalid 'relays' constructing 'PoolParams'" — a pool registration whose only relay is `[0, 3001, null, null]` (single-host-addr with a port and no address). The CDDL allows every field of that relay to be nil and the ledger accepts it; ledger-ts required an IPv4 or IPv6 address. Fixed in cardano-ledger-ts 0.5.12 (vendor/); fixture test `src/consensus/poolRelayNil.test.ts` with the block.

71. Preview slot 109728116 (first block of epoch 1270): "script_data_hash … ≠ expected (languages V3)" — the chain enacted a cost-model change at epoch 1270 (action 014c32e5…:0: PlutusV1/V2 to 332 parameters, V3 to 350) and our tally had not ratified it although the proposal, its votes and the previous-action pointer were all recorded. Cause: the DRep tally put every registered DRep's delegated stake in the denominator (8 798 DReps, 167 T lovelace) while cardano-ledger drops expired DReps (last activity + `drep_activity` behind the current epoch) from the voting distribution — 8 active DReps, 18.5 T; the "Yes" was 11 % for us and 83 % on chain. `drepDistribution` now keeps only active DReps (votes and certificates are activity, as before), and dormant epochs — boundaries with no active proposal — are counted in `gov_state.dormant_epochs` and added to every DRep's activity when the next proposal arrives (numDormantEpochs). Test in `state.test.ts`. The boundary was rolled back with the failed block, so a restart re-ran the tally with the fix; no repair needed.

72. Preview at the tip (epoch 1412): every reward paid since the pot alignment at epoch 1050 was ≈ +0.13 % above the chain's (perf epoch 1391: our operator reward 30 312 875 352 vs 30 282 766 458 for pool 2afbef2f…; 418.81 vs 418.28 G lovelace in total), the reserves lost ≈ 440 ADA per epoch and the treasury drifted −21 ppm/epoch. Not a formula defect: with the chain's inputs (reserves, active stake 1 649 859 842 381 164, pool stake) `computeEpochRewards` reproduces the operator reward and a member reward (1 042 038 for account 2bebb363… in pool 24d3…) to the lovelace. The inputs were stale state: reward balances count as stake, and balances still carried the excess of bugs fixed long before (mistyped script-account withdrawals, the 1050 pot alignment that left the balances alone) — 2.93 M ADA above the chain's reward total, 2.18 M ADA of it delegated, so every snapshot total was +0.13 %, the apparent performance β = n·activeStake/(N·σ) of every pool +0.13 %, and the excess compounded. Repair (node stopped): `scripts/repair-reward-balances.ts --apply` rewrites the three retained snapshots from Koios `pool_delegators_history` (ordered pagination — unordered pages overlap and drop rows), corrects every balance by its snapshot excess (invariant under withdrawals since the boundary; accounts outside the snapshot from `account_info`), and sets the pots to Koios `totals`. Also fixed on the way: the pot floored η·ρ·reserves twice (1 lovelace short on some epochs, e.g. 1391); one floor now, test in `rewards.test.ts`.
73. Preview slot 122 077 808 (2026-09-06 22:30 UTC, at the tip): a one-block fork — our primary served a315e0ea…, the verifiers agreed on a2aeb7e3… at the same slot — left the node on the dead branch for four hours. Three defects: (a) `switchPrimaryAfterOutvote` handed the rollback to `handleRollBack` without the fork point's hash, which only *defers* it, so the successor's range failed the contiguity check ("does not extend the applied chain") and our outvoted block stayed; (b) the ChainSync restart offered a single FindIntersect point (our tip), which the other side of the fork does not hold → IntersectNotFound; (c) on IntersectNotFound the consumer kept the read pointer at origin ("proceeding with producer tip") and validated preview's first headers against the current stake distribution — every honest peer was banned as malicious (`Header leader rule failed at slot 172836`), the 1 h cold hold expired, the loop repeated. Fixes: the outvote rolls back immediately (k-guarded, `rollbackOurChainTo`), FindIntersect offers our last blocks densely and then Fibonacci-spaced back to k (`intersectOffsets`, test in `chainSyncStart.test.ts`), and a resuming peer with no intersection is dropped instead of streamed from origin. The first restart with those fixes exposed two more: (d) the positioning RollBackward that follows FindIntersect was always ignored — correct when the intersection is our tip, wrong when it lies behind it (it is the fork signal that arms the deferred rollback), and (e) a header at our tip's slot whose parent we hold tripped the "does not advance past its parent" check and banned the honest peer; now the positioning rollback is handed to consensus when the intersection is behind our tip, and a same-slot header chaining onto a block we hold rolls our branch back (k-guarded) instead. Second restart 03:29:52 UTC: intersect at 122 077 785 → deferred rollback armed → fork confirmed by the first header → 1 block / 22 deltas undone → caught up 18 000 slots and applied the epoch 1413 boundary within 30 s.
74. Preview since epoch 1270 (found at the tip, 2026-09-07): every PlutusV1/V2 script was costed with PlutusV3 parameter names. The cost-model enactment of epoch 1270 (bug 71) grew the V1/V2 lists to 332 entries; `new Machine(array)` infers the language from the array's length and tests V3 first (≥ 251 entries), so the V2 array was read in V3 order — every parameter after the bls12_381 block shifted (ifThenElse cpu 10 / mem 29 899, tailList mem 43 574 283, unBData cpu 1 293 828) and the shadow reported `exceeded its declared budget` for 21 of 55 sampled redeemers in epoch 1413 (a V2 script family; V3 traffic dominated before, so epoch 1412 showed nothing). `machinesFor` now names the V1/V2 parameters itself (`toCostModelV1/V2`: the first 166/175 entries in their historical order, exactly what aiken's `uplc` crate maps; the entries appended since are ignored, as there). Regression test with the epoch-1413 cost models (`preview-costmodels-1413.json`) in `plutusCostModel.test.ts`. Report-only (shadow), so no halt; strict Plutus verdicts were never enabled on this path.
75. Inbound N2N (relay role), found by serving the Mithril chain to our own node (2026-09-07 07:45 UTC): a block larger than one mux segment (preview slot ≈ 2.47 M, 86 744 bytes; mainnet blocks reach 88 KB) was sent as a single segment. The mux header carries a 16-bit payload length and `Multiplexer.send` does not split, so the length wrapped and the consumer lost the frame boundary ("unwrapped Multiplexer header was not a mini protocol"), dropped the relay and fell back to public peers. `sendN2NResponder` now splits every responder payload into ≤ 12 288-byte segments (cardano-node's SDU; the receiver reassembles per protocol). Test in `N2NDirection.test.ts`. The relay had only ever served small early blocks in tests, so this would have hit the first real peer of a Gerolamo relay.
76. Applier-thread waste found by CPU profiling the local-relay replay (2026-09-07, `bun --cpu-prof` + `scripts/cpuprofile-top.ts --callers`): (a) `@harmoniclabs/cbor` 1.6.6 built every assertion message eagerly — `"… got: " + bytes` stringified whole blocks on every `Cbor.parse` / `parseLazy` / `LazyCborArray` even when the assertion passed (8 % of the thread; patched in `patches/@harmoniclabs%2Fcbor@1.6.6.patch`, lazy messages); (b) `BlockBodyValidator` decoded every Plutus witness script with `UPLCDecoder` on the applier thread just to prove it decodes, although the rules workers run the same scripts (2 % in Alonzo, far more with Conway traffic; removed); (c) `isSlotLeader` recomputed ln(1 − f) and −σ·ln(1 − f) with BigDecimal for every header of every hot peer (2.6 %; cached per f and per (f, σ)); (d) `wsPublish` serialised every tip event with no WebSocket subscriber (2.7 %; skipped without subscribers); (e) `CandidateSet.observe` parsed a BigInt per pending verifier entry per primary header (4 %; numeric slot keys, one key per header); (f) the SQL profiler's own key building put `join` + a regex on every statement (cached per call site). Same chain region (epochs 48–49) before/after the restart: 31 → 57 blocks/s, with the hot-peer target also cut from 6 to 3 (`peerGovernor.targetHot`) for the replay. Second pass with the SQL profiler (per-statement timing): the fee pot and the treasury account were updated once per transaction (54 000 UPDATEs a minute, 37 % of the applier's SQL time) — now once per block; the opcert counter row was read per header and upserted per block — now cached per pool and written only when the counter changes (rollback clears the cache); the reference-script count per scripted transaction only fed a debug line — skipped at INFO. The rules stage's pre-read of a block's inputs never contained outputs created by earlier in-flight blocks (the overlay only removed spent rows), so two thirds of preview spends fell through to a SELECT per transaction — a recent-outputs cache (60 000 refs, cleared on rollback) now serves them; main-thread SQL 12.5 → 6.4 s per minute, 164 k → 57 k statements. Third pass from a fresh profile: spends are deleted once per block (one DELETE … RETURNING with the same strict count check, transactions named on a mismatch) and the pending UTxO writes flush once per block instead of per transaction; the rules job cloned the epoch parameters (cost models) and the genesis JSON into every worker message (8 % of the thread) — sent once per worker now under an id; bech32 output address strings are cached per raw address (6 %); `isHex` in cardano-ledger-ts scanned the string with `includes` per character (2 %) — regex, vendored as 0.5.13. Fourth pass: the writer moved off Bun.SQL onto a synchronous bun:sqlite client with the same tagged-template surface (`src/sqlSync.ts`: cached prepared statements, no promise or query object per statement, long IN-lists bound as one JSON parameter through `json_each` so the statement text stays stable) — 2–3× faster on the applier's statement mix, ~25 % less apply time per block byte on the replay; default since 2026-09-07 (`GEROLAMO_SYNC_SQL=0` restores Bun.SQL), the API's read-only connection unchanged. Fifth pass (dense epochs ~500, 34 blocks/s, applier saturated): the recent-outputs and stake-key caches evicted with `map.delete(map.keys().next().value)` — JavaScriptCore keeps deleted Map entries as tombstones that a fresh iterator walks first, so each eviction at a steady 60 000 entries cost 37 µs (20 % of the thread); replaced by a queue-evicting `BoundedMap`. The stake key of every output was taken by parsing the bech32 string through ledger-ts (another 20 %); it is read from the raw address bytes now (`stakeKeyOfRawAddress`). Output address strings likewise went through the library's bit-string bech32 encoder (32 µs each, ~9 %); the repo's typed-array encoder (2.7 µs, verified against ledger-ts) now encodes every Shelley output address from its raw bytes. 33.6 → 56.6 blocks/s at epoch ~506 before the encoder change. Next profile: the rules pre-read decoded UTxO rows out of SQLite for inputs the recent-outputs map already held (15 %) — the pre-read consults the map first now; `os.cpus()` on every /metrics poll (2 %) replaced by /proc/stat; the in-flight overlays are applied with one map copy per scheduled block instead of one per overlay. Net for the day's passes at epoch ~500–530: 33.6 → 77 blocks/s.
77. The logger singleton defaulted to DEBUG, so the validation workers (which never receive the node's log config) printed nine DEBUG lines per validated header from every hot peer: 22 000 lines a minute (17 GB a day) of "Header validation PASSED" formatted on the workers and written to the node's log. Default is INFO now, the main thread logs its effective level at start, and the per-header line is opt-in (`GEROLAMO_HEADER_TRACE=1`).
78. A pre-Conway transaction may list the same input twice (inputs are a CBOR list until the Conway set tag; the ledger spends the set — preview slot 50 778 243 tx 0). The applier counted the repeat twice against one deleted row, the strict per-block delete check (bug 76, third pass) threw "14 input row(s) known but 13 deleted", the range pipeline reset and the local relay was dropped and re-dialed (the retry passed because the database read collapses the repeat). Input refs are deduplicated per transaction now (`spentInputRefs`).
79. Plutus script context (buildooor `getTxInfos`, three fixes, found by diffing our context against aiken's with `scripts/data-diff.ts`): (a) `TxInfo.signatories` kept the transaction's `required_signers` order — the ledger's is a Set, ascending key hashes; (b) `TxInfo.redeemers` was in witness-set order — the ledger orders by redeemer pointer (spend, mint, cert, reward, vote, propose; then index); (c) a withdrawal's `Rewarding` purpose carried the credential bare — V1/V2 wrap it in `StakingHash` (Constr 0). A script that searches those lists pays a different budget for a different order, and a mismatched purpose fails the redeemer lookup; seven of the twelve shadow-mismatch families of the replay (e.g. preview slot 12 996 478: 73 857 vs 73 758 declared memory units) were these.
80. Plutus machine (plutus-machine 2.1.3 + plutus-data 1.2.6, all patched; found with the new per-builtin differential harness `scripts/builtin-cost-diff.ts` against aiken's `uplc` crate and a builtin-call trace on both machines): (a) the CEK heap deduplicated every bound value by deep equality — O(heap) per variable binding, and `eqData` called an empty list equal to a non-empty one (prefix `every` without a length check), so a Plutarch validator bound a variable to the *previous* value (read the reference inputs where it asked for the outputs; preview slot 15 926 694) and failed a block the chain accepted; deduplication removed, `eqData` fixed; (b) left-application of a lambda pushed the argument onto the lambda's captured environment in place (the right-application branch cloned) — cloned now; (c) string size was byte/8 words instead of one unit per character (`appendString`/`equalsString`/`encodeUtf8` charged up to 7× too little cpu); (d) `verifyEd25519Signature` cpu was linear in the signature instead of the message; (e) `consByteString` errored on values outside 0..255 — V1/V2 take the byte modulo 256 (V3 errors); (f) `serialiseData` wrote maps indefinite-length (the ledger writes definite), dropped every 64-byte chunk after the first of a long bytestring, and left bignums without their tag-2/3 encoding (and unchunked beyond 64 bytes). After these, every one of the replay's 160 shadow mismatches between genesis and epoch 630 evaluates to the declared units exactly, and the harness (275 programs, V1 and V2) agrees with aiken on budget and result for every builtin.
81. Governance actions were enacted at the boundary that ratified them. The ledger sets up the DRep pulser at the start of an epoch (proposals, votes and stake as of that boundary) and completes it at the next boundary, where ratified actions take effect and expired ones are dropped and refunded — one epoch later. Preview action 1f47f3cf… (a 297-entry PlutusV3 cost model) is ratified at 735 and enacted at 736 on the chain (Koios; the 1291 hard fork likewise, ratified 1290); we applied it at 735 and the first block of the epoch failed `script_data_hash` for its V3 transactions (halt at slot 63 504 075; the range transaction rolled the boundary back). `ratifyAndEnact` now records the boundary's ratification in `gov_state.pending` (status `ratified`) and enacts it at the following boundary; chain ids advance at ratification so the next pulser sees them.
82. The ratification tally used the stake snapshot of the previous boundary and the previous epoch's parameters. The ledger sets up the epoch's DRep pulser after the boundary's snapshot and enactment: pool and DRep distributions of *this* boundary's snapshot, thresholds of this epoch's parameters. Preview hard fork 049ae5d6… (pv 10) tallied 46 % of pool stake at 742 with the 741 snapshot and 62 % with the 742 snapshot (threshold 51 %): the chain ratified it at 742 and enacted at 743; we did so one epoch late (744) — blocks of 743 still validated. Ratification now runs after the snapshot (`ratifyForNext`, `scripts/gov-tally.ts` recomputes any tally offline); enactment of the pending result stays first (`enactPending`). Epoch 743's stored parameters and the two governance rows were corrected by hand (pv 10, enacted 743).
83. A committee member's hot-key authorisation certificate (`auth_committee_hot`) was recorded only if the cold key was already a member, so the seven members added by preview's committee updates of epochs 994 and 998 — who authorised their hot keys earlier — cast committee votes we did not count, and parameter change 602d8572… (`committee_min_size` 3; ratified 998, enacted 999 on the chain) was never ratified by us. Authorisations now live in `gov_committee_auth` regardless of membership and are applied when the member is added; the replay's seven authorisations were restored from the stored blocks.
84. A pool's reward account was stored as a bare hash: ledger-ts's `StakeAddress` carries the credential type on itself, not on its `credentials`, so a script reward account (preview pool ae1c21b1fb…, margin 100 %, reward account `stake_test17r76…`) never matched the typed registered set and its operator rewards were dropped every epoch — ~283 B lovelace of rewards by epoch 1413 that the chain paid and that count as that pool's stake. Found by the from-genesis rebuild's stake comparison (our active stake 316 ppm below Koios, 383 B of the 488 B gap in two pools; rewards 300 ppm low everywhere through the performance term). `rewardAccountTypedHex` types it from the address now (the withdrawal path already did).
85. Governance return accounts and treasury-withdrawal targets were derived from the stake address's `credentials` (a bare hash), so a script account lost its type: ten proposal-deposit refunds on preview (1.31 T lovelace, 100 000 ADA each) were credited to the key twin of the script return account and never counted as that account's stake (e.g. `stake_test17ph74…`, 100 B of its 100.4 B). Same helper as bug 84 (`rewardAccountTypedHex`) at both sites.
86. Local parameter records were incomplete until a restart on networks whose Shelley genesis already sits in Alonzo (preview: protocol 6): the era-transition merge of the Alonzo/Conway genesis files never fires, so cost models and prices came only from the startup repair, and that repair merged the genesis cost models *over* the record — reverting an applied V1 update (preview's epoch-8 proposal) to the genesis model. The first replay escaped by a restart at epoch 7; the third halted at slot 894 594 (V1 `script_data_hash`) after its restart at epoch 10. The genesis seed now applies the era genesis itself, and an existing language always wins over genesis in the merge.
87. A verifier re-streaming headers from an old intersection had every header validated before the "already held" check; the leader check for a header six epochs old found no pool-parameter snapshot (kept three epochs) and fell back to the live registry, where the pool had since retired — "issuer … is not a registered pool", the honest peer held as malicious for an hour (third replay, preview slot 18 687 204, our own block). A batch entirely behind the applied tip is now filtered before validation: headers we hold are dropped, a differing header at a slot deeper than k is ignored as a dead fork, only the rest is validated.
88. A verifier diverging from the primary was held cold as malicious on its *first* divergent header, so with quorum 2 the outvote could never form: at preview slot 122 174 111 the primary served a losing block after its own RollBackward, two verifiers carried the canonical block and were both punished, then the primary reorganised onto their branch. Also the recorded divergence was overwritten by every later mismatched slot, so two verifiers on one branch never grouped as one fork. Now: the first divergence is kept as the fork point and cleared when the primary adopts that block; a divergent verifier inside the volatile window is held as a fork candidate (logged once), convicted only when the fork point is k deep and our chain does not carry its block, or the primary is outvoted. Same family as bug 87: divergence is not misbehaviour until the chain settles.
89. A stake credential's deregistration dropped its pool delegation and reward balance but not its DRep delegation; the Conway DELEG rule (`dereg`) removes the credential from vDelegs, sDelegs and rewards together, so a credential that deregistered and re-registered without a new vote delegation kept voting through its old DRep. Spec conformance found while working open item 13 (whose cause is bug 90). Fix: `recordStakeDeregistration` deletes the `gov_drep_delegations` row on every deregistering certificate (journaled, so rollbacks restore it); test in `state.test.ts`.
90. The DRep stake distribution was derived from `epoch_stake_cred`, which holds only credentials delegated to a registered pool. Conway `mkStakeDistrs` aggregates, by vote delegation, the stake of every registered credential (UTxO plus reward balance) plus the deposits of live governance actions credited to their return address. Preview at epoch 1048: Koios lists 2 415 DReps with power, 146.8 T in total; ours had 216 DReps and 117.3 T, with 8 422 vote-delegated credentials absent from the pool snapshot. The largest missing DRep (ab0d62f6…, 14.1 T, the return address of the spam proposals, never voting) is the unvoted stake that made 35b81b42… fail the 3/4 DRep threshold on the chain at 962 (≈ 73.5 % yes) and pass at 963 (77.7 %), where our tally had 93 % and ratified at 962 — open item 13; the same gap inflates every DRep percentage we compute. Fix: `takeDRepStakeSnapshot` writes `epoch_drep_stake` (one row per DRep, never pruned) at each boundary before the tally, from `stake_balance`, `rewards` and `gov_proposals` deposits joined with the vote delegations; `drepDistribution` reads it (falling back to the old join with a warning on databases that predate it). Test in `state.test.ts`. Proof on the next replay: 35b81b42… must ratify at 963. The third replay runs the old build; its 35b81b42… records (ratified 962, enacted 963, epoch 963 `drep_activity` 31) are to be corrected by hand as before.
91. Governance payouts at the boundary (deposit refunds of enacted/expired/dropped actions, enacted treasury withdrawals) were credited to every return account. Conway EPOCH: `refunds = payout ∣ dom rewards`, `treasury = treasury − withdrawals + donations + unclaimed` — an unregistered account gets nothing and the amount stays in / goes to the treasury. Preview epoch 707: two expired 100 k ADA deposits returning to an unregistered account (036d08c0…) went to the chain's treasury, to the account in ours; 728, 736 and 743 one action each (verify-pots: Δtreasury −42 291, −21 401, −22 246, −21 012 ppm at those boundaries, our treasury 504 k ADA below Koios at 1413). Fix: `creditRegisteredAccounts` in leaderState.ts, used for both refunds and withdrawals; test in `state.test.ts`.
92. Treasury donations (Conway tx body field 22) were checked for value conservation and then dropped; the ledger adds the epoch's donations to the treasury at the boundary (same EPOCH rule). Fix: `donation_pot` on `reward_pots`, accumulated per transaction beside the fee pot (both apply paths) and settled into the treasury by the reward update; test in `state.test.ts`. Small on preview (the 8–123 ADA treasury gaps at 715/882/907/943/969/1005 are the candidates), real on mainnet.
93. Pointer-address stake survived the Conway translation. The Babbage→Conway state translation drops the pointer map, so outputs at pointer addresses stop counting for their credential from the first Conway snapshot on; our pre-Conway resolution (bug 4x, `stake_pointers`) kept them. Preview has one such output: 35 553 ADA at `addr_test1g…` for credential 0c90492b…, which is exactly our +35 553 324 604 lovelace total-active-stake excess from snapshot 647 (646 exact) and the +75 ppm on every reward of its pool until the output was spent. Fix: `dropPointerStakeForConway` (null the stake key on pointer-address outputs; the stake_balance triggers do the accounting), run once at the boundary whose protocol major first reaches 9, *before* that boundary's snapshot (replay 4 first ran it after: snapshot 646 was still 35 553 ADA high, 647 exact — the translation precedes the hard-fork boundary's SNAP); test in `db.stakePointers.test.ts`. Replay 4 therefore carries a one-epoch +75 ppm reward residual on pool 2afbef2f… for performance epoch 647.
94. Proposals orphaned by an enactment were never dropped. Conway EPOCH removes, with the enacted and expired actions, every proposal of the same purpose that does not chain on the new head (directly or through surviving proposals) and refunds its deposit then. Ours kept them active until expiry: preview 994 enacted UpdateCommittee f4188b86… and the chain dropped the two sibling committee actions of 104b7df27a… (Koios `dropped_epoch` 994, 200 k ADA refunded at 994), which we refunded at 1019 — the pool of that return account (897d60f7…) had −200 k ADA of stake for 996–1019 and every one of its rewards −222…−556 ppm; likewise −300 k ADA at 1000–1028 (aa5a33e0…) and 1273–1293 (d4252892…). Found with the all-pools stake sweep (every difference a multiple of the 100 k ADA deposit). Fix: `dropOrphans` in enactPending (status `dropped`, refund with the enacted/expired ones); test in `state.test.ts`.
95. Boundary payouts (deposit refunds, treasury withdrawals) were credited before the boundary's stake snapshot. The ledger takes SNAP on the old state and credits in the same EPOCH transition, so a refund credited at boundary E first counts in the snapshot at E+1 (Koios: 79bb181ab5…'s seven 100 k ADA refunds decided 766 appear in its active stake for 768, ours one epoch earlier — the one-epoch +700 k ADA at 767, +3.6 M at 1029, +400/500/600 k at 1077/1079/1080 …). Fix: the orchestrator stashes the boundary's credits and pays them after the stake snapshot and the DRep tally (`applyBoundaryCredits`); the DRep stake snapshot therefore also excludes them, as `mkStakeDistrs` does (mark snapshot + live deposits + old vote delegations).
96. Delaying actions. Conway RATIFY: once a NoConfidence, UpdateCommittee, NewConstitution or InitHardFork action is accepted in a ratification round, every proposal tallied after it in that round is delayed to the next boundary (`delayingAction`). Ours ratified everything that passed: preview 997 accepted UpdateCommittee 6214314b… and, behind it, ParameterChange 602d8572… in the same round (enacted 998); the chain ratified the parameter change at 998 and enacted it at 999 (Koios), so our 998 boundary also refunded and dropped one epoch early (+200 k ADA in snapshot 999, ≈ +160 ppm on every reward paid at 1002 — the 58 ADA seen on replay 4). Found on replay 4 (2026-09-08 15:20 UTC). Fix: a `delayed` flag in ratifyForNext; test in `state.test.ts`.
97. Pool reward split rounding. Shelley `rewardOnePool`: leader = c + ⌊(f̂ − c)·(m + (1 − m)·s/σ)⌋ and member = ⌊(f̂ − c)·(1 − m)·t/σ⌋, one floor each over the exact rational. Ours floored the margin first and split the remainder, so the operator came out 1 lovelace short and a member 1 lovelace long on inputs where the fractional parts add up: pool cb8ccb08…'s leader reward −1 lovelace vs Koios in 217 of its 640 pre-Conway epochs (its reward account 43a48cb9…, all-leader history). Suspected source of the −3 535 lovelace total-active-stake residual carried since Babbage (accumulated across pools), which in turn puts every pool reward ≈ 7 ppb high (σ of a pool = stake / total). Fix: `leaderShare` / `memberShare` in rewards.ts; tests in `rewards.test.ts`. Proof: replay 5.
98. Double refund of an expiring orphan (introduced with bug 94's fix, found on replay 5). enactPending swept orphans before marking the boundary's expired proposals, so a proposal that both expired and lost its parent in the same boundary was refunded twice: preview 999, 573b7228… (expired 998, orphaned by 602d8572…'s enactment) — 100 k ADA twice to 8ff4073b…, +100 k ADA of stake from snapshot 1000, ≈ +30 ADA of reserves drawn per epoch after. The chain refunds once. Fix: expired proposals are marked before the orphan sweep; test in `state.test.ts` (13/13). Replay 5 is exact through snapshot 999 and carries this from 1000 on; replay 6 after it.
99. Consensus: a silent primary was never replaced. `demoteHotToWarm` refused to demote the primary on every path (a guard for the throughput promotion, whose newest hot peer is the primary), so the liveness demotion of a primary that had served nothing for `silentMs` logged "Silent hot→warm" each tick and left it primary; the node sat at the local block store's last block (preview 2026-09-09 09:50–10:10 UTC, relay stopped at the certified tip; the old build behaved the same on 2026-09-08). Fix: the silent path passes `allowPrimary`, and `unregisterHotPeer` promotes the best verifier and re-anchors it on the DB tip. Workaround used: remove the local root from topology.json and relaunch.
100. One-off backfills replayed on the first restart of a genesis-built database. The four repairs for databases from older builds (`delegations_rebuilt_poolreap`, `utxo_byron_addresses_rebuilt`, `orphaned_utxo_deltas_reverted`, `stake_pointers_built`) mark themselves done when the database has no Shelley blocks, but ensureInitialized only calls them when the `blocks` table already exists — on a fresh database it does not yet, so nothing was marked, and the first restart (replay 6, 2026-09-09 09:57 UTC) ran all four over 3.5 M stored blocks (22 GB read in ten minutes; the pointer backfill would have re-added the 35 553 ADA that Conway drops — bug 93). Stopped in time; state verified unchanged (stake 1413 and pots exact). Fix: a fresh database records the markers; the replay-6 database had them written by hand before its relaunch.
101. A DRep's unregistration left its delegators' vote delegations in place. cardano-ledger GOVCERT (`ConwayUnRegDRep` → `clearDRepDelegations` over the DRep's delegator set, no protocol-version guard) clears every delegation to the DRep; only the DRep row was dropped here, so when a DRep registered again its old delegators counted for it without re-delegating. Found 2026-09-09 by the snapshot decoder (phase C) against the node's unified map at preview epoch 1415: 1 339 registered credentials with a delegation the chain no longer has (1 299 to DReps still unregistered, 40 to re-registered ones), 16 DReps with a wrong stake in the epoch-1415 DRep distribution (4.1 M ADA on drep 26c7cb08… from one credential that delegated before its unregistration). No tally changed on preview (the three largest cases are expired DReps) — the Koios-checked epochs were exact — but the state diverged. Fix: `recordDRepUnregistration` deletes the delegations to the DRep (typed); test `state.test.ts` "DRep unregistration". The live database's 1 339 rows and the 16 distribution rows were corrected from the node's snapshot while the node was stopped.
102. DRep expiry derived at tally time from the current `drep_activity`. cardano-ledger materialises the expiry when the DRep registers, updates or votes (`computeDRepExpiry`: epoch + drepActivity − numDormantEpochs, the dormant epochs added back — never past an already reached expiry — when the next proposal arrives; a protocol-9 registration does not subtract them), so a later change of the parameter leaves existing expiries alone. Preview changed drep_activity 20 → 31 at epoch 964: 5 112 of the 8 984 DReps in the epoch-1415 state carry an expiry 11 epochs earlier than `last_active + 31` (all of them long expired under both rules; the epochs 964–994 could have seen a DRep active here and expired on the chain). Fix: `gov_dreps.expiry_epoch` written by `recordDRepRegistration` / `recordDRepActivity` from the epoch's parameters and the dormant count, the dormant bump applied to it as the ledger does, `activeDRepCredentials` reads it (legacy rows without it keep the old rule); test "DRep expiry". The snapshot importer writes the ledger's value directly.
103. Certificate effects of one transaction applied out of certificate order. `applyCertificates` recorded pool, governance and vote-delegation effects in a first ordered pass and the stake-table effects (registration, deregistration — which since bug 89 also drops the DRep delegation) in a second pass run as `Promise.all`, whose statements interleave certificate by certificate. Preview tx 190fdc6e… (slot 60 215 405, epoch 696) deregisters, re-registers and vote-delegates stake_test1uqxfqjft… (494 k ADA of rewards) in one transaction: the vote delegation was written first and then dropped by the deregistration, so the credential voted through nobody where the chain (and Koios) has it on drep1yg7jsy…. Found 2026-09-09 as the one delegation the node's unified map had and the replay lacked. Fix: the deregistration drops the DRep delegation in the ordered pass, and the stake pass runs sequentially in certificate order; test `db.migration.test.ts` "certificate order within one transaction". Live database corrected from the snapshot with bug 101.
104. A rolled-back block's leader stayed counted and its op-cert counter stayed. `blocks_made_by_epoch` and `opcert_counters` were not among the journaled tables, so the one-block forks the tip node resolves several times a day (191 rollbacks in its log) left phantom blocks: preview epoch 1415 had 3 234 counted against 3 211 stored blocks (16 pools over by 1–2), which would have skewed the epoch-1415 pool performances in the reward update at the 1417 boundary. Found 2026-09-10 by phase E: the snapshot-bootstrapped node, which counts from the node's own `nesBcur`, matched its stored blocks exactly while the replay node did not. Fix: both tables journaled (`ledgerJournal.ts`, test "a rolled-back block's leader count and op-cert counter are undone"); both nodes' 1415/1416 counts recounted from their stored headers while stopped. Incomplete on the first try: the triggers were in place but the two writes ran after `setApplyBlock(null)`, outside the journal scope, so nothing was journaled — preview epoch 1416 ended with 24 phantom blocks on both nodes (3 207 and 3 206 counted, 3 183 stored). The writes now happen before the scope closes; both nodes' 1416 counts recounted again before the 1418 reward update uses them. Alongside: `takeStakeSnapshot` now leaves zero-stake credentials out (the ledger's snapshot holds none; the replay carried 13 such rows and the imported state, with a rewards row for every registered credential, 36 zero-stake pools), so `epoch_stake_totals.pools` counts pools with stake like the node's distribution.
105. The first forged block was rejected by our own node: "adoptLocalBlock: header does not parse" (preview leader slot 122520682, 2026-09-12 01:31:22 UTC, both the greeting attempt and the empty fallback). `headerParser` and the volatile header row take a whole ChainSync `MsgRollForward` (`[2, [era − 1, #6.24(header)], [[slot, hash], blockNo]]`, what peers send and what the DB stores) while `adoptLocalBlock` handed it the inner `[era − 1, #6.24(header)]` pair and swallowed the parse error. No test covered the adopt path: the producer test's fake node validated the forged header directly. Fix: `localRollForwardMessage(blockFetchBytes)` (blockHeaderParser.ts) builds the message from the block; `adoptLocalBlock` parses it, runs `validateHeader` (VRF proof, KES signature at the slot's evolution, operational certificate) on our own header with the epoch's η0 before applying, and registers a pending header entry so the applier writes the volatile header row the ChainSync hosts serve. Test "a forged Conway block becomes a full MsgRollForward that headerParser accepts and validateHeader passes" (forge.test.ts) also asserts the inner pair alone does NOT parse. `scripts/forge-dry-run.ts` forges an empty block at the DB tip with the real keys and runs that path offline (nothing published): PASS on preview before the relaunch. Slot 122520682 is lost (an empty network slot stayed empty).
106. The producer forged with the wrong block height. `blocks.block_no` is this node's running count, and on the replay-built preview DB it is one higher than every header's own block number (the snapshot-built DB matches the headers). `getChainTip()` returned the column, so the block forged at slot 122535169 (2026-09-12 05:32:49 UTC, the pool's first adopted block) carried height 4655119 where the network's next height was 4655118; every peer would have rejected it, and the network built on the previous tip. Fix: `getChainTipFromHeader()` reads the tip's block number from the stored block header and the producer's adapter uses it (a warning names the drift once). The column's own off-by-one on replay-built DBs is still open: something counted one block too many between genesis and the tip (Byron EBB or the genesis block), to be found and renumbered offline.
107. A stale mempool voided the block body. Twenty transactions had accumulated since the relaunch; one (tx[1]) spent outputs a later block had consumed and had expired (ttl 122533827 < slot 122535169), the body was rejected as a whole and the fallback was an empty block, so the greeting transaction stayed out. The mempool has no ledger-rule validation or eviction yet. Fix in the forge: when our rules name the offending transactions ("tx[i]: …"), rebuild the body without them and retry (up to 4 rounds) before the empty fallback; the culprits are evicted from the mempool. Proper mempool validation on admission and on every applied block is still to do.
108. FIRST BLOCK ACCEPTED BY THE NETWORK: preview slot 122538785, 2026-09-12 06:33:05 UTC, hash 50de738df07c…, height 4655249; three inbound peers pulled it within the second and the network's next block (122538792) built on it. Two follow-ups from that forge. (a) The producer stalled 55 s afterwards: the primary's ChainSync anchor (`lastAccepted`) still pointed at the header before our block, so the network's next header "chained onto a block we hold but not onto the stream position" and was dropped, the one after it forced a restart, and the restart drained at the tip. `adoptLocalBlock` now sets the anchor to the adopted block. (b) The culprit retry of bug 107 never fired: the validator logged the per-transaction reports but the thrown `BodyValidationFailure` carried only "params=epoch N"; the reports now travel in the error (first 12, 2000 chars), which is what the producer parses. Both deployed 06:37 UTC.
109. The producer refused to restart after its own block: `checkOperationalCert` rejected a certificate whose counter equals the last on-chain counter ("counter 0 not above last on-chain counter 0"), so the relaunch at 06:35 UTC came up as a relay and the 08:44 slot would have been missed. The OCERT rule is `m ≤ n ≤ m + 1`: one certificate serves every block until the operator rotates it, and only a counter below the chain's, or two above, is rejected. Bound fixed, test updated, deployed 06:45 UTC. Rotation still needs counter m + 1 (unchanged).
110. Slot 122546676 (2026-09-12 08:44:36 UTC) lost to the retry loop of bug 107: the mempool held 69 transactions, most stale (no eviction), our rules name only the first failing transaction per attempt, and after five rounds of peeling two or three (69 → 67 → 64 → 62 → 59, 56 queued) the loop ended with the slot marked invalid and never tried the empty body. Fix: the forge pre-filters the mempool with `txSanity` (expired ttl, validity start in the future, inputs or collateral not in the UTxO set: index lookups), retries within a 1.5 s budget, and ALWAYS ends with the empty body; the producer also sweeps the mempool every 30 slots with the same check. Tests: "when every body with transactions is rejected the slot still gets the empty block", "txSanity results keep stale transactions out of the first attempt". Deployed 08:48 UTC. Real mempool validation on admission and on every applied block is still the proper fix.
111. Startup held the inbound listener behind the schedule pass. `startBlockProducer` awaited the epoch's VRF pass (72–329 s depending on load) and `startN2NServer` ran after it, so after the 09:35 UTC reboot the node had no inbound listener and no schedule for five and a half minutes ("inbound off", "no schedule yet" on /stats). Now the listener starts first and `BlockProducer.start()` returns as soon as the certificate is checked and the ticker runs; the schedule fills in behind it (`producer.ready` resolves when the pass ends; tests await it). Deployed 09:58 UTC.
112. Every relaunch redid the epoch's VRF pass (72–329 s) and the panel showed no slots or outcomes meanwhile. The state file now caches each epoch's computed schedule with the nonce and σ it came from (`schedules`), a relaunch reloads it when both match ("from the state file" in the schedule log line), persisted outcomes render even before a pass completes, and `/metrics producer.scheduling` / the page say when a pass is running. Test "a relaunch reuses the schedule from the state file instead of redoing the VRF pass". Deployed 10:05 UTC.
113. Slot 122610920 (2026-09-13 02:35:20 UTC, first of epoch 1419): forged with the greeting (block 4657673, 1 tx), adopted locally, lost to a competing block at slot 122610931 built on the previous tip — no inbound puller at that second, one duplex puller. Then the producer sat on its orphan for two minutes: the competing header's parent was an applied block below our tip, so the primary-stream check dropped it as a "late reply" and only the next header forced a restart. Now a header that extends an applied block below our tip and is newer than the tip restarts the primary's ChainSync at once ("forks from … below our tip"); if our block wins after all, its headers come back through the same path. `Block fetch: served our block … to <peer> N s after forging it` (N2NBlockFetchHost, inbound and duplex) now shows how far and how fast a forged block travels. Deployed 02:40 UTC.
114. The greeting flag survived its block's loss: `greeted` was set when the greeting entered an adopted block and persisted, so after the block was orphaned the message would never have been sent again. The producer now records the greeting block's hash and clears the flag when that block's outcome turns ghosted or stolen ("the next block greets again"). The 02:35 block predates the fix: the state file was reset by hand (greeted null, 122610920 = stolen).
115. Three blocks forged into a dead tunnel. Slots 122619622 (05:00:22 UTC) and 122622853 (05:54:13 UTC) were forged with the greeting, adopted, and never fetched by anyone; 122610920 before them likewise. The OpenVPN tunnel that carries the router's port forward (63.45.33.80:3001 → 10.111.111.2) had not come back after the battery reboot of 2026-09-12 20:22 UTC: no tun0, no openvpn3 session, "connection refused" at the public address, hence zero inbound peers since and blocks that only ever existed here. The node now probes its own public address (`n2n.publicAddress`) at start and every two minutes, exposes it as `inbound.publicReachable`, shows a red "PUBLIC PORT UNREACHABLE" badge on /stats and logs an error when it flips. Deployed 05:59 UTC. Reconnecting the VPN is the operator's action; after every reboot check the tunnel before anything else.
116. After the fork-below-tip restart of bug 113 the producer still sat on its orphan for minutes (2026-09-13 13:28 UTC, slot 122650083): `restartChainSync` drains the pipelined requests before re-syncing, and with 24 requests outstanding at the peer's tip the drain needs 24 more blocks from that peer (the 600 s deadline of 2026-09-10 exists for the promotion loop). The fork restart now drains for 3 s and otherwise terminates the connection; the governor promotes a verifier that is already on the right chain and the promotion path re-anchors on the DB tip. Deployed 13:31 UTC.
117. The inbound ChainSync responder skipped the rollback that must open every stream. After MsgIntersectFound the first reply to MsgRequestNext is a MsgRollBackward to the intersection (network spec §3.7; the library's server and our own client do it); `N2NChainSyncHost` answered with the next header directly. Lenient clients tolerated it (the 06:33 UTC block on 2026-09-12 was pulled by three of them), a strict one did not: once the port forward was back (2026-09-14 01:30 UTC) 65.108.41.222 reconnected dozens of times from its listening port 23001, ran chain-sync and tx-submission, never fetched a block and left after two seconds every time. The responder now sends the rollback first (`pendingRollback`), the host and loopback tests assert it. Deployed 01:34 UTC.
118. Phantom connections. The library multiplexer redials the `connect` closure by itself when the peer closes the socket (SocketLike.reconnect, up to three attempts) and raises no event, so `PeerClient` never terminated and the governor kept a "connected" warm peer with no socket behind it (2026-09-14 01:50 UTC: 65.108.41.222:3001 after it dropped a duplex session; 23 connected in the governor, 22 sockets in the kernel). The closure now dials once; a second call terminates the client ("closed the connection; not redialing") and the governor reconnects with a fresh handshake.
119. Duplex pullers reported stale: `duplexPullers` listed a peer as pulling our chain as long as its responders existed, so the propagation readiness figure counted a dead session. A duplex puller now counts only while its chain-sync initiator sent a frame in the last two minutes. Both deployed 01:52 UTC.
120. Node-to-client (N2C) replies were sent on the initiator side of the mux and the LocalStateQuery host answered every query with a placeholder map, so `cardano-cli` rejected every reply. Fixed 2026-09-14: all N2C hosts send responder-direction frames (`hasAgency: false`); the handshake accepts versions 16–23 (cardano-cli 11 gates newer queries on the negotiated version); LocalStateQuery answers GetSystemStart, GetChainBlockNo, GetChainPoint, GetCurrentEra, GetInterpreter (era history from `src/network/n2c/eraHistory.ts`, indefinite-length list, unbounded last era) and, under QueryIfCurrent, GetLedgerTip, GetEpochNo, GetCurrentPParams (Conway 31-field record built from `epoch_params`, rationals as tag 30 fractions, negative cost-model ints), GetUTxOByAddress, GetUTxOByTxIn and GetStakePools. Encodings were captured from a cardano-node with `scripts/n2c-oracle.ts` and verified by cardano-cli 11 decoding the replies (`query tip`, `query protocol-parameters`, `query utxo --address/--tx-in`, `query stake-pools` all print the ledger's values against Gerolamo's `node.socket`). Still stubbed (client sees a decode error): GetStakeDistribution, GetStakePoolParams, GetGenesisConfig, the governance queries — their result encodings need a Conway-era reference capture, which the syncing preview cardano-node relay will provide.
121. Node-to-client era history said preview's Conway era began at epoch 6 and left the last era's end null; the reference node (the preview cardano-node relay, port 6424) reports Conway from epoch 646 and an end bound at the horizon (the start of the epoch after the tip's). Fixed 2026-09-14 with the relay as oracle (`scripts/n2c-oracle.ts --out` captures every reply as hex + JSON): era table corrected, horizon end derived from the tip's epoch, picosecond values encoded as CBOR bignums like the node. The pparams reply also differed from the node's by three bytes: cost-model lists are indefinite-length there; now byte-identical.
122. `GerolamoChainDb` (the node-to-client LocalChainSync source) read `row.slot` / `row.block_hash` off the positional arrays `getBlockBySlot` returns, so its tip was always origin and every intersect failed. Fixed 2026-09-14 (positional access). N2C chain sync with a real client is still to be exercised.
123. Chunk store (docs/PLAN_CHUNK_STORE.md) delivered 2026-09-14: Gerolamo's block store is cardano-node's immutable-chunk directory plus its volatile files; the format was verified on the preview snapshot and the preprod node db, cardano-node 11.0.1 validated a directory Gerolamo wrote, node 3036 runs it as primary store serving peers, and a fresh node bootstrapped from a Mithril snapshot in block-store mode reached the tip in 33 min + 21 s. Defects found and fixed during the day: volatile-chain connectivity through the immutable tip (first primary start served the immutable tip), startup-tip resolution on a fresh bootstrap (tip below chunk tip; mirror fallback synced from genesis and was halted by the strict rules at slot 320 — now the bootstrap trims the chunks to the state and primary refuses to start without a resolvable tip).
124. Fork deadlock at the tip (found 2026-09-14 22:36 UTC on node 3036, pre-existing consensus path): at slot 122 751 625 two blocks were forged (88453702… from 3036's primary peer, d31806276b18… carried by the rest of the network and by the relay cardano-node). 3036 applied 88453702…; the other peers' RollBackward to the common ancestor (122 751 577) was "deferred until its next headers show a fork", their next block then failed the range check ("does not extend the applied chain … the tip is 88453702…"), the primary's ChainSync was restarted from our tip, the intersection again lay one block behind, and the cycle repeated for five hours while the network moved on (17 000 slots). The producer was unaffected because its primary is the relay, which carried the winning block, and 88453702… was held as a fork candidate. Primary block-store mode made two related weaknesses visible and they are fixed: block existence and "already applied" checks now mean "on the selected chain" (dead-fork blocks stay in the volatile files until GC), the applied-tip hashes are the selected tip only, and a rollback lands on the block the peer named (same-slot forks). Root cause found at 01:05 UTC on 2026-09-15 when 3036 stalled the same way on a second same-slot fork (122 776 947): the outvote handler *did* call the rollback, but `rollbackOurChainTo` first counts the blocks above the fork point with `countBlocksAfterSlot`, a `blocks`-table query that had not been routed to the block store — it returned 0 on the frozen table and the rollback returned early as a no-op (the log's "0 block(s) behind our tip" while our tip was one block above the point). `countBlocksAfterSlot` and `blockAtSlot` (the orchestrator's "do we hold this block" and tip-height reader) are routed now; every remaining `blocks` read in db.ts is either routed, guarded, or harmless on an empty table. The deferred-rollback check was also tightened (only applied blocks count as ours; a failed range clears pending headers). 3036 was recovered by re-importing the ledger state from the snapshot and relaunched on the fixed code.

## Open items (in order)

1. Plutus phase 2: done for preview (bugs 200–214: every script runs, verdicts equal the chain's over the whole preview history). The evaluator now implements all of plutus-core 1.63.0.0 (cardano-node 11.0.1) at protocol 11 — batch 6 incl. the Value builtins and multi-scalar multiplication, the D/E argument bounds, the protocol-11 decoder bounds — and passes plutus' conformance suite (bugs 248–253). Remaining: `TimeTranslationPastHorizon` (mempool transactions whose validity bounds lie beyond the forecast horizon) is not checked; a script that does not decode (phase 1 in the ledger) is still "no verdict", not a rejection.
2. Rewards: fixed (uncapped apparent performance, treasury forfeits, snapshot-time pool params); the clean resync must reproduce every boundary from genesis.
3. (Resolved for snapshot-imported LMDB stores, bug 275: the σ check is strict there; the reports below came from SQLite snapshots and stay reports in sqlite / dual mode.) σ threshold reports: eight canonical preprod blocks (epochs 46–54) fail our leader-threshold check by 1e-5…1e-4 relative. Recomputed offline: each leader value sits just above our threshold, and our snapshot differs from Koios by the same order (pool stake −4e-6, total active +6e-5, e.g. 186 054 761 670 632 vs 186 043 780 730 525 at snapshot 46), so the real threshold is above the value. The exact-arithmetic check is right; the snapshot is very slightly off. Find the missing/extra stake (per-pool comparison at epochs 44–54) before making σ strict.
4. Conway on preprod (epoch 163): governance ratification, reference-script fee, V3 cost models — the run has to get there.
5. Mainnet: reach Shelley, then run the same comparisons (the scripts take `--network mainnet`).
6. Flip σ, opcert counter, withdrawals (`WITHDRAWALS_STRICT`) and the reference-script fee to strict once 2–5 are clean. (2026-10-01: the reference-script fee is strict since bug 170; σ, the over-incremented counter, withdrawal amounts, the treasury value and the zero-balance deregistration are strict on a snapshot-imported LMDB store — bugs 272–276 — and stay reports on SQLite-derived state until a from-genesis run is proven exact.)
6a. Two preprod snapshots (boundaries 30 and 32) each lack one pool that registered and retired within the same epoch (2bdbd083…, 92cd3fdd…; 1.02·10¹² lovelace each), although the pool row, the delegations and the outputs were all present and a unit test of the same sequence passes; the boundary now logs any registered pool with delegations but no snapshot stake so the next occurrence carries details. Those two snapshots make the rewards of performance epochs 31 and 33 0.29 % low for every pool (apparent performance uses the active total).
6b. MIR certificates (pre-Conway, type 6) are now queued when applied and take effect at the next boundary after the reward update (accounts credited from the pot if registered and the pot can pay; pot-to-pot transfers); untested against a real chain until mainnet reaches its first MIR (none on preprod/preview so far).
6c. Memory: the 24 GB OOM of 2026-09-05 was bug 49 (unbounded header batch queue), fixed. The node logs a `Memory:` breakdown every 5 minutes (rss, main heap, external, worker heaps, worker external, unaccounted native) and `scripts/run-supervised.sh` relaunches a node that exits and restarts it cleanly at 14 GB RSS. Remaining baseline is ~1.1 GB native (20 worker runtimes, SQLite page cache) and stable.
7. Stake credentials are typed (key / script) in the certificate rule, the tables, the UTxO index, the snapshot and the reward paths; `rewards` rows written before the change for script reward accounts are still 28-byte (conflated with a key twin, if any) until re-derived from genesis. A rollback within k does not revert registrations/delegations (only UTxOs): a fork carrying a registration certificate would leave it registered.

8. Explorer projection (mb_* tables) now lives in `<db>.explorer.db`, written by a worker in ledger order (2026-09-06). The 7 724 preview blocks applied while the first worker build had died (slots 119 317 516–119 529 557, 2026-09-06) were rebuilt with `scripts/explorer-backfill.ts` (from the ledger's blocks and utxo_deltas, node stopped; 10 653 transactions, 18 s); the script serves any future range. The history copy from the ledger DB runs in the worker only while the node is not bulk-syncing; until it finishes, `/txs/{hash}` for old transactions may 404.
9. Applier follow-up: the block-witness verdict is now awaited at apply time (≈2.5 ms/block of wait at 80 blocks/s) because the rules-ahead step no longer waits for it; either give witness jobs priority in the pool or let the rules job's own witness check stand in for it.
10. Superseded by item 12 (rebuild from Mithril). Kept for the record: `scripts/repair-reward-balances.ts --apply` would have had to run with the node stopped — the dry run is exact for snapshots 1410/1411 (78 920 / 78 921 stake updates, totals = Koios `epoch_info`); the newest snapshot and the balances need Koios again (the free tier's daily quota was spent, HTTP 429, on 2026-09-07 03:00 UTC), and the write was refused by the session's permission classifier, so the operator runs it. The script also takes `--blockfrost <base>` (Blockfrost-compatible API, e.g. the onchainapps mirrors — preprod and mainnet only, preview has none) for the snapshots and accounts, which avoids Koios' quota. Until then every boundary pays ≈ +0.13 % (the 1413 boundary paid 393 471 912 028 for perf epoch 1411) and the pots stay −22 ppm; the later run corrects balances from the newest snapshot's excess, which is invariant under later payouts once the snapshots and pots are exact.
11. Plutus shadow: bug 74 explained the epoch-1413 mismatches (V2 arrays read with V3 names). Residual resolved by bug 205 (V1/V2 parameter names per language). Replay 2026-09-07: the 160 shadow mismatches between genesis and epoch ~630 were bugs 79 and 80 (script context order/shape, machine semantics and costing) — all resolved to the declared units. Tooling: `scripts/builtin-cost-diff.ts <costs.json> v1|v2|v3 [--edge|--edge2]` (per-builtin budget+result diff against aiken), `GEROLAMO_BUILTIN_TRACE=1` / `UPLC_BUILTIN_TRACE=1` (builtin-call traces on our machine / the vendored `tools/uplc-ref/vendor/uplc`), `GEROLAMO_ED25519_TRACE=1`.
14. The Mithril-fed rebuild's ledger state is not exact: our total active stake sits 316 ppm below Koios at the tip (488 B lovelace), of which 383 B are bugs 84 and 85 (script reward/return accounts never credited) and the rest is the self-reinforcing lag those seeds caused — every account's reward balance a few tens to hundreds of ppm low (uncapped performance divides by our active stake), rewards paid 300 ppm below Koios per epoch, treasury +12 ppm per epoch. Block counts, the pot inputs and the formula agree with the chain. Only a replay from genesis with bugs 84/85 fixed produces an exact state; the running node is exact from here on for new credits only.
13. Resolved and proved on replay 4 (2026-09-08 14:39 UTC): 35b81b42… ratified at 963 and enacted at 964, as on the chain (bug 90; bug 89 a related conformance fix).
12. Preview rebuild from Mithril (2026-09-07): instead of repairing the historical balance excess (item 10) the preview ledger is replayed from genesis with the fixed code, fed by the Mithril-certified chain: `mithril-bootstrap --network preview --blocks-only` → `scripts/serve-chain.ts` (local N2N relay over the block store) → fresh node syncing from 127.0.0.1:3101 under full validation. Watch: dashboard port 3050 (Mithril card, then the sync). Expected: pots, stake and rewards exact against Koios at every boundary without any alignment — the final proof for workstream B.

15. Slot battles mislabel honest peers (2026-09-10 02:03 UTC, preview slot 122 349 823): two pools made a block in the same slot; two verifiers first showed the loser 8d0a1d51…, so the primary serving the winner 0dcd8974… (canonical per Koios, height 4 648 496) was "outvoted", held cold for 1 h and the primary switched; a moment later the range from the new primary failed on the loser and that peer was held too. Both nodes still ended on the canonical block (the import node rolled the loser back once the successor arrived) — the ledger is unaffected, but a slot battle should not cost two peers an hour: a same-slot competitor should be treated as a candidate until the next header settles it, not as bad data. Part of the 1 h peer-hold tuning. Second occurrence two hours later (04:03 UTC, slot 122 357 022, winner fee13698…): the import node held its primary for serving the winner and then the verifier whose block fetch returned the winner under the loser's advertised hash (the peer had switched branches between header and body); the tip node, with only one dissenting verifier, merely held the candidate. Twice in two hours on one node — fix before the producer goes live: a same-slot competitor is a candidate until a successor header settles it, and a body that arrives under a different hash than advertised after a slot battle is a branch switch, not bad data. Fixed in the tree 2026-09-10 04:40 UTC: an outvoted primary is demoted to verifier instead of held (the settled-chain rule still convicts a dead branch once it is k deep), and a fetched block whose hash is a competitor any peer announced at that slot is a retryable range failure (`CandidateSet.knownAtSlot`, `RangeVerifyResult.gotHash`); tests in CandidateSet.test.ts and ValidationPool.test.ts. Deployed on both nodes 2026-09-10 04:55 UTC, together with three networking fixes found by the pool registration (mempool buffer never initialised, tx-submission MsgInit never sent, ChainSync-restart drain timeout dropping the peer at the tip — see PLAN_BLOCK_PRODUCTION.md). Third occurrence 14:17 UTC (slot 122 393 825, import node): the demotion worked, but the range fetched from an agreeing peer after the switch still returned the loser and was held — the served hash was in no fragment by the time of the check. The classification now also accepts a served block we hold at that slot or one our own rollback just removed (`recentlyRolledBack`, from `blockHashesAbove`), and logs every fragment's tip when a served block is unknown, so the next occurrence shows why.

16. A promoted verifier's ChainSync restart stalled the node at the tip (2026-09-10 12:12 UTC, import node): a verifier resumed at our DB tip and promoted a second later had 29 pipelined RequestNext outstanding; the FindIntersect restart must drain them first, and at the tip each is answered only by the next block — ten minutes without a block applied while three verifiers were ahead. The earlier 30 s drain deadline (raised to 600 s that morning) had instead dropped the peer and looped over the next verifier. Fix: `anchorPromotedPrimary` — when the promoted verifier agreed with the chain we applied, its fragment past our tip goes to the scheduler and its stream is kept (what the outvote switch has done since bug 73); the restart stays when at most one reply is outstanding. (First version kept the stream only for verifiers that had agreed; a verifier promoted a second after it resumed at our tip has agreed with nothing yet and stalled the import node the same way on 2026-09-11 15:00 UTC — since 15:11 the stream is kept whenever replies are outstanding, agreement or not; the contiguity check on primary headers covers a stream that does not chain.) Third hole, 23:43 UTC: after the fragment's headers past our tip were handed to the scheduler, the contiguity check still expected the kept stream to continue from the DB tip, restarted it and hit the drain again; the anchor is now the last handed header.)

17. One HTTP request stalled the block producer for six minutes (2026-09-10 19:22 UTC): `GET /api/v0/blocks?limit=3` ran `ORDER BY slot DESC, block_no DESC` on the 4.6 M-row `blocks` table, which SQLite answers with a full scan into a temp b-tree — every block body, 58 GB at 190 MB/s — and on the synchronous SQLite client that runs on the applier thread, so headers, ranges, the producer and every endpoint waited behind it. The query is index-driven now (0.2 ms) with the tie-break done in JS. The structural issue stays open: any HTTP handler can still block the applier with a heavy statement; the ledger-store plan (PLAN_SNAPSHOT_BOOTSTRAP.md phase F) takes SQLite off the apply path, and until then API handlers must be audited for index use before they are exposed.

18. The host suspended for 55 minutes (2026-09-10 20:42–21:37 UTC, `systemd-suspend`, s2idle): both preview nodes froze with it, caught up within ten minutes of resume, no state damage. For a block producer a suspended host misses every leader slot in the window and its peers drop it, so the producer host must never sleep: mask the sleep targets (`systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`) and set the lid/idle actions to ignore in logind. Needs root; not done yet.

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
# Conway governance history through the node's code (read-only inputs; 5 min pre-Conway scan, 6 min Conway)
bun scripts/gov-replay.ts --chunks $DIR/db/immutable --ref-db $DIR/preview.db --work /tmp/gov-replay \
  --koios-proposals proposals.json --koios-totals totals.json [--koios-dist /tmp/koios-dist] [--nes <slot>=<ledger state file> …]
# the same rules on a running node's LMDB store, recent blocks (read-only)
GEROLAMO_DB_PATH=/tmp/x.db bun scripts/gov-rules-shadow.ts --node $DIR
# offline replay of a halted block
bun scripts/validate-stored-block.ts --db $DIR/preprod.db --hex $DIR/logs/failed-block-<slot>.hex --slot <slot> --network preprod
```

Preview: `NETWORK=preview` with `src/config/preview/` (genesis files from the local cardano-node install, magic 2, 86 400-slot epochs, Conway since 2024) gives a from-genesis proof that reaches governance in hours instead of days.

Plutus phase 2: `GEROLAMO_PLUTUS_PHASE2=enforce|report|off`; in `report` mode `GEROLAMO_PLUTUS_SHADOW_SAMPLE` (every n-th block) samples the detached shadow job. `GEROLAMO_PLUTUS_SHADOW_MS` and the CPU caps apply only to the legacy evaluator (`GEROLAMO_PLUTUS_LEGACY_SHADOW=1`). Whole-history replay, read-only: `bun scripts/plutus-replay.ts <immutable dir> --params <db with epoch_params> --workers 8 --out r.jsonl` (`--jobs-out` / `--jobs-in` to iterate on a range, `--dump-dir` for fixtures); one job: `bun scripts/plutus-job.ts <job.json> [--ctx dir] [--aiken dir] [--old]` (writes our contexts and a `tools/uplc-ref` bundle); builtin traces `GEROLAMO_PLUTUS_BUILTIN_TRACE=1` vs `UPLC_BUILTIN_TRACE=1`, `scripts/plutus-trace-diff.ts`; timings `scripts/plutus-bench.ts`.

A strict failure halts the sync, writes the block to `$GEROLAMO_FAILED_BLOCK_DIR/failed-block-<slot>.hex`, and drops incoming headers until restart.

## Bugs 200–214 — Plutus phase 2 to enforcement (2026-09-28, plutus worktree)

The shadow evaluator (plutus-machine + buildooor contexts, bugs 18/66/67/74/79/80) was replaced on the validation path by Gerolamo's own evaluator in `src/consensus/plutus/` (flat decoder, CEK machine, builtins, cost models, script contexts) behind `src/consensus/rules/phase2.ts`. Found and verified by replaying every Plutus transaction of the preview chunk store read-only (`scripts/plutus-index.ts`, `scripts/plutus-replay.ts`: inputs resolved from the chain itself, 8 workers) and by per-builtin differential runs against aiken's `uplc` crate (`scripts/builtin-cost-diff.ts --new`, `--batch5`).

200. Speed: every script now runs. plutus-machine cloned the environment array on every lambda, delay and argument frame, cloned values on each variable lookup, kept every binding in a heap that was never freed, computed argument sizes of constant-cost builtins (`tailList` walked the whole list, `chooseData` the whole datum) and copied lists on every `tailList`/`mkCons`; budgets were BigInt objects. The new machine uses persistent linked environments, a frame array, Number budgets (exact below 2^53) and immutable lists (array views, cons cells). Heaviest preview transactions, same inputs (`scripts/plutus-bench.ts`): slot 95148643 (51 redeemers, 4.85·10⁹ cpu) 3 615 ms → 8.6 ms; slot 95050155 (2.79·10⁹) 735 → 9.1 ms; slot 96625439 (2.28·10⁹) 597 → 9.0 ms; slot 1159325 (0.99·10⁹) 152 → 7.1 ms. The declared-cpu (3·10⁹), per-step (2·10⁷) and wall-clock (2 s) skips are gone from the validation path (they remain only in the legacy shadow, `GEROLAMO_PLUTUS_LEGACY_SHADOW=1`).
201. Byte strings decoded from the block were `Buffer#slice` views of the block, and the delegated Ed25519 of `@harmoniclabs/crypto` mutated its signature argument in place: the oracle feeds of preview epochs 1100–1122 (3 of 3 signatures per transaction) "failed" on signatures the evaluator had itself overwritten, 3 415 of 38 423 transactions in chunks 22000–22500. Every decoded byte string is a copy, the context works on private copies, delegated builtins get copies, and Ed25519 is native (libsodium's `crypto_sign_verify_detached` rules: canonical S and key, small-order key/R blacklist, then the cofactorless equation via OpenSSL). Test: evaluating twice leaves the witness bytes untouched.
202. `serialiseData` wrote an integer below 24 given as a bigint with a one-byte argument (`18 00` for 0): hashes of serialised data differed (preview slot 95071833, `blake2b_224 ∘ serialiseData`). Minimal heads; codec equal to the patched plutus-data encoder on bignums, chunked bytes, constructor tags 7/127/128.
203. `verifyEcdsaSecp256k1Signature` (`@harmoniclabs/crypto`) returned False for a valid signature (preview slot 64834939, a V3 script). Native secp256k1 with libsecp256k1 semantics: malformed key / 32-byte hash / 64-byte signature or r, s ≥ n are evaluation failures, a high-S or zero signature is False; Schnorr accepts messages of any length.
204. Cost-function shapes depend on the semantics variant, not only the language (PlutusLedgerApi.V*.EvaluationContext): V1/V2 use variant A before protocol 9, B up to 10, D from 11; V3 C, then E from 11. Variant A costs `multiplyInteger` on added sizes and `verifyEd25519Signature` linear in the signature; D/E cost division above/below the diagonal, D mod/rem memory `linear_in_y2`, and D/E string builtins by UTF-8 bytes `quot` 4. The shapes are now taken from `builtinCostModel{A..E}.json` (`src/consensus/plutus/costShapes.ts`) and compiled over the named parameters. Redeemers spending exactly their declared units in preview chunks 0–1000: 20 862 → 425 495 of 445 932; the +3 063 cpu family of preview slot 3761914 (three Ed25519 checks, slope 1 021 × 3 words) was this.
205. Cost-model parameters are named with the language's own `ParamName` list (`src/consensus/plutus/paramNames.ts`): V1 and V2 appended the post-Alonzo parameters in different orders (V1: serialiseData at 166, integerToByteString at 223; V2: serialiseData at 133, integerToByteString at 175), extra values are ignored and missing ones are maxBound. Before, V1/V2 builtins beyond the first 166/175 parameters were costed with V3 defaults.
206. Validity interval: before Conway an upper bound is inclusive only when it is the only bound (`PV1.to`) and exclusive with a lower bound (`strictUpperBound`); Conway is always exclusive (bug 67 used "protocol < 9 ⇒ inclusive"): 5 710 of 232 301 transactions in preview chunks 0–1000 failed on it.
207. Before Conway, zero-quantity assets in outputs and mint are accepted on the wire and pruned by the ledger when decoding (an emptied policy also leaves the mint policies a redeemer index counts): preview slot 880204 put 18 memory units on four redeemers and all ran out of budget.
208. Governance purposes: redeemer tags 4 (voting) and 5 (proposing) resolve to the voter's script credential (committee hot / DRep; ledger `Voter` order) and to the guardrail policy of a ParameterChange / TreasuryWithdrawals proposal; `ScriptPurpose`/`ScriptInfo` Voting / Proposing; the V3 TxInfo carries `txInfoVotes` (voters and action ids in ledger order), `txInfoProposalProcedures` (with `ChangedParameters` as the ledger's ToPlutusData: tag-ordered map, rationals as reduced `[n, d]` lists, cost models by language), `txInfoCurrentTreasuryAmount` and `txInfoTreasuryDonation` (Nothing for 0). buildooor's TxInfo (empty votes/proposals, Nothing treasury fields) is no longer used on the validation path.
209. Certificates: V3 `TxCert` for every Conway certificate (deposit `Nothing` at protocol 9, `Just` from 10; resign-committee and DRep anchors dropped); V1/V2 `DCert` keeps the deposit forms of stake (un)registration and rejects every other Conway certificate with `CertificateNotSupported`. V1/V2 contexts reject votes, proposals, a donation and a current-treasury field, and voting/proposing purposes, as collect errors (the transaction is invalid whatever its is_valid flag); Babbage V1 rejects reference inputs, inline datums and reference scripts; Alonzo V1 keeps the historical dropping of Byron inputs/outputs; V3 at protocol 11 rejects reference inputs that are also spent.
210. Withdrawals are ordered as the ledger's `Map RewardAccount`: script credentials before key credentials (the wire order is the opposite for testnet reward addresses), both for the Rewarding redeemer index and the TxInfo map (txpath finding 141).
211. Rules workers never set the network (txpath finding 140): slots became POSIX time with preprod's geometry on a preview node. `runBlockRulesJob` sets it from the job, and phase 2 takes the network explicitly.
212. Transactions with is_valid = false were never evaluated (the shadow sat after the collateral-only branch); they are now, and must fail.
213. Enforcement (`GEROLAMO_PLUTUS_PHASE2=enforce|report|off`): in `enforce` the rules job evaluates every Plutus transaction and a verdict that differs from is_valid, or a collect error, fails the block (`tx[i]: plutus phase 2 ValidationTagMismatch: …`); "no verdict" (missing script or datum, unsupported builtin) is reported, never failed. `report` evaluates in the sampled shadow job. `/metrics` → `plutus` carries the mode and totals. Mempool: `checkMempoolTxPhase2` / `checkMempoolTxBytesPhase2` (rules/phase2.ts) return `ValidationTagMismatch` (both directions) / `CollectErrors` / `Unknown`; `shadowEvaluateTx` keeps its signature and now runs the same evaluator.
214. BLS12-381 builtin tags: `@harmoniclabs/uplc` numbers them in its own order (hashToGroup 58 …) while the flat encoding has 58 G1_compress, 59 G1_uncompress, 60 G1_hashToGroup (and 65/66/67 for G2): every script compressing a point "failed" (919 preview transactions, ZK-proof dapps of epochs 715–1100). Fixed in the signature table and cost names; fixture `plutus-preview-61828322-0.json` (9.13·10⁹ cpu, equal to aiken). Also added for protocol 11 (van Rossem, preview since epoch 1291): `case` on builtin constants (unit, bool, integer, list, pair; Data only from Dijkstra) and the batch-6 builtins expModInteger, dropList, lengthOfArray, listToArray, indexArray with array constants; 501 preview transactions used dropList and 63 the builtin case. Not implemented: G1/G2 multiScalarMul and the Value builtins (tags 92–100) — a script using one gets "no verdict" (one preview transaction, slot 124008114).

**Replay result (2026-09-28/29, preview immutable chunk store 0…28699, read-only, `scripts/plutus-replay.ts --workers 8`, 39 min wall):** 3 191 417 Plutus transactions, 10 865 494 redeemers. is_valid = true: 3 191 175 succeed, 0 fail; is_valid = false: 241 fail, 0 pass; ex-units used ≤ declared for every redeemer, 9 375 419 (86 %) spend exactly the declared units; 1 transaction without verdict (multiScalarMul). Median 2 ms per transaction, p99 13 ms, maximum 1.9 s (BLS12-381 in pure JS: a 9·10⁹-cpu proof takes ~0.3 s, the heaviest G2 script 1.9 s; the block budget of 2·10¹⁰ steps bounds a block at a few seconds in the worst case). The numbers combine the full run (983 failures, 578 no-verdict, before bug 214 and the batch-6 work) with the re-evaluation of exactly those 1 561 transactions after it (`--only`); the 76 "unresolved input" entries of the full run were transactions of the tip chunk written while the first pass was scanning (tool artefact; all resolved on the re-run). Per-builtin differential harness against aiken's `uplc` crate (`scripts/builtin-cost-diff.ts --new`, `--edge`, `--edge2`, `--batch5`, V1/V2/V3): 0 budget or result differences over 1 300 programs. Enforcement is therefore the default (`GEROLAMO_PLUTUS_PHASE2=report` reverts to the sampled shadow); the same replay should be run on preprod before a preprod producer relies on it (no local preprod chunk store exists; `scripts/plutus-replay.ts` takes cardano-node's immutable directory and a `epoch_params` SQLite with Koios cost models — a fetch script is in the report).

## Bugs 248–253 — plutus-core 1.63 at protocol 11: batch 6, D/E bounds, decoder bounds (2026-10-01, plutus2 worktree)

cardano-node 11.0.1 (git 97036a66) links plutus-core / plutus-ledger-api **1.63.0.0** (package ids in the binary; cabal.project pins CHaP 2026-05-02). From that tag: `builtinsIntroducedIn` puts all of `batch6` (expModInteger, dropList, lengthOfArray, listToArray, indexArray, bls12_381_G1/G2_multiScalarMul, insertCoin, lookupCoin, unionValue, valueContains, valueData, unValueData, scaleValue = flat tags 87–100) into V3 at protocol 11 and, together with batches 2–5 / 4a / 5, into V1 and V2 at protocol 11 (`vanRossemPV`); there is no tag ≥ 101. The V1/V2/V3 `ParamName` lists have 332/332/350 entries, exactly preview's on-chain cost models at protocol 11, whose values equal 1.63's `builtinCostModelD/E.json` + `cekMachineCostsD/E.json`; Gerolamo's name lists (taken from plutus master) agree on that prefix and only add 11 names (multiIndexArray, assetCount, policies) that no on-chain list reaches, and the cost shapes of every 1.63 builtin equal 1.63's JSON. `case` on builtin values (from protocol 11) covers unit, bool, integer, list and pair; Data, arrays and values are not caseable in 1.63 at any protocol version.

248. Batch-6 tags 92–100 were not implemented (a script containing one decoded as "no verdict"). Now: the `value` constant type (flat tag 13; `Flat Value` through `buildValueWith`: keys ≤ 32 bytes, quantities in [−2^127, 2^127 − 1], currencies and tokens strictly ascending, no empty inner map, no zero), the Value builtins with `PlutusCore.Value`'s denotations (`src/consensus/plutus/multiasset.ts`: insertCoin with amount 0 deletes without key checks, lookupCoin of a missing entry is 0, unionValue drops cancelled entries and fails beyond 128 bits, valueContains fails on negative amounts, valueData fails above 40 000 entries, unValueData is strict, scaleValue by 0 is empty) and costs (`ValueMaxDepth` = ⌊log₂ outer⌋+1 + ⌊log₂ largest inner⌋+1, `ValueTotalSize`, `DataNodeCount`, the four-argument `linear_in_u` shape), and Σ sᵢ·Pᵢ for the multi-scalar multiplications (zip of the lists, every scalar within 4096 bits, costed on the scalar list's length).
249. Semantics variants D/E (protocol 11, every language) bound builtin arguments (plutus-core `ensurable`, `PlutusCore.Default.Universe.Cardano`): integers of add/subtract/multiply/divide/quotient/remainder/mod/lessThan(Equals)Integer and consByteString's byte (D) within [−2^262143, 2^262143 − 1]; bytestrings of append/cons/slice/index/equals/lessThan(Equals)ByteString, every hash, decodeUtf8, the Ed25519/Schnorr message, hashToGroup's message, byteStringToInteger, and/or/xor/complementByteString, readBit, countSetBits, findFirstSetBit at most 65 536 bytes; constrData's tag a Word64; shift/rotateByteString's amount an Int (sized 1, no longer `IntegerCostedLiterally`); writeBits' input at most 4 096 bytes; bls12_381_G1/G2_scalarMul's scalar within 4 096 bits. None of this was checked: a protocol-11 script rotating by 2^63, or hashing a 70 KB bytestring built at run time, passed here and fails in cardano-node — in `enforce` mode an is_valid = false transaction of that kind would have failed a valid block. Results stay unbounded (only arguments are checked); equalsInteger and the other builtins are unchanged.
250. `ExMemoryUsage [a]` is the list's length (no element measure; pairs are maxBound): listToArray was costed on the sum of its elements' sizes (a list of one 11-word integer: 10 × 24 838 cpu too much).
251. expModInteger's bounds are `x > 2^8191 − 1 || x < −2^8191`: −2^8191 as base or exponent failed here.
252. Protocol-11 decoder bounds (`maxBoundsByPV`): a constant's type of size > 32 (`defaultUniSize`: 1 per constructor + 1 per application) or a `constr` with > 1 024 fields does not deserialise from protocol 11 (any language).
253. Flat decoder: BLS12-381 constant types were rejected outright — an empty `(list bls12_381_G1_element)`, the only way to start a point list for multiScalarMul, is a valid constant (a point value is not flat-decodable); array constants were gated on Plutus Core 1.1.0 (1.63 only knows the universe); constr tags between 2^52 and 2^64 − 1 were rejected.

Verification: plutus' conformance suite at tag 1.63.0.0 (`plutus-conformance/test-cases/uplc/evaluation`, 999 cases, results up to α-equivalence and budgets, preview's cost model) — 994 pass, 0 fail, 5 not comparable (dropList by ≥ 10^19: the suite's saturating Int64 counter, beyond every real budget; both machines fail with a real one); 4 shift/rotate cases fail without bug 249. Fixture `src/consensus/__fixtures__/plutus-conformance-1.63.json.gz` (132 KB, the whole suite) run by `conformance.test.ts`; `scripts/plutus-conformance.ts <test-cases> <pp.json>` runs a checkout. Differential fuzzing against aiken's `uplc` 1.1.24 (first release with batch 6; builds with rustc 1.89 using `--ignore-rust-version`), `scripts/plutus-batch6-diff.ts`: 10 300 random Value / insertCoin-chain / multi-scalar programs (the last 4 000 on the final code), 0 result or budget differences (aiken does not implement the D/E argument bounds; those follow the plutus source, `batch6.test.ts`). A V3 script using insertCoin, valueContains, unValueData and multiScalarMul spends exactly aiken's 504 870 098 cpu / 6 891 mem. Preview replay of all protocol-11 history (chunks 25820–28730, read-only, `scripts/plutus-replay.ts --workers 6`, 7 min): 227 209 Plutus transactions, 1 118 433 redeemers; is_valid = true 227 189 succeed, 0 fail; is_valid = false 20 fail, 0 pass; 0 without verdict; 629 504 redeemers spend exactly the declared units. The same range on the baseline code differs in exactly one transaction: slot 120070481 tx 4 (97b5ef26…, a V3 script with bls12_381_G1_multiScalarMul; the "no verdict" of bug 214, whose slot is given there as 124008114), now evaluated — 4 redeemers, 9 275 251 898 cpu, each exactly its declared units and equal to aiken 1.1.24's `eval-tx` at protocol 11 (the multiScalarMul of 77 points: 7 930 226 502 cpu / 1 384 862 mem; fixture `plutus-preview-120070481-4.json`, plus a V2 protocol-11 fixture `plutus-preview-124008114-0.json`, variant D, also equal to aiken); every other verdict and spent budget is identical. No transaction in the range uses a Value builtin or reaches a D/E argument bound, so those paths are verified by the suite, the fuzzing and the source; they are enforced like every other builtin (a false failure would surface as a valid-failed mismatch).

## Bug 126 — nonce row blocked LMDB promotion (2026-09-17 00:00 → 09-18 16:20 UTC, node 3036, fixed)

`storeEpochNonce` ran inside the epoch 1423 boundary block, so the `nonces/1423` key entered that
block's diff with a before-image; a later header-driven direct write changed the stored row, and
from then on `promote` refused the boundary diff ("stored value differs from the block's
before-image") on every range. The anchor stayed at slot 122 947 174 while 3 062 diffs piled up.
Fix: nonces and epoch parameters are derived per-epoch state and now always bypass the diffs
(`applyDirectBeside`); a refused promotion marks the store broken and halts the sync instead of
retrying forever; seed version 4 rebuilds the store.

## Bug 127 — slot battle at 123032202: loser applied, winner rejected as a double spend (2026-09-17 23:37 UTC, node 3036, FIXED 2026-09-20)

Two blocks exist at preview slot 123 032 202: `0ff037f8b73e8d69…` (lost) and
`897d84a4d86e9639…` (won, on the producer's chain, 6 932 bytes). Both contain a transaction
spending the 10 outputs of `597b13db…` (created at slot 123 031 456). Node 3036 applied
`0ff037` (journal and `utxo_deltas` show it as the newest applied block, 21 deltas), then the
producer's stream delivered `897d84a4` and the node validated it *without rolling `0ff037` back*:
"tx[0]: spends 10 input(s) not in the UTxO set" → SYNC HALTED. No ROLLBACK line was logged between
23:36:43 and 23:37:13; the primary switch at 23:37:06 handed "3 header(s) past our tip 123032100"
to the scheduler. The producer (3035) handled the same fork correctly at 23:36:42 (rollback to
123 032 172, 21 deltas deleted). Evidence: `logs/failed-block-123032202.hex` (the winner), the
loser is in 3036's volatile store; log lines 116090–116205 of preview-import.log.
Suspects: the same-slot fork path when the fork block arrives from a *new primary's kept stream*
rather than through `handleRollBack` (no candidate evaluation → no `rollbackChainTo`), and the
`expectedPrev` check letting a block whose prev is the block *below* our tip through when our tip
shares its slot. Reproduce offline with the two blocks against 3036's state.

**Cause and fix (2026-09-20):** the range applier's dedupe branch set `expectedPrev` to the hash of
an already-applied block it skipped, even when that block sat *below* our tip (we held the losing
block at the same height). The next block, the winner with prev = that skipped block, then passed
the "extends the applied chain" check and was validated on top of the loser. Now the skipped block
only becomes `expectedPrev` when it is our tip; otherwise the real tip hashes are used and the
range fails as a fork. The header path's "fork below our tip" detection also covers a competing
header in the *same* slot as our tip (`>=`), so the peer's ChainSync restarts and the intersection
/ candidate machinery decides (equal length: ours stays until the network extends the winner).

## Bug 128 — aborted range could not put the ledger store back (2026-09-20 16:45 UTC, node 3036 in lmdb mode, fixed 09-21)

A range failed ("range pipeline failed") right after a rollback; its first block's parent was a
block the ledger store had already dropped, so `ledgerAbortRange` — which rolled back *to that
parent* — refused ("neither the anchor nor a volatile block"), the store was marked unusable and
the node halted (lmdb mode does not rebuild). Fixes: an aborted range now drops exactly its own
diffs and re-selects the block store's tip after the orchestrator's reset (broken only if the
store does not hold that tip); `ledgerBeginBlock` checks that every block extends the store's
own tip or anchor, so a chain disagreement between the block store and the ledger store is
reported at the block that introduces it rather than at the next abort.

## Bug 129 — after a reboot the block store and the ledger store restarted on different chains (2026-09-22 04:23 UTC, node 3036 in lmdb mode, fixed)

The laptop rebooted at 17:51 UTC on the 21st with both nodes mid-range. On restart 3036's block
store resumed at its persisted tip while the LMDB diffs on disk described a slightly different
last few blocks (one side had flushed a fork branch the other had not); the first range after
the restart failed body validation ("spends inputs not in the UTxO set") and the node halted.
Fixes: in `lmdb` mode the startup tip comes from the persisted tip before the (frozen) SQLite
journal; when the ledger store cannot reach that tip it falls back to the newest block of the
block store's chain that it holds, and the block store's tip is moved there (the network
re-sends the rest); an aborted range whose "tip after" the store does not hold falls back to the
block before the range instead of marking the store broken. The producer (dual mode) was down
10.5 h with the machine and missed its 00:53 UTC epoch-1428 slot; it re-applied the boundary in
513 s on restart.

## Bug 130 — leader-slot tracker kept a replaced block "confirmed" (2026-09-22, fixed)

The producer's block at slot 123 397 182 (04:59 UTC) was adopted locally, reached
CONFIRM_DEPTH = 10 and was marked confirmed; the network's block for that height came 13 s later
and our node followed it after a deeper rollback, but confirmed outcomes were never re-checked, so
the state file and `/metrics` kept reporting the block as on chain (Koios and both nodes hold
`4642224d…` at height 4 685 032). Fix: confirmed blocks are re-checked against the chain until
FINAL_DEPTH = 2160 blocks deep and flip to stolen / ghosted like adopted ones. The 04:59 entry was
corrected by hand in the state file.

## Bug 131 — lmdb mode: an aborted range dropped every volatile diff since startup (2026-09-23 05:36 UTC, node 3036, fixed)

`rangeDiffs` (the diffs a range committed, dropped if the range aborts) was reset only by the
dual-run verifier, which returns early outside `dual` mode. In `lmdb` mode the list grew for the
node's whole life; the first aborted range after 20:14 UTC the day before dropped all of them,
the store fell back to its anchor with 0 diffs, and the next block failed ("spends inputs not in
the UTxO set") → halt, 18 h down unnoticed. Fix: `ledgerAfterRange` clears the range's diffs and
touched refs after every committed range in every mode.

## Bug 132 — "block at slot" returned dead fork blocks from the volatile store (2026-09-24, fixed)

`blockReads.getBlockBySlot` fell back to any volatile block at the slot when none was on the
selected chain. The producer's 02:20 UTC block (slot 123 560 457) was orphaned 38 s after it was
forged (the network built on another pool's block at the same height), but the outcome tracker kept
finding it in the volatile files and reported it "confirmed" until volatile GC removed it 9 h later
(then "ghosted"). The same fallback fed the ledger-rollback cross-check ("kept X but the chain's block
there is Y" warnings) and could have pointed `rollbackSelectedTip` at a dead block. Fix: no block on
the selected chain at the slot → null.

## Bug 133 — every ledger-store read walked all volatile diffs (2026-09-26, fixed)

`LedgerStore.get/getU64` rebuilt the selected chain (up to k = 432 diffs) and hex-encoded the key
once per diff on every read. The epoch-1432 stake snapshot (≈160 k counter reads) blocked the
producer's event loop for 19 minutes at the boundary; every block application paid the same cost
on a smaller scale. Fix: a read overlay per chain state (one map per database, newest entry per
key with its counter delta), extended in place when a block commits on top of it and dropped on
rollback / promotion / dropped diffs. Benchmark: 160 k counter reads through 432 diffs 110 s →
0.3 s, identical results; a 400-step randomized test (commits, forks, rollbacks, promotions,
reopen) compares every read with a reference model.

## Bug 134 — same-slot battle settled by vote count instead of the Praos tie-break (2026-09-26 13:36 UTC, producer, fixed)

Two blocks at preview slot 123 773 790 (677ef4f1… kept by the network, d326df7e… lost). The
outvote rule only compared the challengers with the quorum: two verifiers on d326 outvoted the
primary (on 677e), and a second later two others on 677e outvoted the new primary. The node rolled
back, applied the losing block, then waited ~8 minutes for a ChainSync restart to drain 12
pipelined requests before it followed the network — serving the dead block to its peers
meanwhile; a leader slot in that window would have been built on it. Fix: when both sides of an
outvote end at the disputed slot (equal length), the Praos tie-break decides (same pool: higher
opcert counter; otherwise lower VRF output) and the primary is kept if it wins; the ordinary
outvote still applies when one chain is longer. The real headers are a test fixture
(`src/consensus/__fixtures__/slot-battle-123773790.json`): the tie-break picks the network's block.

## Bug 215 — ledger peers were a FIFO queue, not stake-weighted; no big ledger peers (2026-09-28, fixed)

`seedLedgerPeers` shuffled every registered relay and dialled them in order, and
`peer-snapshot.json` (`bigLedgerPools`) was never read. Now `LedgerPeerSource` follows
ouroboros-network `LedgerPeers`: √-stake picks over the pools with relays, big ledger peers =
the largest pools up to and including the one crossing 90 % (`accumulateBigLedgerStake`), picks on
the 0.9 axis, the snapshot used when its slot is ≥ the ledger tip and `useLedgerAfterSlot`, maps
re-read after 1847 s (30 s while empty), one random address per resolved domain. Verified
offline against the preview relay's own view (`scripts/peer-selection-sim.ts` on
`cardano-cli query ledger-peer-snapshot` output, slot 123 991 628): the same 67 big ledger pools,
accumulated stake equal to 3·10⁻¹⁵; 200 k draws within 0.04 % (all) / 0.08 % (big) of the
expected shares. Pools registering 0.0.0.0 (36 on preview) stay on the stake axis as in
cardano-node and are never dialled.

## Bug 216 — ledger relays: portless relays defaulted to 3001, SRV and IPv6 relays dropped (2026-09-28, fixed)

Mapping now follows ouroboros-consensus `relayToLedgerRelayAccessPoint`: single_host_addr needs a
port and an address (IPv4 first, else IPv6), single_host_name without a port and
multi_host_name are SRV names resolved as `_cardano._tcp.<name>` (CIP-0155; lowest priority,
weighted draw, `srvRecordLookupWithTTL`). Ledger IPv6 bytes are four little-endian words
(cardano-ledger-binary `ipv6ToBytes`): confirmed on preview chunk 17236 against the relay's decode
of 2001:861:4000:2b80:216:3eff:fe05:9009. Stored `pool_relays` rows gain `srv: true` for SRV
entries (old rows are unaffected).

## Bug 217 — topology.json: cardano-node fields ignored or mis-defaulted (2026-09-28, fixed)

`useLedgerAfterSlot` was mandatory (cardano-node: absent / negative = no ledger peers, 0 =
always); `peerSnapshotFile`, `hotValency`/`warmValency`, `behindFirewall`, `diffusionMode` were
ignored; `trustable` defaulted to true (cardano-node: false); access points without a port (SRV)
and IPv6 literals failed. `normalizeTopology` implements the orphan-instance parser
(`localRootPeersGroupFromJSON`, `networkTopologyFromJSON`); paths are relative to the topology
file; local roots stay protected from churn / excess demotion regardless of `trustable`, so the
producer's topology (127.0.0.1 relay, no `trustable`) behaves as before. A group without
valency is still accepted (with a warning) because existing installs rely on it.

## Bug 218 — IPv6 missing from peer sharing, keys and dialling (2026-09-28, fixed)

PeerSharing answers now carry IPv6 peers as `[1, w1, w2, w3, w4, port]` (HostAddress6 words,
big-endian per word) and received IPv6 addresses are kept; peer keys bracket IPv6
(`[2001:db8::1]:3001`), v4-mapped inbound addresses are unmapped; AAAA lookups and IPv6 ledger /
shared peers are used when `peerGovernor.ipv6` is true or "auto" finds a global IPv6 address
(this host has only ULA: off).

## Bug 219 — governor: big ledger targets, warm valency, churn, peer-sharing policy (2026-09-28, fixed)

Big ledger peers count only against `targetKnown/Established/ActiveBigLedger` (15/10/5 for the
relay role, 0 for producer / data unless configured); local-root groups keep `warmValency`
established and `hotValency` active connections ahead of the regular targets; churn (relay
role default) replaces 20 % (rounded down, at least 1) of the non-local-root hot, warm and cold peers every 3300 s + 0–600 s
(900 s + 0–60 s when > k slots behind), never the chain-sync primary or the last hot peer;
peer-share requests wait 300 s after connecting and 900 s between requests to a peer, ≤ 2 in
flight, asking min 255 (max 8 (deficit ÷ requests)); a coin flip (or no donor) takes mature
(15 min) duplex inbound peers instead; our answers contain only advertised, once-connected,
failure-free peers in an 823 s salted order, at most 10. Offline simulation in
`PeerGovernor.test.ts`.

## Bug 220 — no Prometheus endpoint (2026-09-28, fixed)

`prometheus: {host, port, noSuffix}` / `hasPrometheus: [host, port]` / `GEROLAMO_PROMETHEUS`
serves cardano-node's exposition (names checked against the preview relay's 127.0.0.1:12798
output: `cardano_node_metrics_*_int|_counter|_real`, `basicInfo` info, `# EOF`, same content type)
on its own port: blockNum, slotNum, epoch, slotInEpoch, density (fragmentChainDensity over k),
GSM.state (approximated from the tip's age), txsInMempool, mempoolBytes, served.block /
served.header, Forge.* counters and ForgingStats, forging_enabled, the four KES gauges,
connectionManager.* and inboundGovernor.* (approximations noted in nodePrometheus.ts),
peerSelection.* (incl. cardano-node's swapped WarmLocalRoots / HotLocalRoots), basicInfo /
node.start.time, and RTS stand-ins where Bun has one (heap, RSS, CPU; no GC counts). The JSON
`/metrics` is unchanged apart from additive governor-snapshot fields (`bigLedger`, per-peer
`bigLedger`, group `warmValency`).

## Bug 221 — KES rotation needed a restart; SIGHUP killed the node (2026-09-28, fixed)

SIGHUP (as cardano-node) reloads the KES key + operational certificate and topology.json. The new
pair must pass the startup checks (our cold key and signature, this KES key, valid period,
counter = chain's or +1) or the running pair stays; the swap waits for a running forge and zeroes
the replaced secret. Tests: `BlockProducer.reload.test.ts`. Docs: scripts/watchdog/README.md,
`pool-register.ts rotate-kes`. Note: SIGHUP no longer terminates the process (a closed
controlling terminal does not stop the node).

## Bug 225 — Byron update proposals, votes and endorsements ignored (2026-09-28, implemented, report-only; wired and strict since bug 296)

`src/consensus/byron/ByronUpdate.ts` + `byronUpdateCodec.ts` implement cardano-ledger-byron
`Update.Validation.*`: registration (`pvCanFollow`, `canUpdate`, `svCanFollow`), votes and
confirmation (`upAdptThd` = ⌊minThd · genesis keys⌋ = 4 on mainnet / preprod), endorsements
(2k-stable, FADS candidates), TTL expiry, epoch-boundary adoption (candidate stable 4k slots before
the epoch's first slot, `ProtocolVersionBump`). The codec is byte-exact against cardano-ledger's
golden vectors (proposal, vote, payload, parameters, UpId, signed bodies) and checks
proposal / vote signatures. Not wired into the node: the state needs the whole Byron history and
the orchestrator rebuilds its Byron state from the last k headers.

## Bug 226 — Byron replay of the real preprod and mainnet chains (2026-09-28, verified offline)

`scripts/byron-update-replay.ts` over Mithril-downloaded immutable chunks, signatures checked:
mainnet 4 490 510 main blocks, 20 proposals, 83 votes, 0 rule failures; adoptions 0.1.0 at epoch
16, 0.2.0 at 84, 1.0.0 at 176, 2.0.0 at the tick into 208 (the Shelley hard fork); preprod 1.0.0
at epoch 2 and 2.0.0 at epoch 4 (Shelley start; the candidate missed epoch 3 by 3 slots — the 4k
window). Rejection paths are covered by unit tests only (the chain contains no invalid update).

## Bug 227 — mainnet Byron size limits changed on chain (2026-09-28, finding; closed by bugs 297–299)

maxTxSize 4096 → 65536 (epoch 16) → 8192 (epoch 84), maxBlockSize 2 000 000 → 32768 (epoch 84); the
fee policy never changed. No Byron size limit is checked today; any such check must read
`currentByronProtocolParameters()`, not the genesis. Open: persist the tracker snapshot, drive it
from the orchestrator, then have `blockRules.evaluateByronBlock` take the adopted fee policy
(`currentByronProtocolParameters()?.txFeePolicy ?? byronFeePolicyFor(ctx.config)`).

## Bugs 296–305 — the Byron chain-validation state in the node (2026-10-01, fixed; 304–305 open)

Reference: cardano-ledger-byron (cardano-ledger-conway-1.22.1.0) `Block.Validation`
(`updateBody`, `headerIsValid`, `epochTransition`, `updateChainBoundary`), `Byron.API.Validation`
(`applyChainTick`, `validateBlock`, `validateBoundary` — the path ouroboros-consensus drives),
`UTxO.Validation.validateTxAux`, `Common.TxSizeLinear`, `Delegation.Validation.{Interface,
Scheduling, Activation}`; ouroboros-consensus `Byron.Ledger.Ledger` (`ByronTransition`),
`Byron.Ledger.Inspect.protocolUpdates`, `Byron.ByronHFC.byronTransition`.

**296. The Byron update state was not part of the node's ledger.** Bug 225's rules ran only in the
offline replay; Byron blocks applied with no update, delegation or adoption state. Now
`consensus/byron/ByronLedger.ts` is the Byron `ChainValidationState` minus the UTxO, stepped the way
cardano-node steps it: every block (EBBs included) `applyChainTick` (UPIEC epoch transition from
`cvsLastSlot`, then the delegation tick), then for a main block header size, block size,
`updateDelegation`, BUPI with the delegation map *after the tick*, `cvsLastSlot`, and the consensus
`ByronTransitionInfo` (candidate version → block number); for an EBB the 2·10⁶-byte limit and
`cvsLastSlot := epoch·10k`. `ByronLedgerDriver` holds it at the applied tip; the applier steps it
before body validation and commits it after `applyBlock`, inside the block's scope:
`ledger/byronStore.ts` writes LMDB `byron/{core,tip}` into the block diff and the SQLite table
`byron_ledger` (journaled, `db/ledgerJournal.ts`), so a rollback or a failed range takes the block's
Byron effects with it; the driver is dropped then and reloaded from the store at the next Byron
block. `core` (update + delegation + transition info, JSON) is rewritten only when it changed; `tip`
(`lastSlot|blockNo`) every block. A chain an older build took into Byron is rebuilt over the stored
blocks on first use; a store seeded from SQLite (dual rebuild) copies the rows. Update and
delegation rule failures (`ChainValidationUpdateError`, `ChainValidationDelegationSchedulingError`)
fail the block like body rules (strict on a from-genesis node).

**297. Byron body rules read the genesis parameters only.** The tx rules took `txFeePolicy` from the
genesis file. They now get the adopted parameters of the ticked state (`ctx.byronParams`: what the
block's header, body and transactions are checked against, after the epoch transition, before the
block's own update payload); genesis only when no Byron state is available.

**298. No Byron size limit was checked.** Now `headerLength ≤ ppMaxHeaderSize`, `blockLength ≤
ppMaxBlockSize` (bytes of `[header, body, extra]`), EBB ≤ 2·10⁶, and `txSize ≤ ppMaxTxSize`, all
with the adopted parameters.

**299. The Byron fee basis was a lower bound.** `validateTxAux` measures `txSize` on the whole
`ATxAux` encoding (`[tx, witnesses]`, as on chain) for both the size limit and `a + ⌈b·size⌉`; we
used the witness-less tx bytes. `blockRules.byronTxAuxSizes` slices the body's tx payload from the
raw block (`ctx.rawBlock`); without the raw block the old basis stays and the size is reported
unchecked.

**300. Byron delegation: genesis-only after a restart, and read before the tick.** The OBFT state
rebuilt itself from the genesis `heavyDelegation` after every restart and rollback, forgetting
on-chain certificates; the offline replay gave the update rules the map before the block's tick
(CHAIN rule). `ByronLedger` implements `Delegation.Interface` (scheduling checks: genesis delegator,
current/next epoch, once per epoch and per slot, certificate signature; activation 2k slots later
unless the delegate already delegates or the slot does not move; pruning), persisted with the rest;
`ByronObftState.restoreDelegation` takes the applied chain's map and schedule. Neither preprod nor
mainnet Byron carries a single delegation certificate, so the difference never showed on the real
chains.

**301. The Byron→Shelley transition did not come from the Byron ledger.** The hard-fork history saw
Shelley only when the first Shelley block's epoch parameters said major 2 (and slot arithmetic used
the hard-coded geometry). Now, as in `byronTransition`: the newest candidate whose major is Shelley's
`eraProtVerLow` (2), once stable — 2k slots after its endorsement slot, or k blocks after the block
that made it a candidate — ends Byron at `succ (epoch (slot + 4k))`. `HardForkHistory.byronTransition`
makes GetInterpreter report `TransitionKnown` during the last Byron epoch; at the first post-Byron
block `crossByronBoundary` rejects it unless that epoch has been reached (`HardForkLedgerErrorWrongEra`)
and records Shelley's start from the Byron state (`noteByronTransition`); a Byron block at or past a
known transition is rejected. A `TestShelleyHardForkAtEpoch` network keeps its configured epoch. On
the soft path (a node that is not strict) a post-Byron block before the Byron state's end, or with no
stable candidate, records Shelley from that block's epoch, never later, so the history never falls
below the tip block's own era tag (bug 237). Past the boundary the hook answers "unknown" without
reloading the Byron state (a Mithril-bootstrapped chain whose history is still at Byron is bug 237's
case: the tip-era floor answers).

**302. An EBB moves `cvsLastSlot` on the node path** (finding). `validateBoundary` sets it to the
epoch's first slot, so an epoch that opens with an EBB runs its UPIEC at the EBB's tick; adoption is
the same either way.

**303. Custom networks without a Shelley override** stayed on Byron geometry forever
(`shelleyStartEpoch` 2⁴⁰): their slot/epoch geometry now takes the Shelley start from the Byron
state once it is known (workers receive it with their jobs).

**304. An LMDB ledger store cannot start from an empty chain** (finding, open, outside this area).
`ledgerBeginBlock` marks the store broken when the first block's parent (the genesis hash) is neither
the tip nor an anchor, and the chain never reaches an anchor, so a from-genesis sync in `lmdb` mode
halts after the first range. `dual` rebuilds the LMDB store from SQLite after that range (the Byron
record included) and works; a from-genesis preprod sync must start in `sqlite` or `dual` mode.

**305. Byron witness roots hash with the pure-TS BigInt sha3** (finding, performance, open): about
0.5 ms per input on the applier's thread, so roughly half an hour of main-thread CPU over mainnet's
2.4 M Byron transactions.

Verification:
- Preprod, the whole Byron era (46 blocks, Mithril-certified chunks 0–4) through the node's own
  apply path (`scripts/byron-node-replay.ts`: a fresh database, `ConsensusOrchestrator.applyRange`,
  strict full validation, in `sqlite`, `dual` and `lmdb` (after a dual start; also with
  `GEROLAMO_LEDGER_SQL_WRITES=0`)): every block applies; the persisted state after the last Byron
  block equals the standalone replay; 1.0.0 adopted at epoch 2; the 2.0.0 candidate (slot 56163)
  stable from slot 60486, so the hard-fork history knows the transition before the boundary; a
  10-block rollback restores the state at that block and re-applying reproduces the tip; the first
  Shelley block (slot 86400) passes `crossByronBoundary` and the history records Shelley@4 from the
  Byron state; the OBFT delegation map is restored from the persisted delegation state.
- Mainnet, the whole Byron era (Mithril chunks 0–208, 4.5 GB, deleted afterwards) through
  `scripts/byron-ledger-replay.ts --utxo` (ByronLedger with proposal / vote signatures checked, the
  transactions as `blockRules` decodes them through `evaluateByronTxRules` with the adopted
  parameters and the `ATxAux` sizes; witness signatures and key-root hashes not recomputed):
  4 490 510 main blocks + 176 EBBs (none after epoch 175), 2 400 911 transactions in 1 659 935
  blocks, final UTxO 729 941, zero rule failures (1 152 s, ≤ 1.5 GB RSS). Adoptions: 0.1.0 at epoch
  16 (EBB tick; maxTxSize 65 536, maxProposalSize 70 000), 0.2.0 at 84 (EBB tick; maxBlockSize
  32 768, maxTxSize 8 192), 1.0.0 at 176 (unlockStakeEpoch). Largest tx / block against the limit in
  force: 3 981 / 4 096 B (0.0.0), 65 519 / 65 536 B (0.1.0), 8 182 / 8 192 B and block 32 640 /
  32 768 B (0.2.0), 8 173 / 8 192 B and 32 607 / 32 768 B (1.0.0). The Byron→Shelley transition is
  known from slot 4 481 414 (block 4 479 125): epoch 208, the first Shelley block's (slot
  4 492 800); the tick there adopts 2.0.0. The persisted core record changed 60 times, each
  round-tripped. A second run without `--utxo` (436 s, 0.3 GB) prints the same adoptions with the
  parameters they changed.
- Unit tests: `ByronLedger.test.ts` (the preprod era as a fixture; delegation rules; transition by
  slots and by blocks; size limits; persisted form), `ledger/byronStore.test.ts` (SQLite journal undo
  and LMDB diff rollback / promotion, rebuild from stored blocks, wrong-era block),
  `byronTxRules.test.ts` / `byronAdoptedParams.test.ts` (fee and size on the ATxAux bytes, adopted
  `maxTxSize`), `hfc.test.ts` (TransitionKnown from the Byron state, Shelley start, rollback).

Left for a from-genesis preprod sync: start in `sqlite` or `dual` ledger mode (bug 304); Byron
headers are still checked against the OBFT state at header time, ahead of application, with the
lenient active-or-scheduled delegation test (the ledger's forecast of the delegation map is not
used there); the mempool has no Byron-era rules (no public network is in Byron).

## Bugs 150–165 — Conway governance: rules, ratification, typed credentials (2026-09-28, fixed)

Reference: cardano-ledger-conway 1.22.1.0, the version cardano-node 11.0.1 resolves (CHaP index
2026-05-02; `Rules/Gov.hs`, `GovCert.hs`, `Deleg.hs`, `Ratify.hs`, `Enact.hs`, `Epoch.hs`,
`HardFork.hs`, `Governance/DRepPulser.hs`, Shelley `Pool.hs`). Proof: `scripts/gov-replay.ts` over
all of preview's Conway history (below) and `scripts/gov-rules-shadow.ts` on both nodes' LMDB stores.

**150. Governance transactions were recorded, never validated.** Proposals, votes and certificates
were written to the governance tables as they came. `consensus/governance/govRules.ts` now checks
every phase-2-valid transaction as LEDGER / CERTS / GOV do, in their order — withdrawals drain the
accounts first, then the certificates one by one (DELEG / POOL in `certificateRules.ts`, GOVCERT),
then the proposals and the votes against the state after the certificates — over the state before the
transaction (`GovBlockOverlay` carries the block's earlier transactions). The bodies are decoded from
their CBOR (`govTxDecode.ts`), not from ledger-ts objects. Failures are named after the ledger's
constructors and reach the producer as `tx[i]` (it drops those transactions). Protocol gates as in
1.22.1: bootstrap (9) — only ParameterChange / HardFork / Info proposals, DReps vote on Info only, no
return-account or zero-withdrawal checks, no DRep registration check on delegation; 10 — as Conway;
11 — `UnelectedCommitteeVoters`, `DepositIncorrectDELEG` / `RefundIncorrectDELEG`, duplicate VRF keys,
nOpt ≠ 0 in updates; the hard-fork succession test looks the parent up among the proposals before the
transaction (1.22.1; master looks inside it). Replay: 218 325 governance-bearing transactions of preview
epochs 646–1434, 0 failures; node shadow: 0. Strict by default; `StakeKeyHasNonZeroAccountBalanceDELEG`
stays report-only with `WITHDRAWALS_STRICT` (our reward balances), a refund against an untracked
deposit is a report, tip sync is report-only. Counters on `/metrics` (`governanceRules`).

**151. Ratification order and the round's enact state.** Proposals were tallied in submission order
and one action per purpose per epoch. RATIFY sorts by `actionPriority` (NoConfidence, UpdateCommittee,
NewConstitution, HardFork, ParameterChange, TreasuryWithdrawals, Info; stable) and every ratified
action updates the round's enact state at once: roots (a ParameterChange chained on one ratified
earlier in the round passes in the same round), parameters (thresholds and committee bounds for the
proposals after it), committee, protocol version, treasury. `ratify.ts` is the round, pure.

**152. Committee tally.** A member with an authorised hot key that did not vote was left out; the
ledger counts it as No (`committeeAcceptedRatio`), leaving out only Abstain, expired, resigned and
unauthorised members. The minimum committee size applied in the bootstrap phase, where it does not;
below the minimum the committee has no threshold (not ratified), zero threshold means accepted.

**153. DReps and committee credentials keyed by bare hash.** The ledger keys them by (key | script,
hash). DReps now use the typed hex of db/stakeCred.ts (hash / "01" + hash; `is_script` of an older row
decides), committee cold and hot keys "00"/"01" + hash; UpdateCommittee payloads carry `typed: true`.
The Mithril importers stripped the type (`cold.replace(/^01/, "")`) and now keep it; the genesis
seeding reads `scriptHash-` / `keyHash-`. Stored data: `govCredMigration.ts` (`gov_cred_typed_v1`,
once, inside the first Conway block a new build applies, so LMDB diffs and the SQLite journal hold it)
rekeys script DReps and types committee rows whose type the genesis or the committee's votes name; a
row of unknown type keeps its bare key and matches both types until a certificate names it
(`ccCredsOf`). Preview's three committee members are scripts with script hot keys (NES).

**154. SPO tally and distribution.** An SPO that did not vote counted by its reward account's DRep
delegation on every action; on a hard fork it is always No, in the bootstrap phase Abstain
(`spoAcceptedRatio`). The SPO voting stake is the mark snapshot plus the deposits of live proposals
whose return account delegates to a pool of it (`addToPoolDistr`): Koios `pool_voting_power_history`
at preview 742, 766, 994, 1300 exceeds our snapshot by exactly those deposits (100 k ADA multiples).

**155. The DRep distribution excluded the boundary's refunds and withdrawals.** The pulser is set up
on the EPOCH rule's output, whose accounts already hold the refunded deposits and the treasury
withdrawals (bug 95's note that the DRep snapshot excludes them was wrong; its pool-snapshot half is
right; `Epoch.hs`: `returnProposalDeposits` feeds `certState2`, and `setFreshDRepPulsingState` runs on
that `epochState2`). Koios `drep_history` at 766: DRep 74519ac5… 700 000 ADA above our snapshot — the
seven 100 k refunds of that boundary; at 1435 the only DRep that differs is b25d7204…, −1 000 ADA, the
refund of the expired e6ed8d65…:0 to its return account 104b7df2… (the same finding as the lsq agent's
bug 185, which makes GetDRepStakeDistr byte-identical once fixed). The orchestrator now credits the
boundary's payouts after the pool snapshot and before the ratification (`applyBoundaryCredits` before
`governanceRatify`); the ratification's treasury is then the post-boundary one too.

**156. An unregistering DRep's votes stayed.** GOV removes them from every proposal
(`GovRemovedVotes`); they counted again if the DRep re-registered before the action was decided.

**157. Conway genesis `initialDReps` / `delegs` were never seeded.** cardano-node injects them only
into the initial state of a chain that starts in Conway (`mkInitExtLedgerStateCardano` →
`injectIntoTestState`), never on mainnet and never at the Babbage→Conway translation; `seedGovernance`
does the same (delegations of registered credentials only). None of the public networks has them.

**158. Treasury and committee-term conditions were missing.** A TreasuryWithdrawals is ratified only if
it fits the treasury left by the round's earlier withdrawals; an UpdateCommittee only if every new term
ends within `committeeMaxTermLength` of the pulser's epoch (`validCommitteeTerm`).

**159. Descendants of an expiring proposal stayed.** EPOCH removes an expiring proposal with its
subtree (`proposalsRemoveWithDescendants`); a child waited — unratifiable — for its own expiry.

**160. The committee state kept non-members.** EPOCH intersects `csCommitteeCreds` with the (new)
committee's members at every boundary (`updateCommitteeState`); authorisations of cold keys that never
became members stayed (preview 3035: 8 rows, the chain 3). An authorisation survives a boundary only
if the key is a member after that boundary's enactment; bug 83's test now authorises in the epoch
between ratification and enactment. With the pruning the replay's committee state equals the chain's
at all three NewEpochStates.

**161. Dormant epochs.** An epoch counts as dormant when no proposal with `expiresAfter` ≥ the new
epoch remains (`updateNumDormantEpochs`); any stored active proposal, even one expiring at that
boundary, kept it from counting.

**162. NoConfidence left the committee in place.** ENACT sets the committee to none; an UpdateCommittee
after it starts from its added members only (`updatedCommittee SNothing`). Never enacted on preview.

**163. DRep expiry at ratification.** A DRep counted when its expiry reached the epoch before the
pulser's; the ledger excludes it once the pulser's epoch passes its expiry (`reCurrentEpoch > drepExpiry`).

**164. The first Conway epoch had no committee or constitution.** Seeding waited for the boundary after
the Babbage→Conway one; `translateEra` installs them at the translation, so the first epoch's
proposals (guardrail script) and committee certificates are judged against them.

**165. Protocol-9 reverse delegations.** In the bootstrap phase a re-delegation left the account in the
old DRep's delegator set (`preserveIncorrectDelegation`, cardano-ledger issue 4772) and a delegation
to an unregistered DRep entered no set; an unregistration cleared the delegations of the set's
accounts only — whatever they delegated to by then. The protocol-10 hard fork dropped delegations to
unregistered DReps and rebuilt the sets (`updateDRepDelegations`). Ours cleared every delegation to
the unregistering DRep. Preview: 0a047809… delegated to fd160e2b…, then to 9b239a50…; fd160e2b…
unregistered at epoch 724 and the chain cleared the account (NES 1415, 1420, 1434); acab7e49… the
same. Fix: `gov_drep_boot_delegs` (LMDB `gov_drep_boot`) holds the sets during protocol 9,
`hardForkToV10` at the boundary that enacts protocol 10.

Proof (`scripts/gov-replay.ts`, 2026-09-28): a raw scan of preview's 2.34 M pre-Conway blocks builds the
accounts and pools (267 s), then the node's own functions apply the 2.36 M Conway blocks — the rules
before each block, certificates / proposals / votes as `applyTransaction` does, `enactPending` /
POOLREAP / `ratifyForNext` at every boundary with the node's stored stake snapshots and Koios' treasury
(349 s). Every boundary 646–1434: the ratified, expiring, enacted, expired and orphan-dropped sets equal
Koios `proposal_list` (all 1 552 proposals, 14 enactments). With Koios' own DRep and SPO distributions
at the 27 epochs that ratified something or precede one (`--koios-dist`): the same outcomes. The
decoded NewEpochStates of slots 122 316 253 (Mithril), 122 735 066 and 123 980 824 (the cardano-node
11.0.1 relay): all DReps with expiry and deposit (8 984 / 8 984 / 9 162), committee members and typed
committee state, live proposals, their votes, the four roots, the pulser's enacted / expired lists and
the dormant count equal; vote delegations equal (111 734 at 1434) after bug 165.
## Bugs 230–236 — chain selection, Genesis, hard-fork combinator (2026-09-28, parity with cardano-node 11 / ouroboros-consensus 3.0.1)

Reference: ouroboros-consensus `release-ouroboros-consensus-3.0.1.0` (the version cardano-node 11.0.1
builds: `Protocol/Praos/Common.hs`, `Shelley/Ledger/Config.hs`, `Storage/ChainDB/Impl/ChainSel.hs`,
`Util/AnchoredFragment.hs`, `Genesis/Governor.hs`, `Node/GSM.hs`, `Node/Genesis.hs`,
`HardFork/History/*.hs`, `HardFork/Combinator/State/Infra.hs`, `Shelley/ShelleyHFC.hs`), cardano-ledger
`Conway/Translation.hs`, cardano-diffusion `Governor/Types.hs` (HAA).

230. Praos tie-break was not `comparePraos`: (a) the same-issuer rule (higher opcert issue number wins)
    applied whenever the issuers matched; consensus arms it only when the two tips are in the **same
    slot** and have the same issuer; (b) there was no restricted VRF tie-breaker: from Conway on
    (`mkShelleyBlockConfig`: `RestrictedVRFTiebreaker 5`) the VRF outputs are compared only when the
    tips are at most 5 slots apart, otherwise neither chain is preferred and the node keeps its own.
    Real case from the preview volatile stores (2026-09-28): two blocks at height 4 706 249,
    5f0c957a…@123 973 034 and 7b139945…@123 973 074 (40 slots apart) — the network kept the later one;
    the unrestricted rule we had prefers the dropped one. `tieBreak.ts` is now an exact port
    (`comparePraos`, and the unrestricted `Ord` used to rank candidates); fixture
    `restricted-vrf-race-123973034.json`. The legacy outvote path only calls it for same-slot battles,
    where both rules agree, so the default behaviour is unchanged. `scripts/chainsel-replay.ts` over the
    two nodes' and the relay's volatile stores: 12 fork points, the selection picks the kept branch in
    all 12; of the 11 same-slot races the tie-break agrees with the network in 11.
231. A Praos node must be able to roll back up to k blocks across an epoch boundary. The SQLite guard
    of bug 63 (`rollbackChainTo` refuses: boundary work is not journaled) ran in every mode, before the
    LMDB rollback, so `ledgerStore: lmdb` refused too — although there the boundary work (reward update,
    SNAP, POOLREAP, governance) is written into the epoch's first block's diff and is reverted with it
    (nonces and epoch parameters are direct writes, but cannot change within k: the candidate nonce
    freezes 4k/f and the proposal deadline 6k/f before the boundary; the per-epoch start state is
    rewritten by the re-applied TICKN). Now `rollbackOurChainTo` allows the crossing when the LMDB store
    is the ledger authority and its anchor is not above the target (`rollbackChainTo(slot, { allowEpochCross })`);
    it also resets `lastAppliedEpoch` — without that the new branch's boundary would have been skipped
    (`onEpochStart` returns for epochs ≤ the last applied one). sqlite/dual modes still refuse (unchanged).
    Tests: `consensus/lmdbEpochRollback.test.ts`,
    `db.rollbackRestore.test.ts`. The SQLite shadow tables of an lmdb node that still writes them
    (GEROLAMO_LEDGER_SQL_WRITES≠0) keep the boundary's rows after such a rollback (logged): rebuild them
    before switching the node back to `ledgerStore: sqlite`.
232. GetInterpreter: the current era's end was always "the epoch after the tip's". Consensus
    (`reconstructSummary`, `TransitionUnknown`) ends it at the first epoch boundary at or after
    tip + 1 + safe zone (3k/f): during the last 3k/f slots of every epoch (30 % of it on every public
    network) the relay answers epoch + 2. Now computed by `consensus/hfc/hfc.ts`; byte-identical with the
    cardano-node 11.0.1 preview relay (`scripts/hfc-compare.ts`, 268 bytes, captured in `hfc.test.ts`).
233. Era boundaries were hard-coded per network (`n2c/eraHistory.ts`, `txSubmissionCodec.hfcEraIndexNow`,
    `startBlockProducer`, `ConsensusOrchestratooor` pointer-stake trigger: PV 9 crossing). A ledger-driven
    hard-fork history (`consensus/hfc/HardForkHistory.ts`, `hfcNode.ts`) now provides them: `Test*HardForkAtEpoch`
    triggers from the config (top level, or `cardanoNodeConfigFile`), the protocol major adopted at each
    epoch boundary against the next era's `eraProtVerLow` (`shelleyTransition` guards with `==`;
    Conway's successor is `TriggerHardForkNotDuringThisExecution` in node 11), persisted to
    `hfc-eras.json`; eras the node never observed (Mithril) come from the block store (first block with
    the era's tag, binary search over the chunks: preview Babbage@3, Conway@646 found in node 3036's
    store, identical to the relay), and only then from the built-in history. Consumers fall back to the
    old tables until the history reaches the tip's era (`ready`).
234. `stabilityWindowSlots()` (genesis-delegation activation) returned 129 600 on every network; preview's
    3k/f is 25 920, so a replay from genesis activated preview genesis delegations five times too late.
    Now per network (geometry).
235. A network other than mainnet/preprod/preview fell back to preprod's slot/epoch geometry
    (`normalizeEpochNetwork`) and had no GetSystemStart/GetInterpreter. Custom testnets and SanchoNet
    now get the geometry (epoch length, slot lengths, Shelley start, stability window) from their
    genesis files and hard-fork history (`EPOCH_GEOMETRY.custom`, passed to the validation workers).
236. The Babbage → Conway translation (`utxosInstantStake = ConwayInstantStake . sisCredentialStake`:
    pointer stake dropped; the UTxO and the Babbage snapshots are kept) was applied to SQLite only. In
    `ledgerStore: lmdb` the `stake_bal` counters kept the pointer outputs, so an lmdb node replaying
    across the Conway boundary would have counted them in every Conway snapshot (preview: the 35 553 ADA
    of bug 93). `consensus/conwayTranslation.ts` also rewrites the LMDB records inside the boundary
    block's diff; triggered by the hard-fork history's Conway start (also correct when Conway starts
    through a Test* trigger). Test: `consensus/conwayTranslation.test.ts`.

### New, opt-in: ouroboros-consensus chain selection and Genesis mode

`consensus.chainSelection: "praos"` (or GEROLAMO_CHAIN_SELECTION=praos; default "legacy" = primary +
verifier votes; "shadow" runs the new selection beside legacy and only logs "Chain selection (shadow)
would: …" and counts `chainSelection.shadowDisagreements` in the sync snapshot) runs `consensus/chainsel/`: every hot peer's validated headers form its candidate
fragment; our chain is the applied chain (anchor = immutable tip k blocks back, reconciled with the DB
before each decision); the node switches to the best candidate that forks at most k blocks back
(longest, then the Praos tie-break of bug 230; candidates ranked by the unrestricted `Ord`), rolls back
to the intersection and fetches the candidate's blocks; a primary whose stream forks onto a chain that
is not preferable is not followed. Peers whose fork is deeper than k (ForkTooDeep) or whose candidate
contains a block known to be invalid (deferred-VRF failures are recorded) are disconnected; headers
still awaiting their VRF check are not part of any candidate. `consensus.mode: "genesis"` (implies
"praos") adds the GSM (PreSyncing / Syncing / CaughtUp; HAA = ≥ 5 active big ledger peers or
`localRootsOnly`; 20 min max caught-up age + ≤ 300 s bonus; marker file `caught-up` next to the DB),
the Limit on Eagerness (the apply pipeline holds blocks more than k past the LoE tip; PreSyncing: LoE
at the immutable tip) and the GDD (sgen = 3k/f, rate-limited to 1 s). ChainSync Jumping: bug 289
(was not implemented). Big ledger peers come from peer selection through `orchestrator.setBigLedgerPeerSource({
bigLedgerPeers(): string[] })`. Verified by unit tests and a deterministic simulator
(`chainsel/sim.ts`: 200 random fork scenarios, deep forks, invalid blocks, LoE, sparse adversaries for
GDD) and the real fork replay above; **not yet run on a live node** — run "shadow" on node 3036 first,
then "praos" there, before the producer.
## Bugs 284–289 — legacy chain following halted the producer; shadow-mode audit; ChainSync Jumping (2026-10-01)

284. **Legacy mode applied a losing branch on top of the ledger store and halted (producer, 2026-09-29
    10:03:57 UTC, 8 h 40 min without sync).** The producer, 44 min behind (bug 285), outvoted its primary
    and switched to the local relay, whose fragment was … A, L; 0.2 s later the relay's own slot battle
    went to N (lower VRF) and it sent RollBackward A + N. N did not chain onto our tip, its ChainSync
    restarted and re-streamed W1 … A, N, N2 while the switch's ranges were still downloading. The switch's
    ranges applied (tip L); the re-streamed W1 … A ranges were all duplicates, and `mirrorToBlockStore` set
    the block store's selected tip to the last point *of each range* (A) although L was applied on top —
    a silent rollback the ledger store never saw. N then passed the block store's continuity check and the
    LMDB store refused it ("ledger store unusable: block 54a7c5f8…@124020237 extends a3d48c2a… but the
    ledger store's tip is a6916d45…") → SYNC HALTED. Fixes (`ConsensusOrchestratooor.ts`,
    `RangeScheduler.ts`, `ledger/nodeLedgerStore.ts`): the selected tip is the last block a range *applied*
    (an all-duplicate range moves nothing); `onRange` gets `stillCurrent()` and a range dropped by a
    primary switch / rollback (`reset()`) while it waited for the DB is discarded, not applied; in legacy
    mode a range whose first new block continues from a block of our chain below the tip rolls back to that
    block first (≤ k, `rollbackForForkingRange`, keeping the queued ranges of the new branch) — only when the
    branch is preferable as cardano-node would judge it (longer counting headers still waiting for bodies,
    or as long and preferred by `comparePraos`); otherwise the continuity check fails the range as before
    (our own forged block is never given up for a shorter branch); `ledgerBeginBlock` given a block whose
    parent is a block the store holds a complete state for rolls the store back to it instead of halting
    (unknown parents still break it). Reproduced with the real orchestrator, block store (primary) and LMDB
    store on forged Babbage blocks (`consensus/legacyFork.test.ts`: the incident, plus "as long, tie-break
    for/against", "longer"): with the fixes reverted the test halts with the producer's exact message.
    Node 3036 hit the same race twice on 2026-10-01 (14:02:37, 15:33:18 UTC: "range … does not extend the
    applied chain", pipeline reset, primary terminated); the new path rolls back instead.
285. **Stale divergence of a promoted primary stalled body fetch (producer, 2026-09-29 09:19–10:03 UTC, 44
    min without a block).** A verifier promoted to primary kept the divergence it had recorded against the
    old primary; `eligibleFetchPeers` skipped divergent peers, the primary included, and once every
    verifier diverged at the next slot battle no peer could serve the head range — `RangeScheduler.pump`
    found no peer, nothing was in flight, and nothing ever pumped again. `setPrimary` clears the new
    primary's divergence and pending comparisons; the primary is always a body source; a head range with
    no eligible peer and nothing in flight is re-offered after `RETRY_NO_PEER_MS` (1 s, `noPeerWaits` in
    the scheduler stats). Tests in `CandidateSet.test.ts`, `RangeScheduler.test.ts`.
286. **A resolved divergence fired an outvote 44 minutes later.** When the primary rolled back and followed
    the block a verifier had diverged with, the verifier's divergence stayed recorded; at the next slot
    battle two such verifiers mismatching the primary anywhere outvoted it *at the old slot* (124017576 —
    the rollback of bug 284's incident went to slot 124017575). `observe` on the primary clears a verifier's
    divergence when the primary now carries the verifier's block at that slot. Test in `CandidateSet.test.ts`.
287. **Our ChainSync server sent the new branch straight after an abandoned block.** The relay stores serve
    "the next header after the client's slot"; after our chain switched branches below a client's
    position the client got N2 right after L and the cardano-node relay dropped us
    (`UnexpectedPrevHash`, relay log 2026-09-29 10:04:05.7079Z, header 835d13d9…@124020242). The host now
    remembers the points it served (≤ 2200) and, when the next header's parent is not the client's
    position, sends MsgRollBackward to the newest served point still on our chain first (a store gap, the
    position still on our chain, is served as before). `RelayHeader.prevHash` from the chunk and SQLite
    stores. Tests in `N2NChainSyncHost.test.ts`.
288. **Shadow-mode analysis, node 3036 2026-10-01 01:25 → 22:20 UTC (finding: praos right 10/10; no praos
    fix needed).** `shadowDisagreements` = 10 "would" lines. Judged against the cardano-node 11.0.1 relay
    (its ChainDB log, and N2C ChainSync FindIntersect on the relay and on 3036, read-only):
    06:24:48 switch → 53a1161d@124179888, 08:30:18 → 583bc63c@124187418, 10:19:40 → a66750ea@124193980,
    15:33:18/19 (2 peers) → e7546cdf@124212798, 17:27:54 → 3c7897bf@124219674 (all tie-break): the relay
    first extended with the block legacy's primary served (f3f942af, ca06e622, 71c9535c, f32ab11b,
    f31bd570) and switched to praos's block 0.15–0.46 s later; 14:02:37 → 760ed96f@124207357 (tie-break
    against 30f687b1, which the relay never adopted); 15:33:22 (3 peers) → 98639582@124212802 ("longer",
    the child of e7546cdf). Nine of the ten targets are on the relay's (and 3036's) chain today; 3c7897bf
    was abandoned 107 s later by both the relay and 3036 for a longer branch (dafef7b6@124219781) — praos
    had made the relay's own decision. Legacy acted on the same blocks within 0–4 s each time (outvote, or
    a rollback its primary confirmed), but on the way two range-pipeline failures (bug 284's race) and
    three ChainSync restarts terminated its new primary ("drain timed out"). Of legacy's 26 outvotes in the window, 25 targets are on the relay's chain (the
    26th is 3c7897bf), and the relay's ChainDB decided each of those 26 slots for the same block (21 times
    it adopted the other sibling first and switched 0.05–0.46 s later, 3 times it kept the first, twice it
    never saw a second block — preview has a same-slot battle about every 50 min). The 21 outvotes with no
    "would" line are battles legacy settled (rollback, or the primary's block not applied yet) before
    praos's next evaluation, which then saw both siblings extending our tip: an "extend" verdict, not
    logged; its choice there is `comparePraos`, the relay's own rule (bug 230). Checked on the real headers
    where they still exist: `scripts/chainsel-replay.ts` over the relay's volatile DB (929 blocks, read-only,
    22:30 UTC): 9 fork points, selection picks the kept branch in 9; in the 8 same-slot races the
    tie-break prefers the kept block 8 times — four of them silent outvotes (124216681, 124221394,
    124222688, 124234028) — and the 3c7897bf/f31bd570 battle is decided by length (46e0b97f…). Note: `shadowDisagreements` counts
    praos *actions*, not disagreements. New: `chainsel/shadowAudit.ts` follows every shadow decision until
    it resolves — `legacy-followed` (legacy applied the same tip later; latency), `legacy-kept` (our tip
    moved 180 slots past it without it, ≥ 3 min: check the relay), `peer-dropped` / `peer-kept` for
    disconnects — logged as "Chain selection (shadow) resolved: …" and in `/metrics`
    `sync.chainSelection.shadow`.
289. **ChainSync Jumping was not implemented (Genesis mode).** `consensus/genesis/csj.ts` is a port of
    ouroboros-consensus 3.0.1 `MiniProtocol/ChainSync/Client/Jumping.hs` (+ `State.hs`): one dynamo
    streams, every other engaged peer is a jumper answering single-point MsgFindIntersect jumps each
    `jumpSize` slots (default `2 × 2160`, `consensus.csjJumpSize`); a rejected jump binary-searches the
    disagreement, the dissenting jumper with the oldest one becomes the objector and streams so the GDD
    can compare densities; dynamo/objector rollbacks before their jump/disputed point, MsgAwaitReply and
    disconnects disengage / re-elect (`backfillDynamo`, `electNewObjector`, `rotateDynamo`). Wired in
    `ChainSelDriver` (Genesis only, not CaughtUp; `consensus.csj: false` / GEROLAMO_CSJ=0 turns it off;
    off in "shadow", where legacy needs every stream) and the orchestrator (`csjLoop` per hot peer: pause,
    jump via `PeerClient.csjJump`, resume, restart; the dynamo becomes the primary). Simulator
    `genesis/csjSim.ts` (real ChainSel + LoE + GDD + CSJ; per-peer ChainSync servers): honest sync with
    ≤ 2 engaged downloaders, adversarial dynamo on a sparse fork, a stalling denser-looking fork, a lying
    jumper (rejects every jump; also as objector), a dynamo rolling back before its last jump, two sparse
    forks, and 100 random scenarios (k = 50: honest tip reached, no honest peer disconnected, about a
    third of the header downloads of plain Genesis). Not yet run on a live node: Genesis mode is off on
    both preview nodes.

**Rollout (chainSelection).** Deploy bugs 284–287 to the producer first (it runs legacy). 3036 shadow →
praos once, on this code, for ≥ 48 h spanning an epoch boundary and ≥ 20 recorded shadow decisions:
every `legacy-kept` resolution checked on the relay with zero cases where the relay kept legacy's block;
every praos switch target adopted by the relay (its log) at the time; zero shadow disconnects that the
relay does not mirror (an invalid block it also rejects, or a fork > k); no halt, no `ledger store
unusable`, no range-pipeline failure, and `scripts/chainsel-replay.ts` over the volatile stores picking
the relay's branch at every fork point. Then 3036 on praos ≥ 72 h (3 boundaries): every relay "Switched to a
fork" mirrored by 3036 within 10 s and none of its own, tip within 60 s of the relay's ≥ 99.9 % of
minutes, zero rollbacks > 1 block that the relay did not make, chain-selection peer terminations not
above legacy's (11 in those 21 h: 9 "drain timed out", 2 range-pipeline failures). Producer: shadow ≥ 24 h on its own peer set, then praos, switched right after
a forged block, with the next leader slot ≥ 2 h away; legacy stays the one-line fallback. Genesis + CSJ
only on a scratch node syncing from a Mithril snapshot first.

## Bug 135 — LocalTxSubmission could not take a cardano-cli transaction, and keyed the mempool by the wrong hash (2026-09-28, fixed)

cardano-node's MsgSubmitTx carries the hard-fork-wrapped transaction `[0, [6, #6.24(tx)]]`; the
host parsed it with ouroboros-miniprotocols-ts, which only accepts bare bytes, so every real
client got `MsgRejectTx [2, 1]` (an integer no client can decode). Transactions that did get in
were stored under blake2b-256 of the *whole* transaction, which is nobody's id: LocalTxMonitor
HasTx, the tx-submission id announcements and the mini-Blockfrost mempool lookups never matched
the body-hash ids clients and peers use. Fix (`src/network/n2c/LocalTxSubmitHost.ts`,
`src/mempool/`): both wire forms accepted, id = body hash, and a rejection carries cardano-node's
own `HardForkApplyTxErr` — `[2, [[6, [ConwayLedgerPredFailure…]]]]` with the nested UTXOW / UTXO
/ UTXOS failures, in the order the ledger's small-steps engine produces (a sub-rule's failures
prepended in execution order before the parent's; `RuleRun` in `applyTxErr.ts`). Verified against
the cardano-node 11.0.1 preview relay with unsigned (never valid) transactions,
`scripts/tx-reject-oracle.ts`: **31 of 31 byte-identical** — all inputs spent (MEMPOOL text), bad
inputs, missing vkey witness, fee too small, value not conserved, expired, not yet valid, output
too small, three multi-failure combinations, wrong network (output, body id, withdrawal), required
signer, max tx size, metadata hash / metadata missing, invalid signature, stake key already
registered, delegation of an unregistered key, native script not satisfied, extraneous script,
supplemental datum + script integrity hash (with preimage), too many collateral inputs, collateral
with tokens, reference-script fee, no collateral / insufficient / total mismatch / script-locked
collateral, execution units too big. Through the whole wire path (`scripts/n2c-mempool-harness.ts`
serving Gerolamo's N2C hosts), `cardano-cli conway transaction submit` prints the same error text
against both sockets for 31 of 31 cases. Not byte-compared (no safe way to provoke them, or
Gerolamo cannot reproduce the payload): phase-2 script failures (the ledger's
`ValidationTagMismatch` carries the evaluator's debug text and script arguments; ours carries
plutusEval's note), MissingRedeemers, GOV failures, treasury value mismatch, withdrawal amount
(IncompleteWithdrawals) and DRep delegation of *registered* reward accounts, pool / DRep /
committee certificate failures, OutsideForecast, bootstrap attribute size, wrong-era submissions,
a full mempool. Those are still rejected (the block rules' verdict is carried as a
ConwayMempoolFailure text) but not in the ledger's encoding.

## Bug 136 — the mempool validated nothing and relays never pruned it (2026-09-28, fixed)

LocalTxSubmission and HTTP stored anything that parsed; inbound node-to-node tx-submission checked
parse and hash; only the block producer swept stale entries (`txSanity`, bug 110), so a relay
re-announced transactions long on chain or double-spent to its peers indefinitely. Now
`src/mempool/ValidatingMempool.ts` admits a transaction only if it applies to the ledger at the
tip ticked to the next slot (as cardano-node: validity intervals are judged at tip + 1) *after*
every queued transaction in order — their spent inputs are gone, their outputs spendable, their
certificates applied. Phase 1 is `conwayMempoolRules.ts` (the ledger's rule structure) together
with the node's block rules on the same inputs (`evaluateTxRules`, which runs alonzoRules, and
`checkCertificateSequence`); a block-rule failure the structured pass does not model still rejects.
Signatures and phase 2 (plutusEval's `shadowEvaluateTx`, a `mempoolPlutus` job) run once per
transaction on a dedicated worker. **Phase 2 is report-only**: `mempool-replay.ts --plutus` over the
same blocks had plutusEval judge 498 of 1 093 valid script transactions failing (every one "exceeded
its declared budget" on CPU by 2–4 %, e.g. 24 915 886 vs 24 123 473 declared), so a failing verdict
is admitted and counted (`/metrics mempoolValidation.phase2.failed`); `mempool.rejectFailedPlutus:
true` makes it strict once the evaluator agrees with the chain (same for `rejectUncheckedPlutus`). Every chain change
(block adopted: `emitTip`; rollback: `afterRollback` → `emitChainChanged`) re-applies the whole
mempool with the cached verdicts (cardano-node `syncWithLedger` / `reapplyTx`): included
transactions go (all inputs spent), so do transactions a block invalidated or whose interval
passed; after a rollback the rest is re-validated and, like cardano-node, transactions of the
rolled-back blocks are not re-added. The forger takes `snapshotForBlock(slot)`: the mempool
re-applied at the forge slot, cut to the block's byte / execution-unit / reference-script
capacity (the producer's own sweep and `txSanity` remain for a node without it). N2N inbound
transactions and HTTP / mini-Blockfrost submissions go through the same admission. Capacity is
cardano-node's: 2 × (maxBlockBodySize − 1024) bytes, each transaction counted as sizeTxF + 4.
False rejections: `scripts/mempool-replay.ts` re-validates the valid transactions of the last 40
immutable chunks plus the volatile files of node 3036 (read-only; inputs from the blocks
themselves and the explorer DB), each against its pre-block state at its block's slot: **3 853
transactions, 0 rejected** (3 466 skipped: an input outside the 2 000-chunk look-back that the
explorer row cannot reproduce — it keeps no reference-script bytes). Stake-registration and
withdrawal checks are inactive in that replay (no historical registration state). The first run rejected one — a guardrail-script proposal (redeemer purpose
5) — which is fixed (voting and proposing purposes, proposal policy scripts). Latency
(`scripts/mempool-bench.ts`, 300 chained signed transactions): admission p50 2.0–2.3 ms, p90
2.9–3.1 ms with the signature worker (the main thread's share is phase 1, 0.7–2.4 ms per real
preview transaction in the replay); re-applying 300 queued transactions on a new tip 74–100 ms
(0.25–0.33 ms each, signatures and scripts not re-run); worst event-loop stall 4 ms during
admission and 8–9 ms during a revalidation (it yields every 4 ms of work, and every admission
yields once before it starts). `/metrics` → `mempoolValidation`.

## Bug 137 — LocalTxMonitor answered in the library's format, not cardano-node's (2026-09-28, fixed)

MsgReplyNextTx sent bare transaction bytes (cardano-node: `[6, [6, #6.24(tx)]]`), MsgHasTx compared
against whole-transaction hashes, MsgAcquired carried the tip slot (cardano-node: the snapshot's
slot, tip + 1), MsgReplyGetSizes reported a 256 KiB capacity and store bytes (cardano-node: 2 ×
(maxBlockBodySize − 1024) and Σ sizeTxF + 4), MsgAwaitAcquire answered at once instead of when the
snapshot changes, and MsgGetMeasures (N2C v20+) did not exist. The host now has its own codec over
the validating mempool's snapshot; MsgReplyGetMeasures is `[12, txCount, {text: [size, capacity]}]`
with `ex_units_memory`, `ex_units_steps`, `reference_scripts_bytes`, `transaction_bytes` in that
(Map) order. Byte-identical to the preview relay for GetSizes and GetMeasures (empty mempool: the
relay's mempool stayed empty through a multi-hour poll every 2 s); cardano-cli 11 decodes
Gerolamo's replies with a transaction queued (`query tx-mempool info` 1 tx, 228 bytes;
`next-tx` prints the body-hash id), and `info` / `next-tx` print identically against both sockets
when both are empty.

## Bug 138 — ledger-ts drops `total_collateral`, so its check never ran (finding, open)

`ConwayTxBody`'s constructor guards the field with an inverted condition
(`if (!(totCollateral === undefined || canBeUInteger(totCollateral)))`), so `body.totCollateral`
is always undefined and alonzoRules' `total_collateral ≠ collateral − return` check (and db.ts's
collateral pot, which then uses consumed − returned) never sees the declared value. The mempool
reads key 17 from the body bytes (IncorrectTotalCollateralField byte-identical to the relay).
Fixing ledger-ts (or reading the bytes in alonzoRules) is left to the rules owner: the check must
be replayed before it can be strict.

## Bug 139 — txRules sizes reference scripts by their whole `[lang, bytes]` CBOR (finding, open)

The ledger's `txNonDistinctRefScriptsSize` counts `originalBytesSize` — the Plutus binary (the
bytestring payload) or the timelock's bytes. txRules adds `referenceScriptCbor.length / 2`, five
bytes more for the captured 14 144-byte script (fee 212 235 vs the ledger's 212 160). Harmless
while `REF_SCRIPT_FEE_VERIFIED` keeps that check report-only; the mempool computes it the
ledger's way (the relay's FeeTooSmallUTxO minimum reproduced exactly).

## Bug 140 — Plutus shadow jobs on workers use preprod slot geometry (finding by reading, open)

`runBlockRulesJob` never calls `setEpochNetwork` (only the header job does), so a validation
worker keeps the module default `preprod` and plutusEval's `shelleyStartSlot()` — the system start
of the script context's POSIX validity range — is preprod's on preview and mainnet. Scripts that
read the validity range would disagree with the chain. Not reproduced; the mempool's Plutus job
sets the network explicitly.

## Bug 141 — withdrawal redeemer indexes follow the wire order (finding, unverified)

The ledger orders a transaction's withdrawals by `AccountAddress` (network, then the credential
with `ScriptHashObj` *before* `KeyHashObj`, then the hash); canonical CBOR orders the map by bytes,
which puts key accounts (`e0…`) before script accounts (`f0…`). alonzoRules and plutusEval index
Rewarding redeemers by the wire order, so a transaction withdrawing from a key and a script account
at once would get the wrong index (a false "extra redeemer" failure in the block rules). The mempool
uses the ledger order. No such transaction was found to confirm it.

## Bug 142 — txRules treats the validity upper bound as inclusive from Allegra on (finding, open)

`evaluateTxRules` fails a transaction as expired only when `slot > ttl`. From Allegra the ledger's
`inInterval` requires `slot < invalid_hereafter` (only Shelley's TTL was inclusive), so a block
carrying a transaction at exactly its `invalid_hereafter` slot passes Gerolamo's block rules while
cardano-node rejects the block — a missed rejection, not a false one. The mempool's own check is
exclusive (unit test "the validity upper bound is exclusive"; the relay's OutsideValidityIntervalUTxO
reproduced byte for byte). For the rules owner: make the bound exclusive for era ≥ 3 after a replay.

## Bug 143 — the mempool handed the Plutus evaluator the wrong network name (fixed, integration 2026-09-29)

Phase 2 in the mempool is now strict (`mempool.rejectFailedPlutus` default on). The mempool path passed the
mainnet/testnet address flag as the slot-geometry network; "testnet" normalises to preprod, so on preview every
script context carried a validity range computed from preprod's system start. 2 of 20 valid script transactions
(slots 124016238, 124016250) were judged failing while the block path passed them with their declared units. The
old shadow wrapper ignored the field, which is why this surfaced only with the new evaluator (bugs 200–214).
Fixed in `src/mempool/plutusJob.ts` by passing the geometry name and calling `checkMempoolTxPhase2`. Replay of
1 137 preview script transactions through the mempool path: 0 disagreements, 0 unchecked; phase 1: 4 051
transactions, 0 false rejections. Unchecked transactions (missing script or builtin) are admitted and counted but
never forged. CollectErrors rejections are carried as MEMPOOL text, not the ledger's per-redeemer payload.

## Bug 144 — the block path took the Plutus geometry name from `config.network` (fixed, integration 2026-09-29)

Same confusion as bug 143 on the block side: `blockRulesPure` passed `ctx.config.network` to phase 2, which is the
address flag ("testnet") in the offline replay harnesses and absent in a node's config.json. "testnet" normalises
to preprod, so the from-genesis UTxO replay (scripts/utxo-rules-replay.ts) reported 6 valid V2 transactions at
slots 1 184 573–1 193 537 as "budget exceeded" (scripts that loop on a wrong validity range). The live node was
not affected — its rules jobs carry `network: getEpochNetwork()` — but the check now reads `getEpochNetwork()`
directly, which the worker pins from the job, and the replay script calls `setEpochNetwork`.

## LocalStateQuery parity with cardano-node 11.0.1 (2026-09-28, bugs 185–190)

Every Conway `BlockQuery` of ouroboros-consensus-cardano 3.0.1 (tags 0–39) is answered from the
acquired ledger state (`src/network/n2c/lsq/`: `view.ts` acquire and frozen read view, `queries.ts`
encoders, `govIndex.ts` governance facts from the chain, `govAdapter.ts` the one reader of gov-store
keys, `txOut.ts` the ledger's output forms), plus QueryAnytime GetEraStart. Verified on preview
against the relay with `scripts/n2c-compare.ts` (both sides acquire the same block): 59 of 61
answers byte-identical at the tip and at a point 250 blocks back, including GetGovState (1.4 MB)
except one value, GetDRepState (1.26 MB), GetFilteredVoteDelegatees (2.8 MB), GetDRepDelegations,
GetProposals, GetRatifyState, GetCommitteeMembersState, DebugChainDepState, GetLedgerPeerSnapshot
(all / big / legacy), GetPoolState, GetStakeDistribution2; 2 004 sampled UTxO outputs identical by
TxIn. The acquire failures and the connection drop on undecodable queries match. cardano-cli 11
against `scripts/lsq-host.ts` (this build serving node 3036's stores read-only): tip,
protocol-parameters, stake-distribution, stake-address-info, gov-state, drep-state, committee-state,
constitution, treasury, utxo, stake-snapshot, pool-params, pool-state, spo-stake-distribution,
proposals, ratify-state, future-pparams, stake-pools, ledger-peer-snapshot, era-history,
protocol-state print the relay's output exactly; `drep-state --include-stake` differs by bug 185.
Not served at the time (the connection was closed with a log line): DebugEpochState,
DebugNewEpochState, GetRewardInfoPools, GetNonMyopicMemberRewards for a non-empty set, the top-level
DebugLedgerConfig, and GetRatifyState / GetGovState / GetFuturePParams while an action is ratified
and not yet enacted — all served since bugs 260–266 (2026-10-01). GetUTxOWhole is served (preview: 650 MB, 72 s, 2.4 GB anonymous memory) but was not
compared whole with the relay, to spare it.

## Bug 185 — the DRep stake distribution missed refunded proposal deposits (found 2026-09-28, OPEN, governance)

GetDRepStakeDistr at preview epoch 1435: drep b25d7204… 939 611 081 113 here, 940 611 081 113 on
cardano-node, the only difference among 3 055 DReps. Proposal e6ed8d65…:0 expired at the 1435
boundary and its 1 000 ADA deposit went back to 104b7df2…, whose vote is delegated to b25d7204…. The
relay's distribution counts it (as the account's reward balance: the DRep pulser is set up after the
EPOCH rule returned the deposits); here the proposal no longer counts as a live deposit and the refund
is credited only afterwards (`applyBoundaryCredits`, bug 95's ordering, right for the pool SNAP), so it
counts nowhere. Treasury withdrawals are presumably affected the same way (not observed yet).
Consensus-relevant: the ratification tally uses this distribution. Not fixed here (governance area):
take the DRep snapshot (`takeDRepStakeSnapshot` in `ratifyForNext`) after the boundary credits, or add
the pending refunds to it, and replay the boundaries with refunds before making it strict.

## Bug 186 — LocalStateQuery answered from the tip whatever was acquired, and answered unknown queries (2026-09-28, fixed)

MsgAcquire of any point on the chain was acknowledged and every query then answered from the tip;
[10] / [11] (ImmutableTip) were not parsed at all (the library knows only [0, p] / [8]); an unknown or
unsupported query got an empty list (cardano-cli fails to decode it). Now: VolatileTip, ImmutableTip
(the ledger store's anchor) and any block of the selected chain within the ledger store's volatile
diffs are acquired as frozen views (LMDB + the chain's diffs down from that block, rebuilt after a
promotion); other points fail as LedgerDB's `openStateRefAtTarget` does — slot below the anchor
PointTooOld (whatever the hash), else PointNotOnChain. An undecodable query (unknown tag, wrong
arity, a Conway-only query for an earlier era) closes the connection, as cardano-node's codec
failure does. sqlite mode keeps no history: only the tip can be acquired, an older point is
PointTooOld.

## Bug 187 — N2C answers over 64 kB corrupted the mux framing (2026-09-28, fixed)

The library multiplexer writes a message as one segment and masks its length to 16 bits, so any
LocalStateQuery answer above 65 535 bytes carried a wrong length header followed by the whole payload
(GetGovState 1.4 MB, the vote delegatee map 2.8 MB). Answers are now sent in 12 288-byte segments.

## Bug 188 — pool parameters and pool distributions not in the ledger's bytes (2026-09-28, fixed at encoding)

GetPoolState(all) differed for one pool: the stored parameters are the certificate's bytes, and it
wrote the margin unreduced (0 / 1000000; the ledger answers 0 / 1) and the relay list
indefinite-length. `normalizePoolParams` re-encodes both. GetPoolDistr / GetPoolDistr2 / the ledger
peer snapshot lacked the 36 pools the `set` snapshot lists at zero stake (delegators with nothing):
zero-stake pools are recorded only for snapshots taken from 2026-09-29 on; for older snapshots they
are now derived from the pools registered at the snapshot with a delegation today (exactly the 36 for
epoch 1434). GetStakeDistribution2 is the *current* stake over the circulation (not the set
snapshot), pools with delegators and no stake included.

## Bug 189 — UTxO answers in the wrong output form and key order (2026-09-28, fixed)

GetUTxOByAddress / GetUTxOByTxIn wrote every output in map form, sorted the entries by the
"txid:ix" string (index 10 before 2) and always used a definite-length map. The Conway ledger writes
an output without inline datum or script as [address, value] (with a datum hash
[address, value, hash]), orders entries by TxIn (id, then index number) and uses an indefinite map
beyond 23 entries.

## Bug 190 — sets, maps and lists in LocalStateQuery answers (2026-09-28, fixed, encoding notes)

cardano-node writes the same Haskell type two ways depending on the encoder: `EncCBOR` (the era's
results) uses definite length up to 23 elements and indefinite beyond for maps, sequences and sets
(tag 258); cardano-binary's `ToCBOR` (GetStakePools, the op-cert counter map of DebugChainDepState,
the ledger peer snapshot) writes sets and maps definite at any size and lists indefinite. Map keys
follow the key type's `Ord`: a `Credential` puts script hashes before key hashes, a `DRep` orders
key, script, abstain, no confidence. Recorded in `src/network/n2c/lsq/cborWriter.ts` and
`queries.ts`.
## Bugs 170–184 — UTXO / UTXOW / LEDGER / BBODY parity with cardano-node 11 (2026-09-28, fixed)

Semantics and protocol-version gates were taken from cardano-ledger master (Babbage and Conway
`Rules/Utxo.hs`, `Rules/Utxow.hs`, `Rules/Ledger.hs`, `Rules/Bbody.hs`, `TxCert.hs`, `Tx.hs`,
`UTxO.hs`; Alonzo `Rules/Utxo(w).hs`; Shelley `Rules/Ledger.hs`; ouroboros-consensus
`Protocol/Praos.hs`). Each check is one function in `src/consensus/rules/ledgerChecks.ts` (the
mempool reuses them); failures are named after the ledger constructor. Proof:
`scripts/utxo-rules-replay.ts` rebuilds UTxO, pools, stake registrations and DRep delegations from
genesis over node 3036's immutable chunks (read-only) and runs the full body rules on every block
(signatures taken as verified, no Plutus, no reward balances). Run of 2026-09-29 (3 h 52 min, RSS
≤ 1.6 GB with the UTxO set in a scratch SQLite file): **4 707 894 blocks, 6 935 607 transactions,
genesis → slot 124 018 519 (the immutable tip), Alonzo 13 012 blocks / 4 txs, Babbage 2 330 997 /
4 820 144, Conway 2 363 885 / 2 115 459 (PV 9, 10 and 11), 241 phase-2-invalid txs — zero
failures.** Coverage of the new rules in that run: 1 125 977 txs with reference scripts (largest
179 414 B per tx, 430 197 B per block), 4 txs with an input also referenced (all outside PV 9–10),
294 616 withdrawals under PV ≥ 10 (4 523 key accounts, 290 093 script), 1 551 260 txs with
auxiliary data, 859 110 with witness datums, 2 240 187 collateral returns, 5 283 bootstrap outputs,
1 022 592 script-witness txs, 15 629 DRep registrations, 7 198 deregistrations, 70 vote and 495
propose redeemers, 495 guardrail-guarded proposals, 17 `current_treasury_value` claims; the
opcert counter rule held on all 4 707 894 headers (0 too small, 0 over-incremented). Remaining
reports: 4 613 duplicate list-form redeemers (Map.fromList, known) and the 17 treasury claims
(treasury not modelled by the script).

- **170** The reference-script fee priced each reference script by its whole `[lang, bytes]`
  wrapper; the ledger's `txNonDistinctRefScriptsSize` uses `originalBytesSize` of the `Script`
  (Plutus flat bytes, a native script's own CBOR). Too many bytes → a fee "below minimum": the
  15 reports of 2026-09-23 (preview slots 123 476 723–123 477 466) and txpath's 212 235 vs 212 160
  (txpath bug 139). `refScriptOriginalSize`.
- **171** An input listed both as spent and as reference input was priced twice (the ledger
  takes `refInputs ∪ inputs`, a set). `txRefScriptsSize`.
- **172** Not checked: Conway LEDGER `ConwayTxRefScriptsSizeTooBig` (200 KiB per phase-2-valid
  tx), BBODY `BodyRefScriptsSizeTooBig` (1 MiB per block, every tx; up to PV 10 measured against
  the block-start UTxO, from PV 11 earlier txs' outputs — collateral return for an invalid tx —
  count too, `totalRefScriptSizeInBlock`), BBODY `HeaderProtVerTooHigh` (mainnet only).
  `BlockRefScriptSize`, `checkHeaderProtVer`.
- **173** Not checked: `BabbageNonDisjointRefInputs` — `disjointRefInputs` enforces
  inputs ∩ reference inputs = ∅ for `pvMajor > 8 && pvMajor < 11` only, i.e. protocol 9–10; PV 11
  lifts it again. `checkDisjointRefInputs`.
- **174** `BadInputsUTxO` covered spent inputs only; the ledger requires collateral inputs from
  Alonzo (`txins ∪ collateral`, with or without redeemers) and reference inputs from Babbage
  (`allInputs`) to exist. `checkBadCollateralAndRefInputs`.
- **175** The ex-unit fee was `Math.ceil` over doubles, which overshoots by one at integer
  boundaries (10 000 mem + 430 000 000 steps at 577/10⁴, 721/10⁷: 31 581 instead of 31 580 — a
  false rejection of a tx paying the exact minimum). Prices are now read back as the exact
  decimal they stand for (`rationalOf`) and `txscriptfee` / `tierRefScriptFee` are computed in
  rationals. `minFeeTx`, `scriptExecutionFee`, `tierRefScriptFeeExact`; `REF_SCRIPT_FEE_VERIFIED`
  is now true.
- **176** Certificate deposits in the balance came from the certificates' own fields (Conway
  reg/reg-deleg, DRep registration); the ledger (`conwayTotalDepositsTxCerts`) takes `keyDeposit`
  and `drepDeposit` from the protocol parameters, refunds a deregistration by the deposit held
  (`keyDeposit` when registered earlier in the same tx), a DRep deregistration by its own field,
  and charges `poolDeposit` once per new pool even when a tx registers it twice.
  `certDepositsAndRefunds` (the held deposit is `keyDeposit` until the store keeps per-account
  deposits: `keyDeposit` never changed on preview, preprod or mainnet).
- **177** `maxValSize` was loaded but unused: `OutputTooBigUTxO` (ledger serialisation of each
  output value ≤ 5 000 B, Alonzo+; Babbage+ the collateral return too). The collateral return also
  escaped the min-UTxO (`BabbageOutputTooSmallUTxO`) and network rules. `serializedValueSize`,
  `checkOutputsTooBig`.
- **178** Not checked: `OutputBootAddrAttrsTooBig` (bootstrap address attributes ≤ 64 B:
  derivation-path payload + unknown attributes), `WrongNetworkWithdrawal`.
- **179** From Allegra the validity upper bound is exclusive (`inInterval`: `slot < ttl`); a tx
  in exactly its ttl slot was accepted (Shelley keeps `ttl ≥ slot`). Same finding as txpath bug
  142. `checkValidityInterval`.
- **180** Withdrawals: (a) Conway PV ≥ 10 (`unless hardforkConwayBootstrapPhase`, i.e. not PV 9)
  every key-hash reward account must be DRep-delegated in the state before the tx's certificates
  (`ConwayWdrlNotDelegatedToDRep`); script accounts exempt. (b) The account must be registered
  (`Shelley/ConwayWithdrawalsMissingAccounts`), also judged before the tx's certificates in every
  era — preview slot 3 836 003 tx 42 withdraws 0 from a script account and deregisters it in the
  same tx. (c) Reward-account keys were untyped for script accounts: ledger-ts decodes both kinds
  with a `StakeKeyHash` credential and marks scripts only in the address `type`, so
  `typedCredHexOf` fell back to the bare hash and balance lookups missed script accounts
  (`rewardAccountKey`). The block inputs now carry DRep delegation and registration of the
  withdrawn accounts (`drepDelegatedFor`, `stakeRegisteredFor`), advanced across in-flight
  blocks by the overlay and across earlier txs of the block.
- **181** UTXOW: `ExtraneousScriptWitnessesUTXOW` (up to Alonzo witness scripts = needed; from
  Babbage witness = needed − reference scripts), `NotAllowedSupplementalDatums` (a witness datum
  no Plutus-locked input needs must be an output's datum hash — Babbage: collateral return and
  reference inputs' outputs too), the guardrail script named by a ParameterChange /
  TreasuryWithdrawals proposal is a needed script, and voting (tag 4, voters in the ledger's
  `Map Voter` order) and proposing (tag 5) redeemers are matched to Plutus voters / proposals
  (`GOV_REDEEMERS_STRICT = false`: report-only until more script votes are replayed — strict since bug 277).
- **182** `ConwayTreasuryValueMismatch` (`current_treasury_value` = the epoch's treasury) is
  checked against the local pots, report-only (`TREASURY_VALUE_STRICT`): the pots are not yet
  proven exact against the reference node. (Strict on an exact ledger store since bug 273.)
- **183** OCERT: `CounterTooSmallOCERT` (n < m) is strict. Praos `CounterOverIncrementedOCERT`
  (n > m + 1, Babbage+) and the m = 0 default for a pool without a counter are evaluated and
  reported only: headers are checked before the blocks between our tip and them are applied, so
  a pool that rotated its certificate twice inside that window would be rejected though valid.
  σ stays report-only (open item 3). `opcertCounterVerdict`. (Both strict on an exact ledger store since
  bugs 275 and 276.)
- **184** Not checked: `MissingTxBodyMetadataHash`, `MissingTxMetadata`, `ConflictingMetadataHash`
  (blake2b-256 of the auxiliary data's original bytes) and `InvalidMetadata` (text / bytes ≤ 64 B,
  PV > 2). ledger-ts keeps no slice for some auxiliary-data forms (preview slot 2 032 466 tx 1, an
  Allegra `[metadata, scripts]` array), which also left those txs' minimum fee unchecked ("tx size
  unknown"); the entries are now sliced from the block bytes (`blockAuxDataBytes`).
- Also (txpath bug 138): ledger-ts drops `total_collateral` (body key 17), so
  `IncorrectTotalCollateralField` never ran; it is read from the original body bytes
  (`bodyUintField`).

### Conway predicate checklist (cardano-ledger master constructors)

UTXO (`ConwayUtxoPredFailure`): UtxosFailure — Plutus phase 2, shadow only (open item 1) ·
BadInputsUTxO ✓ (174) · OutsideValidityIntervalUTxO ✓ (179) · MaxTxSizeUTxO ✓ · InputSetEmptyUTxO ✓ ·
FeeTooSmallUTxO ✓ (170, 171, 175) · ValueNotConservedUTxO ✓ (176) · WrongNetwork ✓ (177) ·
WrongNetworkWithdrawal ✓ (178) · OutputTooSmallUTxO ✓ · OutputBootAddrAttrsTooBig ✓ (178) ·
OutputTooBigUTxO ✓ (177) · InsufficientCollateral ✓ · ScriptsNotPaidUTxO ✓ · ExUnitsTooBigUTxO ✓ ·
CollateralContainsNonADA ✓ · WrongNetworkInTxBody ✓ · OutsideForecast — cannot fail (the rule
extends the epoch info linearly from the current slot, `unsafeLinearExtendEpochInfo`) ·
TooManyCollateralInputs ✓ · NoCollateralInputs ✓ · IncorrectTotalCollateralField ✓ (138) ·
BabbageOutputTooSmallUTxO ✓ (177) · BabbageNonDisjointRefInputs ✓ (173).

UTXOW (`ConwayUtxowPredFailure`): InvalidWitnessesUTXOW ✓ · MissingVKeyWitnessesUTXOW ✓ ·
MissingScriptWitnessesUTXOW ✓ · ScriptWitnessNotValidatingUTXOW ✓ (native) ·
MissingTxBodyMetadataHash / MissingTxMetadata / ConflictingMetadataHash / InvalidMetadata ✓ (184) ·
ExtraneousScriptWitnessesUTXOW ✓ (181) · MissingRedeemers / ExtraRedeemers ✓ (spend, mint, cert,
reward; vote and propose ✓ since 277) · MissingRequiredDatums ✓ · NotAllowedSupplementalDatums ✓
(181) · PPViewHashesDontMatch / ScriptIntegrityHashMismatch ✓ · UnspendableUTxONoDatumHash ✓
(report when the script's language is unknown) · MalformedScriptWitnesses / MalformedReferenceScripts
✗ (Plutus deserialisation per protocol version; Plutus area).

LEDGER (`ConwayLedgerPredFailure`): ConwayCertsFailure / ConwayGovFailure — certificate and
governance rules (certificateRules.ts, governance/) · ConwayWdrlNotDelegatedToDRep ✓ (180) ·
ConwayTreasuryValueMismatch ✓ on an exact store (182, 273) · ConwayTxRefScriptsSizeTooBig ✓ (172) ·
ConwayMempoolFailure — mempool only · ConwayWithdrawalsMissingAccounts ✓ (180) ·
ConwayIncompleteWithdrawals ✓ on an exact store (272).

BBODY (`ConwayBbodyPredFailure`): WrongBlockBodySizeBBODY / InvalidBodyHashBBODY ✓ (header/body
validators) · TooManyExUnits ✓ · BodyRefScriptsSizeTooBig ✓ (172) · HeaderProtVerTooHigh ✓ mainnet
(172).

## Bug 166 — stale DRep votes from before bug 156 on the running nodes (2026-09-29, fixed by a one-time repair)

Found by the lsq agent's live byte-compare of node 3036 against the relay: `GetProposals` /
`GetGovState` differed in one place, a DRep vote by e8cfbc95… on 56348457…:0 that the relay does not
hold. Koios `drep_updates`: the DRep registered on 2026-09-29 (tx 44755cd3…), deregistered three
minutes later (80cb01f9…) and registered again a minute after that (18e7bca6…), while the build
before bug 156 ran, which kept an unregistering DRep's votes; the re-registered DRep has a delegator,
so RATIFY would have counted a vote the ledger discarded. Both preview nodes' stores carry it; a
fresh sync would not.

The ledger's vote semantics (cardano-ledger-conway 1.22.1 `Rules/Gov.hs`): a vote replaces the voter's
earlier vote on the action; after a transaction's votes are in, the DRep votes of every DRep its
certificates unregister are removed from every live action (`cleanupProposalVotes`, also when the same
transaction registers it again). Nothing else removes a vote — a committee member's resignation or
expiry and a pool's retirement leave their votes in the state (`Ratify.hs` skips them at tally time),
and a vote leaves only with its action at a boundary.

Fix: `govVotesRepair.ts` recomputes the votes of the live proposals from the node's own chain (the
selected chain from the first slot of the oldest live proposal's epoch to the tip, chunk store and
volatile files, `govTxDecode`) with exactly those rules, and deletes, adds or rewrites stored votes so
they equal the result. It runs once per store from the same hook as the credential migration (inside
the first Conway block a restarted node applies, before the block's own transactions; the block is
not on the walked chain yet): SQLite marker `gov_votes_repaired_v1`, LMDB `gov_state.credSchema` = 2.
`scripts/gov-votes-repair.ts --node <dir> --dry-run` prints the plan for a node's stores read-only.
Unit test `govVotesRepair.test.ts` (removal through re-registration, same-transaction unregistration,
script DReps by type, resignation / retirement / dead actions unchanged, the plan, a SQLite store).

Dry run against node 3036 (2026-09-29, read-only, 6.1 s): 15 live proposals, 80 616 blocks walked
from slot 121 824 000 to 124 074 915, 1 177 transactions with certificates or votes — one change:
`REMOVE 5634845753337bc2bd7c3146c65a30940a9f2f80da84be388142fb941dec41e5:0 DRep key
e8cfbc95aca05eb2591f0bb6a9121354e318194e6210a2c892764608 vote 1 (stored at slot 124039523)`, no
additions, no other differences. The producer's store (still on the build before bug 156): that
removal and one more on the same proposal, DRep e11ab000…, which voted in the same transaction and
deregistered on 2026-09-30 01:15 UTC (tx 17b10ad1…) — after node 3036 had restarted with the fixed
build at 01:02 UTC, so 3036 dropped that vote itself and only the producer kept it.

## Bug 167 — the node-to-client governance answers were derived from the live state, not from the DRep pulser's frozen snapshot (2026-09-29, fixed)

Ground truth (cardano-ledger-conway 1.22.1 `Governance.hs`, ledger-api `Query.hs`): the pulser is
set up at the start of every epoch with a copy of the live proposals (votes included), the DRep
distribution it computes for them, `vsDReps` and the pool distribution, and that copy is frozen
until the next boundary. `queryProposals` (GetProposals, 31) answers from it (`psProposals`),
`queryDRepStakeDistr` (26) from `psDRepDistr`, and `queryGovState` (24) embeds the pulser with its
snapshot. So after DRep e11ab000… voted on 56348457…:0 before the 1436 boundary and deregistered
after it, the relay keeps the vote in 31 / 24 (and the DRep in 26) for the rest of epoch 1436 while
its live `cgsProposals` no longer hold it — and after e8cfbc95…'s vote was removed before the
boundary (bug 166) it is in neither. Ours rebuilt the pulser part from the live proposals (votes
filtered by slot) and today's DReps, so 24, 26 and 31 differed from the relay's for the epoch.

RATIFY itself was right: `ratifyForNext` runs at the boundary, and `gatherRatifyInput`
(ratifyInputs.ts) takes the live proposals and their votes as they stand at that moment (after the
boundary's removals, before any block of the new epoch), the DRep distribution `takeDRepStakeSnapshot`
computes at the boundary (`epoch_drep_stake`), the DRep expiries stored then, the mark pool snapshot
plus proposal deposits, and the committee state — exactly `finishDRepPulser`'s inputs; only the
proposals-with-votes and DRep states were not kept for the queries (790 preview epochs verified against
Koios, bug 150).

Fix: `govPulser.ts`. At every boundary `ratifyForNext` stores the round's proposals with their full
CC / DRep / SPO vote maps, the DRep distribution (zero entries included, as `computeDRepDistr` lists
every DRep someone delegates to), the DRep states (raw expiry, deposit, delegators) and the pool
distribution as the epoch's frozen snapshot (`gov_pulser`, four parts per epoch, DRep states binary;
SQLite `gov_pulser_snapshot`; pruned with the retention window). Queries 24 (pulser part), 26, 30
and 31 answer from it (`queries.ts` `pulserOf`; DRep anchors from the gov index as of the boundary
block), falling back to the former derivation for epochs without one. A restarted node whose
boundary ran before this build backfills the current epoch once (`backfillPulserSnapshotOnce`, the
migration hook): proposals and votes from the chain up to the epoch's first slot (bug 166's rules),
the DRep distribution from the boundary's `epoch_drep_stake`, and the DRep states, delegations and
pool delegations from the ledger store's view at the last block before the epoch — exact while that
block is within the volatile window (k blocks, ≈ 2.4 h on preview), else from today's state
("backfill-approx", the epoch's registrations and re-delegations leak in). `scripts/gov-pulser-backfill.ts
--dry-run` prints the reconstruction for a node read-only; `scripts/lsq-host.ts` with
`GEROLAMO_LSQ_PULSER_BACKFILL=1` serves it in memory for a node that has not restarted yet. Tests
`govPulser.test.ts` (store round trip, boundary snapshot contents, backfill from a pinned view).

Dry run against 3036 (2026-09-30 01:50 UTC, read-only): `epoch 1436 (backfill-exact; boundary block
124070374 85d249cd9135c38c…): 15 proposal(s), 3057 DRep distribution entr(y|ies), 9164 DRep state(s),
681 pool(s)`; the one difference from the live proposals: `563484575333… drep e11ab0000138456d2f71e12
7992503df016c33b5728903956bae0d6b vote 1: in the epoch's snapshot, not in the live proposals`.
`scripts/n2c-compare.ts` through `scripts/lsq-host.ts` on 3036's stores against the relay, both at
block 124075095:06f9f738…: `[24] GetGovState` 1 421 441 B, `[26] GetDRepStakeDistr(all)` 113 900 B,
`[26] (some)`, `[31] GetProposals(all)` 4 767 B, `[31] (some)`, `[32] GetRatifyState` — 6 of 6
byte-identical (before the fix: 24, 26(all) and 31(all) differed by exactly e11ab000…'s vote and
distribution entry).

Also checked: the pre-repair votes a compare saw for ~30 s after bug 166's repair ran are not a
stale read view. The repair is written inside the block that runs it (the LMDB diff of that block,
so a rollback undoes it), and a LocalStateQuery client that acquired the block *before* it — the
tip at that moment, since a block commits after its apply — correctly sees the state without the
repair until it re-acquires; the relay at the same block never had the vote. Views are cached per
acquired block and rebuilt when the anchor moves; no invalidation is missing.

## Bug 168 — rules workers pinned to preprod's clock: a valid preview block rejected by phase 2 (2026-09-30 01:19 UTC, node 3036, fixed)

Block 36613e98… (slot 124075124, one V2 transaction, on the chain) failed `plutus phase 2 ValidationTagMismatch: is_valid = true but redeemer 0:0 (V2) budget exceeded [cpu 855634542/585654985, mem 491745/1874286]` and halted the sync. Offline reproduction (`src/consensus/__fixtures__/plutus-preview-124075124-0.json`: the raw block, its seven inputs from Koios `utxo_info`, epoch-1436 parameters): with preview's slot→POSIX clock the transaction passes spending exactly the declared units (585 654 985 / 1 874 286); with preprod's clock it reproduces the live numbers to the unit. The script derives a step count from the validity range (`interestMultiplierFromRate called with timeSteps = 2` vs `−4619` in its trace): 9.2 Ms into the past it loops until the budget is gone — the bug 143/144 class.

Cause: `src/config/preview/config.json` (and preprod's) say `"network": "testnet"`; the blockRules job alone carried `config.network = this.config.network` while every other job carries `getEpochNetwork()`; the worker pins its geometry with `setEpochNetwork(job.config.network)`, and `normalizeEpochNetwork` maps any name it does not know to **preprod**. Every rules worker on a preview node therefore ran with preprod's clock; the shadow evaluator had the same defect (the "exceeded its declared budget" shadow warnings of 2026-09-26/28 on this node are the same class), and it only surfaced as a halt once phase 2 became enforcing.

Fix: the rules job carries `getEpochNetwork()` (ConsensusOrchestratooor); workers accept only a network the geometry table knows (`pinJobNetwork` in validationJob.ts, warns once and keeps the current geometry otherwise) — both header and rules jobs; `slotToPosixMs` (rules/phase2.ts) likewise ignores an unknown name instead of normalising it to preprod. Tests (`src/consensus/plutus/phase2.test.ts`): the block passes with preview's clock at the exact units, preprod's clock reproduces the rejection, `"testnet"` keeps the active clock, and a rules job naming `"testnet"` does not re-pin the worker.

## Bug 237 — the producer forged an Alonzo-tagged block in Conway: hard-fork history "ready" with only the config's eras (2026-09-30 03:32 UTC, producer, fixed in integ)

The preview producer's leader block at 03:32:04 UTC failed its own `adoptLocalBlock` ("header does
not parse: Invalid CBOR format for AlonzoHeaderBody", 0 tx): `startBlockProducer` took the era from
the new ledger-driven hard-fork history (bug 233), which on both Mithril-bootstrapped nodes knew only
Byron..Alonzo (the `Test*HardForkAtEpoch 0` eras of preview's config) and yet answered as complete.
Root cause, in order: (1) `attachBlockStore` resolved the history against `getChainTipFromHeader()`
— but it runs before `setNodeBlockStore`, so the global getter read the SQLite `blocks` table, which
is empty in `blockStoreMode: primary`, and returned null; (2) `resolveEraStarts` treated a missing
tip as "nothing to reach" and set `ready = true` without running the block-store search or the
built-in fallback (neither log line exists in either node's log); (3) `installHardForkHistory` had
already persisted the five config eras to `hfc-eras.json` at startup, so every restart reloaded the
same incomplete history. `scripts/hfc-compare.ts` passed because it passes the relay's era as the
tip, and the LSQ interpreter fell back to the built-in table when `currentEra()` did not match.
Fixes: the tip for the resolution comes from the attached store itself (`blockReads.getChainTipFromHeader(store)`);
the history is ready only through `markReady(tipEra)` (known eras reach the tip block's era tag) and is
never ready without a tip; the tip block's era tag is recorded as a floor (`noteTipEra`) and
`eraOfSlot` never answers below it at or after the tip; `hfc-eras.json` is written only once ready
and carries `complete: true` — the files both nodes hold (five eras, no flag) are ignored on load;
the block-store search reports eras already in progress at the store's first block as unknown
instead of dating them from that block; producer and tx-submission era come from `eraIndexAt`
(history if ready, tip era tag, built-in table — the highest wins, capped at Conway). With their
full chunk stores both nodes will resolve Byron@0 Shelley@0 Allegra@0 Mary@0 Alonzo@0 (config),
Babbage@3 and Conway@646 (block store, first block of the era), tip era Conway → block era tag 7,
tx-submission era 6 — as before the regression. Tests in `hfc.test.ts` (Conway-only store, the
live nodes' incomplete file, a custom network without fallback, the forging era).

## Bug 245 — after the 2026-09-30 reboot the producer halted on every restart: a promoted block's diff file survived the crash and the recovery picked a tip whose chain was broken below it (2026-09-30 17:04 UTC, producer, fixed in integ)

The laptop rebooted at 17:04:44 UTC with both preview nodes running; 3036 (lmdb, SQL writes off)
came back, the producer (lmdb, SQL writes still on) halted at 17:06:25 and again at 17:12:02 after
the watchdog restart ("the selected tip … does not reach the anchor through the 436 / 466 volatile
diff(s)"). Its log stops at 16:52:34 and its tip stopped at slot 124 131 151 (= 16:52:31), so the
machine was wedged for 12 minutes before the reset; whatever was still in the page cache then never
reached the disk.

Found in a copy of the halted store (483 diff files, anchor `2f7cc00d…` @ 124 119 870): every file
decodes completely (no torn or partial diff), every tip in the log walks down through all its
diffs — and the oldest diff is the **anchor block's own** (`2f7cc00d….diff`, written 13:44:30 UTC
when the block was applied), whose parent `13c11caf…` was promoted long ago and has no diff. All 44
of its writes are already in LMDB (18 hold the after-image, 26 deleted keys are absent, none holds
the before-image): the last promotion before the wedge committed to LMDB (`mdb_txn_commit` fsyncs)
but the `rmSync` of the promoted block's diff — a directory update that only the journal carries —
was lost. `chainReachesAnchor` walked through the anchor's diff to the missing parent and said
false; `chain()` also kept that diff in the read overlay, where its 6 u64 adds (stake balances,
fee pot, blocks made) would have been counted a second time on top of LMDB.

Why the recovery did not help: the bug-129 fallback took the newest block of the block store's
chain that the ledger store *had a diff for* (`knows`), which was the tip itself (c9775388 @
124 131 151, then 8ff35711 @ 124 131 924) — "moved back" to the same slot — and the first range's
`ledgerAfterRange` re-ran the real check and halted. A second, smaller hole: the persisted
selected tip is rewritten in place (`Bun.write`), so an empty file after the crash dropped the
"persisted tip" candidate silently and the startup tip came from the SQLite journal (harmless here
because SQL writes were still on; on 3036 that source is frozen). Meanwhile each short run let the
block store promote (immutable tip 124 119 870 → 124 120 601) while the ledger anchor stayed.

Fixes (`src/ledger/LedgerDiff.ts`, `LedgerStore.ts`, `nodeLedgerStore.ts`, `src/network/peerManager.ts`,
`src/storage/blockReads.ts`): diff files are `LDF2` — body + `u32 length | u32 crc32` trailer — and
`decodeDiff` is strict (bounds-checked, trailer verified, no bytes past the body; `LDF1` files
from before still load when fully consumed), so a file cut short or zero-filled by a crash is
absent; `saveDiff` writes temp → fsync → rename (`GEROLAMO_LEDGER_DIFF_FSYNC=0` skips the fsync)
and a leftover `.tmp` is swept at open; a diff of a block at or below the anchor is ignored and
removed at open (`staleDiffs`, logged), and `chain()` never walks through the anchor; the startup
fallback is `LedgerStore.recoveryTip`: the newest block of the block store's chain (volatile chain
plus its immutable tip as the last candidate) whose diffs reach the anchor, with `chainGap`
naming the missing link in the warning; the persisted tip is written temp + rename. Tests in
`LedgerStore.test.ts`: trailer/legacy decoding, a kill between the block store's commit and the
diff write, a truncated diff and a stray `.tmp`, a persisted tip two blocks past the diffs (and a
gap below → the anchor), and the incident itself (promoted diffs re-appearing: dropped, no double
counting, the next promotion clean). Live repair of the producer: the store was being rebuilt from
SQLite; for a node without SQL writes the fix alone recovers it (the stale anchor diff is removed at
open and the chain reaches the anchor).

## Bug 246 — a dual-mode rebuild from SQLite did not reproduce the LMDB governance state (2026-09-30, fixed)

After the 17:04 UTC reboot the producer ran in dual mode and `rebuildFromSqlite` rebuilt its LMDB
store from its SQLite ledger; the dual verifier saw 0 differences (it compares LMDB with the SQLite
it was built from) while `n2c-compare` against the relay at 23:41 UTC found 55 of 61 identical.
`scripts/gov-store-compare.ts --node …mithril` (read-only: the SQLite governance tables copied to a
scratch file, the seed run on the copy, the result compared with the node's LMDB) names the three:

1. **GetDRepState (25), expiries +11.** `gov_dreps.expiry_epoch` is NULL on 8 980 of the producer's
   9 165 rows (rows from before bug 102, epoch ≤ 1414); the seed copied the NULL and every reader
   derived `last_active + drep_activity` with today's 31, where the ledger stored `last_active +
   drep_activity in force then` (20 before preview epoch 964: DRep 01186e32…, last active 646, relay
   666, ours 677). Node 3036's store came from a NewEpochState and holds the ledger's values. Only
   DReps last active before 964 differ, all expired under both rules: RATIFY's active set is the same
   (a NULL row last active at e ≥ 964 derives e + 31 = the ledger's value, preview having had 0
   dormant epochs at every checked boundary). Fix: `govStoreSync.ts` `legacyDRepExpiry` (the
   parameter history in `epoch_params`), applied by the seed to NULL rows and, once, to both stores
   by `migrateDRepExpiryOnce` (`gov_drep_expiry_v1`, `credSchema` 3).
2. **GetCommitteeMembersState (27), 8 rows vs 3.** The producer's `gov_committee_auth` still holds the
   8 rows bug 160's boundary pruning removes (its 1436 boundary ran on the old build; 3036's store
   was imported with the chain's 3); the 5 extra are authorisations of cold keys that are not
   members, reported as Unrecognized. No effect on RATIFY (the tally counts members only); the 1437
   boundary prunes them in both stores.
3. **GetGovState / GetDRepStakeDistr / GetProposals (24, 26, 31).** The epoch-1436 pulser snapshot was
   in the SQLite mirror (`gov_pulser_snapshot`, written by the producer's earlier restart) but the
   seed never read it back, and in dual mode neither the boundary write nor the backfill ran (they
   used the lmdb-only read accessors), so the rebuilt store answered from the live state — without
   e11ab000…'s frozen vote. No effect on RATIFY (the round is tallied from live data at the boundary).
   Fix: the seed imports the mirror (and `gov_drep_boot_delegs`), the snapshot writers read the
   store through the block's writers in dual mode too, and `credSchema` comes from
   `schema_migrations` so a rebuilt store does not re-run the migrations.

Test `govStoreSync.test.ts`: a store written in dual mode (genesis seeding, committee, DReps, a
legacy NULL-expiry row, delegations, a proposal with votes, a pulser snapshot, the migration) and a
store seeded from its SQLite mirror hold byte-identical governance databases.

Producer, read-only, 2026-09-30 23:55 UTC (`gov-store-compare`): gov_dreps 9 165 rows, 8 980 changed
(the NULL expiries); gov_pulser 0 in LMDB, 4 keys SQLite-derived (epoch 1436); gov_constitution_anchor
1 only in LMDB (the raw backfill, not mirrored — rebuilt from the chain after any rebuild);
delegations, committee, auths, state, proposals, votes, enacted, DRep stake, parameters and nonces
equal. RATIFY at the 1437 boundary is unaffected by all three.

## Bug 247 — the boundary-written pulser snapshot left the zero-stake pools out of its pool distribution (2026-10-01, fixed)

Node 3036 crossed into epoch 1437 on bug 167's code and the first snapshot `snapshotAtBoundary`
wrote (rather than the backfill) differed from the relay in `GetSPOStakeDistr(all)` (30; ours 24 906 B,
relay 26 022 B) and in the pulser part of `GetGovState` (24): the relay lists 36 pools more. They are
exactly the stake snapshot's pools whose delegators hold nothing (`snap_pool_zero`, bug 188's
`snapshotZeroPools(1437)`: 36 pools, all registered, none retiring; e.g. 045e7dd9…, 06e8504b…,
1d6e46e4…). The ledger's `calculatePoolDistr'` (cardano-ledger-core 1.22.1 `State/SnapShots.hs`) lists every
pool of the stake-pool snapshot with `spssNumDelegators > 0`, its stake `spssStake` — 0 when the
delegators hold nothing; `setFreshDRepPulsingState` copies that `ssStakeMarkPoolDistr` into the
pulser (`dpStakePoolDistr`, later `psPoolDistr`) and `addToPoolDistr` adds proposal deposits to pools
already in it. The boundary path took `gatherRatifyInput`'s distribution — the snapshot's non-zero
sums plus deposits — while the backfill (`poolDistrOf`) added the zero-stake pools, which is why
epoch 1436's backfilled snapshot was byte-identical. 36 entries × 31 bytes = the 1 116-byte gap.
No effect on RATIFY (a zero-stake pool adds nothing to the SPO total), except the edge case of a
proposal deposit whose return account delegates to such a pool: the ledger counts it, the round
did not — now included (`gatherRatifyInput` lists the zero-stake pools before the deposits).

Fix: `completePulserPoolDistr` (govPulser.ts) adds the snapshot's zero-stake pools (with any live
deposit landing on them) and stamps `version` 2; `snapshotAtBoundary` and the backfill write
version 2; the query layer completes a version-1 snapshot on read, and `fixPulserPoolDistrOnce`
(the migration hook) rewrites every stored version-1 snapshot at the next restart — on 3036 and on
the producer, which wrote its own 1437 snapshot in dual mode. Test in `govPulser.test.ts` (a
zero-stake pool in the boundary snapshot; completion of a legacy snapshot, deposit included,
idempotent). Verified with `scripts/lsq-host.ts` on 3036's stores read-only against the relay, both at
block 124157487 (epoch 1437): `[24] GetGovState` 1 421 725 B, `[26]`, `[30] GetSPOStakeDistr(all)`
26 022 B, `[30] (pools)`, `[31]`, `[32]` — 6 of 6 byte-identical.

## Bug 308 — verification against the relay during the soak was manual (2026-10-01, fixed: continuous verification in the watchdog)

Bugs 246 and 247 were found by running `scripts/n2c-compare.ts` by hand: the dual-mode rebuild's
own check compares LMDB with the SQLite it was built from, so a store that disagrees with the
network passes it, and a boundary-written snapshot is only wrong after a boundary. The watchdog
watched liveness, halts, lag, KES, leader-slot outcomes and the public port, nothing about state.
Now (`scripts/lib/parityProbe.ts`, `scripts/parity-probe.ts`, wired into `scripts/watchdog.ts`,
documented in `scripts/watchdog/README.md`), for every node with an N2C socket:

1. **parity** — the n2c-compare query set (moved to `scripts/lib/n2cCompare.ts`, shared with the
   CLI) on the node and on the relay at one acquired block, every 30 min and, after each epoch
   boundary, from +3 min until a run has acquired a block of the new epoch; GetUTxOWhole and the
   two debug dumps skipped by default. A query that differs in two consecutive runs alerts, naming
   it with sizes and the first differing byte; a clean run sends "OK again". Not run on a producer
   within 180 s of a leader slot, nor on a node more than 10 min behind.
2. **schedule** — `cardano-cli conway query leadership-schedule --current` on the relay socket (the
   producer config's `vrfSkeyFile` passed as a path; only slot numbers are kept) against
   `/metrics producer.leaderSlots`, once per epoch and after each producer restart; every tick then
   compares the producer's live schedule with that answer.
3. **forge** — each forged block whose outcome the producer has settled against the relay's chain
   (N2C ChainSync `FindIntersect` at our block, once the relay is 15 min past the slot, re-checked
   for 36 h): `adopted`/`confirmed` must be on it, `ghosted`/`stolen` must not.

The tick only reads `parity-history.json` (atomic replace) and starts the probe detached under a lock
file when a check is due: a tick stays at ~80 ms. An unreadable history keeps the open parity
problems instead of clearing them. Also fixed in the oracle tooling: a differing answer waited 3 s
after its last attempt (every DIFF cost 3 s in n2c-compare), and `scripts/lib/lsq.ts` `close()` sent
MsgDone while still acquired — valid only in StIdle, so the relay logged a `DecoderFailure …
(SingAcquired) unexpected key (7, 1)` for every oracle connection (150 of the 856 DecoderFailures in its log); it now sends
MsgRelease first (0 such lines from the probe since).

Verified 2026-10-01 01:45 UTC (scratch config, read-only N2C and cardano-cli against the running
nodes): producer 61 of 61 and node 3036 61 of 61 byte-identical at block 124163052 (one block on
both sides, ~4 s each); epoch 1437 schedule cardano-cli [124191912, 124223229, 124232541] = producer;
forged slot 124117188 `confirmed` and on the relay's chain; a watchdog tick with an empty history
started the probe detached (18.5 s, lock released), the next tick started nothing; a crafted
history with `[30] GetSPOStakeDistr(all)` differing in two runs raised the alert and a clean one the
"OK again". Tests `scripts/lib/parityProbe.test.ts` (fake N2C sockets speaking handshake,
LocalStateQuery and ChainSync; a fake cardano-cli): 15 cases.
## Bugs 272–277 — the balance-dependent ledger rules and the σ / counter header rules made strict (2026-10-01)

Six checks were report-only because the state they read was not proven exact: withdrawal amounts
(`WITHDRAWALS_STRICT`), `current_treasury_value` (`TREASURY_VALUE_STRICT`),
`StakeKeyHasNonZeroAccountBalanceDELEG`, the σ leader threshold, `CounterOverIncrementedOCERT` and
the voting / proposing redeemers (`GOV_REDEEMERS_STRICT`). Both preview nodes now run an LMDB store
imported from a Mithril NewEpochState. Audit of the validation path in lmdb mode: every reward
balance, registration, DRep delegation, pot and stake-snapshot read goes through the store —
`rewardBalancesFor`, `stakeRegisteredFor`, `drepDelegatedFor`, `localTreasury`, `registeredPools`
(db/rulesQueries.ts), `buildGovLedgerView` and `readRewardPots` (governance), `poolStakeForEpoch` and
`opcertCounterState` (headers); workers get the maps from the main thread; the SQLite branches run only
in sqlite / dual mode. The mempool's own lookups (mempool/ledgerViewDb.ts) are outside this change.

**272 — withdrawal amounts.** (a) Within a block every transaction was compared with the balance
before the block: a second withdrawal from an account an earlier transaction of the block had emptied
was reported against the old balance (and a second full withdrawal passed). The block now keeps a
running copy of the balances and empties each valid transaction's withdrawn accounts (`drainAccounts`).
(b) lmdb mode is not enough: a store seeded from SQLite carries SQLite's balances. The producer's store,
rebuilt from SQLite in dual mode on 2026-09-30, reported `withdrawal 19105183 ≠ local reward balance
19105182` (slot 124 157 182) and `638220378 ≠ 638220367` (slot 124 161 011) before it was replaced with a
copy of 3036's at 01:21 UTC; the same blocks pass on 3036's store. The store now records its provenance
(meta `ledger_source`: "snapshot" from importLmdb.ts, "sqlite" from the SQLite seed); a store without the
key counts as an import when the pots' initialized epoch equals the governance seed epoch (both preview
stores: 1420; the producer's old store: 0 and 647). `ledgerStateExact()` (nodeLedgerStore.ts) is true
only in lmdb mode on a snapshot import; the rule fails the block then (`ConwayIncompleteWithdrawals`,
before PV 11 `WithdrawalsNotInRewardsCERTS` / `…DELEGS`) and otherwise reports with the reason
(`(report-only: ledger store mode sqlite)`, `… seeded from SQLite`, `… not imported from a snapshot`).

**273 — `current_treasury_value`.** Strict on an exact store, in txRules.ts and in the governance
LEDGER copy (govRules.ts), which had been strict in every mode; both report with the reason otherwise.

**274 — `StakeKeyHasNonZeroAccountBalanceDELEG`.** Strict when the governance view's balances are
exact (`CertLedgerView.balancesExact`).

**275 — σ.** The value is the ledger's `individualPoolStake` = `spssStake / ssTotalActiveStake` of
the epoch's distribution (`nesPd`: the snapshot taken at the start of the previous epoch;
cardano-ledger-core 1.22.1 `calculatePoolDistr'`), compared with the Praos threshold by the ledger's
Taylor comparison (leaderMath.ts). Open item 3's reports came from SQLite snapshots a few ppm off, not
from the comparison; strict on an exact store, reported with the reason otherwise.

**276 — `CounterOverIncrementedOCERT`.** Headers were judged against the applied tip's counters, which
lag a header checked ahead of apply. `LeaderChecker` now records every validated header (parent,
issuer, counter; VRF-deferred headers too: their opcert is verified) and evaluates the rule against the
counter state as of the header's parent on its own chain (`counterAsOf`): walking back from the parent,
the first block the store holds answers from the store's state after it (`LedgerStore.viewAt` /
`knowsHex`: the anchor or any volatile diff, whatever the selected tip), a validated header of the same
pool on the way answers with its counter. `CounterTooSmallOCERT` reads the same state. The
over-increment fails the header when that state is found and the store is exact; otherwise it is
reported (tip counters, the old slot guard). Stale counters are the second reason for the exactness
gate: the producer's SQLite-seeded store held 520 for pool a8e65680… (set at slot 123 968 361) and
reported 525 at slots 124 133 758 / 124 134 759 (2026-09-30 17:57 UTC) as over-incremented, while the
chain stepped through every counter (replay below).

**277 — voting / proposing redeemers.** Phase 2 evaluates both purposes (plutus/context.ts: voter /
proposal by redeemer index, the V3 Voting / Proposing script purposes); the UTXOW match (alonzoRules.ts)
orders voters as the ledger's derived `Ord Voter` (committee < DRep < pool, script before key, then
the hash bytes). `GOV_REDEEMERS_STRICT = true`.

Verification (all read-only):
- `scripts/reward-accounts-compare.ts`: every registered stake credential of the store (111 805), query
  10 in 56 batches, byte-identical with the preview relay on both nodes at block 124 163 389;
  `scripts/n2c-compare.ts --only …`: GetAccountState, GetFilteredDelegationsAndRewardAccounts,
  GetStakeSnapshots (snapshots 1435–1437), GetPoolDistr / GetPoolDistr2 (epoch 1437), DebugChainDepState
  (the opcert counters) — 14 of 14 (3036) and 11 of 11 (producer) byte-identical at block 124 163 340.
- `scripts/ledger-rules-shadow.ts` (body rules as the validator gathers them, governance rules, view
  pinned to each block's parent, the epoch's first block judged after the boundary): 3036 432 blocks
  (slots 124 151 954–124 163 597), 414 transactions, 128 withdrawals from 13 accounts, 0 failures;
  producer 432 blocks, 122 withdrawals, 0 failures; the producer's pre-transplant store: not exact, its
  two drifted withdrawals reported, not failed. Neither window held a treasury claim or a deregistration.
- `scripts/balance-history-check.ts` over 3036's epochs 1421–1437 (balances rebuilt from the chain and
  the payouts the store recorded): 49 988 blocks, 46 188 valid transactions, 40 328 withdrawals —
  40 247 checked (81 first withdrawals after the import have no rebuilt balance): 40 246 equal, 1 equal
  to the rebuilt balance plus a 500 ADA pool-deposit refund, 0 mismatches; 40 deregistrations, the 32
  of tracked accounts at 0. Treasury claims: none since the import; all 17 since the Conway hard fork
  (epochs 646–1437, 2 120 187 valid transactions) equal the treasury recorded for their epoch.
- Node 3036's own log since 2026-09-14 (59 process starts; a process logs its first 20 body-rule and
  header-rule reports, and none exceeded 15): no withdrawal, treasury, deregistration-balance, σ or
  counter report.
- `scripts/header-rules-replay.ts` over the whole preview chain (4 713 292 headers, 155 s): the counter
  rule along the chain 0 failures; the node's mechanism with the store 500 headers behind (everything
  in between only validated) gives the chain's counter for 4 713 285 headers, 0 differences, 7 with no
  state (the first after Byron). σ with exact snapshots (3036's store, epochs 1419–1437; a store imported
  at slot 122 316 253, epochs 1414–1416): 65 550 headers, 0 failures; the producer's SQLite-derived
  snapshots equal them pool for pool (epochs 1414–1437) and clear all 89 528 headers of 1408–1437.
- `scripts/gov-redeemers-replay.ts`: every Conway transaction with a script voter, a guarded proposal or
  a tag 4/5 redeemer — preview 500 (103 script votes, 33 native; 70 vote and 495 propose redeemers, 98
  at a non-zero index), preprod (cardano-node db to slot 133.5 M) 500 (464 script votes, 30 native; 431
  vote redeemers, 3 in multi-voter transactions at a non-zero index; 93 propose, 54 at a non-zero
  index): 0 match messages; preview phase 2 equal to is_valid on all 467 with redeemers.

Not covered: the zero-balance deregistration and the treasury claim were not met inside the volatile
windows (only through the rebuilt balances and the recorded pots); a node synced from genesis in lmdb
mode (no snapshot import) keeps the five balance and header checks report-only until such a run is
proven exact. Tests: `withdrawalBalances.test.ts`, `ledgerSource.test.ts`, `leaderCheck.test.ts`
(σ strictness, counters as of the parent across validated headers and forks), `govRules.test.ts`,
`alonzoRules.test.ts` (voter order).
## Bugs 260–266 — the LocalStateQuery answers that still closed the connection (2026-10-01, fixed)

Before this round a node answered 61 of the 61 compared queries byte-identically with the cardano-node
11.0.1 relay, but closed the connection on GetNonMyopicMemberRewards [2] for a non-empty set,
DebugEpochState [8], DebugNewEpochState [12], GetRewardInfoPools [18], the top-level
DebugLedgerConfig, and GetRatifyState / GetGovState / GetFuturePParams between a boundary that
ratifies an action and the one that enacts it. The ledger state they need is now kept (bugs 262,
263) or derived (264, 266). Sources: cardano-ledger tag cardano-ledger-conway-1.22.1.0
(cardano-ledger-shelley 1.18: PoolRank.hs, Rewards.hs, RewardUpdate.hs, LedgerState/PulsingReward.hs,
Rules/Rupd.hs, API/Wallet.hs; cardano-ledger-core State/SnapShots.hs; cardano-ledger-conway
Governance.hs, Rules/Ratify.hs, Rules/Enact.hs) and ouroboros-consensus 3.0.1. Compared with
`scripts/n2c-compare.ts` (now on `scripts/lib/n2cCompare.ts`; the new queries are its `extra` set,
`--huge` for the dumps, `--save` + `scripts/cbor-diff.ts` for a structural diff) through
`scripts/lsq-host.ts` on node 3036's stores read-only, both sides acquiring the same block: 64 of 64
byte-identical at block 124240736 (epoch 1437; the 61 plus DebugLedgerConfig, [2] for coins and
credentials, [18]) and again at 124244059 after the 1438 boundary, the dumps identical but for bug
263's legacy snapshots.

### Bug 260 — DebugEpochState [8] and DebugNewEpochState [12] (served)

`lsq/epochState.ts` rebuilds the ledger's `NewEpochState` / `EpochState` from the acquired view: the
pots, `CertState` (VState: DReps with anchors, deposits and delegators, committee authorisations,
dormant epochs; PState: VRF key counts, pools as `StakePoolState` with their delegators, future
parameters, retirements; DState: accounts with balance, deposit, pool and DRep, genesis delegations),
`UTxOState` (the UTxO map itself empty as under UTxO-HD, deposits, fees, GovState, instant stake,
donations), the mark / set / go snapshots, `esNonMyopic`, both `BlocksMade` maps, the reward update
in progress (bug 264) and the pool distribution. The first build wrote CertState's three parts
without CertState's own list header: a 23 MB item followed by stray items, which a client waits on
forever (found because n2c-compare timed out while the answer was ready in 5 s). Fixed before use.
Preview, epoch 1437, block 124239436 / 124239946: [8] 40 433 444 B vs 40 437 869 B and [12]
46 201 977 B vs 46 206 402 B; `scripts/cbor-diff.ts` finds one difference only, bug 263's
`spssNumDelegators` (155 of 728 pools) and `spssSelfDelegatedOwners` (85 pools: owners delegating
without stake) in the three snapshots, which 3036 took before that was recorded. Everything else —
pots, PState and VState byte for byte, accounts, instant stake, GovState, fees, the nonmyopic state,
`nesRu` (Complete), `nesPd`, blocks made — is identical. The same after the 1438 boundary (block
124244059: [8] 40 434 648 B, [12] 40 500 328 B with `nesRu` SNothing).

### Bug 261 — GetNonMyopicMemberRewards [2] and GetRewardInfoPools [18] (served)

`consensus/nonMyopic.ts` mirrors the ledger's pool ranking in GHC's floating point: `LogWeight` as
32-bit `Float` (every operation rounded with `Math.fround`), samples in `Double` rounded once,
`fromRational` reproduced exactly for bigint ratios (`rationalToDouble`, ties to even), the Beta(40, 1)
prior, `percentile'` at 0.5, `maxPool'`, `calcStakePoolDesirability`, `getTopRankedPools` (stable
sort) and `calcNonMyopicMemberReward`. `lsq/rewardQueries.ts` answers both over the current stake
(`currentSnapshot`: instant stake plus rewards of credentials delegated to a registered pool, every
registered pool) with the epoch's `esNonMyopic` (bug 262). Byte-identical with the relay at block
124237561: [2] for three coin amounts and four credentials 165 992 B, [18] 52 259 B; again after the
1438 boundary (block 124244059: 165 996 B, 52 259 B), the relay's 1437 state advanced in memory over
3036's 1438 boundary records.

### Bug 262 — `esNonMyopic` was not kept (fixed)

The per-pool likelihoods and `rewardPotNM` the ranking needs accumulate over every epoch (each reward
update: 0.9 × the old likelihood + the new one, normalised, for the pools of the go snapshot; others
dropped). Now kept per epoch: LMDB `nonmyopic` (u32 epoch → reward pot, pools × 100 f32), written in
the boundary block's diff and rolled back with it, three earlier epochs kept; SQLite mirror
`epoch_nonmyopic`. `runEpochRewards` advances it at every boundary (`advanceNonMyopic`: the go
snapshot's pools, their blocks in the performance epoch, σ over the circulation, the update's R);
a Mithril import takes it from the snapshot's `NewEpochState`. A store bootstrapped before this has
none: `scripts/nonmyopic-seed.ts --config … --state <cardano-node ledger state file> [--yes]` (node
stopped) reads it from a relay's `db/ledger/<slot>/state` and advances it over the store's own
boundaries; `GEROLAMO_LSQ_NONMYOPIC_SEED=<state file>` does the same in memory for the query layer
(lsq-host). Until then [2] (non-empty), [8], [12] and [18] stay unanswered with a log line.
Verified: the relay's epoch-1436 state advanced over 3036's 1437 boundary records equals the relay's
own 1437 `esNonMyopic` bit for bit (728 pools, reward pot 13 130 493 748 437); unit fixture
`nonmyopic-preview-1437.json` (every pool's 100 floats and performance estimate).

### Bug 263 — stake snapshots kept no delegator counts or self-delegated owners (fixed, exact three boundaries on)

The ledger's `StakePoolSnapShot` keeps `spssNumDelegators` (every delegator, zero-stake ones too) and
`spssSelfDelegatedOwners` (the owners delegating to the pool); the store kept only the stake-holding
credentials. `takeStakeSnapshot` now records both (`snap_pool_meta`, pruned with the snapshot); the
Mithril import writes the node's own. A snapshot taken before counts its stake-holding delegators
(the remaining difference in [8], [12] and the pulser's `PoolRewardInfo`). No effect on rewards:
the owners' stake the pledge check uses is the same.

### Bug 264 — the reward update in progress (`nesRu`) was not modelled (fixed)

`lsq/rewardUpdate.ts`: SNothing until the first block past 4k/f slots into the epoch; then `Pulsing`
(the `RewardSnapShot` — fees, protocol version, `esNonMyopic`, ΔR1, R, ΔT1, every go pool's new
likelihood, the leader rewards — and the RSLP pulser: pulse size ⌈|go stake| / 4k⌉, `FreeVars` with
the registered accounts at the window's first block, the circulation and each block-producing
pool's `PoolRewardInfo`, the stake not yet visited, the accumulated member rewards and the last
pulse's events); `Complete` (ΔT1, −ΔR, every reward as a set per credential — leader rewards first —,
−ΔF, the advanced `NonMyopic`) at the block after the stake is used up or the first past 8k/f. The
number of pulses and the registered accounts at the window's start come from walking the window's
blocks (the gov index's certificate walk, recording each credential's first (de)registration and
undoing it). Verified on preview epoch 1437: `Complete` byte-identical with the relay's ledger-state
snapshot at slot 124226511 (5 701 016 B) and live inside [12]; `Pulsing` at slot 124225609
(9 469 118 B: 1 321 blocks into the window, pulse size 47) identical except bug 263's delegator
counts in 31 `PoolRewardInfo` snapshots. Unit tests in `rewardUpdate.test.ts`.

### Bug 265 — DebugLedgerConfig (top-level [4]) was not served (fixed)

`lsq/ledgerConfig.ts` builds the hard-fork combinator's ledger config from the network's genesis
files: the eight eras' `EraParams` (epoch size, slot length, safe zone, genesis window), Byron's
`Genesis.Config` (boot stakeholders, heavy delegation certificates, start time, non-AVVM balances in
`Ord Address` order, the 14 protocol parameters with the fee policy CBOR-in-CBOR, k, protocol magic,
AVVM balances, genesis hash, RequiresNetworkMagic; definite lengths, as Byron encodes), and per
Shelley-based era the CompactGenesis (GetGenesisConfig's bytes), the `Globals`, the translation
context (Shelley: genesis delegations, parameters, max supply; Alonzo: `AlonzoGenesis` with the V1
cost model as a definite list under today's parameter names — the genesis still says `blake2b-…` and
`verifySignature-…`; Conway: `ConwayGenesis`; Dijkstra: cardano-node 11's built-in genesis) and the
hard-fork trigger (preview: Shelley…Alonzo at epoch 0 from `Test*HardForkAtEpoch`; otherwise at
protocol versions 2, 3, 4, 5, 7, 9; Conway → Dijkstra never without experimental hard forks).
Refused before node-to-client v20 (QueryVersion3), as cardano-node's codec does. Byte-identical with
the preview relay (10 626 B; `ledgerConfig.test.ts` keeps the capture); preprod and mainnet are built
the same way but were not compared (no relay).

### Bug 266 — ratified, not yet enacted: GetRatifyState, GetGovState, GetFuturePParams, GetProposals, GetCommitteeMembersState (fixed)

Between the boundary whose ratification decided actions (the store's `pending` decision) and the
next, `lsq/ratifyView.ts` derives the pulser's `RatifyState`: the enact state the ratified actions
lead to (ENACT in ratification order: ParameterChange applies the update with cost models replaced
per language, HardForkInitiation the protocol version, TreasuryWithdrawals sums per credential,
NoConfidence / UpdateCommittee / NewConstitution), the epoch's previous parameters, treasury 0 (as
RATIFY leaves it), the chain roots, the ratified actions as the pulser's snapshot holds them, the
expiring ids and `rsDelayed`. GetFuturePParams / `cgsFuturePParams` follow `predictFuturePParams`:
potential (the enact state's parameters when a ParameterChange or hard fork is ratified) until two
stability windows before the epoch's end, definite after; GetCommitteeMembersState marks the next
committee's changes (ToBeRemoved, an added member Unrecognized and ToBeEnacted); GetProposals keeps
the ratified actions until the enacting boundary. Offline test `govWindow.test.ts` on preview's
ParameterChange dd4fbc61…:0 (ratified at 1366, enacted at 1367; Koios `proposal_list` and
`epoch_params` 1367 agree): the future parameters are exactly what preview adopted at 1367; plus a
ratified UpdateCommittee and TreasuryWithdrawals. Not observable live today (nothing ratified on
preview); outside the window all five stay byte-identical with the relay.
