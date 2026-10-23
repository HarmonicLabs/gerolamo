# Publishing to pragma-org/node-diversity-conformance

The site (https://github.com/pragma-org/node-diversity-conformance) runs nothing itself. Each node publishes one
JSON report per scenario and lists where to download them in `nodes/<id>/metadata.json`. Gerolamo's entry,
ready to copy into their `nodes/gerolamo/`, is in `docs/parity/ndc-node-entry/` (metadata, README, logo). It
points at GitHub release assets of HarmonicLabs/gerolamo named `gerolamo-*-<scenario>.json`; the build picks the
asset with the latest `YYYYMMDD` in its name, so every release of reports must carry the date.

Nothing below runs on its own. Publishing is an outward action: the operator says when.

## 1. Produce the reports from a clean commit

```
bun scripts/ndc/fetch-corpora.ts --dir ~/ndc-corpora
taskset -c <two idle cores> bun scripts/ndc/report-all.ts --corpora ~/ndc-corpora --out <dir>
```

It refuses a dirty tree: a report names the commit it came from, and a reader must be able to check it out.
It validates every report against the scenario schema (pragma's repository at 8974561), scores it the way the
site's `build.py` does, and writes `manifest.json` with sha256 digests, our totals, the site's scores and the
metadata the schemas no longer admit in a report: the uplc-conformance and uplc-turbo reports may carry nothing
beyond their fields (`implementation` is `{name}`, plus `language` for turbo), so Gerolamo's version and commit,
the corpus revision and digest, the cost models and the turbo setup are in the manifest and in the release notes
`publish.ts` writes from it. The cbor-decoding and ledger-rules reports still carry `implementation.version/commit`,
`corpus` and `totals`.

Inputs and where they come from:

Inputs (all fetched by `fetch-corpora.ts` into `--corpora`, digests and commits in its `corpora.json`; each can be
overridden with `--ndc`, `--cbor-dataset`, `--uplc`, `--turbo`):

| Input | Source |
|---|---|
| `ndc/` | `pragma-org/node-diversity-conformance` at 8974561 (schemas, ledger-rules fixtures, uplc-conformance expectations) |
| `cbor-dataset/` | `etorreborre/cardano-cbor-dataset`, branch `etorreborre/feat/normalization`, `dataset/conway-123-100` |
| `uplc-conformance/` | pragma's `uplc-conformance.tar.zst` (1 064 vectors with their cost models), sha256 `8bd4ad4f…` |
| `uplc-turbo/` | pragma's `turbo.tar.zst` (3 997 mainnet scripts by epoch), sha256 `821af55e…` |

The site scores turbo against the 3 997 scripts its schema enumerates (the `turbo.tar.zst` corpus); a script
outside that list cannot be in a valid report (`uplc-turbo.ts --schema` leaves it out and lists it). The turbo
budgets must also agree with the majority of nodes (cardano-node breaking ties): `report-all.ts` compares them with
cardano-node's report when pragma's build has downloaded it (`<ndc>/_site/reports/uplc-turbo/cardano-node.json`).

## 2. Check the numbers

Expected on 2026-10-18: cbor-decoding 9 200 / 9 200, ledger-rules 277 / 277, uplc-conformance 1 064 / 1 064
(budget 750 / 750, the site's expectations agreeing on every vector), uplc-turbo budgets 3 997 / 3 997 equal to
cardano-node's and 3 995 / 3 997 within the site's cpu rule on a quiet machine (one run; do not pick the best of
several; see `docs/parity/ndc-run.md`). Compare with `docs/VALIDATION_STATUS.md`; a drop is a regression, not a
publishing step.

## 3. Publish the release (operator's go)

```
bun scripts/ndc/publish.ts --dir <dir> --tag v<version>-conformance-<YYYYMMDD>          # dry run
bun scripts/ndc/publish.ts --dir <dir> --tag v<version>-conformance-<YYYYMMDD> --yes    # creates the release with gh
```

It refuses when the manifest's commit is dirty, is not HEAD, or is not pushed. The release is marked
pre-release; the site does not care.

## 4. Add the node to the site (operator's go)

Fork pragma-org/node-diversity-conformance, copy `docs/parity/ndc-node-entry/` to `nodes/gerolamo/` (the node entry
format — `id`, `name`, `language`, `repository`, `website`, `color`, `reports` — is unchanged at 8974561), build
locally (their `scripts/build.py`; the `runpy` line in `docs/parity/ndc-run.md` runs it under `python3 -I`) to see
the downloaded reports render, open the pull request.

## 5. Later releases

Re-run step 1 at the new commit with a new date, step 3 with a new tag. The site picks the newest date on
its next build; no change to the pull request is needed.
