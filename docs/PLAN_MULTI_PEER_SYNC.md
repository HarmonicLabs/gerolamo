# PLAN: Multi-peer honest sync, parallel BlockFetch, validation workers

Status: **implemented 2026-09-02** (phases A–D below, plus Byron OBFT
verification and strict-from-genesis body validation). This document is kept
as the design rationale; the "Where we are" section describes the state
*before* the work. Decisions taken with Mike: 3 hot peers everywhere,
divergent/lying peers held cold for 1 hour, validation workers default to
all cores (`validation.workers`, user-configurable).

Implementation map:

| Concern | Code |
|---|---|
| Body hash / Byron body proofs | `src/consensus/bodyHash.ts` |
| Byron crypto (key hash, cert + block signatures) | `src/consensus/byron/ByronCrypto.ts` |
| Byron OBFT state (delegation map, k-window threshold) | `src/consensus/byron/ByronOBFT.ts` |
| Per-peer candidate fragments, primary/verifier, quorum | `src/consensus/CandidateSet.ts` |
| Parallel BlockFetch across peers, ordered apply | `src/consensus/RangeScheduler.ts` |
| Header-validation worker pool | `src/consensus/workers/` |
| Per-epoch protocol params for body rules | `src/consensus/epochParams.ts` |
| Orchestration (roles, dedupe, gates, apply) | `src/consensus/ConsensusOrchestratooor.ts` |
| Malicious hold, roles on promote/demote | `src/network/PeerGovernor.ts`, `src/network/peerManager.ts` |
| `/metrics.sync`, desktop honesty panel | `src/network/peerBlockServer.ts`, `desktop/src/mainview/components/ControlCenter.tsx` |

Known gaps after this pass: pre-OBFT Byron SSC proofs (types 0–2) are not
recomputed (mainnet epochs before OBFT); Byron delegation-certificate
activation delay is modelled as 2k slots (pending certs are accepted for
authorisation either way); the primary-switch path after an outvote is unit
tested on `CandidateSet` but has not been exercised against a real fork.

2026-09-03 follow-up (see `SYNC_PIPELINE_RESEARCH.md`, "Round 1"): ChainSync
RequestNext is pipelined (`blockFetchBatch.pipelineDepth`), header crypto uses
the fast pure-TS ed25519, rollbacks deeper than k are refused and the peer is
held as malicious, the outvote quorum counts distinct remote hosts, and the
Byron genesis UTxO set is seeded on a fresh from-genesis DB.

References: `cardano-docs/network-design.pdf` §5.1.2 (block/body splitting),
§5.2 (consensus components: ChainSync candidates → BlockFetch → chain
selection), `cardano-docs/network-spec.pdf` (ChainSync §3.7, BlockFetch §3.8).

## 1. Where we are

Facts from the code, not aspirations:

- `PeerGovernor` keeps `targetHot = 2` (config). Every hot peer runs its own
  ChainSync loop and is wired to the **same** `ConsensusOrchestrator`
  (`peerManager.wirePeerConsensus`). Batches are serialised on
  `rollForwardChain`. There is no comparison between what peer A and peer B
  deliver. Two hot peers today means redundancy, not honesty.
- In resume mode both hot peers intersect at the DB tip and deliver the same
  headers. The orchestrator re-applies duplicates. `blocks` insert is
  `INSERT OR IGNORE` and UTxO writes are idempotent (DELETE inputs,
  INSERT OR REPLACE outputs), but `applyTransaction` also does
  `UPDATE chain_account_state SET treasury = treasury + fee`, which is **not**
  idempotent. Duplicate delivery double-counts fees. This is a bug regardless
  of the rest of this plan.
- BlockFetch already uses `RequestRange` (`blockFetchBatch.maxBlocks`, 32 by
  default, clamped to 256). That is the "batch download" the mini-protocol
  offers. Ranges are always fetched from the **same** peer that delivered the
  headers. One peer, one pipe.
- Header validation (KES verify, VRF, op-cert) and block CBOR parsing run on
  the main thread, serially, inside the orchestrator. During the genesis run
  on 2026-09-02 preprod Shelley blocks applied at roughly 2.5 blocks/s with an
  idle network, which points at CPU on the main thread as the ceiling.
- `block_body_hash` in the header is **never** checked against the fetched
  body. `assertBlockRangeMatches` only checks that the fetched block's header
  hashes to the advertised header hash. A peer could serve a tampered body
  under a valid header and we would apply it.

## 2. What "honest" means here

We are a follower. Honesty comes from three independent checks, in order of
cost:

1. **Header integrity** (have): KES/VRF/op-cert on every Shelley+ header,
   prevBlock chaining on Byron. Proves the header was produced by a stake
   pool for that slot.
2. **Body integrity** (missing, cheap): `blake2b_256` of the body components
   must equal `header.body.blockBodyHash`. Proves the body is the one the
   producer signed. Catches a lying BlockFetch peer immediately, no ledger
   state needed. See the Merkle-triple/quad description already in
   `blockHeaderParser.ts`.
3. **Chain agreement** (missing): the same slot from N upstream peers must
   yield the same header hash. If peers disagree we have either a real fork
   (run chain selection) or a liar (demote it). Needs at least 3 hot peers so
   one liar is outvoted.

Body validation (`bodyValidation`) and script validation are ledger-rule
checks and are covered separately; they do not make a peer honest, they make
*our ledger* honest.

## 3. Design

### Phase A — Dedupe and body hash (small, do first)

- Orchestrator keeps an LRU of recently applied header hashes (size ≥ 2 ×
  `maxBlocks` × hot peers) and consults `getBlockByHash` on a miss. A header
  already applied is acknowledged and skipped, never re-applied. Fixes the
  treasury double count.
- Implement `verifyBlockBodyHash(multiEraBlock)` for Shelley+ (Byron uses
  `bodyProof`, see CDDL `blockproof`) and call it right after
  `assertBlockRangeMatches`. A mismatch terminates the peer with a
  `body-hash-mismatch` reason that the governor treats as malicious (cold +
  long backoff), not as a network error.
- Tests: fixture-based, using `__fixtures__/byron-preprod.json` and a captured
  Shelley/Conway block (extend the capture script to grab one).

### Phase B — Candidate headers from every hot peer

Per network-design §5.2: ChainSync from all immediate upstream peers builds
*candidate chains*; BlockFetch and chain selection act on those candidates.

- Split the orchestrator's roll-forward handling into two stages:
  - **Header stage** (per peer, concurrent): parse + validate the header,
    append to that peer's in-memory candidate fragment (a bounded deque of
    `{slot, hash, prevHash}`, keep the last `k = 2160`). This is where the
    KES/VRF cost lives.
  - **Adoption stage** (single, ordered): one peer is *primary*; its
    fragment drives BlockFetch and apply. Headers from the other peers are
    only compared.
- **Cross-check rule**: whenever a non-primary peer delivers slot `s` and the
  primary fragment already has slot `s`, compare hashes.
  - Equal → mark peer `agrees@s`.
  - Different and the divergent fragment is *not* longer/denser than ours →
    mark peer `divergent`, demote to cold with a long backoff, governor
    promotes another.
  - Different and the divergent fragment *is* preferable under
    `chainSelection.evaluateChains` → this is a fork; roll back to the
    intersection (`handleRollBack` already exists) and switch primary to that
    peer.
- **Primary liveness**: if the primary goes silent (`hotSilentMs`) or fails
  a range, promote the best-agreeing peer to primary. Its fragment is already
  validated, so switchover costs nothing.
- Config: `peerGovernor.targetHot` default 3 for genesis mode, and a new
  `sync.minAgreeingPeers` (default 2) below which we keep fetching but the UI
  shows "unconfirmed".
- Tests: unit tests around a `CandidateSet` class with synthetic fragments:
  agreement, single liar, real fork preferring the longer chain.

### Phase C — Parallel BlockFetch across peers ("batch download")

Headers still arrive in order from the primary; bodies do not have to.

- A `RangeScheduler` takes the primary's validated fragment, cuts it into
  ranges of `blockFetchBatch.maxBlocks`, and hands ranges to *any* hot peer
  that agrees with the primary at that range's end slot. Up to
  `blockFetch.parallelRanges` (default = hot peers) in flight at once.
- Each fetched range is checked with `assertBlockRangeMatches` + body hash,
  then placed in an ordered reassembly buffer keyed by first slot. The
  applier drains the buffer strictly in order. A failed or slow range is
  reissued to another agreeing peer.
- Expected win: during genesis sync the network side becomes ~N× wider;
  combined with Phase D the applier becomes the only serial part.
- The mini-protocol constraint: one BlockFetch client per connection is
  request/response, so parallelism comes from *peers*, not from multiple
  ranges on one peer. This is exactly why "more than one node" and "batch
  download" are the same feature.

### Phase D — Bun workers for CPU

<https://bun.sh/docs/runtime/workers>. What can move off the main thread and
what cannot:

- **Can**: header parse + KES/VRF/op-cert validation; block CBOR parse; body
  hash; Byron structural checks. All pure functions over bytes. A
  `ValidationPool` of `os.availableParallelism() - 1` workers, messages carry
  `ArrayBuffer`s with transfer lists (zero copy), results are small JSON
  (`{slot, hash, era, ok, reason}`). Workers import the same
  `blockHeaderParser` / `BlockHeaderValidator` modules, so no logic forks.
- **Cannot (yet)**: SQLite writes. `src/sql.ts` holds one Bun SQL SQLite
  handle; SQLite is single-writer and the handle is not shareable across
  workers. The applier stays on the main thread.
- **Later, optional**: one worker per peer connection (sockets work in Bun
  workers). Not needed for throughput; only worth it if the main thread's
  event loop becomes the bottleneck after Phases C+D.
- Fallback: `validation.workers = 0` runs everything inline (current
  behaviour) so the worker path is never a hard dependency.
- Tests: pool round-trip with the Byron fixture; a worker crash must reject
  the pending header, not hang the applier.

### Phase E — Genesis rule (later)

Ouroboros Genesis density comparison for the choose-among-candidates step
when far from the tip. Only matters once Phase B exists; `evaluateChains`
already carries the Praos rule.

## 4. Order and size

| Phase | Depends on | Size | Risk |
|---|---|---|---|
| A dedupe + body hash | — | small | low; body hash derivation per era needs care (Alonzo+ quad root) |
| B candidate cross-check | A | medium | medium; touches orchestrator/peerManager/governor |
| C parallel BlockFetch | A, B | medium | medium; reassembly + reissue logic |
| D worker pool | A | medium | low; pure functions, feature-flagged |
| E genesis density | B | small | low |

A can ship alone. B and D are independent of each other and can proceed in
parallel. C needs B for "which peers are safe to fetch from".

## 5. UI (desktop)

- Era + Epoch badges: **done** (`/metrics.era`, `/metrics.eraName`).
- Add: sync mode (genesis / resume / tip), primary peer, per-hot-peer
  agreement (✓ agrees at slot N / ✗ divergent), ranges in flight, blocks/s.
  All of this is new fields on `/metrics` and `/ws/stats`; the Overview
  already renders hot/warm/cold lists, so it is a matter of one more column.
- Surface `governor.recentErrors` on the Overview so a failing peer loop is
  visible instead of a frozen 0.00%.

## 6. Open questions for Mike

1. Default `targetHot` 3 for genesis and 2 for tip-follow, or 3 everywhere?
2. Should a `divergent` peer be banned for the process lifetime or backed off
   (say 1 h)? Public relays occasionally serve a stale fork briefly.
3. Worker count: fixed default or derived from cores? Desktop users on
   laptops may prefer a cap.
