# Dijkstra era and Plutus V4 (workstream 2, items 420–436)

Goal: Gerolamo understands the Dijkstra era (protocol 12) and Plutus V4, inertly until a
Dijkstra era starts on the network, with no behaviour change for Byron..Conway.

## Sources and versions

| Source | Version | Used for |
|---|---|---|
| IntersectMBO/cardano-ledger | tag `cardano-ledger-dijkstra-0.4.0.0` (2026-10-01) and master `5b31cdd` (2026-10-08). The Dijkstra CDDL is byte-identical in both; the Haskell sources quoted below are master. | CDDL, rules (`eras/dijkstra/impl/src/.../Rules/*.hs`), BlockBody, TxBody, PParams, golden `tx.cbor` and `hashtx.hex` |
| IntersectMBO/plutus | master `40b6705` (2026-10-06) | `PlutusLedgerApi.V4`, `Common.Versions`, `ProtocolVersions` (semantics variants), cost model data E, conformance suite (1011 cases) |
| blinklabs-io/gouroboros | `v0.210.0` (the version Dingo pins) | `ledger/dijkstra` decoders, golden tx fixtures, the musashi block fixtures, Leios body rules |
| Dingo | `14f789e` (2026-10-07) | header arity cases, musashi fixtures and genesis files |

The spec is still moving upstream (Leios and Peras fields appeared in the header, the body and
the protocol parameters during 2026). What is stable and implemented: everything in the
0.4.0.0 CDDL. What is still a placeholder upstream (Peras certificate validation, Leios
certificate verification, the PlutusV4 script context) is marked as such below.

## 420. Conway → Dijkstra CDDL diff

Block and header
- `block = [header, block_body]` replaces the segregated
  `[header, tx_bodies, tx_witness_sets, auxiliary_data_set, invalid_transactions]`.
- `block_body = [transactions : [* block_transaction], leios_certificate / nil, peras_certificate / nil]`.
- `block_transaction = [body, witness_set, auxiliary_data / nil, is_valid : bool]` (the
  flag moves to the end and is set by the block producer). There is no `invalid_transactions`
  list any more: a false flag marks a phase-2 failure.
- `block_body_hash` = blake2b-256 of the whole `block_body` bytes (BlockBody/Internal.hs
  `hashBlockBody` hashes the memoised bytes); `block_body_size` = their length.
- `header_body` has 12 fields: the 10 Babbage/Conway ones (with `protocol_version` renamed
  `header_version_info = [highest_supported_major_version, self_reported_software_tag]`, same
  wire shape), then `block_body_contains_leios_cert : bool` and
  `eb_references_announcement : [hash32, uint32] / nil`. `vrf_cert` output is now `bytes .size 64`.
- `leios_certificate = [signers : bytes .size (0..8192), signature : bytes .size 48]`,
  `peras_certificate = bytes`.

Transactions
- `mempool_transaction = [body, wits, aux / nil] / [body, wits, true, aux / nil]` (the flag may
  only be `true` when present).
- Transaction body: key 14 `required_signers` becomes
  `guards = nonempty_set<addr_keyhash> / nonempty_oset<credential>` (script credentials allowed);
  new keys 23 `sub_transactions`, 24 `required_top_level_guards = {+ credential => plutus_data / nil}`,
  25 `direct_deposits = {+ reward_account => coin}`,
  26 `account_balance_intervals = {+ reward_account => account_balance_interval}`,
  27 `starting_account_balance_intervals` (top level only).
- `account_balance_interval = [coin, coin / nil] / [coin / nil, coin] / coin` (half-open
  `[lower, upper)`, or an exact balance).
- `sub_transaction = [sub_transaction_body, witness_set, aux / nil]`; the sub body has no fee (2),
  no collateral (13, 16, 17), no sub-transactions (23) and no key 27.
- `multiasset` maps must be non-empty (`{+ ...}`, Conway `{* ...}`).
- Witness set: every field is a `nonempty_set` (Conway allowed lists for some); new key
  8 `nonempty_set<plutus_v4_script>`; `redeemers` only in the map form (the array form is gone);
  `redeemer_tag` adds 6 (guarding); bootstrap `chain_code` is `bytes .size 32`.
- Scripts: `script` adds `[4, plutus_v4_script]` (hash prefix 0x04); native scripts add
  `script_require_guard = (6, credential)`; auxiliary data map adds key 5 (V4 scripts).
- Certificates: 0 and 1 (registration without deposit), 5 (genesis delegation) and 6 (MIR) are
  removed; `pool_params` gains an optional `bls_key / nil` after the VRF key hash
  (`bls_key = [bytes .size 96, bytes .size 48]`, proof of possession checked by the POOL rule).
- `language = 0 .. 3`; `cost_models` gains key 3 (PlutusV4); `major_protocol_version = 0 .. 13`.

Protocol parameter update keys
- 34 max ref-script size per block, 35 per tx, 36 ref-script cost stride, 37 multiplier
  (Conway constants become parameters), 38 max pledge leverage (`nonnegative_interval / nil`),
  39 min pool margin, 40..48 Leios (announcement, vote and diffusion period lengths in ms,
  committee size, quorum stake threshold, max endorser-block references size, txs size, ex units,
  ref-script size), 49..54 Peras (min candidate block age, healing factor, certificate boost,
  target committee size, bootstrap round `nil / uint32`, quorum threshold safety margin),
  55..56 reference-input fees (per multi-asset policy, per datum byte; not used by the fee rule yet).
- The full `PParams` record (N2C `GetCurrentPParams`) is a 54-element list: Conway's 31, then
  34..56 in `eraPParams` order; `perasBootstrapRound` encodes as a StrictMaybe (`[]` / `[x]`).

Rules that change (cardano-ledger eras/dijkstra Rules/*.hs)
- BBODY: `HeaderProtVerTooLow` (header's highest supported major ≥ the ledger's), Conway's
  `HeaderProtVerTooHigh` is gone, `PerasCertValidationFailed` (the validator is a placeholder that
  always says no), reference-script size limit from the parameters.
- UTXO: value conservation and the input checks cover the whole batch (top + sub-transactions,
  all inputs from the UTxO before the batch); direct deposits are produced value.
- UTXOW: `MissingRequiredGuards`, `MalformedGuardDatums`, script guards need their scripts
  (Plutus ones a guarding redeemer).
- ENTITIES: direct deposits (network, registered account), account balance intervals (network,
  registered, balance in interval; starting intervals against the balances before the batch),
  withdrawals may be partial unless the transaction runs a Plutus V1..V3 script ("legacy
  mode", where they must drain the account as in Conway); `ConwayWdrlNotDelegatedToDRep` removed.
- `hashTx` (new): blake2b-256 of `hash(body) ‖ hash(wits) ‖ hash(aux)? ‖ cbor(is_valid)`, the
  whole-transaction id Leios endorser blocks use.

## 421. Experimental hard forks switch

What: cardano-node's `ExperimentalHardForksEnabled`. Without it Conway's successor is
`TriggerHardForkNotDuringThisExecution`, so a node never enters Dijkstra.
Design: `src/consensus/hfc/experimental.ts` holds the switch; it is turned on by the config key
(also read from the cardano-node config file next to the genesis files, which is how musashi's
config enables it) or `GEROLAMO_EXPERIMENTAL_HARD_FORKS=1`. `triggersFrom` then makes Dijkstra a
version-12 trigger (or `TestDijkstraHardForkAtEpoch`), `HardForkHistory.lastReachableEra` and
`eraIndexAt` allow HFC index 7, the debug ledger config answers `atVersion 12`, and validation
workers pick the switch up from their job config. Off by default: every era-8 path below is
unreachable.
Tests: `src/consensus/dijkstra/dijkstra.test.ts` "ExperimentalHardForksEnabled".

## 422. ledger-ts: Dijkstra header

What: `DijkstraHeaderBody` decoded the 10-field Conway header; the current header has 12.
Fix: strict 12-field decoder (`leiosCertified`, `ebAnnouncement`, `versionInfo`; nil `prev_hash`
accepted), exact re-encoding from fields, 448-byte KES signature check.
Tests (ledger-ts `src/eras/dijkstra/__tests__/dijkstra.vectors.test.ts`): the musashi header
decodes and re-encodes byte-identically (also without cached bytes); Dingo's 14-case arity table
(`dijkstra_header_arity_test.go`); `MultiEraHeader` era 8.

## 423. ledger-ts: Dijkstra block body

What: `DijkstraBlock` implemented an earlier CIP-0176 draft (`[invalid_txs/nil, txs, peras]`).
Fix: `[header, [txs, leios/nil, peras/nil]]` with 4-element block transactions, the legacy
4-field musashi body rejected ("expected 3 components, got 4", as Dingo's peer path),
`blockBodyBytes` / `computeBlockBodyHash()`, and Conway-shaped views (`transactionBodies`,
`transactionWitnessSets`, `auxiliaryDataSet`, `invalidTransactions` = indices whose flag is
false) so Gerolamo's era-generic code reads Dijkstra blocks unchanged. `MultiEraBlock` era 8.
Tests: musashi block body hash and size equal the header's; a block with the golden transaction
twice (valid, invalid) and a Leios certificate round-trips without cached bytes; malformed
block transactions and Leios certificates are rejected.

## 424. ledger-ts: Dijkstra transactions

Fix: one strict field codec for both body levels (allowed keys per level, duplicates and unknown
keys rejected, the non-empty and positive-donation checks of `decodeSparseKeyed`), encoding in the
Haskell key order with tag-258 sets; governance fields decoded (they were dropped); keys 24 and
27; account balance intervals keyed by reward account with the exact-coin form and the "invalid
reward account" check; `requiredSigners` (key-hash guards) and `scriptGuards` views; Dijkstra
certificate decoder (0/1/5/6 rejected, `DijkstraCertPoolRegistration` with the BLS key slot);
witness set: keys 0..8 only, map-form redeemers only, guarding tag 6; mempool form strict
(`true` only); `DijkstraTx.fromBlockTransactionCborObj`, `toBlockTransactionCborObj`,
`hashTx()` / `hashTxBytes()`.
Tests: the cardano-ledger golden tx (master) and gouroboros' current golden decode (with the
upstream 2-byte pool-metadata placeholders expanded, as gouroboros does), re-encode
byte-identically, and the body encodes from fields in the Haskell key order;
`hashTxBytes(golden) == golden/hashtx.hex` (532feb14…); gouroboros' account-interval expectations
and non-reward-account rejection; key/level/duplicate rejections; guard views; certificate
rejections. ledger-ts suite: 198 pass, the same 5 fail / 3 errors as before the change (pre-existing,
unrelated: TxWithdrawals.toData, isProtocolParameter, Tx.fromCbor).
Packaging: version `0.6.0-dijkstra.1`, packed with `scripts/vendor-pack.sh` into
`vendor/harmoniclabs-cardano-ledger-ts-0.6.0-dijkstra.1.tgz` (nested cbor 2.0.2 kept). The diff
against the sibling checkout is `docs/parity/dijkstra-ledger-ts.patch`. The copy's dev
dependencies (cbor, plutus-data, plutus-machine, uplc, cardano-costmodels-ts, crypto) were set to
the versions Gerolamo resolves at runtime: with the older dev copies even the existing Dijkstra
tests failed.

## 425. Gerolamo: Dijkstra headers

What: era-8 headers returned "unsupported era".
Fix: `headerParser` decodes them with `DijkstraHeader` when the switch is on (null otherwise,
as before); `BlockHeaderValidator` treats them as Praos headers (VRF, KES over the header-body
bytes, opcert); `blockLeader` reads their issuer; the forger writes 12-field headers
(`false`, `nil`) and the Dijkstra body for era 8 (`dijkstraBlockBodyFromSegments`), and forges
Dijkstra blocks empty until the mempool learns the era (432). Chain selection's tie-break reader
(`tieBreakInfoOf`) accepts the 12-field body (it returned null, so two Dijkstra forks of equal
length would never have been compared by VRF); Dijkstra keeps Conway's restricted VRF tie-break.
Tests: ChainSync parse with and without the switch; a header captured from musashi at slot 566037
(genuinely signed, KES evolution 4) passes KES + opcert and fails when tampered; a forged empty
era-8 block passes our full header validator (VRF with the right nonce, fails with a wrong one) and
its body hash. Note: Dingo's `musashi_type8_dijkstra_header.hex` does not verify under KES (it
looks constructed), so it is only used for decoding.

## 426. Gerolamo: Dijkstra body hash and size

Fix: `bodyHash.ts` hashes the raw `block_body` for era 8 and checks `block_body_size` against
its length (`WrongBlockBodySizeBBODY`; not checked for older eras, unchanged).
Tests: the musashi block verifies; a body with a different Peras field fails with the size detail.

## 427. Gerolamo: Dijkstra BBODY rules

Fix (`rules/dijkstraRules.ts` `checkDijkstraBlock`, called for era 8 only, also for empty
blocks): `HeaderProtVerTooLow`, no `HeaderProtVerTooHigh`, `PerasCertValidationFailed`, and the
Leios prototype rules gouroboros enforces (certified flag equals certificate presence; a certified
block carries no transactions); the Leios aggregate signature is reported as not verified.
Reference-script block limit from the parameters.
Tests: `blockRules.test.ts`, `dijkstra.test.ts` "Dijkstra block rules"; a Conway block with the
same fields is untouched.

## 428. Gerolamo: Dijkstra transaction rules

Fix (`evaluateTxRules` era 8, `checkDijkstraTx`): batch value conservation (sub-transaction
inputs from the UTxO before the batch, their mint, withdrawals, refunds, outputs, donations,
deposits, direct deposits); key-hash guards as required signers, script guards as needed
scripts; `MissingRequiredGuards`, `MalformedGuardDatums`; direct deposits (network, registered
account); account balance intervals (balance after the sub-transactions; starting intervals
against the balances before the batch); partial withdrawals except in Plutus legacy mode;
`WdrlNotDelegatedToDRep` skipped; reference-script limits and tier price from the parameters.
Block level: sub-transaction inputs are read, their vkey witnesses verified against their own
body hash, their required keys and validity interval checked, their outputs visible to later
transactions of the block and to the next block's overlay.
Not enforced (reported): the rest of SUBLEDGER (sub-transaction scripts, native and Plutus), the
guarding redeemer pointers, BLS proof of possession of a pool's key, max pledge leverage and min
pool margin in the POOL rule.
Tests: `dijkstra.test.ts` "Dijkstra transaction rules", `blockRules.test.ts`.

## 429. Gerolamo: applying Dijkstra blocks

Fix: `applyDijkstraTransaction` (BlockApplication): sub-transactions first (each a transaction
whose id is its body hash, no fee; their donations go to the pot), then the transaction, then
direct deposits (`applyDirectDeposits`: LMDB `creditRewards`, the SQLite row, a journal entry).
A phase-2 invalid transaction only loses its collateral, as before. Partial withdrawals already
debit the amount. Raw decoders: `govTxDecode` and `certScan` skip the optional BLS slot of an
11-element pool registration (the key joins the PoolParams encoding, a nil does not).
Tests: `apply.test.ts` (order, donations), `poolCertBls.test.ts`.
Open: governance actions and votes inside sub-transactions are not recorded by the governance
state (it reads the top-level body); the explorer and mini-Blockfrost index only top-level txs.

## 430. Gerolamo: Dijkstra protocol parameters

Fix: update keys 34..56 and the PlutusV4 cost model are decoded for proposals made at protocol 12
(`paramChangesOfUpdateMap(…, { dijkstra })`); the Dijkstra genesis is merged when the ledger
crosses into protocol 12 (`dijkstraGenesisRaw`: the reference-script fields, pledge leverage,
pool margin, Leios, Peras, reference-input fees, `plutusV4CostModel`); `DijkstraGenesisFile` /
`dijkstra-genesis.json` next to the Shelley genesis; N2C `GetCurrentPParams` and the other
pparams answers use the 54-field encoding from protocol 12 (`pparamsCborFor`).
Tests: `dijkstra.test.ts` "Dijkstra protocol parameters" (musashi genesis: 251-entry V4 model).

## 431. LocalStateQuery

The era index of the HFC answers follows `eraIndexAt` (7 once in Dijkstra); queries for era 7 are
answered by the Conway query code with the Dijkstra pparams encoding; the debug ledger config
answers Conway → Dijkstra `atVersion 12` with the switch on. Open: Dijkstra-specific query
result shapes beyond PParams (e.g. pool params with BLS keys from the LMDB store, account
states) are not specialised.

## 432. Mempool and transaction submission (open)

The validating mempool and LocalTxSubmission still accept Conway transactions only (era index 6).
With Dijkstra active the producer forges empty blocks (guard in BlockProducer) so it never
includes a Conway-shaped transaction in a Dijkstra block. Teaching the mempool rules the
Dijkstra body (and era index 7 on the wire) is the next step.

## 433. Plutus V4 language

Fix: language 4 everywhere the ledger names a language, gated by the era: witness key 8 and
script tag 4 only from era 8 (`maxPlutusLanguage(era)`), script hash prefix 4, V4 language view
(key 3, definite list; Alonzo PParams.hs `getLanguageView`), V4 cost models (`PlutusV4`, key 3;
`PARAM_NAMES_V4` = V3's list, identical in plutus master), builtins: batches 1..6 from protocol 12;
Plutus Core 1.2.0 accepted from protocol 12 for every language (`plcVersionsIntroducedIn`); the
phase-2 program cache keys protocol 12 apart from 11 (a 1.2.0 program decodes at 12 only).
Guarding redeemers (tag 6) are reported, not failed, in Dijkstra transactions.
Tests: `conformance.v4.test.ts`, `dijkstra.test.ts` "Plutus V4 in the ledger rules".

## 434. Semantics variants F and G

What: from protocol 12 V1/V2 use variant F and V3/V4 variant G (ProtocolVersions.hs note).
F/G keep the bytestring bounds (`ensurableByteString`) and the byte-length text costing of D/E
but drop the integer bounds (`ensurableInteger`), and use D's / E's cost functions.
Fix: `semanticsVariant`, `shapeVariant`, `BuiltinCtx.boundedInt` (`cint`), `legacy` = V1/V2 only.
Measured: plutus master's conformance suite (1011 cases, variant G = its `def`), evaluated as
Plutus V4 at protocol 12 with master's default cost model E: 997 pass, 0 budget mismatches,
5 skipped (Int64-saturating costs, as with 1.63), 9 result mismatches, all in the UPLC *text*
parser used by the test harness (value literal ordering checks, free variables), not in the
evaluator or the flat decoder. The same suite as V3 at protocol 11 fails the two `case` on Data
programs that need protocol 12, as it should. The 1.63 suite still passes as before.

## 435. Plutus V4 script context (open)

`PlutusLedgerApi.V4.Contexts` (677 lines at plutus master) adds guards, sub-transactions,
direct deposits, balance intervals and required top-level guards to TxInfo; Dijkstra's TxInfo
for V1..V3 refuses transactions using these fields. Not ported: phase 2 gives "no verdict"
(reported, never a failure) for a V4 script, for a V1..V3 script in a transaction with body keys
23..27, and for a guarding redeemer.

## 436. No regression

- `bunx tsc --noEmit -p .`: clean.
- Full suite: before, `bun test src` 1373 pass and 5 fail (the 5 are the dashboard's UI tests, which
  that path filter also picks up and which cannot find `solid-js` in a worktree); after,
  `bun test ./src` 1266 pass, 0 fail (209 files, 52 of the tests new).
- ledger-ts suite: 198 pass, the same 5 fail / 3 errors as the sibling before the change.
- `scripts/dijkstra-regression-replay.ts` over the whole preview relay chain
  (`/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable`, read-only, 28 883 chunks):
  4 736 254 blocks (Alonzo 13 012, Babbage 2 330 997, Conway 2 392 245), every one decoded by the new
  ledger-ts and re-encoded byte for byte, header parsed with the right hash, body hash verified;
  189 450 blocks (every 25th) give identical JSON with the old ledger-ts 0.5.13; the witness-set
  script hashes of all 6 981 124 transactions are the same with the era's language ceiling as
  with the old default. 0 problems, 85 min, 580 MB RSS.

## How to enable

Add `"ExperimentalHardForksEnabled": true` to the node configuration (or the cardano-node config
file Gerolamo reads next to the genesis files), or set `GEROLAMO_EXPERIMENTAL_HARD_FORKS=1`, and
put `dijkstra-genesis.json` next to the Shelley genesis (or set `dijkstraGenesisFile`). Nothing
needs to be set for preview, preprod or mainnet: there the switch stays off.
