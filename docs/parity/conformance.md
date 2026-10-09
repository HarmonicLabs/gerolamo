# Conformance suites (Dingo-parity wave, items 400–419)

Dingo runs two shared corpora: the Cardano Blueprint ledger conformance vectors (through
blinklabs-io/ouroboros-mock) against its validation entry points, and the ouroboros-mock consensus
scenarios against its chain selection and ChainSync server. Gerolamo now runs both in `bun test`.

```
bun test src/conformance            # both corpora (about 12 s)
bun test src/mempool/mempoolConformance.test.ts
```

## Results (2026-10-08)

| Corpus | Entry point | Result |
|---|---|---|
| Blueprint ledger vectors (2 574 txs, 78 parameter sets) | block path: validation worker job, governance, certificate sequence | **2 574 / 2 574** verdicts; 0 resulting-state differences over the 2 408 accepted txs |
| same | mempool admission (`ValidatingMempool.addTx`) | **2 574 / 2 574** |
| ouroboros-mock consensus scenarios (7) | `ChainSelDriver` (praos) + `N2NChainSyncHost` over `ChunkRelayChainStore` | **5 / 7** strict; the other 2 differ only in the final tip, which the capture never served (classified below) |

Per rule family (block path; mempool path identical):

| Spec.Rule | Pass | of which expected rejections |
|---|---|---|
| AllegraImpSpec.UTXOW | 1/1 | 1 |
| AlonzoImpSpec.UTXO | 19/19 | 7 |
| AlonzoImpSpec.UTXOS | 96/96 | 9 |
| AlonzoImpSpec.UTXOW | 219/219 | 43 |
| BabbageImpSpec.UTXOW | 12/12 | 4 |
| ConwayImpSpec.CERTS | 13/13 | 4 |
| ConwayImpSpec.DELEG | 95/95 | 9 |
| ConwayImpSpec.ENACT | 309/309 | 0 |
| ConwayImpSpec.EPOCH | 122/122 | 0 |
| ConwayImpSpec.GOV | 475/475 | 37 |
| ConwayImpSpec.GOVCERT | 42/42 | 8 |
| ConwayImpSpec.RATIFY | 881/881 | 0 |
| ConwayImpSpec.UTXO | 9/9 | 0 |
| ConwayImpSpec.UTXOS | 261/261 | 35 |
| MaryImpSpec.UTXO | 3/3 | 1 |
| ShelleyImpSpec.EPOCH | 1/1 | 0 |
| ShelleyImpSpec.LEDGER | 2/2 | 0 |
| ShelleyImpSpec.UTXO | 2/2 | 1 |
| ShelleyImpSpec.UTXOW | 12/12 | 7 |

Every one of the 166 expected rejections is rejected by a named rule whose message matches the test
(the test asserts no rejection comes from a decode failure). Before the fixes below the block path
agreed on 2 571 vectors, the mempool path on 2 569, and the consensus replay could not parse block 0.

## 405. Blueprint ledger vector harness (feature)

What: `src/conformance/blueprint/` decodes the corpus (`ledgerState.ts`: the May-2025 `LedgerState`
layout, reusing mithril/nesDecoder.ts for the governance parts, `utxohdMemCodec` + `txOutWireCbor`
for the MemPack UTxO) and runs each transaction through the node's own code:

- block path: the transaction's bytes untouched inside a one-transaction Conway block, then
  `runBlockRulesJob` (the validation worker's job: `MultiEraBlock.fromCbor`, witnesses, UTXO/UTXOW/
  UTXOS, Plutus phase 2), `checkBlockGovernance` (GOV, GOVCERT, DELEG, POOL, LEDGER) over a
  `GovLedgerView` of the vector state, and `checkCertificateSequence` (body validator). Inputs are
  filled the way `rulesQueries.ts` / `govLedgerView.ts` fill them (deposits paid not tracked,
  balances exact, treasury unknown);
- resulting state of accepted transactions: UTxO set (refs, values, addresses, datums, reference
  scripts) from `shelleyBlockOverlay`, fee pot (`applyInvalidTransaction` rule for phase-2 failures),
  deposit pot, and the `GovBlockOverlay` effects (accounts, DRep delegations, reward balances, DReps,
  pools, committee hot keys, proposals and their expiry);
- mempool path: `ValidatingMempool.addTx` over a `MempoolLedgerView` of the vector state.

Environment the vectors do not carry (Blueprint exports `LedgerState`, not `NewEpochState`):
- epoch: the latest `proposedIn` of the old/new proposals, and past the expiry of every action the
  serialised DRep pulser has in `rsExpired` (RATIFY expires `gasExpiresAfter < current epoch`);
  ImpSpec start 899 otherwise. Checked: all 277 proposals submitted by the corpus get the ledger's
  exact `expiresAfter`. (ouroboros-mock instead hard-codes 899 plus one exception, 902.)
- slot: the first slot of that epoch; slot geometry of ImpSpec (system start 2017-09-23T21:44:51Z,
  1 s slots, 4 320-slot epochs) as the "custom" network during the run, restored after.
- treasury: unknown, so `current_treasury_value` is report-only here; no vector depends on it.
- MemPack `TxIn`: this cardano-ledger version encodes `TxIx` little-endian; node 11 tables (what
  `decodeTxInKey` reads) big-endian. The harness swaps the two bytes (`nodeTxInKey`).

Tests: `src/conformance/blueprint.test.ts` (archive checksum and counts; both paths; table printed).
Not covered by this corpus: epoch-boundary logic (ratification, enactment, rewards), BBODY limits,
Peras (none in the corpus, as for Dingo).

## 406. ouroboros-mock consensus scenario replay (feature)

What: `src/conformance/consensus/replay.ts`. Every RollForward goes through `headerParser` into
`ChainSelDriver.observe`, every RollBackward into `ChainSelDriver.rollBackward`; when a peer's
trace reaches its tip (the MsgAwaitReply point) the orchestrator's `evaluateChainSel` step runs
(`decide`, adopt "extend"/"switch" candidates header-only, drop punished peers). Switches are
recorded with our previous tip and the candidate's intersection. Downstream: the selected chain as
header-only blocks in a scratch `BlockStore`, served by `N2NChainSyncHost` over
`ChunkRelayChainStore` to a client that intersects where the followed peer's trace starts, until
MsgAwaitReply. Checks are ouroboros-mock's `RunConsensusVector`: final tip, the switch onto the final
tip off a shorter-or-equal peer at the expected rollback point, and the exact downstream messages.

| Scenario | Result |
|---|---|
| exceeds_k_no_switch_v1 | pass (the longer peer forks > k back: fork too deep, no switch) |
| fork_and_select_v1 | pass (switch, rollback to slot 11) |
| slot_battle_v1 | pass (equal length, restricted VRF tie-break, rollback to slot 11) |
| within_k_fork_v1 | pass |
| within_k_fork_winner_first_v1 | pass (no switch needed) |
| intersect_origin_one_rollforward | classified: final tip #1 (slot 3) was never served; the capture stops at #0 |
| intersect_non_origin_v1 | classified: final tip #6 (slot 10) was never served; the capture stops at #3 |

The two classified scenarios report the oracle node's tip although the captured trace stops before
it. A node that selects among received headers cannot end there (Dingo's adapter passes them by
reporting the best peer's *announced* tip instead of its selected chain). For both, the test
requires every other check to pass: our tip is the last served header, and the downstream messages
(RollBackward to the intersection, the RollForward headers and eras) are identical apart from the
advertised tip. A further test proves k is applied: with k = 100 the exceeds-k scenario switches.
Not exercised: header crypto (KES, VRF, opcert; the captures' genesis and stake are not in the
vectors). Dingo's local_tip "k-guard" test does not apply: neither Gerolamo nor ouroboros-consensus
has a tip-plausibility guard.

Tests: `src/conformance/consensus.test.ts`.

## 400. Babbage UTXOW `validateScriptsWellFormed` was not implemented (bug)

What: an output carrying a reference script that does not deserialise
(`MalformedReferenceScripts`), or a witness-set Plutus script that does not
(`MalformedScriptWitnesses`), is a phase-1 failure since Babbage. Gerolamo accepted the first and
gave the second only a phase-2 "no verdict". Vectors `BabbageImpSpec.UTXOW.MalformedReferenceScripts/0`
and `MalformedScriptWitnesses/2` (ImpSpec's `malformedPlutus = "invalid"`).

Fix: `consensus/rules/scriptsWellFormed.ts`, called from `evaluateTxRules` (block rules and, through
them, the mempool) for every Plutus witness script and every output / collateral-return reference
script, at the epoch's protocol version. `phase2.ts plutusScriptMalformed` follows plutus-ledger-api
`deserialiseScript` (plutus master, read 2026-10-08): language available at the protocol version,
one CBOR bytestring (trailing bytes rejected only from V3: `RemainderError`), flat program with the
builtins and constant/constr bounds of that language and protocol version. Evaluation-time checks
are deliberately not applied: the Plutus Core version's availability and term scoping live in
`mkTermToEvaluate`. `decodeProgram` got a `deserialiseOnly` option for that (`constr`/`case` still
need the program's own version ≥ 1.1.0, as in the UPLC flat decoder); phase 2 is unchanged.

Safety measurement: every Babbage/Conway block of the preview relay's immutable chunks (read-only),
4 736 104 blocks, 6 980 670 transactions, 1 041 134 Plutus witness scripts and 59 274 output
reference scripts (87 354 distinct script / protocol-version pairs), checked at the ledger's
protocol version of their epoch: 0 rejections. A first version that also checked the Plutus Core
version flagged 377 V2 reference scripts of version 1.1.0 from protocol 8 (preview slot 51 809 324
on): that is how the evaluation-time / decode-time split was confirmed. 163 scripts using the
secp256k1 builtins in epochs 31–125 decode at protocol 8 only, as expected (Valentine was in force).

Tests: `consensus/rules/scriptsWellFormed.test.ts` (5), the two Blueprint vectors.

## 401. Praos chain selection could not select from the origin (bug)

What: `ChainSel` anchors an empty chain at a stand-in hash (`00…00`), but the first block of a
Shelley-based chain has a null previous hash, and a ChainSync RollBackward to the origin point has
no hash. Both left the peer's fragment detached, so in `chainSelection: "praos"` (and Genesis mode)
nothing could be selected from an empty chain (scenario `intersect_origin_one_rollforward`, and every
captured peer trace, which starts with RollBackward to the origin).

Fix: `ORIGIN_HASH`; a null previous hash extends it, and a hashless slot-0 RollBackward re-anchors at
it while it is in our window. Other hashless rollbacks still detach.

Tests: `chainsel/ChainSel.test.ts` "the origin (bug 401)" (2); the baseline code returns
"no-candidate" for the same input.

## 402. Babbage/Conway headers with a null `prev_hash` did not parse (bug, workaround)

What: ledger-ts 0.5.13's Babbage, Conway and Dijkstra header-body decoders accept only bytes in
`prev_hash` although the CDDL allows `nil` and its own encoder writes it (Shelley–Alonzo accept
both). Block 0 of a chain starting in a Praos era (the captured devnet; any local Conway devnet) was
"invalid cbor for ConwayHeaderBody". Preview, preprod and mainnet are unaffected (their first block
is Alonzo or Byron).

Fix (Gerolamo side): `headerParser` parses such a header with 32 zero bytes in place of the null,
then clears `prevHash` and the cached slices; `header.body.toCborBytes()` (the KES-signed bytes)
re-encodes the null as `f6`, the original bytes (asserted). Only headers with a null `prev_hash`
take this path.

Tests: `consensus/blockHeaderParser.nullPrev.test.ts` (3).
Open: the same decoder failure hits `MultiEraBlock.fromCbor` for that block's body (BlockFetch,
apply); the proper fix belongs in cardano-ledger-ts (sibling repository, not touched here).

## 403. The mempool admitted `is_valid = false` transactions without scripts (bug)

What: the ledger runs UTXOS for every `is_valid = false` transaction; with no script the vacuous
evaluation passes and the transaction fails `ValidationTagMismatch PassedUnexpectedly`. The block
rules reject it ("marked invalid (phase-2) but carries no redeemers"); the mempool skipped phase 2
when there were no redeemers and admitted it (vectors `AlonzoImpSpec.UTXOS.PlutusV{1,2,3}.Valid
transaction marked as invalid/0`).

Fix: `evaluateMempoolPhase1` runs phase 2 for `is_valid = false` whatever the redeemer count.
Tests: `mempool/mempoolConformance.test.ts` "bug 403".

## 404. Mempool withdrawal checks: wrong account for script credentials, amounts never strict (bug)

What: `ValidatingMempool.lookups` asked the store for reward balances by the bare credential hash,
while the rules look a balance up by the typed key ("01" + hash for a script account): the balance of
a script account was read from the key account with the same hash, or reported missing. And the
mempool never passed the store's exactness, so a wrong withdrawal amount
(`WithdrawalsNotInRewardsCERTS`) was admitted even on an exact (snapshot-imported) store, where the
block rules reject it (vectors `CERTS.Withdrawals.Withdrawing the wrong amount/6, /7`).

Fix: typed keys (`rewardAccountKey`, as `shelleyBlockReads`); `MempoolLedgerView.exactness()`
(`ledgerStateExact()` in `ledgerViewDb.ts`) passed to `evaluateTxRules`. The rule is strict exactly
when the block rules' is. A withdrawal by an earlier mempool transaction now drains the account for
the later ones, as the block rules carry it from transaction to transaction (without that, the strict
rule would reject a valid follow-up withdrawal of 0 and admit a second full withdrawal).
`MempoolLedgerView.govLedgerView()` (optional) lets the harness supply the governance state; the
node keeps reading its store.
Tests: `mempool/mempoolConformance.test.ts` "bug 404" (the withdraw-zero trick from a Plutus V2
script account is admitted and its balance read as `01e9cb0f…`), `mempool/mempoolWithdrawals.test.ts`
(2: exact amount, typed key, drained by a queued transaction; the second fails without the drain).

## Files

- New: `src/conformance/{tar.ts, blueprint.test.ts, consensus.test.ts}`,
  `src/conformance/blueprint/{ledgerState.ts, harness.ts}`, `src/conformance/consensus/replay.ts`,
  `src/conformance/__vectors__/` (README, archive 1.78 MB, 7 JSON 312 KB),
  `src/consensus/rules/scriptsWellFormed{,.test}.ts`, `src/consensus/blockHeaderParser.nullPrev.test.ts`,
  `src/mempool/mempoolConformance.test.ts`, `src/mempool/mempoolWithdrawals.test.ts`.
- Changed: `consensus/rules/{txRules,phase2}.ts`, `consensus/plutus/flat.ts` (option only),
  `consensus/chainsel/ChainSel{,.test}.ts`, `consensus/blockHeaderParser.ts`,
  `mempool/{ValidatingMempool,conwayMempoolRules,ledgerViewDb}.ts`, `mithril/nesDecoder.ts`
  (helpers exported, no behaviour change).

## Open

- cardano-ledger-ts: accept a null `prev_hash` in Babbage/Conway/Dijkstra header bodies (402).
- 400 was checked against preview history only; preprod and mainnet chunks were not scanned.
- Epoch-boundary rules are outside this corpus; a NewEpochState-based corpus would be needed.
- Consensus header crypto is not exercised by the scenarios.
