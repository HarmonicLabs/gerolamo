# node-diversity-conformance: `cbor-decoding` (2026-10-15)

pragma-org's [node-diversity-conformance](https://github.com/pragma-org/node-diversity-conformance) scenario
`cbor-decoding` runs every node's production CBOR decoders over the same corpus:
[cardano-cbor-dataset](https://github.com/etorreborre/cardano-cbor-dataset), branch `etorreborre/feat/normalization`,
corpus `conway-123-100` (25 Conway rules, 9 200 expectations). The reference (cardano-node, report
`dataset/reports/conway-123-100/latest.json`) decodes at protocol 11.0 and meets all 9 200.

- harness: `src/conformance/ndc/cborDecoding.ts`, normalizer `src/conformance/ndc/cborNormalize.ts`
- CLI: `bun scripts/ndc/cbor-decoding.ts --dataset <cardano-cbor-dataset>/dataset/conway-123-100 --out report.json [--schema <ndc>/scenarios/cbor-decoding/schema.json]`
- test: `src/conformance/ndc/cborDecoding.test.ts` (normalizer vectors always; the corpus with
  `GEROLAMO_NDC_CBOR_DATASET=<dir>` [+ `GEROLAMO_NDC_CBOR_SCHEMA=<schema.json>`], per-rule floors = this run)

## Result

| node | protocol | round-trip | generated rejected | zap rejected | met / 9 200 |
| --- | --- | --- | --- | --- | --- |
| cardano-node (reference) | 11.0 | 866 / 866 | 1 634 / 1 634 | 6 700 / 6 700 | 9 200 (100 %) |
| Amaru (preview report) | 10.0 | 692 / 866 | 1 261 / 1 634 | 6 645 / 6 700 | 8 598 (93.46 %) |
| **Gerolamo** (f372532-dirty, ledger-ts 0.6.0-dijkstra.1, cbor 2.0.2) | 11.0 | **599 / 866** | **605 / 1 634** | **3 779 / 6 700** | **4 983 (54.16 %)** |

| rule | round-trip | generated rejected | zap rejected |
| --- | --- | --- | --- |
| auxiliary_data | 43 / 49 | 34 / 51 | 89 / 300 |
| block | 0 / 0 | 100 / 100 | 300 / 300 |
| certificate | 35 / 35 | 3 / 65 | 149 / 300 |
| cost_models | 0 / 100 | 0 / 0 | 0 / 0 |
| credential | 50 / 50 | 0 / 50 | 0 / 100 |
| datum_option | 32 / 55 | 2 / 45 | 187 / 300 |
| drep | 60 / 60 | 0 / 40 | 0 / 100 |
| gov_action | 21 / 33 | 0 / 67 | 153 / 300 |
| header | 0 / 0 | 100 / 100 | 300 / 300 |
| header_body | 0 / 0 | 100 / 100 | 300 / 300 |
| native_script | 42 / 46 | 35 / 54 | 188 / 300 |
| plutus_data | 27 / 100 | 0 / 0 | 59 / 300 |
| proposal_procedure | 2 / 3 | 0 / 97 | 169 / 300 |
| protocol_param_update | 0 / 14 | 0 / 86 | 0 / 300 |
| redeemer | 40 / 47 | 8 / 53 | 147 / 300 |
| redeemers | 0 / 2 | 16 / 98 | 116 / 300 |
| relay | 47 / 47 | 0 / 53 | 0 / 300 |
| script | 89 / 89 | 0 / 11 | 0 / 300 |
| transaction | 0 / 0 | 95 / 100 | 299 / 300 |
| transaction_body | 0 / 0 | 15 / 100 | 221 / 300 |
| transaction_input | 50 / 50 | 0 / 50 | 149 / 200 |
| transaction_output | 4 / 26 | 1 / 74 | 237 / 300 |
| transaction_witness_set | 0 / 0 | 96 / 100 | 291 / 300 |
| value | 50 / 53 | 0 / 47 | 218 / 300 |
| voting_procedure | 7 / 7 | 0 / 93 | 207 / 300 |

Every one of the 4 217 failures is in `@harmoniclabs/cardano-ledger-ts` 0.6.0-dijkstra.1,
`@harmoniclabs/cbor` 2.0.2 (the copy nested under ledger-ts), `@harmoniclabs/plutus-data` 2.0.1 or
`@harmoniclabs/cardano-costmodels-ts` 1.6.1. None is in Gerolamo's own code: the two Gerolamo
entry points in the table (`headerParser` for `header`, `parseMempoolTx` for `transaction`) reject
everything they should except what the library underneath lets through. The broad picture: the
libraries decode leniently (they read what they need and ignore the rest), so 3 950 of the
8 334 must-reject samples are accepted; and the re-encoders either re-emit the original bytes
(memoized `cborRef`) where cardano-ledger rebuilds, or rebuild where cardano-ledger keeps the bytes.

## How the report is produced

**Rule → decoder.** For every rule the harness calls the function the node runs for that
structure. A structure the node only decodes inside a parent is decoded with the exact function
the parent calls, on objects parsed by the library's own nested cbor copy (as the parent hands
them down); `datum_option` and `redeemers` have no standalone function, so they go through a
minimal carrier (an output `{0: addr, 1: 1, 2: datum_option}`, a witness set `{5: redeemers}`).
Re-encoding uses the same library's encoder.

| rule | node path | re-encoding |
| --- | --- | --- |
| auxiliary_data | `ConwayAuxiliaryData.fromCborObj` (ConwayBlock aux set, ConwayTx) | `toCbor()` |
| block | `blockParser` → `MultiEraBlock.fromCbor([7, block])` → `ConwayBlock.fromCborObj` | `block.toCbor()` |
| certificate | ConwayTxBody key 4 → `certificateFromCborObj` (eras/common/ledger/certs/Certificate.js) | `toCbor()` |
| cost_models | ParameterChange → `partialProtocolParametersFromCborObj` key 18 → `costModelsFromCborObj` | key 18 of `partialProtocolParametersToCborObj` |
| credential | `Credential.fromCborObj` | `toCbor()` |
| datum_option | inline in `ConwayTxOut.fromCborObj` key 2 (carrier output) | key 2 of `ConwayTxOut.toCborObj` (no memo) |
| drep | `drepFromCborObj` (eras/conway/governance/DRep, as the Conway delegation certs call it) | `toCbor()` |
| gov_action | `govActionFromCborObj` (via ProposalProcedure) | `toCbor()` |
| header | Gerolamo `headerParser` on `[2, [6, #6.24(header)], tip]` → `ConwayHeader.fromCbor` (null-prev patch) | `toCbor()` |
| header_body | `ConwayHeaderBody.fromCbor` | `toCbor()` |
| native_script | witness set key 1: `Script(NativeScript, Cbor.encode(item))`; interpreted by `Script.nativeScript()` → `nativeScriptFromCbor` (txRules) | `script.bytes` (the hash preimage) |
| plutus_data | witness set key 4 / inline datum: `dataFromCborObj` | `dataToCbor` |
| proposal_procedure | ConwayTxBody key 20 → `ProposalProcedure.fromCborObj` | `toCbor()` |
| protocol_param_update | ParameterChange → `partialProtocolParametersFromCborObj` (ledger/protocol/ProtocolParameters.js) | `partialProtocolParametersToCborObj` |
| redeemer | witness set key 5 list form → `ConwayTxRedeemer.fromCborObj` | `toCbor()` |
| redeemers | `ConwayTxWitnessSet.fromCborObj` key 5 → `witnessRedeemersFromCborObj` | key 5 of `ConwayTxWitnessSet.toCborObj` |
| relay | PoolParams → `poolRelayFromCborObj` | `poolRelayToCborObj` |
| script | ConwayTxOut key 3 payload → `Script.fromCbor` | `toCbor()` |
| transaction | Gerolamo `parseMempoolTx` (ValidatingMempool, LocalTxSubmit) → `ConwayTx.fromCbor` | `ConwayTx.toCbor()` |
| transaction_body | `ConwayTxBody.fromCbor` | `toCbor()` |
| transaction_input | ConwayTxBody keys 0/13/18 → `TxOutRef.fromCborObj` | `toCbor()` |
| transaction_output | ConwayTxBody key 1 → `ConwayTxOut.fromCborObj` | `toCbor()` |
| transaction_witness_set | `ConwayTxWitnessSet.fromCborObj` | `toCbor()` |
| value | ConwayTxOut key 1 → `Value.fromCborObj` | `toCbor()` |
| voting_procedure | ConwayTxBody key 19 → `VotingProcedures` → `VotingProcedure.fromCborObj` | `toCbor()` |

Gerolamo's own CBOR readers do not take part in accept/reject: `govTxDecode.ts` (certificates,
proposals, votes for the GOV/GOVCERT checks) and `costModelUpdate.ts` (cost models of an enacted
ParameterChange) run after ledger-ts accepted the block, and a decode error there is a report,
not a rejection (`govValidate.ts` `blockGovModels`). See 582 for the one place this matters.

**Comparison** follows the dataset's `verify expected` (app/Corpus.hs): valid samples must decode,
then for the seven hashed rules (`auxiliary_data header native_script plutus_data redeemers
transaction_body transaction_witness_set`) the re-encoding must equal the original bytes and the
`expected` file; for the others the normalized re-encoding must equal `expected`. The normalizer
implements the README table including the rational reduction (`#6.30([n, d])` reduced; the
Haskell `Normalize.hs` does not need it because the ledger stores a reduced `Ratio`), and passes
the 20 `normalization-vectors`. Invalid samples (`zap-0`) and mutations (`zap-1..3`) must throw.

**Report shape** mirrors Amaru's preview report: `schema_version`, `scenario`, `generated_at`,
`implementation` {name, version, commit, `cardano-ledger-ts`, `cbor` (ledger-ts's copy),
`cbor-node` (root 1.6.6)}, `corpus`, `protocol_version` "11.0", `successful`, `totals`, `rules`
(the seven Outcome counters), `failures`. Failure classes are the dataset's own labels
(app/Report.hs `failureKindLabel`; Amaru's older report spells two of them differently), sample
paths are `<rule>/valid/<stem>` and `<rule>/invalid/zap-<n>/<stem>` as the README specifies. Like
Amaru's, every failing sample is listed; hex dumps inside a reason are cut at 4 096 bytes.

**Attribution.** The counts below assign each failing sample to one class: valid-sample failures
by their error or re-encoding difference, accepted invalid samples by the first matching feature
in the order 570–581 (a sample with a chunked hash and a bignum coin counts under 570 only).
"gen" = `invalid/zap-0`, "zap" = mutations. The features were checked against the valid samples
(none of them carries a feature counted as a cause in that context). Minimal examples were run
through the harness.

## Must-reject samples that are accepted (3 950)

## 570 — chunked byte / text strings accepted everywhere (1 953: gen 759, zap 1 194)

Rules: certificate 165, credential 106, datum_option 104, drep 87, gov_action 130, native_script 57,
proposal_procedure 203, relay 200, script 228, transaction 6, transaction_body 164,
transaction_input 77, transaction_output 122, transaction_witness_set 12, value 115,
voting_procedure 110, auxiliary_data 64 (in scripts), protocol_param_update 3.

Example (credential): `82005f581c<28 bytes>ff` — accepted, cardano-ledger rejects. cardano-ledger
takes indefinite-length (chunked) strings only inside Plutus Data (`bounded_bytes`) and transaction
metadata; hashes, keys, addresses, URLs and DNS names must be definite.

Root cause: `@harmoniclabs/cbor` `Cbor.parseWithOffset` (dist/Cbor/index.js, `parseCborObj`, major
types 2/3) folds the chunks into one `CborBytes` / `CborText`; the decoders read `.bytes` / `.text`
and never look at `CborBytes.isDefiniteLength`: `Hash28.fromCborObj`, `Hash32.fromCborObj`,
`Hash.fromCborObj` (dist/hashes), `Address.fromCborObj`, `Anchor.fromCborObj`,
`poolRelayFromCborObj`, `TxOutRef.fromCborObj`, `Value.fromCborObj` (policy / asset names).

Fix: one helper `definiteBytes(cObj)` / `definiteText(cObj)` in ledger-ts that throws unless
`isDefiniteLength` (add the same getter to `CborText`), used by every non-Data, non-metadata
decoder. `dataFromCborObj` and `txMetadatumFromCborObj` keep accepting chunks.

## 571 — indefinite-length arrays where cardano-ledger requires definite ones (634: gen 264, zap 370)

Rules: protocol_param_update 179 (keys 19, 20, 21), redeemers 255 and redeemer 101 (ExUnits),
voting_procedure 50, gov_action 39 and proposal_procedure 10 (GovActionId, Anchor, ProtVer).

Example (voting_procedure): `9f02f6ff` — accepted. In the corpus no valid VotingProcedure, Value,
ExUnits, ExUnitPrices or ex-unit parameter is indefinite, and every rejected `zap-0` redeemer and
parameter update has an indefinite ExUnits / ExUnitPrices; elsewhere (credentials, certificates,
scripts) indefinite arrays are fine.

Root cause: `CborArray.indefinite` is never consulted: `ConwayTxRedeemer.fromCborObj` (ex units),
`VotingProcedure.fromCborObj`, `TxOutRef.fromCborObj` (as GovActionId), `Anchor.fromCborObj`,
`ProtocolVersion.fromCborObj`, `partialProtocolParametersFromCborObj` keys 19–21.

Fix: in exactly those decoders, `if (cObj.indefinite) throw`. Do not apply it globally.

## 572 — bignums (#6.2 / #6.3) accepted as fixed-width integers (379, all zap)

Rules: protocol_param_update 135, native_script 45, script 44, gov_action 34, relay 37, redeemer 26,
transaction_input 19, value 14, certificate 10, proposal_procedure 8, transaction_output 7.

Example (transaction_input): `825820<32 bytes>c24101` (index as bignum 1) — accepted, re-encodes
with the bignum. cardano-ledger reads coins, slots, indexes, ports and ex units with
`decodeWord64`/`decodeWord16`, which do not accept tags; bignums are Plutus Data only.

Root cause: `Cbor.parseWithOffset` (major type 6) turns `#6.2`/`#6.3` over bytes into
`CborUInt.bigNum` / `CborNegInt.bigNum` (dist/CborObj/CborUInt.js, CborNegInt.js), so every
`instanceof CborUInt` check passes.

Fix: keep the origin (`CborUInt` already takes a `bigNumEncoding` argument; the parser passes
`undefined` for heads and the bytes for bignums) and add `CborUInt.isBigNum`; ledger-ts integer
fields reject it; plutus-data accepts it.

## 573 — invalid Plutus Data accepted (359, all zap)

Rules: plutus_data 241, redeemer 69, datum_option 41, redeemers 8.

Examples: `5841<65 bytes>` (bounded_bytes over 64 bytes in one chunk) and `d82a40` (tag 42, not a
constructor) — both accepted; the second decodes as the bare bytes.

Root cause: `dataFromCborObj` (plutus-data dist/fromCbor.js): "any unrecognized tag … ignore the
tag and treat the object as if it were normal CBOR"; `CborBytes` of any length / chunk size is a
`DataB`. `ConwayTxOut.fromCborObj` decodes an inline datum with `Cbor.parse(_1.data.buffer)`
without requiring the payload to be exactly one item.

Fix: in `dataFromCborObj` throw on tags other than 121–127, 1280–1400, 102 and 2/3-over-bytes; on
definite byte strings over 64 bytes and on chunks over 64 bytes (needs the chunk list from 570);
on text, floats and simple values. Inline datum: `Cbor.parseWithOffset` and require
`offset === bytes.length`.

## 574 — string length bounds not enforced (216, all zap)

Rules: auxiliary_data 144 (metadata text / bytes over 64 bytes), relay 61 (DNS name over 128
bytes, IPv4 not 4 bytes, IPv6 not 16), voting_procedure 8 and proposal_procedure 2 (URL over 128),
certificate 1.

Example (relay): `8202 7881 <129 × "a">` — accepted (and then `poolRelayToCborObj` cannot
re-encode it).

Root cause: no length checks in `txMetadatumFromCborObj` (dist/tx/metadata/TxMetadatum.js),
`poolRelayFromCborObj` (dist/eras/common/ledger/PoolRelay.js), `Anchor.fromCborObj`
(dist/governance/Anchor.js).

Fix: enforce the CDDL `.size` bounds there (metadata 64, url 128, dns_name 128, ipv4 4, ipv6 16).

## 575 — 28-byte hashes of any length accepted (202, all zap)

Rules: drep 53, credential 44, script 39, native_script 29, certificate 32, auxiliary_data 3,
transaction_output 2.

Example (credential): `8200 47 <7 bytes>` — accepted.

Root cause: the `Hash28` constructor (dist/hashes/Hash28/Hash28.js) only checks
`_bytes instanceof Uint8Array` although its message says "must be an hash of length 28";
`Hash28.fromCborObj` passes anything. `Hash32` does check its length.

Fix: `if (this._bytes.length !== 28) throw` in the `Hash28` constructor (subclasses PubKeyHash,
script hashes, pool ids inherit it).

## 576 — unexpected or wrong CBOR tags accepted (64, all zap)

Rules: protocol_param_update 41, datum_option 11, transaction_output 3, gov_action 3,
proposal_procedure 2, auxiliary_data 4.

Example (datum_option): `8201 d819 4100` (tag 25 instead of 24) — accepted, re-encoded with tag 24.

Root cause: `ConwayTxOut.fromCborObj` checks `_1 instanceof CborTag` but not `_1.tag === 24`
(same for the script_ref tag); rationals are read with `CborPositiveRational.fromCborObjOrUndef`
(@harmoniclabs/cbor dist/extra/CborRational.js), which accepts any tag number
(`a1 09 d81f820102`, tag 31, is accepted and re-encoded with tag 30).

Fix: compare the tag number (24 for datum / script_ref, 30 for rationals, 258 for sets, 259 for
Alonzo auxiliary data) wherever a tag is expected, and reject tags elsewhere.

## 577 — floats and simple values silently dropped (55, all zap)

Rules: relay 46, protocol_param_update 7, certificate 1, gov_action 1.

Example (relay): `8400 f93c00 f6 f6` (port 1.0) — accepted, re-encoded as `8400f6f6f6`.

Root cause: `poolRelayFromCborObj` maps every field that is not the expected type to `undefined`
(`port: _1 instanceof CborUInt ? _1.num : undefined`); `partialProtocolParametersFromCborObj` does
the same per key (`fromUIntOrUndef`).

Fix: only `null` maps to `undefined`; any other type throws.

## 578 — protocol parameter update fields of the wrong value accepted (21, zap)

Examples: `a1 09 d81e820100` (pool pledge influence 1/0) and `a1 0a d81e820302` (monetary
expansion 3/2, a unit interval) — both accepted unchanged; `a1 09 820102` (untagged) is accepted
and the field silently dropped (re-encodes as `a0`); negative values in uint keys are dropped the
same way. Root cause: `partialProtocolParametersFromCborObj` (dist/ledger/protocol/
ProtocolParameters.js) maps every unreadable field to `undefined` (`fromUIntOrUndef`,
`CborPositiveRational.fromCborObjOrUndef`), and nothing checks denominators or interval bounds.
Fix: throw on a present-but-unreadable field; require denominator > 0 and, for keys 10, 11 and the
voting thresholds, numerator ≤ denominator.

## 579 — integers outside the field's range (7, zap)

Rules: transaction_input 5 (TxIx > 65 535: Word16 in Conway), relay 2 (port > 65 535).
Example: `825820<32 bytes>1a00010000` — accepted.
Root cause: `TxOutRef.fromCborObj` (dist/eras/common/tx/TxOutRef.js) and `poolRelayFromCborObj`
take any `CborUInt`. Fix: range checks (index ≤ 0xffff, port ≤ 0xffff).

## 580 — vote outside 0..2 accepted (18, zap)

Example (voting_procedure): `8206f6` — accepted, re-encoded unchanged.
Root cause: `VotingProcedure.fromCborObj` (dist/governance/VotingProcedure.js) takes any uint as
the vote. Fix: `vote <= 2`.

## 581 — other structural leniency (42: gen 6, zap 36)

auxiliary_data 13, gov_action 7, relay 7, certificate 4, redeemers 3, proposal_procedure 3,
redeemer 2, transaction_output 2, transaction_witness_set 1: arity (`length >= N` instead of
`=== N`, e.g. `Credential.fromCborObj` never checks the array length, `poolRelayFromCborObj`
destructures four fields of any array), metadata keys/values of the wrong kind, extra map keys.
Also not exercised by this corpus but present: every `fromCbor(bytes)` ignores trailing bytes
(`Cbor.parse` returns the first item; e.g. credential `8200581c<28>00` is accepted). Fix:
`fromCbor` entry points use `Cbor.parseWithOffset` and require the whole input; exact arity in the
record decoders.

## Valid samples that fail (267)

## 582 — cost models dropped (114: cost_models 100, protocol_param_update 14)

Example: cost_models `a1 00 81 00` — decoded parameter update carries no cost models.

Root cause, three layers: (a) `costModelsFromCborObj` (cardano-costmodels-ts dist/CostModels.js)
resolves its own nested `@harmoniclabs/cbor` copy, so the `CborMap` that ledger-ts parsed fails
`cObj instanceof cbor_1.CborMap` and the function returns `{}` — every cost model in every
ParameterChange decoded by ledger-ts is dropped; (b) even with one copy, an entry list holding a
negative integer is skipped (`v.array.every(n => n instanceof CborUInt)`); (c) language keys other
than 0, 1, 2 are ignored, while cardano-ledger keeps unknown languages.

Gerolamo is protected for (a)/(b): enactment reads key 18 from the body bytes
(`costModelsOfUpdateMap`, src/consensus/governance/costModelUpdate.ts, bug 59). On this corpus that
reader keeps all three known languages including negatives (100/100 parse) but drops 1 303 language entries (keys ≥ 3)
in 95 of the samples. Gerolamo-side fix, to be made by the owner of
src/consensus/governance (not touched here): keep unknown language keys as raw integer lists in
`RawCostModels` so the stored parameters match `GetCurrentPParams`.

Library fix: let cardano-costmodels-ts take the cbor copy as a peer dependency (one instance), or
duck-type the check (`cObj?.map`); accept `CborNegInt` entries; keep unknown languages.

## 583 — empty bignum magnitude throws (26: plutus_data 14, redeemer 7, datum_option 4, transaction_output 1)

Example: plutus_data `c240` (bignum 0 with an empty magnitude, valid) — "SyntaxError: Failed to
parse String to BigInt".

Root cause: `CborUInt.bigNum` / `CborNegInt.bigNum` (@harmoniclabs/cbor dist/CborObj/CborUInt.js,
CborNegInt.js) compute `BigInt("0x" + toHex(bytes))`, which throws for zero bytes.
Fix: `bytes.length === 0 ? 0n : BigInt("0x" + …)` (negative: −1).

## 584 — Plutus Data re-encoded instead of kept (78: plutus_data 59, datum_option 19)

Example: plutus_data `d87981 01` re-encodes as `d8799f01ff`. The hashed `plutus_data` rule demands
the original bytes; for `datum_option` the reference re-encodes the selector but keeps the inline
datum bytes inside `#6.24`, which normalization does not touch.

Root cause: `dataFromCborObj` builds `Data` without the source bytes and `dataToCbor` writes its
own canonical form (indefinite lists, re-chunked bytes, minimal bignums). ledger-ts's
`ConwayTxOut.toCborObj` re-encodes an inline datum through `dataToCbor` whenever the output has
no `cborRef`. Inside a decoded block the memoized output bytes are re-emitted, so the node's
datum hashes (computed from bytes) are unaffected; anything that rebuilds an output or a witness
set from objects changes datum bytes and hashes.

Fix: keep a `SubCborRef` on `Data` (as ledger-ts does for its own types) and have `dataToCbor` /
the witness-set and output encoders emit it when present.

## 585 — outputs re-emitted where cardano-ledger rebuilds them (21: transaction_output)

15 legacy `[address, amount, datum_hash]` outputs: example `83 581d60<28> 01 5820<32>` re-encodes
as the map `a3 00 … 01 01 02 [0, hash]`; cardano-ledger keeps the legacy array. Root cause:
`ConwayTxOut.fromCborObj` legacy branch builds the output without `getSubCborRef(cObj)` and
`toCborObj` always writes the post-Babbage map. Fix: pass the sub-ref in the legacy branch, or
remember the form and write the array back.

6 map-form outputs with a `script_ref` whose script was indefinite (`#6.24(9f 02 … ff)`):
cardano-ledger re-encodes the script inside the tag-24 payload (`82 02 …`), ledger-ts re-emits
the memoized output. Fix: none needed for the node (the bytes on chain are what matters); a
fully rebuilt encoding would need `Script.toCbor()` without its `cborRef` for the payload.

## 586 — maps / values not re-encoded in cardano-ledger's canonical form (16)

13 TreasuryWithdrawals (gov_action 12, proposal_procedure 1): cardano-ledger stores
`Map RewardAccount Coin` and writes it in `Ord` order (network, then script credentials before key
credentials, then hash); ledger-ts re-emits the original order (memoized). 3 values `[coin, {}]`:
cardano-ledger writes the plain coin; ledger-ts re-emits the array (example `8201a0`, expected
`01`). Root cause: the `cborRef` memo in `GovActionTreasuryWithdrawals.toCbor` /
`Value.toCborObj` (dist/eras/common/ledger/Value/Value.js) — the fresh encoders already do the
right thing for Value (`isAdaOnly` → uint). Fix: these types are not hash preimages; drop the memo
in their `toCbor`, and sort withdrawals by the ledger's order in the fresh encoder.

## 587 — native script integers (5: native_script 4, auxiliary_data 1)

Example: `83 03 20 80` (`atLeast` with n = −1; cardano-ledger decodes `Int`) — rejected "ill formed
native script to deserialize". Root cause: `nativeScriptFromCborObj` (dist/script/NativeScript.js)
requires `CborUInt` for `n`, and stores `required` and `slot` as JS `Number` (`Number(f1.num)`),
so slots above 2^53 lose precision and re-encode differently (seen in auxiliary_data 00014).
Fix: accept `CborNegInt` for `n`, keep both as `bigint`.

## 588 — Shelley / Allegra auxiliary data re-encoded in the Alonzo form (5: auxiliary_data)

Example: `82 a0 80` (`[metadata, native scripts]`) re-encodes as `d90103 a1 00 a0`. Hashed rule:
the auxiliary data hash would change. Root cause: `ConwayAuxiliaryData.fromCborObj` (dist/eras/
conway/tx/ConwayAuxiliaryData.js) array branch decodes into the common object and drops the
sub-ref; `toCborObj` always writes `#6.259({...})`, and re-encodes native scripts as byte strings
(`Script` bytes) with the 587 precision loss. Node impact: none while the memo is present (blocks);
mempool / tx building paths that re-serialize aux data would change its hash. Fix: keep the sub-ref
in every branch; remember the source form.

## 589 — redeemers re-encoded as a definite list (2: redeemers)

Example: `9f 84 00 00 00 82 00 00 ff` re-encodes as `81 84 00 00 00 82 00 00`. Hashed rule (the
script data hash covers the redeemer bytes). Root cause: `witnessRedeemersFromCborObj` returns a
plain `ConwayTxRedeemer[]`; `ConwayTxWitnessSet.toCborObj` key 5 always writes a definite array
(and the map form as an array). Gerolamo computes the script data hash from the witness-set bytes
(scriptDataHash.ts), so the node is unaffected. Fix: keep the redeemers' sub-ref, or a flag for
map vs list form plus the original bytes.

## Gerolamo-side changes

None were needed in Gerolamo's decoders outside the libraries: `headerParser` (header 400/400,
including the null-prev patch path) and `parseMempoolTx` (transaction 394/400; the six it accepts
are chunked strings that `ConwayTx.fromCbor` lets through, 570) are correct on their own. The
improvements come from fixing ledger-ts / cbor / plutus-data / cardano-costmodels-ts (570–589) and
re-vendoring; raise the floors in `cborDecoding.test.ts` after that. The only Gerolamo item is
the unknown-language note in 582 (src/consensus/governance, left to its owner).

## 2026-10-17: 9 200 / 9 200

Item 585's remaining 6 samples (transaction_output 00005, 00012, 00016, 00018, 00019, 00024) are fixed in ledger-ts
`conformance.3`: the `script = [tag, payload]` wrapper inside `#6.24` is re-encoded as a definite array with the
payload bytes kept (Alonzo `encodeScript`), and a decoded `ConwayTxOut` re-encodes from its fields by cardano-ledger's
`EncCBOR (BabbageTxOut era)` rule. The `datum_option` codec in `cborDecoding.ts` now gives its carrier output a
script reference so the output takes the map form and key 2 is the datum option as `EncCBOR (Datum era)` emits it.
