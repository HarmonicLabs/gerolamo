# Running pragma's conformance tests yourself

Everything runs under Bun from the Gerolamo checkout. Three commands: fetch the corpora, produce the reports, build
pragma's site locally to see the ranking.

## 1. Fetch the corpora (once; ~400 MB download)

```
bun scripts/ndc/fetch-corpora.ts --dir ~/ndc-corpora
```

It clones pragma's site repository at the pinned commit (`8974561`: schemas, ledger-rules fixtures, the
uplc-conformance expectations, `build.py`), the CBOR corpus, and downloads and unpacks the two UPLC corpora of the
reworked scenarios, sha256 checked: `turbo.tar.zst` (3 997 mainnet scripts under epoch directories, into
`uplc-turbo/`) and `uplc-conformance.tar.zst` (1 064 vectors with their cost models, into `uplc-conformance/`).
The `.zst` archives are decompressed in-process (no `zstd` binary needed); `git`, `curl` and `tar` must be on PATH.
`corpora.json` records what is there, with digests and commits; step 2 reads it. Re-running updates the clones and
skips an archive already there with the right digest. Nothing downloaded is ever executed.

## 2. Produce the four reports

```
taskset -c 0,10 bun scripts/ndc/report-all.ts --corpora ~/ndc-corpora --out ~/ndc-reports --allow-dirty
```

About two minutes, most of it the turbo benchmark (3 997 scripts × 50 timed evaluations after a short JIT warm-up,
see below). Each report is validated against pragma's schema (commit 8974561
of their repository) and two scores are printed per scenario: ours (the harness's own verdicts against the corpus)
and the site's (what pragma's `build.py` will compute from the report, `src/conformance/ndc/ndcScore.ts`). The turbo
budgets are also compared with cardano-node's report when pragma's build has downloaded it into
`<ndc>/_site/reports/uplc-turbo/cardano-node.json` (step 3 does that; `--turbo-reference <file>` names another).
`manifest.json` has the digests, both scores and, per report under `metadata`, what the schemas no longer let a
report carry: the uplc-conformance and uplc-turbo schemas allow nothing beyond their fields, so Gerolamo's version
and commit, the corpora's digests, the cost models and the turbo setup live only there (the cbor-decoding and
ledger-rules reports still carry `implementation.version/commit`, `corpus` and `totals`). `--allow-dirty` is for a
local run on an uncommitted tree; a report meant for publishing must come from a clean commit, and `report-all.ts`
refuses otherwise. `--ndc`, `--cbor-dataset`, `--uplc` and `--turbo` override the directories `--corpora` implies.

Expected on 2026-10-18 (schemas 8974561, archives `821af55e…` / `8bd4ad4f…`): cbor-decoding 9 200 / 9 200;
ledger-rules 277 / 277; uplc-conformance 1 064 / 1 064 (budget 750 / 750), the site's expectations agreeing on every
vector; uplc-turbo budgets equal to cardano-node's on 3 997 / 3 997 scripts and 3 995 / 3 997 within the site's
cpu rule (cardano-node's own report passes 3 956, Amaru's 3 995; three to five scripts near the 2× line move
across it between runs, see below).

### The speed benchmark needs a quiet machine

The site passes a script when its mean pure evaluation time (`cpu_us`) is within 2 × its budget (1 CPU unit =
1 ps) or within 200 µs of it, and when its budget agrees with the majority of nodes. Anything else running on the
same core (or its SMT sibling) shows up as a slow script. Pin the run to two idle physical cores so the runtime's GC
and JIT helper threads do not compete with the evaluator:

```
mpstat -P ALL 2 1                       # pick two idle cores from different pairs (siblings: /sys/devices/system/cpu/cpuN/topology/thread_siblings_list)
taskset -c 0,10 bun scripts/ndc/report-all.ts ... --only turbo ...
```

The harness decodes each script once, warms the JIT on a small set of scripts (the first 64 plus the first 8 of
each language; at least 3 passes and 3 s), then per script one unmeasured and 50 measured evaluations, reporting
the mean of the best 30 — the README's protocol. Heavier warm-ups were measured and are kept as flags of
`uplc-turbo.ts` (`--warmup-scope corpus`, `--warmup-passes`, `--warmup-runs`): passes over the whole corpus make
the ten V3 scripts slower (the JIT specialises on the V1 / V2 majority), a thousand unmeasured evaluations per
script take ten times longer without changing the picture, and with any of them three to five scripts near the 2×
line move across it between runs — JIT state, not evaluator speed (`docs/parity/ndc-uplc.md`). `--turbo-runs` and
`--turbo-best` change the measured runs. `manifest.json` (`reports.uplc-turbo.metadata.setup.measurement`) records
the protocol and the affinity mask it ran under; the report itself has only the `machine` block. A `--only` run
keeps the other scenarios' manifest entries. Run it once; do not pick the best of several runs for a published
report.

### One scenario at a time

```
bun scripts/ndc/cbor-decoding.ts --dataset ~/ndc-corpora/cbor-dataset/dataset/conway-123-100 --out /tmp/cbor.json --schema ~/ndc-corpora/ndc/scenarios/cbor-decoding/schema.json
bun scripts/ndc/ledger-rules.ts --fixtures ~/ndc-corpora/ndc/scenarios/ledger-rules/fixtures --out /tmp/ledger.json --schema ~/ndc-corpora/ndc/scenarios/ledger-rules/schema.json [--verbose] [--only 00074]
bun scripts/ndc/uplc-conformance.ts --corpus ~/ndc-corpora/uplc-conformance --out /tmp/uplc.json --expectations ~/ndc-corpora/ndc/scenarios/uplc-conformance/expectations.json
taskset -c 0,10 bun scripts/ndc/uplc-turbo.ts --corpus ~/ndc-corpora/uplc-turbo --out /tmp/turbo.json --schema ~/ndc-corpora/ndc/scenarios/uplc-turbo/schema.json --reference ~/ndc-corpora/ndc/_site/reports/uplc-turbo/cardano-node.json
bun scripts/ndc/uplc-validate-report.ts ~/ndc-corpora/ndc/scenarios/uplc-turbo/schema.json /tmp/turbo.json
```

`cbor-decoding.ts --rules value,relay` limits a run to some rules; the report lists every unmet expectation with
the expected and actual bytes. `ledger-rules.ts --schema` checks every `result` against the schema's vocabulary
(58 predicate names) and exits 1 naming any it does not know: such a name must be looked at, never dropped.
`uplc-turbo.ts --stride K --limit N` runs a subset for a quick look (never a report); `--schema` keeps only the
scripts the scenario enumerates in the report and lists the others. `--summary <file>` on any of the three writes
the metadata report-all.ts puts in the manifest.

The default cost models the turbo scenario asks for come from plutus-core's variant JSONs; regenerate the fixture
from a plutus checkout with `bun scripts/ndc/plutus-default-cost-models.ts --plutus <IntersectMBO/plutus>` (it
writes `src/consensus/__fixtures__/plutus-default-cost-models.json`).

## 3. See the ranking the way the site computes it

```
cd ~/ndc-corpora/ndc
mkdir -p nodes/gerolamo && cp <gerolamo>/docs/parity/ndc-node-entry/* nodes/gerolamo/
for s in cbor-decoding ledger-rules uplc-conformance uplc-turbo; do mkdir -p scenarios/$s/preview; done
cp ~/ndc-reports/gerolamo-*-cbor-conformance.json  scenarios/cbor-decoding/preview/gerolamo.json
cp ~/ndc-reports/gerolamo-*-ledger-rules.json      scenarios/ledger-rules/preview/gerolamo.json
cp ~/ndc-reports/gerolamo-*-uplc-conformance.json  scenarios/uplc-conformance/preview/gerolamo.json
cp ~/ndc-reports/gerolamo-*-uplc-turbo.json        scenarios/uplc-turbo/preview/gerolamo.json
python3 -I -c "import runpy, sys; sys.path.insert(0, 'scripts'); sys.argv = ['build.py', '--preview']; runpy.run_path('scripts/build.py', run_name='__main__')"
python3 -m http.server -d _site 8008                # open http://localhost:8008
```

`build.py` is pragma's tool (Python, needs only the standard library; `.zst` previews need Python 3.14 or `zstd`);
since 8974561 it imports its sibling `scripts/build_common.py`, which isolated mode (`-I`, no script directory on
`sys.path`) does not find, hence the `runpy` line that adds only that directory. `--preview` adds the reports
under `scenarios/*/preview/` (Amaru's and cardano-node's are checked in there) to the live ones it downloads for
Dingo. `_site/catalog.json` has the per-node percentages; `_site/scenarios/uplc-turbo/data.json` the turbo
summaries and the cross-node budget disagreements (`turbo_disagreements.by_node`, ours 0).

## 4. The tests behind the numbers

```
bun test src/conformance                                    # Blueprint ledger vectors, NDC harness tests (corpus tests skip without the env vars below)
GEROLAMO_NDC_CBOR_DATASET=~/ndc-corpora/cbor-dataset/dataset/conway-123-100 bun test src/conformance/ndc/cborDecoding.test.ts
NDC_LEDGER_RULES_FIXTURES=~/ndc-corpora/ndc/scenarios/ledger-rules/fixtures bun test src/conformance/ndc/ledgerRules.test.ts src/mempool/ndcLedgerRules.test.ts
NDC_UPLC_CORPUS=~/ndc-corpora/uplc-conformance NDC_TURBO_CORPUS=~/ndc-corpora/uplc-turbo NDC_DIR=~/ndc-corpora/ndc bun test src/conformance/ndc/uplcConformance.test.ts
bun test src/consensus/plutus                               # decoder, CEK, IntersectMBO vectors, bugs 550–553
```

The corpus tests carry floors (9 200, 276, 1 064 / 750, and every turbo budget equal to cardano-node's when
`NDC_DIR` holds its downloaded report): a library or decoder change that lowers a score fails them. With `NDC_DIR`
set they also check each report against its schema and score the conformance report the site's way (ndcScore.ts).
