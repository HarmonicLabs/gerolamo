# vendor/

Tarballs of HarmonicLabs libraries that Gerolamo depends on but that are not
published to npm in the form Gerolamo needs. They are committed so a fresh
clone installs with plain `bun install` and no sibling checkouts.

Upstreaming these libraries, and coordination with other HarmonicLabs projects that use them, is tracked outside
this repository, in the HarmonicLabs workspace root: `LIBS_UPSTREAM_NOTE.md` (everything Gerolamo carries and what
must happen before each tarball can go) and `COORDINATION-GRAVITY.md` (shared with the Gravity DEX session).

Every tarball here is byte-identical to the one canonical build of its package in the workspace's `libs/` folder
(`../libs/check.sh ../gerolamo` checks it). Names follow `libs/`'s rule: the plain version each build will be
published as (set in its source branch, with a `CHANGELOG.md`); what the work was for goes in the changelog, never in
the name.

| Tarball | Source |
|---|---|
| `harmoniclabs-kes-0.1.0.tgz` | HarmonicLabs/kes-ts, `master` plus the KES-agent operations (branch `kes-agent-ops` in the merge plan) |
| `harmoniclabs-cardano-ledger-ts-0.6.0.tgz` | HarmonicLabs/cardano-ledger-ts, branch **`conformance-merge`**: `conformance-fixes` merged with `main` 0.5.6, plus its follow-up commits (see below) |
| `harmoniclabs-cbor-2.1.0.tgz` | HarmonicLabs/cbor, branch **`conformance-fixes`** (`isBigNum()` stays a method, as in 2.0.2) |
| `harmoniclabs-plutus-data-2.1.0.tgz` | HarmonicLabs/plutus-data, branch **`conformance-fixes`** |
| `harmoniclabs-cardano-costmodels-ts-1.7.0.tgz` | HarmonicLabs/cardano-costmodels-ts, branch **`conformance-fixes`** |
| `harmoniclabs-shared-cardano-mempool-ts-*.tgz` | HarmonicLabs shared mempool |

## The `conformance-fixes` libraries (2026-10-15)

The four `+conformance` tarballs make the ledger decoders as strict and as lossless as
cardano-ledger's, so Gerolamo passes pragma-org's
[node-diversity-conformance](https://github.com/pragma-org/node-diversity-conformance)
scenarios: CBOR decoding 9 200 / 9 200 (was 4 983) and ledger rules 277 / 277 (was 276).
Each library's changes live on a branch named `conformance-fixes` in its repository, one commit
per item; the item numbers (570–589) refer to `docs/parity/ndc-cbor-decoding.md`.

| Library | Branch base | What changed |
|---|---|---|
| cbor | 2.0.2 (remote `main`) | `isBigNum()` reliable on parsed integers (still a method), empty bignum magnitude decodes, rationals need tag 30, tags keep their source bytes and head width, indefinite tag heads rejected |
| plutus-data | 2.0.1 (remote `main`) | Data decoded exactly like cardano-ledger (tags, 64-byte bytes, trailing bytes); decoded Data keeps and re-emits its source bytes |
| cardano-costmodels-ts | 1.6.1 (remote `main`) | cbor as peer dependency and duck-typed decoding (cost models were dropped across cbor copies), negative entries, languages ≥ 3 kept |
| cardano-ledger-ts | the exact source of `0.6.0-dijkstra.1` (first commit on the branch), i.e. `main` with its then-uncommitted work plus the Dijkstra era | definite-length strings and records, bignums rejected in integer fields, CDDL size bounds, exact arities and full-input parsing, tag checks, ranges, protocol-version-gated rules (v9, v12) as in cardano-ledger, re-encoding that keeps source bytes, empty input set accepted; era-agnostic `TxOut` decodes stored outputs of every era; `.3`: outputs and the `[tag, payload]` script wrapper re-encode exactly as cardano-ledger (`encodeTxOut` map vs compact array, payload bytes kept) |

**0.6.0 (2026-10-23)** is the same conformance line merged with upstream `main` 0.5.6 (Byron address API of
0.5.6: `byronType`, `toBuffer()`; Gerolamo reads both through `src/consensus/byron/byronAddressCompat.ts`), with the
V1/V2 withdrawal-key fix, a CommonJS load-order fix and opt-in lenient decoding (`withLenientDecoding`; Gerolamo
stays strict). With the release-named builds installed (cbor 2.1.0, plutus-data 2.1.0, costmodels 1.7.0, ledger-ts 0.6.0, kes 0.1.0): `bun test src` 1 730 pass / 0 fail, including
the CBOR 9 200 / 9 200 and ledger-rules 277 / 277 corpus floors.

Verified earlier with `+conformance.3` installed: `bun test src` 1 678 pass / 0 fail, Cardano
Blueprint ledger vectors 2 574 / 2 574 on both paths, and the whole preview chain
(4 742 667 blocks) decodes and re-encodes byte for byte and passes the body rules
(`scripts/utxo-rules-replay.ts`).

### How they are wired

Gerolamo itself, `ouroboros-miniprotocols-ts` and `buildooor` stay on root `@harmoniclabs/cbor`
1.6.6 and `plutus-data` 1.2.6. Only the 2.x consumers get the conformance builds, through
range-keyed `overrides` in `package.json`:

```json
"overrides": {
    "@harmoniclabs/cbor@^2": "file:vendor/harmoniclabs-cbor-2.1.0.tgz",
    "@harmoniclabs/plutus-data@^2": "file:vendor/harmoniclabs-plutus-data-2.1.0.tgz",
    "@harmoniclabs/cardano-costmodels-ts": "file:vendor/harmoniclabs-cardano-costmodels-ts-1.7.0.tgz"
}
```

cardano-ledger-ts then nests the conformance cbor and plutus-data (shared with its nested uplc 2.x
and plutus-machine 3.x). The release versions (cbor 2.1.0, plutus-data 2.1.0, costmodels 1.7.0) satisfy
the ranges other packages ask for (`^2.0.1`, `^1.6.1`).

### Earlier cardano-ledger-ts tarballs

0.5.5 adds `ByronAddress.fromRedeemPublicKey`; 0.5.6 fixes MIR certificate decoding (`fromCborObj`
accepts the whole `[6, [source, destination]]` the dispatcher passes); 0.5.7 decodes multi-asset maps
with duplicate policy / asset-name keys the way the Haskell ledger does before protocol 9 (later entry
wins) instead of rejecting the block; 0.5.8 decodes Conway body keys 19–22 (voting procedures,
proposal procedures, current treasury value, donation) with decoders for all seven governance actions;
0.6.0-dijkstra.1 implements the Dijkstra CDDL of cardano-ledger-dijkstra 0.4.0.0 (12-field header,
`[txs, leios, peras]` block body, sub-transactions, guards, direct deposits, balance intervals, BLS
pool keys, `hashTx`; diff in `docs/parity/dijkstra-ledger-ts.patch`). The conformance build is
0.6.0-dijkstra.1 plus the `conformance-fixes` commits; 0.6.0 adds the merge with upstream 0.5.6.

## Refreshing a tarball

After changing a library: set the version it will be published as (and its CHANGELOG entry),
run `scripts/vendor-pack.sh <library dir>`, replace the canonical build in `../libs/` with it, update the spec in `package.json` (and the
override, for cbor / plutus-data / costmodels) to the new filename, delete the old tarball and
`bun install`. Bun keeps the old content under an unchanged filename, so always bump. The pack
script folds peerDependencies into dependencies and builds `dist/` first. Remove a tarball here
once the package is on npm and the spec points at a registry version.
