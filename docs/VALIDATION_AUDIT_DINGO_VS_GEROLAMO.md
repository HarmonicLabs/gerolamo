# Validation audit: Dingo v0.70.5 vs Gerolamo (from-genesis mainnet), 2026-09-04

Code audit of what each node actually verifies per block and per transaction
when syncing mainnet from genesis with its full-validation settings
(Dingo: `--validate-historical --strict-utxo-validation --block-pipeline-enabled
--block-pipeline-validate-enabled`; Gerolamo: defaults, `bodyValidation` strict).
Paths: `D/` = dingo, `G/` = gouroboros v0.202.5, `Ge/` = gerolamo/src.

## Table

| # | Item | Dingo | Gerolamo |
|---|---|---|---|
| 1 | Prev-hash / slot monotonic | Yes. `D/ledger/state.go:6065`, `envelope_validation.go:118-158` | Partial. Prev-hash contiguity (`Ge/consensus/ConsensusOrchestratooor.ts:1100`, Byron `:506`); slot monotonicity only for Byron |
| 2 | Byron header (EBB, OBFT sig, delegation, 0.22k window) | Yes, when `shouldValidate`. `G/consensus/byron/pbft.go`, `D/ledger/byron_pbft.go` | Yes. `ByronOBFT.ts:validateSignedMainHeader`, `validationJob.ts:110` |
| 3 | Shelley+ header (KES, VRF, leader, opcert) | Yes. `D/ledger/verify_header.go:256,513-530,1040-1110`, `verify_opcert.go:322`, counter `state.go:6135` | Partial. KES + opcert signature yes. **VRF proof result discarded** (`BlockHeaderValidator.ts:176-189`, comment "temporarily only check output match"). **Leader eligibility vacuous**: stake stand-in of 1/genDelegs (`:245-271`). No opcert counter, no registered-VRF-key check. η0 from local evolver or Blockfrost fallback |
| 4 | Body hash | Yes, at decode. `D/ouroboros/blockfetch.go:134` → `G/ledger/shelley/shelley.go:993`, Byron `byron.go:1379` | Yes, on worker before apply. `validationJob.ts:runRangeVerifyJob`, `bodyHash.ts` |
| 5 | Block / tx size limits | Yes (body, header, tx, ExUnits) | Partial. Max tx size only, Alonzo+ |
| 6 | Tx rules | Yes, all eras: inputs exist, no dup, value conservation, min fee, TTL, vkey/bootstrap signatures per input, native scripts, certs, withdrawals, network id, collateral, script-data-hash, redeemers, **Plutus phase-2 (Conway)**. Byron `eras/byron.go:141`. Gap: Alonzo/Babbage-era Plutus txs are refused, not evaluated (`G/ledger/alonzo/rules.go:148`) | Partial, **Alonzo+ only** (`BlockBodyValidator.ts:76`: era < 5 → no rules). Alonzo+: inputs exist, lovelace balance, min fee, validity interval, cert sequence, collateral %, tx size. **No vkey signature verification, no native scripts, no withdrawal balance, no minting policy, no datum/redeemer hash, no Plutus execution** |
| 7 | Ledger state | UTxO, stake, pools, rewards, MIR, pparam updates, Conway governance, epoch rollover computed locally | UTxO, stake, delegations, pool distr; **rewards, pparams, epoch nonces imported from Blockfrost** (`state/blockfrost/*`, `epochParams.ts:121-150`); no reward calc, no governance |
| 8 | On failure | Header: block rejected, peer recycled. Tx: block rejected, rewind, then halt | Header / body hash: peer terminated. Body rules: sync halted. Missing UTxOs during apply are **silently skipped** (`db.ts:1523,1572`) |
| 9 | Extras | Mithril-boundary skip only when a Mithril ledger slot is set (zero on genesis sync); checkpoints | Multi-peer header quorum and outvoting (`CandidateSet.ts`); body fetch from any peer bound by body hash |

## Material differences, most important first

1. **Transaction validation coverage.** Dingo runs the full per-era rule set for every block from genesis. Gerolamo validates no transaction rules before Alonzo and never checks transaction signatures or scripts in any era.
2. **Phase-2 Plutus.** Dingo executes Conway scripts. Gerolamo only decodes UPLC.
3. **VRF and leader eligibility.** Dingo verifies the proof and the stake threshold. Gerolamo computes `proof.verify()` and ignores it, and uses a genesis-delegate stand-in for stake, so any operational-certificate holder passes.
4. **State provenance.** Gerolamo's epoch nonce, protocol parameters and rewards can come from Blockfrost; Dingo derives all of it.
5. **Dingo's own gaps.** Alonzo/Babbage-era Plutus transactions are refused rather than evaluated; leadership stake is UTxO-only per its comment.
6. **Gerolamo's advantage.** Peer quorum cross-check of headers; Byron OBFT comparable to Dingo's.

## Verdict

Not on par. Dingo's genesis sync applies header crypto, opcert, leader
eligibility, body hash, envelope and per-era transaction rules, including
Conway Plutus execution, on every block, and a failure rejects the block and
halts. Gerolamo enforces headers (KES, opcert, Byron OBFT), body hashes and
peer agreement strictly, but its transaction layer is a thin Alonzo+ balance,
fee and certificate check with no signature, script or pre-Alonzo coverage,
its VRF proof and leader checks are effectively no-ops, and key epoch state
may be trusted from Blockfrost. Gerolamo halts correctly on what it checks;
it checks far less. The claim "syncs from genesis with full validation" is
not true of Gerolamo today.

## Peering test side-findings (same day)

Running Dingo and Gerolamo as each other's local roots exposed two Gerolamo bugs:

- **Duplex advertised, not served.** As a relay Gerolamo advertises
  InitiatorAndResponder on the connections it opens, but only runs responder
  protocols on its inbound listener. Dingo started client protocols over the
  duplex link, got nothing, and closed the connection ("chainsync client
  failed on inbound connection, closing to free per-IP slot").
- **Silent primary never replaced.** Gerolamo promoted Dingo (a trustable local
  root) to primary, received no header from it, and stayed at slot 0: nothing
  demotes or replaces a primary that never rolls forward.
