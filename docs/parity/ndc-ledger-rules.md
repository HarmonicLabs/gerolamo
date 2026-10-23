# node-diversity-conformance `ledger-rules` (bugs 530–549)

pragma-org's [node-diversity-conformance](https://github.com/pragma-org/node-diversity-conformance)
site compares node implementations on shared corpora. Scenario `ledger-rules` is 277 fixtures, each
one raw Conway transaction applied to a declared ledger state (UTxO, accounts, pools, DReps,
committee, proposals and their roots, guardrail script, pots) at a point, with the expected outcome
`Pass`, a cardano-ledger predicate failure by constructor name, or a decoding failure.

```
# report (schema_version 1) for the site
bun scripts/ndc/ledger-rules.ts --fixtures <ndc>/scenarios/ledger-rules/fixtures --out gerolamo.json [--verbose]
bun scripts/ndc/validate-report.ts --schema <ndc>/scenarios/ledger-rules/schema.json --report gerolamo.json
# regression test (skipped unless the corpus is present)
NDC_LEDGER_RULES_FIXTURES=<ndc>/scenarios/ledger-rules/fixtures bun test src/conformance/ndc
```

## Result (2026-10-15, corpus `98cc462`)

**276 / 277** fixtures conform. The one that does not:

| Fixture | Expected | Observed | Why |
|---|---|---|---|
| 00074 empty input set | `InputSetEmptyUTxO` | `DecodingFailure` | `ConwayTxBody.fromCbor` (cardano-ledger-ts) rejects an empty `inputs` set ("invalid 'inputs' field"). Conway's CDDL has `0 : set<transaction_input>` (empty allowed; only collateral, reference inputs and required signers are `nonempty_set`), so cardano-ledger decodes it and UTXO fails `InputSetEmptyUTxO`. The fix belongs in cardano-ledger-ts, outside the code this work may change; Gerolamo's own rule (`InputSetEmptyUTxO`, mempool and block path) is in place behind the decoder. |

Before the fixes below the score was 266 / 277.

## How a fixture is run (src/conformance/ndc/ledgerRules.ts)

- **References.** `era_history` and `protocol_parameters` are `$ref`s (`common/<kind>/<file>` resolves
  to `fixtures/<kind>/<file>`) with an optional `$override` shallow-merged over the document.
- **Parameters** become the raw record the rules read (`conwayPParamsToRaw` field names). The corpus
  treats `max_reference_scripts_size` as a parameter (Conway has it as the constant 200 KiB): it is
  passed as `max_ref_script_size_per_tx`, which the mempool now honours (it is Dijkstra's parameter).
- **Time.** The network's system start (preprod 2022-06-21T00:00:00Z) and the fixture's era history
  (one Conway era from slot 0, 432 000-slot epochs, 1 s slots, stability window 129 600) become the
  process-wide `custom` slot geometry for the run; the epoch of the point is the rules' epoch.
- **State.** UTxO entries are decoded with cardano-ledger-ts (`TxOut.fromCbor` + `outputLike`, the
  block rules' conversion); accounts carry their deposit, reward balance, pool and DRep delegation;
  pools, DReps (deposit), committee (cold → term, hot key or resignation), proposals
  (`ProposalKind` → GOV proposal view: `HardFork(M.m)` with its version, `ProtocolParameters(security-group)`
  security-relevant, `ConstitutionalCommittee` an UpdateCommittee, `Orphan` and `Information` an
  Info action), roots, guardrail script and treasury fill the `GovLedgerView`. Balances are exact.
- **Committee members without a term.** The corpus lists some members with no `valid_until`: they may
  authorise a hot key or resign (GOVCERT accepts them) but are not elected (protocol 11 refuses their
  votes). cardano-ledger has exactly one such state: a cold credential that is not in the enacted
  committee but is named by a pending UpdateCommittee proposal (`isPotentialFutureMember`). They are
  carried that way, under a proposal id no transaction can reference.
- **Entry points.** The bytes, untouched, go to `ValidatingMempool.addTx` (MEMPOOL → LEDGER → CERTS /
  UTXOW → UTXO → UTXOS as cardano-node's ApplyTxErr wire CBOR, then GOV / GOVCERT / DELEG / POOL,
  then phase 2 with `rejectFailedPlutus` and `rejectUncheckedPlutus` on), and to the block path
  (the transaction in a one-transaction Conway block through `runBlockRulesJob`,
  `checkBlockGovernance` and `checkCertificateSequence`, as the Blueprint harness does).
- **Names.** The ApplyTxErr CBOR is decoded to cardano-ledger constructor names by wire tag
  (`applyTxErrNames`; LEDGER, UTXOW, UTXO, UTXOS, CERTS ▸ CERT ▸ DELEG / POOL / GOVCERT, GOV, with
  the protocol-11 additions). Governance failures reach the mempool's answer as `ConwayMempoolFailure`
  text that starts with the rule and the constructor (`GOV VotersDoNotExist …`); block-path failures
  are text, mapped by `blockFailureName`.
- **Verdict.** Decoding failure expected: conforms when the bytes do not decode. `Pass` expected:
  conforms when both paths accept. A predicate expected: conforms when it is among the named
  failures of the rejection (cardano-node returns every failure of a rejected transaction, not only
  the first); for `ValidationTagMismatch` the `PassedUnexpectedly` / `FailedUnexpectedly` side must
  match too. The report's `result` is `pass` when the fixture conforms, otherwise the first observed
  predicate (corpus vocabulary), `accepted` for an accepted transaction that should fail, or
  `DecodingFailure`.

Of the 159 expected-failure fixtures that conform, 59 are named by the mempool's structured ApplyTxErr
CBOR, 97 by the mempool's governance text (GOV / GOVCERT / DELEG / POOL / LEDGER constructors), and 3
only by the block path:

- 00050 (unknown spent input): the mempool answers cardano-node's MEMPOOL rule "All inputs are spent.
  Transaction has probably already been included" (no input of the transaction is in the UTxO), as
  cardano-node does; the LEDGER rule (block path) is `BadInputsUTxO`.
- 00072, 00273 (stake registration with a wrong deposit): the mempool stops at its structured phase-1
  failure (`ValueNotConservedUTxO`, the deposit is the parameter's) and only runs DELEG / GOV when phase
  1 passes; the block path names `IncorrectDepositDELEG` too.

In 151 of the 159 the expected predicate is the first failure; in the others another genuine failure
comes first (for example 00148 / 00150 also have an unregistered return account,
`ProposalReturnAccountDoesNotExist`, which cardano-ledger reports as well).

### Corpus vocabulary

The corpus names some constructors differently from cardano-ledger. The decoder speaks
cardano-ledger; `CORPUS_NAMES` maps for the comparison and the report:

| cardano-ledger | corpus |
|---|---|
| `StakeKeyRegisteredDELEG` | `StakeKeyRegistered` |
| `StakeKeyNotRegisteredDELEG` (delegating an unregistered credential) | `StakeCredentialInvalidPoolDelegation` |
| `StakeKeyHasNonZeroRewardAccountBalanceDELEG` / `…AccountBalanceDELEG` | `StakeKeyHasNonZeroAccountBalance` |
| `DelegateeDRepNotRegisteredDELEG`, `DelegateeStakePoolNotRegisteredDELEG` | without `DELEG` |
| `ConwayDRepAlreadyRegistered`, `ConwayCommitteeHasPreviouslyResigned`, `ConwayCommitteeIsUnknown` | without `Conway` |
| `InvalidPolicyHash` | `InvalidGuardrailsScriptHash` |
| `ZeroTreasuryWithdrawals` | `TreasuryWithdrawalsAllZeros` |
| `WrongNetwork` | `WrongNetworkInTxOutput` |
| `MissingVKeyWitnessesUTXOW` | `MissingVerificationKeyWitnessesUTXOW` |
| `UnelectedCommitteeVoters` (protocol 11) | `VotersDoNotExist` (00171) |
| `OutputBootAddrAttrsTooBig` | `OutputTooBigUTxO` (00280: Byron output with 99 bytes of attributes) |

The last two are not spelling: the corpus files a different cardano-ledger constructor under an
existing name. Gerolamo reports the cardano-ledger one; the mapping counts it as the corpus's.

## 530. The mempool answered `FailedUnexpectedly` for a transaction marked invalid whose scripts pass (bug)

**Cause.** `ValidatingMempool` encoded every phase-2 `ValidationTagMismatch` as
`ValidationTagMismatch isValid (FailedUnexpectedly [PlutusFailure …])`. A transaction marked
`is_valid = false` whose scripts all succeed (or that has none, bug 403) is
`ValidationTagMismatch False PassedUnexpectedly` (`[0, false, [0]]`) in cardano-ledger. Verdict
unchanged (rejected); the wire answer and the predicate's description were wrong. Fixtures 00199, 00200.

**Fix.** `UtxosF.validationTagPassedUnexpectedly` (src/mempool/applyTxErr.ts); the mempool uses it
when the transaction is marked invalid.

**Test.** src/mempool/ndcLedgerRules.test.ts "bug 530" (fixture 00200's transaction).

## 531. The mempool ran CERTS and GOV for a transaction marked invalid, and spent its inputs (bug)

**Cause.** Conway LEDGER runs the treasury-value and DRep-delegated-withdrawal checks, CERTS and GOV
only when `isValid == IsValid True`; a transaction marked invalid only forfeits its collateral. The
mempool ran the governance rules (GOV / GOVCERT / DELEG / POOL), the certificate sequence and the
withdrawal-account checks whatever the flag, so a valid phase-2-failing transaction with, say, a
delegation to an unregistered pool was rejected (`DelegateeStakePoolNotRegisteredDELEG`, fixtures 00274,
00275). Its mempool overlay also treated it as a normal transaction: the inputs were spent and the
outputs created for the transactions after it, where the ledger spends the collateral and creates
only the collateral return (index |outputs|); its certificates and withdrawals changed the
registration state and balances later transactions were judged on.

**Fix.** src/mempool/conwayMempoolRules.ts: withdrawal-account checks and CERTS only for
`tx.isValid`. src/mempool/ValidatingMempool.ts: governance only for `tx.isValid` (and only valid
queued transactions as the block prefix); the overlay of an invalid transaction spends the
collateral and adds the collateral return; queued invalid transactions do not register / deregister
credentials or drain balances.

**Test.** "bug 531" ×2: fixture 00274 is admitted; resubmitted after admission it is not "All inputs
are spent" (its input is still unspent) but `BadInputsUTxO` (its collateral is gone).

## 532. The mempool did not check `OutsideForecast` (bug)

**Cause.** Alonzo UTXO `validateOutsideForecast`: a transaction with redeemers whose validity upper
bound the ledger's `EpochInfo` cannot turn into time (past the forecast horizon) fails
`OutsideForecast` before any script runs. The mempool did not model it (it was listed under "not
modelled"); such a transaction went to phase 2 with a script context built from an untranslatable
time (fixture 00088: bound 500 000, horizon 432 000; the script then failed, `ValidationTagMismatch`).

**Fix.** `forecastHorizonSlot` (src/mempool/conwayMempoolRules.ts): the HFC bound of the last era with
no transition known, the first epoch boundary at or after `next(tip) + 3k/f` (ouroboros-consensus
`mkUpperBound` over `slotToEpochBound`, which rounds up), from the active epoch geometry;
`MempoolLedgerState.forecastHorizon` can override it. UTXO fails `OutsideForecast ttl` (wire `[17, slot]`,
`UtxoF.outsideForecast`) right after the validity interval, when there are redeemers and `ttl ≥ horizon`.
With a hard fork already scheduled the real horizon extends into the next era; this bound is then
stricter than cardano-node's (at an era boundary only). The block path does not check it (the block
rules do not know the ledger tip before the block); it can only be laxer there.

Also here (parameterisation, not a bug): `maxRefScriptSizePerTx(raw)` reads
`max_ref_script_size_per_tx` when the parameter record carries it (Dijkstra's parameter; the corpus
sets it to 50 in 00034 / 00055–00057) and Conway's 200 KiB constant otherwise.

**Test.** "bug 532" ×3: the horizon arithmetic (432 000 from slot 0 and 302 400, 864 000 from 302 401,
none without a stability window, 86 400 on preview), fixture 00088's transaction failing
`[17, 500000]`, and the reference-script limit.

## 533. A bootstrap witness with a bad signature was not `InvalidWitnessesUTXOW` in the mempool (bug)

**Cause.** Shelley UTXOW `validateVerifiedWits` fails `InvalidWitnessesUTXOW` with the vkeys of the
vkey witnesses *and the bootstrap witnesses* whose signature does not verify. The mempool collected
only vkey witnesses; a Byron input whose bootstrap witness had the right key, chain code and
attributes but a wrong signature passed the structured checks (the root counts as present, rightly)
and was rejected only by the block rules' text "missing bootstrap witness" (fixture 00079).

**Fix.** `ValidatingMempool.verifyWitnesses`: failing bootstrap witnesses' vkeys follow the failing
vkey witnesses' in `invalidVkeys`.

**Test.** "bug 533": fixture 00079's transaction fails `InvalidWitnessesUTXOW [d59ec5ed…]` and not
`MissingVKeyWitnessesUTXOW`.

## Observed, not fixed

- **Fixed since as bugs 534 and 535 (see VALIDATION_STATUS.md):** the block-path gap below, and the block execution-unit sum that also left out invalid transactions.
- **Block path, transactions marked invalid (was open).** `evaluateShelleyBlockWithInputs` runs only the
  collateral checks (`evaluateAlonzoRules` `collateralOnly`), signature validity and phase 2 for an
  `is_valid = false` transaction. cardano-ledger runs the whole UTXOW / UTXO for it (inputs exist,
  fee, value conservation, validity interval, required witnesses, metadata, outputs, network, size…);
  only LEDGER's treasury / withdrawal checks, CERTS and GOV are skipped. A block carrying an invalid
  transaction that breaks a phase-1 rule would be accepted by Gerolamo and rejected by cardano-node.
  The mempool path checks them (it runs phase 1 whatever the flag). Not changed here: it is the
  live nodes' block validation, and the corpus does not exercise it (every fixture is judged on both
  paths, and the mempool path rejects these). Recommended fix: run `evaluateTxRules` for invalid
  transactions with the withdrawal / treasury / DRep checks off, replayed over the preview history.
- **Block-path naming.** A vkey or bootstrap witness with a bad signature also reads as "missing …
  witness" (the block rules count only verified keys); an `is_valid = false` transaction without
  redeemers also fails "Plutus scripts without collateral inputs" (cardano-ledger checks collateral
  only with redeemers); unregistered withdrawal accounts read `ConwayWithdrawalsMissingAccounts` at
  protocol 10 (cardano-ledger: `WithdrawalsNotInRewardsCERTS`; protocol 11 moved it to LEDGER).
  Verdicts are right; only the extra / mislabelled text differs.
- **Mempool governance failures are text, and only after phase 1.** GOV / GOVCERT / DELEG / POOL /
  LEDGER governance failures reach LocalTxSubmission as `ConwayMempoolFailure` text carrying the
  constructor name, and they are evaluated only when the structured phase 1 passed (cardano-node
  reports CERTS and GOV failures in the same list as UTXOW ones, and structured). Verdicts are right.

## Files

- src/conformance/ndc/ledgerRules.ts — fixture loader (refs, overrides), state and views, both entry
  points, ApplyTxErr / text → constructor names, corpus vocabulary, report.
- src/conformance/ndc/ledgerRules.test.ts — decoder tests; the corpus at ≥ 276 when
  `NDC_LEDGER_RULES_FIXTURES` is set.
- scripts/ndc/ledger-rules.ts — the report CLI; scripts/ndc/validate-report.ts — JSON Schema check
  (the keywords the scenario schemas use).
- src/mempool/applyTxErr.ts, conwayMempoolRules.ts, ValidatingMempool.ts — bugs 530–533;
  src/mempool/ndcLedgerRules.test.ts — their tests.
