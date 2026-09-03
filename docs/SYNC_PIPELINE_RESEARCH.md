# Sync pipeline research: Dolos, Dingo, cardano-node vs Gerolamo

Date: 2026-09-03. Status: research done, first optimisation round implemented
the same day (see "Round 1 results" at the end). Requested by Mike before
optimising Gerolamo's download/verify/apply pipeline.

Sources: local Dolos clone (`../dolos`, 174a5de6), Dingo `main` on GitHub,
IOG `network-design.pdf` / `network-spec.pdf` (cardano-docs), ouroboros-consensus
docs. Line numbers refer to the files named at the time of reading.

## A. Dolos (Rust, TxPipe)

1. **Batching.** One `pull` stage (`src/sync/pull.rs`): drain ChainSync until
   `block_fetch_batch_size` headers (default 100), then a single
   `fetch_range(first,last)`. Strictly alternating headers → bodies → headers.
   At tip: one header, one fetch.
2. **Validation order.** Pull checks prev-hash continuity and non-decreasing
   slot only. Apply checks continuity against the persisted cursor then builds
   UTxO/entity deltas. No KES/VRF/op-cert, no body-hash, no phase-1/2 tx
   validation on synced blocks. Dolos is an explicitly trusting follower.
3. **Mithril.** Verifies the certificate chain and per-immutable digests
   (unless `--skip-validation`), imports in 500-block chunks, replays deltas.
   Ledger state is never validated.
4. **Bad peer / multi-peer.** One upstream. Continuity failure → worker restart
   and reconnect to the same peer. No ban, no comparison.
5. **Concurrency.** gasket stages `pull → apply → stores` over a bounded
   channel (50). Apply groups blocks into an epoch-bounded `WorkBatch`, prefetches
   entities/UTxOs with rayon `par_chunks(100)`, commits one transaction per batch.

## B. Dingo (Go, Blink Labs)

1. **Batching.** Headers queue up to `min(batch*4, MaxQueuedHeaders)`;
   BlockFetch ranges up to 500. Range size scales with the gap to tip
   (>1000 behind → 256, >256 → 128, >64 → 32, >16 → 8, >4 → 2). Blocks are
   committed in groups of 8. Near tip a "shadow" fetch sends the same ≤4-header
   range to a second peer when the primary is slow; first delivery wins.
2. **Order.** Header crypto at ChainSync arrival when the epoch nonce is cached
   and the slot is past the Mithril boundary; otherwise deferred to BlockFetch or
   to apply with a persisted marker. With `ValidateHistorical=false` (default)
   blocks below `tip − stabilityWindow` skip validation entirely, including
   phase-2. Future headers held up to 2 s clock skew.
3. **Mithril.** Blocks at or below the snapshot slot are trusted and never
   crypto-checked; rollbacks past the snapshot are refused.
4. **Bad peer / multi-peer.** Header verification failure → disconnect and
   reconnect (no permanent ban seen). Fork resolution after 20 mismatches,
   rollback-loop detection, range failing 3× drops the queue and resyncs. One
   active ChainSync/BlockFetch peer chosen by a `ChainSelector`. Genesis mode:
   a source is followed only if ≥ `MinCorroboratingPeers` distinct remote hosts
   report the same slot+hash inside a `3k/f` window; otherwise the node stalls.
5. **Concurrency.** Event bus with backpressure, one mutex serialising ledger
   mutation, optional pipeline with 2 decode + 2 validate workers, DB pool of 5.

## C. cardano-node / ouroboros

1. **Header/body split.** Per-peer validated candidate fragments from ChainSync;
   BlockFetch logic keeps plausible candidates, strips fetched/in-flight blocks,
   assigns ranges to peers; ChainDB does final selection. Four validation
   sites: header checks in ChainSync client, plausibility in BlockFetch logic,
   header↔body match in BlockFetch client, ledger validation in ChainDB.
2. **k.** Intersection more than k from tip → `ForkTooDeep` disconnect.
   Candidate fragments are k long. Blocks deeper than k move to ImmutableDB.
3. **Peer choice.** Peers ordered by expected arrival (GSV); bulk sync uses one
   peer (`maxConcurrencyBulkSync = 1`), deadline mode two. Protocol timeouts 60 s,
   2.5 MB streaming limit. A body not matching its header disconnects the peer.
4. **Pipelining.** Interleaving transmission and validation is the core design
   principle. Header validation in per-peer threads, ledger apply in ChainDB's
   background thread, downloads continue while validation catches up.
5. **Genesis.** Limit on Eagerness (never select > k past the candidates'
   intersection), Genesis Density Disconnect, Limit on Patience token bucket
   against header withholding, ChainSync Jumping with one dynamo. Assumes ≥ 1
   honest peer.

## Gerolamo today

See `PLAN_MULTI_PEER_SYNC.md`. 3 hot peers, one primary drives BlockFetch and
apply, verifiers compared slot by slot (`CandidateSet`, quorum 2). Header
KES/VRF/op-cert in a worker pool. `RangeScheduler` ranges of 32 blocks, 3 in
flight, one per peer, each verified (header match + body hash) then applied in
order. Body validation strict from genesis, soft otherwise. Malicious peers
held cold 1 h.

## Where Gerolamo differs (ordered by likely impact)

1. **Fixed 32-block ranges.** Dolos 100, Dingo up to 500 scaled by gap. Make
   `maxBlocks` adaptive when far from tip.
2. **Per-block apply on the main thread** with awaits per block. Dolos and
   Dingo batch UTxO lookups and commit once per batch. Biggest serial cost.
3. **Strict validation from genesis.** Dingo skips header crypto and phase-2
   below `tip − stabilityWindow`; Dolos validates nothing. A "trusted
   historical" mode gated by ≥ N agreeing peers is the precedent; the trade-off
   must stay explicit and opt-in.
4. **Parallel BlockFetch across 3 peers** only pays off after (2). Dingo's
   shadow fetch near tip is a cheap tail-latency trick we lack.
5. **No rollback bound.** cardano-node disconnects on `ForkTooDeep`; Dingo
   refuses rollbacks past Mithril. Gerolamo's `handleRollBack` without a
   candidate rewinds the DB unconditionally.
6. **No density / Genesis rule.** Our outvote is a majority of peer keys, not
   density, and does not dedupe by remote host.
7. **No future-header clock-skew check.**
8. **Ledger-invalid block handling.** cardano-node records invalid blocks and
   disconnects any peer advertising them; we poison the scheduler and terminate
   the primary without a malicious hold, other peers unpunished.
9. **Missing epoch nonce is fatal** for us; Dingo defers header verification
   with a persisted marker.
10. **Where Gerolamo is ahead:** body-hash check on every fetched block (Dolos
    never, Dingo header-hash only), per-peer candidate comparison during sync,
    header validation across all cores, 1 h malicious hold.

Not examined: Gerolamo's own Mithril path; Dolos `max_rollback`; Dingo peergov
denylisting.

## Round 1 results (2026-09-03, preprod genesis sync, 150 s runs, 3 hot peers)

Measured with the new per-phase profile (`/metrics.sync.profile`, log line
`Sync profile:` every 256 blocks) and Bun `--cpu-prof`.

| Change | blocks applied in 140 s | blocks/s | Note |
|---|---|---|---|
| baseline (master) | 671 | 4.4 | main thread mostly idle; 200 ms/header in "validation" |
| WAL + synchronous=NORMAL | 675 | 4.2 | SQLite was never the bottleneck |
| fast ed25519 (noble port inside @harmoniclabs/crypto) | 923 | 6.6 | validation 190 → 14 ms/header, CPU 127 % → 24 % |
| pipelined ChainSync RequestNext (depth 32) | 14 564 | 40–137 | one header per RTT was the real cap; throughput then decayed |
| drop `gc_volatile` AFTER INSERT trigger | 26 897 | ~200 sustained | trigger scanned the table on every insert (15 ms at 14k rows, growing) |
| pipeline depth 128, 64-block ranges | 24 753 | ~200 | no gain, +500 MB RSS: the relay serves ~200 headers/s per connection |

What each fix was:

1. `verifyEd25519Signature_sync` in @harmoniclabs/crypto is a textbook BigInt
   implementation (~30 ms/verify). The same package bundles the noble-curves
   port (~1 ms). Two verifies per header (op-cert, KES leaf). Gerolamo now uses
   the noble one (`src/consensus/fastEd25519.ts`) and injects it into kes-ts via
   the new `setEd25519Verify` (kes-ts 0.1.0-dev1). Still 100 % pure TS, ours.
2. ChainSync was strictly `await requestNext()` per header. The protocol allows
   pipelining; `ChainSyncPipeline` keeps `blockFetchBatch.pipelineDepth`
   (default 32) requests in flight until the server answers `MsgAwaitReply`.
3. `gc_volatile` trigger → periodic `gcVolatile()` every 2048 blocks over
   partial `WHERE is_valid = FALSE` indexes.

Also landed in the same round: Byron genesis UTxO seeding (nonAvvm + AVVM via
`ByronAddress.fromRedeemPublicKey`, ledger-ts 0.5.5; verified against mainnet),
rollback bound at k with the offending peer held as malicious, and distinct-host
quorum for the primary outvote.

Remaining cap: ~200 headers/s from one public preprod relay regardless of
pipeline depth (batches never fill). Options if more is wanted: measure against
a relay we run, or split header streams across peers (needs known intersection
points, i.e. a header-hash index ahead of the tip, which ChainSync cannot give).
Main-thread CPU is ~25 %; the visible hot spots are hex/string conversions in
ledger-ts parsing and CBOR, not SQLite.

