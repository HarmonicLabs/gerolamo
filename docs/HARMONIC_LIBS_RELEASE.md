# HarmonicLabs libraries: release review (2026-10-23)

**For:** Michele, and Roger (his review agent). Everything needed to review and publish the HarmonicLabs library
releases that came out of Gerolamo's conformance work and Gravity's fixes: what changed in each library and why,
what can break for its users, how it was tested, and the order to publish in.

**Compiled by** the Gerolamo Claude agent instance together with the Gravity Claude agent instance (the gravity-sdk
session), which supplied the buildooor and ouroboros-miniprotocols-ts sections and cross-checked the rest.

**How the changes land.** Mike pushes each library's branch straight to its default branch (no pull requests). Review
from this document, from the `CHANGELOG.md` now in each library, and from the commit history (one commit per fix item,
named by its item number). cardano-ledger-ts and cardano-costmodels-ts run their GitHub CI on every push to `main`.
Michele publishes to npm.

## At a glance

| Package | npm today | Release | Breaking for users? | Publish after |
|---|---|---|---|---|
| `@harmoniclabs/cbor` | 2.0.2 | **2.1.0** | No API change; stricter only on invalid input | (first) |
| `@harmoniclabs/cardano-costmodels-ts` | 1.6.1 | **1.7.0** | cbor becomes a peer dependency; invalid input throws | (first) |
| `@harmoniclabs/kes` | not on npm | **0.1.0** | No (first release) | (first) |
| `@harmoniclabs/buildooor` | 0.2.9 | **0.2.10** | No; margins become a `TxBuilder` option | (first) |
| `@harmoniclabs/ouroboros-miniprotocols-ts` | 0.0.5-dev7 | **0.0.6-dev0** | Moves to cbor 2.x; new version line | (first) |
| `@harmoniclabs/plutus-data` | 2.0.1 | **2.1.0** | No API change; decoding stricter (plutus-core rules) | cbor 2.1.0 |
| `@harmoniclabs/cardano-ledger-ts` | 0.5.6 | **0.6.0** | Stricter decoders (lenient mode available), some encodings change | cbor, plutus-data, costmodels |

## 1. Why these changes exist

pragma-org runs the [node-diversity-conformance](https://github.com/pragma-org/node-diversity-conformance) site,
which compares Cardano node implementations on four scenarios: CBOR decoding (9 200 Conway samples that must be
decoded, rejected and re-encoded exactly like cardano-ledger), ledger rules (277 transactions), UPLC conformance
(1 064 programs) and UPLC speed (3 997 mainnet scripts). Gerolamo is built on these libraries, so its score is largely
theirs. Before this work the libraries decoded leniently: 3 950 of 8 334 must-reject samples were accepted, 267 valid
samples re-encoded differently, and every cost model was silently dropped.

After the changes, built with pragma's own `build.py` on the reworked scenarios (their commit `8974561`, site data of
2026-10-18 with Gerolamo's reports added locally):

| Node | CBOR | Ledger rules | UPLC conformance | UPLC speed | Overall |
|---|---|---|---|---|---|
| **Gerolamo** | 9 200 / 9 200 | 277 / 277 | 1 064 / 1 064 | 3 996 / 3 997 | **99.99 %, first** |
| Amaru | 9 200 | 277 | 1 064 | 3 995 | 99.99 % |
| cardano-node | 9 200 | 277 | 1 064 | 3 956 | 99.74 % |
| Dingo | 9 200 | not reported | not reported | not reported | 25 % |

The one speed script Gerolamo misses is missed by every node. Gerolamo's reports are not published on pragma's site
yet; Mike decides when. Before this work Gerolamo scored 4 983 / 9 200 on CBOR and 276 / 277 on ledger rules.

Beyond the scores, the same changes fix real bugs: cost models lost across cbor copies, a datum's hash not matching
the chain after re-encoding, script contexts built with the wrong wrappers, and decoders accepting blocks a Haskell
node rejects.

The rationale behind every individual item, with the cardano-ledger rule it follows, is in this repository:
`docs/parity/ndc-library-changes.md`, `docs/parity/ndc-cbor-decoding.md` (items 570–589) and
`docs/parity/ndc-ledger-rules.md`.

## 2. Versions and builds

Each library branch sets its release version in a release commit together with a new `CHANGELOG.md`. Until the
packages are on npm, Gerolamo, Gerolamino and the Gravity components use builds packed from those branches under the
same plain names (`harmoniclabs-cbor-2.1.0.tgz`, ...), byte-identical across projects. If a different version
number is published, those copies are rebuilt under it; once a version is on npm, the projects switch to it and
drop their tarball. Earlier `+conformance.N` version commits stay in the branch history.

## 3. Publish order

CI installs dependencies from npm, and plutus-data and cardano-ledger-ts only pass against the new cbor:

1. **Now, in any order:** cbor 2.1.0, cardano-costmodels-ts 1.7.0, kes 0.1.0, buildooor 0.2.10,
   ouroboros-miniprotocols-ts 0.0.6-dev0.
2. **After cbor 2.1.0 is on npm:** plutus-data 2.1.0 (its last commit moves the cbor peer dependency to `^2.1.0`).
3. **After cbor, plutus-data and costmodels are on npm:** cardano-ledger-ts 0.6.0 (its last commit moves those three
   to the new versions).

Access: Mike has read-only access to `cbor` (and `shared-cardano-mempool-ts`). For cbor, either grant him write access
or push the branch yourself.

## 4. Library by library

### 4.1 `@harmoniclabs/cbor` 2.0.2 → 2.1.0

Branch `conformance-fixes`: 11 conformance commits on `main`, a compatibility commit and the release commit.
Tests: jest 259 passed, 0 failed. No CI workflow in the repository.

What changed:
- **572** `CborUInt` / `CborNegInt.isBigNum()` reliably says whether a parsed integer came from a `#6.2` / `#6.3`
  bignum (cardano-ledger-ts rejects bignums in fixed-width fields with it). Still a method, as in 2.0.2.
- **570** `CborText.isDefiniteLength`, like `CborBytes.isDefiniteLength`.
- **583** An empty bignum magnitude (`c2 40`) decodes as 0 instead of throwing.
- **576** `CborPositiveRational.fromCborObjOrUndef` accepts only `#6.30([uint, uint])`; new `fromCborObj` throws.
- **584** Parsed tags keep their source bytes and head width, so a datum's bytes survive re-encoding.
- An indefinite-length tag head (`0xdf`) is rejected; it parsed as tag −1 before.

**Breaking changes: none in the API.** Every 2.0.2 export keeps its name and shape. Behaviour differs only on input
that is not valid for its purpose (a rational with another tag, an `0xdf` head, an empty bignum). Details:
`CONFORMANCE.md` and `CHANGELOG.md` in the repository.

### 4.2 `@harmoniclabs/cardano-costmodels-ts` 1.6.1 → 1.7.0

Branch `conformance-fixes`: 3 commits on `main` and the release commit. Tests: jest 46 passed, 0 failed (CI runs jest;
under `bun test` one test that relies on `jest.isolateModules` fails).

What changed: **582** cost models decode like cardano-ledger and round-trip; negative int64 entries accepted;
languages 3–255 kept in `CostModels.unknownLanguages`; the decoders are duck-typed, so a map parsed by another cbor
copy decodes (before, every cost model was silently dropped when two cbor copies met).

**Breaking changes:** `@harmoniclabs/cbor` moves to `peerDependencies` (consumers must have cbor 2.x installed; npm 7+
does it automatically). Invalid input throws instead of being skipped. A known language whose list has an unexpected
length comes back as a raw `bigint[]` (the TypeScript type widens). Valid cost models decode to the same values.

### 4.3 `@harmoniclabs/plutus-data` 2.0.1 → 2.1.0

Branch `conformance-fixes`: 4 commits on `main`, the release commit, and a cbor-bump commit once cbor 2.1.0 is on
npm. Tests: jest 79 passed, 0 failed (against the new cbor).

What changed:
- **573** `dataFromCborObj` follows plutus-core's decoder: constructor tags only 121–127, 1280–1400 and 102;
  `#6.2` / `#6.3` only as bignums over bytes; fields must be a list; byte strings and bignum magnitudes at most 64
  bytes or chunked in pieces of at most 64; trailing bytes rejected.
- **584** Decoded `Data` keeps its source bytes, so `dataToCbor` / `hashData` of a decoded datum match the chain.

**Breaking changes:** no API change. Decoding is stricter, as above. Data the chain accepts, and Data built with this
library's constructors, still decode (checked: 100-byte strings, 2^80 integers, constructors 7 and 200, maps).
Re-encoding a decoded value returns its original bytes; values built with constructors encode as before.

### 4.4 `@harmoniclabs/cardano-ledger-ts` 0.5.6 → 0.6.0

Branch `conformance-merge`: the `conformance-fixes` line merged with `main` 0.5.6, four follow-up commits, the
changelog commit, and, once the dependencies are on npm, a dependency bump. Tests: jest 232 passed, 0 failed (`main`
alone: 177). Gerolamo's whole test suite on this build: 1 730 passed, 0 failed, including the Cardano Blueprint ledger
vectors (2 574 / 2 574) and the pragma CBOR and ledger-rules corpora.

What it brings:
1. **The Dijkstra era** (commit `22ee547`, never on GitHub before): the CDDL of cardano-ledger-dijkstra 0.4.0.0
   (12-field header, `[txs, leios, peras]` body, sub-transactions, guards, direct deposits, balance intervals, BLS
   pool keys, `hashTx`), with earlier unreleased work: MIR decoding, pre-protocol-9 duplicate multi-asset keys, Conway
   body keys 19–22 with all seven governance actions, Byron address construction from keys.
2. **23 conformance commits**, one per item: strings and records definite where cardano-ledger wants them, bignums
   rejected in fixed-width integers, Word16/32/64 ranges, CDDL size bounds, exact arities, tag checks, trailing bytes
   rejected, duplicate keys / empty asset maps / zero quantities rejected from protocol 9, era-gated certificates,
   canonical Value and withdrawals, redeemers and scripts re-encoded as cardano-ledger does, and `TxOut` / `Script`
   re-encoding exactly like cardano-ledger.
3. **The merge with `main` 0.5.6**: upstream's Byron address redesign kept as is (`ByronAddress extends Address`,
   `byronType`, `toBuffer()`), this branch's builders (`computeRootHash`, `fromPublicKey`, `fromRedeemPublicKey`)
   re-added on top; the `totCollateral` guard; CI.
4. **Three bug fixes** that the CI runner (jest) exposed: a CommonJS import cycle that kept three Dijkstra test files
   from loading; a double `StakingHash` wrap on V1/V2 withdrawal keys in script contexts; a golden test that named the
   wrong cause.
5. **Opt-in lenient decoding** (below).

**Breaking changes:**
- Decoders reject what cardano-ledger rejects. Valid chain bytes decode as before; hand-built or non-canonical CBOR
  may now be rejected.
- Era-specific decoders apply their era's protocol version; the era-agnostic `TxOut.fromCbor` decodes at protocol 7
  unless a context is set (`withDecodeVersion`).
- Decoded values re-emit their source bytes where cardano-ledger keeps bytes; outputs without a datum or script
  reference encode in the compact array form, so transaction builders may produce slightly different, valid bytes.
- `StakeCredentials.toData` returns the `StakingCredential` in every Plutus version, so `Address.toData` gives
  `Just (StakingHash cred)` for V1/V2 as the ledger does (0.5.6 omitted the wrapper, so V1/V2 script contexts of
  staked addresses change bytes).
- `ByronAddress`: the 0.5.6 API (`type` is `"byron"`, `byronType`, `toBuffer()`); that break shipped with 0.5.6.

**Opting out of the strict decoders:** `withLenientDecoding(fn)`, `withDecodeStrictness("lenient", fn)` or
`setDefaultDecodeStrictness("lenient")`, exported from the package root with `withDecodeVersion` and friends. They
relax the CBOR form checks so data 0.5.x could read still reads; field types, hash sizes, required fields and era
rules stay enforced. Strict is the default. Never use lenient decoding to judge validity.

**Known gap, not in this release:** the Dijkstra balance-interval fields follow an earlier draft of the Dijkstra CDDL
(reward-account keys); cardano-ledger master keys them by credential. Dijkstra is on no network yet.

### 4.5 `@harmoniclabs/kes` 0.1.0 (first npm release)

Repository kes-ts, `master` plus one local commit, the KES-agent work and a merge of the README commit `master` gained
upstream. Tests: 25 passed, 0 failed.

What it adds: `setEd25519Verify` (plug a fast raw ed25519 verifier into the KES leaf check), and `src/ops/`:
cardano-cli compatible text envelopes, Sum6 key evolution, the operational certificate's remaining life, and rotation
with the counter rule. The keys under `tests/vectors/cardano-cli/` are throwaway test keys (pool id `61f4231c…`), not
any real pool's. Gerolamo's preview block producer runs this code. **Breaking changes:** none (additions only).

### 4.6 `@harmoniclabs/buildooor` 0.2.9 → 0.2.10 (from the Gravity agent)

Eight commits on `main` (jest 55 passed): Conway tiered reference-script fee (1.2× per 25 600-byte tier); no redeemer
for native-script minting policies; fee and ex-unit margins as a `TxBuilder` constructor option instead of
`process.env` (the previous Gravity build underpaid the script fee); `TxBuilderRunner.attachMemo` registered; three
script-context fixes from Gerolamo (validity-interval bounds as the ledger passes them, `TxInfo` redeemers in
(tag, index) order, V1/V2 Rewarding purpose wrapped in `StakingHash`); and the 0.2.10 release commit with its
changelog. **Breaking changes:** none in the API for anyone upgrading from npm 0.2.9 (published 0.2.9 never read
the `BUILDOOOR_*_MARGIN` environment variables; only Gravity's private build did, and gravity-sdk 0.1.0 now passes
the margins as options). Two behaviour changes: fees rise, to what the ledger requires, for transactions with more
than 25 600 bytes of reference scripts; and the three script-context fixes change what scripts see during local
evaluation, which now matches the chain.

### 4.7 `@harmoniclabs/ouroboros-miniprotocols-ts` → 0.0.6-dev0 (from the Gravity agent)

Branch `cbor-2x-compat`: the cbor 2.x port of every message class, era-wrapped LocalTxSubmit and TxMonitor replies,
TxMonitor message indices, the peer-sharing IPv6 address decode fix (`e62e65c`, missing from the earlier Gravity
build), Gerolamo's `HandshakeServer` (version negotiation with a network-magic check; `propose()`
rejects on a multiplexer error instead of hanging), and the release commit with its changelog. Tests: 38 passed.

**Publish as a new line (0.0.6-dev0), never over 0.0.5-dev7.** npm 0.0.5-dev7 contains APIs that are on no GitHub
branch (the handshake n2c/n2n split, `NetworkMagic`, `TxSubmitReplyTx`); a release from `main` removes them for anyone
upgrading from dev7. If you have the dev7 source, please say where it is. **Breaking changes:** consumers move from
cbor 1.x objects to cbor 2.x objects. Follow-up from Gerolamo: its patches on dev7 (multiplexer framing, BlockFetch
client, IPv6 peer addresses) and two handshake fixes (string version keys against a number-only guard; v15 missing from
the default lists).

## 5. Not included, on purpose

- **shared-cardano-mempool-ts:** 14 uncommitted files of unknown origin (a spelling rename
  `getAviableSpace` → `getAvailableSpace` and dependency bumps). Gerolamo calls the old name; if the rename ships, keep
  the old one as an alias.
- **gravity-sdk:** Gravity's own package; its 0.1.0 build exists, the repository stays on its current branch until
  Mike's test harness is ported.
- **Library bugs found but not fixed** (by the Gerolamino browser-node rebuild): `@harmoniclabs/crypto` ed25519
  accepts an identity key with S = 0, S + L and non-canonical points; VrfProof03 accepts a non-canonical scalar;
  BLS12-381 point decompression accepts x ≥ p; the miniprotocols handshake issues listed in 4.7.

## 6. How to check the claims

In each library repository, on its branch:

```bash
npm ci && npx jest          # cbor 259, cardano-costmodels-ts 46, plutus-data 79 (needs cbor 2.1.0), buildooor 55
bun test                    # kes-ts 25
npm ci && npm test          # cardano-ledger-ts 232 (needs cbor, plutus-data, costmodels on npm)
```

The conformance scores, reproduced end to end from this repository: `docs/parity/ndc-run.md`.
