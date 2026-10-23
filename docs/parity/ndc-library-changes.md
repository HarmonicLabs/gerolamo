# What was changed for pragma's node-diversity-conformance tests, and why

pragma-org's [node-diversity-conformance](https://github.com/pragma-org/node-diversity-conformance) site compares
Cardano node implementations on four scenarios. Each node runs the scenario itself and publishes a JSON report;
the site only renders them. This page records what Gerolamo and the HarmonicLabs libraries had to change to score
on every scenario, library by library, and what the scores mean. Dated 2026-10-17; standings and upstream status
updated 2026-10-23.

## The four scenarios and Gerolamo's standing

| Scenario | What it checks | Gerolamo | Others |
|---|---|---|---|
| `cbor-decoding` | 9 200 samples of corpus `conway-123-100`: 866 valid encodings must decode and re-encode to the reference bytes; 1 634 generated invalid and 6 700 mutated ("zapped") ones must be rejected | **9 200 / 9 200** | Amaru, cardano-node and Dingo 9 200 (Amaru had 8 598 before pragma's rework) |
| `ledger-rules` | 277 raw Conway transactions applied to a declared state; accept or reject with cardano-ledger's exact predicate name | **277 / 277** | Amaru 277, cardano-node 277 |
| `uplc-conformance` | 1 064 Plutus programs with their cost models per protocol version: result term and budget | **1 064 / 1 064** | Amaru 1 064, cardano-node 1 064 |
| `uplc-turbo` | 3 997 mainnet scripts: mean pure-evaluation time of the best 30 of 50 runs within 2 × the CPU budget (1 unit = 1 ps) or under 200 µs, and budgets that agree with the other nodes | **3 996 / 3 997**, budgets equal to cardano-node's on 3 997 / 3 997 | Amaru 3 995, cardano-node 3 956 |

These are the scenarios as pragma reworked them on 2026-10-18 (their commit `8974561`). Built with pragma's own
`build.py`, Gerolamo is first at 99.99 %, Amaru 99.99 % with one script fewer on turbo, cardano-node 99.74 %,
Dingo 25 %. The one turbo script Gerolamo misses (`8100C5F1…`) every node misses. Gerolamo started this work at
4 983 / 9 200, 276 / 277 and 1 051 / 1 059. The reports are not published yet (the operator decides when).
The sections on `uplc-turbo` below describe the earlier 24-script version of the scenario; `ndc-uplc.md` has the
reworked one.

## Libraries modified

All four live on a branch named `conformance-fixes` in their repository and are vendored into Gerolamo as
`vendor/*+conformance.N.tgz` (see `vendor/README.md` for the wiring: Gerolamo's own root `@harmoniclabs/cbor`
stays 1.6.6; the 2.x consumers get these builds through `package.json` `overrides`).

### `@harmoniclabs/cardano-ledger-ts` → `0.6.0-dijkstra.1+conformance.3` (26 commits)

The branch starts from a baseline commit holding the exact source of the previously vendored `0.6.0-dijkstra.1`
(the `main` working tree with its then-uncommitted work, plus the Dijkstra era). Every later commit is a
conformance change, named by the item numbers of `ndc-cbor-decoding.md`.

**Why.** The library decoded leniently: it read the fields it needed and ignored the rest. 3 950 of the 8 334
must-reject samples were accepted, and 267 valid samples re-encoded differently from cardano-ledger. The
`cbor-decoding` scenario asks for cardano-ledger's exact acceptance boundary and exact re-encoding.

**What.**
- **Strings and records.** Byte and text strings must be definite-length outside Plutus Data and metadata (item
  570); the records cardano-ledger decodes with `RecD` (anchor, governance action id, voting procedure, proposal,
  ex-units, prices, `[coin, multiasset]`, redeemer tuples) must be definite arrays (571). Both rules are gated on
  the protocol version like cardano-ledger: Dijkstra (12) accepts chunked strings and indefinite records again.
- **Integers.** Fixed-width integer fields reject bignums (572; uses the new `isBigNum` flag from cbor); Word16 /
  Word32 / Word64 ranges for output indexes, ports, votes, amounts (579, 580).
- **Sizes.** CDDL `.size` bounds: 28- and 32-byte hashes (575), metadata strings 64 bytes, URL and DNS 128 bytes
  from protocol 9 (64 before), IPv4 4 and IPv6 16 bytes (574).
- **Tags and types.** Tag numbers compared where a tag is expected (24 datum / script reference, 30 rational, 258
  set, 259 Alonzo auxiliary data) and rejected elsewhere (576); fields of the wrong type throw instead of being
  dropped (577); protocol-parameter updates validated field by field, rationals reduced like Haskell's `%` (578).
- **Structure.** Exact arities; every `fromCbor` entry point rejects trailing bytes (581); duplicate map and set
  keys, empty asset maps and zero quantities rejected from protocol 9 (586); certificate tags gated by era (657779d).
- **Re-encoding.** Decoded values re-emit their source bytes where cardano-ledger keeps bytes (Data, scripts'
  payloads, metadata) and rebuild where cardano-ledger rebuilds: Value in canonical form, treasury withdrawals in
  `Ord` order, redeemers' bytes kept (586, 588, 589). The last six samples needed `ConwayTxOut` to re-encode from
  its fields by cardano-ledger's `EncCBOR TxOut` rule (compact array when there is no inline datum and no script,
  else the keyed map) and `Script` to rebuild its `[tag, payload]` wrapper as a definite array with the payload
  bytes kept (585; commits 6496c58 and 4b11427).
- **Ledger rules fixture 00074.** An empty input set must decode (cardano-ledger accepts it; the rule
  `InputSetEmptyUTxO` rejects it later).
- **Two fixes found by the checks, not by the corpus.** The era-agnostic `TxOut.fromCbor` (used on stored UTxO
  outputs of any era, e.g. Mithril import) applied Conway's rules and rejected a Mary output with a zero-quantity
  asset, legal before protocol 9; it now decodes at version 7 unless an era context is set. The Dijkstra script
  tests decode in a protocol-12 context.

**Node impact.** None on block validation: blocks, transactions and bodies re-emit their own bytes;
reference-script sizes and hashes come from each output's source bytes, which the decoded output still carries.
Verified by the Blueprint vectors (2 574 / 2 574), a 200 000-block decode / re-encode replay (0 problems) and the
full-chain rules replay (4 742 667 blocks, 0 failures).

**Compatibility for other users of the library (added 2026-10-23, on the merge branch for upstream).** Valid chain
data decodes as before, but hand-built or non-canonical CBOR may now be rejected. For tools that must read such data,
the merge branch adds an opt-in lenient mode: `withLenientDecoding(fn)`, `withDecodeStrictness("lenient", fn)` or
`setDefaultDecodeStrictness("lenient")`, exported from the package root. It relaxes the CBOR form checks (indefinite
strings and records, bignums and ranges in fixed-width integers, extra elements, missing tags, duplicates, empty sets,
text bounds, trailing bytes) and keeps field types, hash sizes, required fields and the era rules. Strict stays the
default; Gerolamo never uses the lenient mode for validation.

### `@harmoniclabs/cbor` → `2.0.2+conformance.1` (11 commits)

**Why.** ledger-ts needed to know what the parser had seen, and the parser itself threw on a valid encoding.
- `CborUInt` / `CborNegInt.isBigNum()` tells whether the integer came from a `#6.2` / `#6.3` bignum, so ledger-ts
  can reject bignums in fixed-width fields (572). The vendored `+conformance.1` build made it a read-only property;
  the branch for upstream keeps it a method, as in 2.0.2, so callers do not break (ledger-ts reads it either way).
- `CborText.isDefiniteLength` is typed and documented beside `CborBytes.isDefiniteLength` (570).
- An empty bignum magnitude (`c2 40`) decodes as 0 (negative: −1) instead of throwing (583; 26 corpus samples).
- `CborPositiveRational.fromCborObjOrUndef` accepts only `#6.30([uint, uint])`; a new `fromCborObj` throws (576).
- Parsed `CborTag`s keep their source bytes and head width, so a datum's bytes survive re-encoding (584).
- An indefinite-length tag head (`0xdf`) is rejected; it used to parse as tag −1.

### `@harmoniclabs/plutus-data` → `2.0.1+conformance.1` (4 commits)

**Why.** Plutus Data is the one place cardano-ledger allows chunked strings and bignums, with its own limits, and
the hash of a datum is the hash of its original bytes.
- `dataFromCborObj` follows plutus-core's decoder (573): tags other than 121–127, 1280–1400 and 102 are rejected;
  `#6.2` / `#6.3` only as bignums over bytes; constructor fields must be a list; byte strings and bignum magnitudes
  at most 64 bytes, or chunked with each chunk at most 64; `dataFromCbor` rejects trailing bytes.
- Decoded `Data` keeps its source bytes (in a `WeakMap` behind a read-only `cborRef` getter, so equality and JSON
  are unaffected) and `dataToCbor` / `hashData` reproduce them (584). Values built with the constructors encode
  exactly as before.

### `@harmoniclabs/cardano-costmodels-ts` → `1.6.1+conformance.1` (3 commits)

**Why.** Every cost model in the corpus was dropped (item 582, 114 samples), and protocol-parameter updates lost
their cost models.
- `@harmoniclabs/cbor` becomes a peer dependency, and the decoders are duck-typed, so a map parsed by another cbor
  copy (ledger-ts's) no longer fails the `instanceof` check that made the library return nothing.
- Negative int64 entries are accepted; languages 3–255 are kept in `CostModels.unknownLanguages`; a known
  language whose list is not the expected length stays a raw `bigint[]`; invalid input throws instead of being
  skipped; the encoder round-trips.
- Also fixed in ledger-ts: `partialProtocolParametersToCborObj` checked `'PlutusV1'` where the key is
  `'PlutusScriptV1'`, so cost models were never re-encoded.

## Gerolamo itself

### Ledger rules (`src/mempool`, `src/consensus/rules`), bugs 530–535

The `ledger-rules` fixtures are judged on both of Gerolamo's paths: the mempool (LocalTxSubmission, which names
failures in cardano-node's `ApplyTxErr` wire form) and the block rules. The fixtures found:
- **530** every Plutus tag mismatch encoded as `FailedUnexpectedly`; a transaction marked invalid whose scripts pass
  must be `PassedUnexpectedly`.
- **531** CERTS, GOV and withdrawal-account checks ran for `is_valid = false` transactions, and the mempool overlay
  spent their inputs instead of their collateral.
- **532** `OutsideForecast` was not checked.
- **533** a bootstrap witness with a bad signature was missing from `InvalidWitnessesUTXOW`.
- **534** block validation checked only the collateral of a transaction marked invalid; cardano-ledger runs the
  whole UTXOW / UTXO rule and skips only CERTS, GOV and the withdrawal / treasury checks. A block carrying an
  invalid-marked transaction that broke a phase-1 rule would have been accepted by Gerolamo and rejected by
  cardano-node.
- **535** the block's `maxBlockExUnits` sum left out invalid-marked transactions.

Names are mapped to the corpus vocabulary (it drops `DELEG` suffixes and `Conway` prefixes, and spells a few
constructors differently); the table is in `ndc-ledger-rules.md`.

### Plutus (`src/consensus/plutus`), bugs 550–551 and the speed work

- **550** text programs skipped the version and builtin-availability checks; **551** the text parser lacked the old
  `verifySignature` alias. Both affect only the text tooling used by the conformance vectors; the on-chain flat
  path had no bugs on either corpus.
- **Speed, round 1.** Iterative flat decoder (a 200 000-deep term no longer overflows the stack, truncated input
  no longer hangs or reads past the end: both were consensus-relevant), CEK with a parallel-array frame stack,
  positional builtin arguments, table-driven step costs.
- **Speed, round 2.** Programs decode into typed arrays (node kinds and operands, side tables for constants) with a
  table-driven header loop; the CEK runs on node indices. Decode is 3.5–5× faster than before, evaluation 2.2×;
  median time-to-budget ratio over the 24 scripts 2.79 → 0.65–0.83; per-redeemer verdicts and budgets identical on
  50 537 real preview redeemers. Every remaining `uplc-turbo` miss is one sample hit by a 0.5–1 ms JavaScriptCore
  eden collection; nothing is done to hide it.

### Harnesses, tooling, docs

`src/conformance/ndc/` holds one harness per scenario and `scripts/ndc/` the CLIs: `cbor-decoding.ts`,
`ledger-rules.ts`, `uplc-conformance.ts`, `uplc-turbo.ts`, `uplc-validate-report.ts`, plus `fetch-corpora.ts`
(gets every corpus), `report-all.ts` (all four reports with release-asset names, schema-validated, refuses a dirty
tree) and `publish.ts` (GitHub release, guarded). The node entry for pragma's repository is in `ndc-node-entry/`.
How to run: `ndc-run.md`. How to publish: `ndc-publish.md`. Per-scenario details: `ndc-cbor-decoding.md`,
`ndc-ledger-rules.md`, `ndc-uplc.md`.

## Still open

- `uplc-turbo` 24 / 24 would need a GC-pause-free sample window; Amaru fails the same script we sometimes miss.
- ledger-ts: the era-specific `BabbageTxOut` / `DijkstraTxOut` / `AlonzoTxOut` and the witness-set-decoded Plutus
  scripts still use the older re-encoding paths (outside the Conway corpus).
- Upstream: the `conformance-fixes` branches are local and not yet merged. The merge plan, with the
  cardano-ledger-ts merge against upstream 0.5.6 already prepared, is in the HarmonicLabs workspace root
  (`LIBS_MERGE_GEROLAMO.md`, pull request texts in `libs/merge/`).
