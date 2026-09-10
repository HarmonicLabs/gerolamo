# Plan: ledger integrity before mainnet (rollback journal, pots, Plutus costs)

Written 2026-09-06 while preview syncs (epoch ~930 of 1411). Three open findings from
the preview run, in the order they will be fixed. Bugs 59–64 in VALIDATION_STATUS.md
are the background; this plan is the work list and the acceptance criteria.

## A. Rollback journal for non-UTxO ledger state (bug 63)

**Problem.** `rollbackChainTo` reverts `blocks`, `utxo` (through `utxo_deltas`) and
`volatile_headers`. Everything else a block writes stays: `stake`, `delegations`,
`stake_pointers`, `pool_distr`, `rewards` (withdrawals), `reward_pots` /
`chain_account_state` (fees, deposits), `gov_proposals`, `gov_votes`, `gov_dreps`,
`gov_committee`, `gov_drep_delegations`, `gov_state`, `gov_enacted`, `epoch_nonces`
snapshot columns. A rollback of n blocks followed by re-apply of the same or a forked
chain therefore re-registers credentials that are already registered (the preview
halt) or, worse, silently keeps state from blocks that are no longer on our chain.

**Design: before-image journal written by SQLite triggers.**

- `apply_ctx (id=1, block_hash BLOB NULL, journaling INTEGER)`: the applier sets
  `block_hash` at the start of each block (inside the range transaction) and clears it
  after; `journaling = 0` while `onEpochStart` runs (boundary work is not journaled, see
  limits) and during migrations / repair scripts.
- `ledger_journal (id PK, block_hash BLOB, tbl TEXT, op TEXT 'I'|'U'|'D', row_id INTEGER,
  before TEXT)`: one row per state-table write while `apply_ctx.block_hash` is set.
  `before` is `json_object(col, OLD.col, …)` for U/D, NULL for I.
- Triggers `AFTER INSERT/UPDATE/DELETE` on each journaled table, generated at
  `ensureInitialized` from `PRAGMA table_info` (explicit column lists; SQLite has no
  generic row image). `WHEN (SELECT block_hash FROM apply_ctx WHERE id = 1) IS NOT NULL
  AND (SELECT journaling FROM apply_ctx WHERE id = 1) = 1`. All journaled tables are
  rowid tables (verified: no WITHOUT ROWID tables in the DB).
- Journaled tables: stake, delegations, stake_pointers, pool_distr, rewards, reward_pots,
  chain_account_state, gov_proposals, gov_votes, gov_dreps, gov_committee,
  gov_drep_delegations, gov_state, gov_enacted. Not journaled: utxo (has utxo_deltas),
  blocks/headers (deleted directly), mb_* / tx_index / address_tx (the MiniBF writer has
  `rollbackMbToSlot`), epoch_* snapshot tables (boundary only).
- `rollbackChainTo(slot)`: after the UTxO deltas, read `ledger_journal` rows of the gone
  blocks ordered by `id DESC` and undo each: I → `DELETE … WHERE rowid = row_id`;
  D → `INSERT … (rowid, cols…) SELECT json fields`; U → `UPDATE … SET cols… WHERE rowid`.
  Journal rows of the gone blocks are then deleted; rows of blocks that are still on the
  chain are kept until the block becomes immutable (pruned with the immutable move, like
  `utxo_deltas`).
- Limits: a rollback that crosses an epoch boundary (the boundary's reward update,
  snapshot and parameter derivation are not journaled) halts with a clear message and
  the epoch it would need to re-derive. cardano-node bounds rollbacks by k (2160 blocks;
  ~12 h on mainnet), so a boundary crossing is possible but rare; re-deriving the boundary
  from journaled pre-boundary state is a follow-up, not part of this plan.
- Cost: one journal insert per state write; blocks write a handful of state rows, so the
  overhead is below the noise of `blk.apply`. Journal rows for immutable blocks are
  pruned; steady-state size is k blocks of state writes.

**Steps.** (1) `src/db/ledgerJournal.ts`: table DDL, trigger generation, `setApplyBlock`,
`withJournalingOff`, `undoJournal(blockHashes)`. (2) Hook the applier: set/clear the
block hash per block in `applyRangeBlocks`, journaling off around `onEpochStart`.
(3) `rollbackChainTo` calls `undoJournal` for the gone blocks and refuses boundary
crossings. (4) Prune with the immutable move. (5) Tests: a synthetic block with stake
registration + delegation + DRep registration + vote + withdrawal, applied then rolled
back: every journaled table byte-identical to the pre-apply snapshot; a two-block
rollback undoes in reverse order; journaling-off during boundary leaves no rows;
the preview fixture blocks (78299405..) re-apply cleanly after a synthetic rollback.
(6) One-off: the phantom rows left by the 164-block double apply were removed by hand
(bug 63); deposits counted twice there are covered by B.

**Acceptance.** `bun test src/db` green; a forced 5-block rollback on the running preview
node (test hook) leaves `stake`/`delegations`/`gov_*` equal to a snapshot taken before
those blocks; no "already registered" halts across the rest of the preview sync.

## B. Treasury / reserves drift against Koios (~150 ppm per epoch)

**Finding.** `scripts/verify-pots.ts` on preview epochs 640–929: the local treasury
increase per boundary exceeds Koios by 66–258 ppm every epoch (pre-Conway epochs
included), accumulating to treasury −70.8 B and reserves −1 845 B lovelace at epoch 929
(reserves diff −0.02 %). Not caused by the double apply (which is 11 stake deposits and
one DRep deposit in one epoch); this is a formula or destination difference.

**Candidates** (in the order to test): (1) rewards to unregistered accounts at
application time go to the *treasury* in the ledger (`applyRUpd`), pool leader rewards
whose reward account is unregistered stay in reserves — check where our `unclaimed`
(16 T of a 20 T pot on preview!) is routed; (2) pool-deposit refunds on retirement when
the reward account is unregistered go to the treasury; (3) η (performance factor) and
the τ / ρ rounding order (`floor` per component vs on the sum); (4) Conway: proposal
deposit refunds to unregistered accounts, treasury donations (body key 22), enacted
treasury withdrawals — Koios `totals` exposes `treasury_donation` / `treasury_withdrawal`.

**Found 2026-09-06 09:50 UTC.** Per-pool active stake vs Koios `pool_history` matched
to 0.06 % except for script stake credentials, whose stake exceeded both Koios and our own
UTxO sum by exactly their `rewards` balance. `withdrawalEntries` typed script reward
accounts as key accounts, so their withdrawals never debited the 29-byte row (bug 65).
The pot itself (η, fees, ρ) was exact; the excess came through apparent performance
(`activeStake` 1.3 % too high at epoch 637) and the resulting pool rewards.

**Original steps (kept for the record).** (1) Extend `verify-pots.ts` to print per-epoch Koios `totals` (treasury,
reserves, deposits_*, donation, withdrawal) next to `reward_epochs` (pot, treasury_delta,
paid, unclaimed) and `epoch_info.total_rewards`, and to derive the residual per component
(Δreserves − our Δreserves, Δtreasury − our Δtreasury, Koios rewards paid − our paid).
(2) Attribute the residual to one of the candidates above with the epoch-by-epoch data;
fix the formula in `epochRewards`/pots; (3) recompute from the first drifting epoch with
`recompute-rewards.ts` or repair the pots by replaying the corrected boundary deltas;
(4) fixture test on two preview epochs (params + pool set + blocks made) reproducing the
Koios treasury/reserves to the lovelace.

**Status 2026-09-06 10:30 UTC.** Fix landed (bug 65) and balances repaired from our own
withdrawal deltas; the node runs on the repaired state from epoch ~995. Next: read
`verify-pots.ts` for epochs ≥ 997 (the first boundaries computed entirely on repaired
snapshots) and attribute whatever residual remains.

**Status 2026-09-06 11:05 UTC.** After the balance repair the per-epoch treasury deviation
became a constant −285 ppm, equal to the accumulated reserves offset (−2.57 T on 8.98e15):
the boundary formula is now consistent with the node and only the inherited pot offset
remained. The pots (`reward_pots`, `pot_snapshots`) were set to the Koios totals at epoch
1050 (reserves +2 565 170 652 657, treasury +189 108 200 783) so the next boundaries can be
verified at 0 ppm; this is a documented external repair of historical state, not something
the code does.

**Acceptance.** `verify-pots.ts` shows 0 ppm treasury deviation for ≥ 20 consecutive
preview epochs after the fix, and the accumulated reserves/treasury diff at the tip is 0
after the repair.

## C. Plutus V3 CPU excess of exactly 1453 units (shadow mismatches)

**Finding.** Every "local verdict invalid ≠ block's valid" on preview epochs 820–930 is
`dmem = 0, dcpu = +1453` (one dapp, dozens of transactions), plus one `+3114` and one
`dmem 98 / dcpu −340 941` (a different script). Memory matching exactly means the CEK
step accounting is right; a constant CPU excess per script run is one builtin whose V3
cost function is off (a constant/intercept term), or one whose V3 semantics (pv 10
"ConstAboveDiagonal" integer division family, quadratic `integerToByteString` /
`byteStringToInteger`) is implemented with the wrong branch.

**Tooling 2026-09-06.** `GEROLAMO_PLUTUS_TRACE=1` (passed through by run-supervised.sh)
wraps each Plutus machine's builtin cost lookup and appends per-builtin totals
(`trace[name×count:cpu/mem …]`) to every over-budget mismatch note; fixtures
preview-block-72702137.hex + preview-block-72702137-inputs.json + preview-params-841.json
hold the block, its resolved inputs and the epoch parameters (the offline evaluation of
those transactions stays within budget, so the excess depends on the node-side context).

**Steps.** (1) Fixture: block at slot 72702137 (13 hits) with its resolved inputs and
epoch parameters. (2) Instrument `@harmoniclabs/plutus-machine` (bun patch, or a
subclass in `plutusEval.ts`) to log every builtin evaluation with argument sizes and the
charged cpu/mem. (3) Compute the reference cost for each observed builtin from the
plutus-core cost model definitions (sizes in 64-bit words, the two-variable models'
branch conditions) and diff. (4) Patch the machine's cost function; add a test that
evaluates the fixture redeemer and asserts the budget equals the declared one, plus unit
tests of the fixed cost function at the boundaries. (5) Re-run the shadow over the
preview fixtures with mismatches (`scripts/validate-stored-block.ts`) — all clean.
(6) Report upstream (HarmonicLabs plutus-machine) with the failing sizes.

**Acceptance.** No verdict mismatches in the preview shadow from the restart onward;
the second script family (`dmem 98`) either fixed by the same change or filed
separately with its own fixture.

**Status 2026-09-06 12:30 UTC — landed (bugs 66, 67).** The "+1453" family and the
"dmem 98" family were two different things, neither of them a V3 cost function:

- The evaluator costed V1/V2 scripts with V3 division functions (the fake-V3 conversion
  drops the V1/V2 parameters), used `c02·y` for `c02·y²` in the V3 quadratic and added
  instead of multiplied sizes for V3 `multiplyInteger`. Found by evaluating our dumped
  applied program with aiken's `uplc` crate under the chain's cost models: V2 costs gave
  the declared budget to the unit, V3 costs gave ours. Patched (`patches/…plutus-machine…`),
  `plutusCostModel.test.ts` (real V2 redeemer + 126 reference cases from
  `plutus-integer-builtin-reference.json`, generated with `tools/uplc-ref eval-text`).
- The +1453 cpu was our script context: aiken's own context reproduced the declared
  budget exactly; `scripts/data-diff.ts` against aiken's context (dumped with
  `tools/uplc-ref ctx`) showed the validity-interval closures and the V1/V2 stake
  credential encoding (buildooor / ledger-ts). Fixed in buildooor (patch), ledger-ts
  0.5.11 (vendor) and buildooor's nested 0.4.8 (patch); contexts now identical.

Method that worked, for next time: dump the applied program and our context
(`GEROLAMO_PLUTUS_DUMP_DIR`), evaluate the program with the reference under each
language's cost model (`eval-prog`), evaluate the whole transaction with the reference's
own context (`eval-tx`), diff contexts structurally. Note `aiken uplc eval` always uses
V3 costs and `aiken tx simulate` rejects unused reference scripts; `tools/uplc-ref` does
neither. Open: pre-PV9 contexts (inclusive ttl handled; the V1/V2 cost-model shapes
before Chang are unverified — matters for mainnet Alonzo/Babbage replay).

## Sequencing

A first (a fork on preview or mainnet corrupts state today), then B (blocks Koios-exact
validation), then C (diagnostic today, but block production needs exact budgets to
build valid blocks). Each lands with tests and a `VALIDATION_STATUS.md` entry; preview
keeps syncing meanwhile and is restarted once per landed workstream.
