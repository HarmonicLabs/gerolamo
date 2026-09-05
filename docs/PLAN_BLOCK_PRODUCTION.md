# Plan: Gerolamo as a stake pool block producer

> 2026-09-05: operator tooling (keys, certificates, transactions) is built on
> the HarmonicLabs libraries only and later surfaced in the desktop UI; the
> first live pool runs on the preview testnet (1-day epochs). Step-by-step
> mapping of the operator flow to library calls: `PLAN_POOL_TOOLING.md`.

What has to exist before Gerolamo can forge blocks and run as a pool node.
Status legend: **have** (in the tree today), **partial**, **need**.

## 0. Prerequisite: a ledger the network agrees with

A producer that forges on a wrong ledger state mints invalid blocks. Everything
below assumes the validation plan is finished and proven (`PLAN_FULL_VALIDATION.md`):
Plutus phase-2 strict, local rewards and parameters verified against a reference,
Conway governance applied. Until then the node can *relay* but must not *forge*.

## 1. Keys and credentials — have (`src/pool/keystore.ts`, 2026-09-05)

- Cold key (pool operator), KES signing key, VRF signing key, operational
  certificate: load from the same files `cardano-node` uses
  (`kes.skey`, `vrf.skey`, `node.cert`, CBOR envelope JSON) so operators keep
  their tooling.
- Key hygiene: files read once at startup, never logged, held only in the
  forging process; KES key zeroised after evolution; cold key never loaded.
- Operational certificate checks at startup: cold signature valid, KES period
  in range, counter equal to the last on-chain counter + 1.
- Libraries: **have** `@harmoniclabs/kes` (`sign`, `kes_update`, `kes_to_pk`),
  `@harmoniclabs/crypto` `VrfProof03.generate`. Ed25519 signing for opcert
  verification only.
- Done 2026-09-05: `src/pool/keystore.ts` reads and writes cardano-cli
  TextEnvelopes (cold/KES/VRF keys, `node.counter`, `node.cert`), derives
  pool id and VRF key hash, issues operational certificates byte-identical
  to `cardano-cli node issue-op-cert`, checks a certificate at startup
  (cold signature, KES key match, period window, counter = last on-chain + 1)
  and evolves the KES secret (cardano-cli stores the 608-byte body; the
  library works on the 612-byte body‖period form). Fixtures: throwaway keys
  generated with cardano-cli 11.0 in `src/pool/__fixtures__/cli-keys/`.

## 2. Slot clock and leadership — have (2026-09-05)

- **have**: exact slot ↔ time geometry per network, epoch nonce evolver,
  overlay schedule, leader threshold math (`rules/leaderMath.ts`), stake
  snapshots per epoch, operational-certificate counters.
- **need**: a wall-clock slot ticker (`slotToUnixTime` inverse, tolerant of
  drift, one tick per slot); per-epoch leader-schedule check for *our* pool
  (VRF over the epoch nonce for each slot, compare with our σ from the "set"
  snapshot the ledger uses for the current epoch); a "must forge now" decision
  with the deadline rules (block issued within the slot, one block per slot).
- Note the snapshot lag: the producer's σ for epoch e comes from the snapshot
  the ledger takes at the start of e − 1; `poolStakeForEpoch` already follows it.
- Done 2026-09-05: `src/pool/leaderSchedule.ts` (`leaderSlotsForEpoch`,
  `leadsSlot`) runs the header validator's check forward with our VRF key:
  `praosVrfInput` → `vrf03Prove` → `praosLeaderValue` → `isSlotLeader`.
  `vrf03Prove` (fastVrf.ts) is a draft-03 prover on the noble curve library,
  byte-identical to `VrfProof03.generate` and 0.9 ms per proof (the BigInt
  reference took 31 ms, an hour per epoch); a preview epoch schedule takes
  about two minutes. `scripts/leader-schedule.ts` reads σ and η0 from the
  node DB. `src/pool/slotClock.ts`: `SlotTicker` (re-armed per slot boundary,
  injectable clock) and `decideForge` (leader for the slot, inside the slot
  with 500 ms skew, not forged before, tip known and within 600 slots of the
  clock); tests.

## 3. Block assembly — have (2026-09-05; Haskell-node acceptance pending)

- Header (Praos): block number, slot, prev hash, issuer vkey, VRF vkey,
  VRF result (proof + output) for the slot's input, body size, body hash,
  opcert (KES vkey, counter, KES period, cold signature), protocol version;
  KES-sign the header body; evolve the KES key per period.
  `cardano-ledger-ts` has the header/body classes (`ConwayHeaderBody`,
  `ConwayBlock`) to serialise from fields.
- Body: transactions chosen from the mempool, sizes bounded by
  `maxBlockBodySize` and `maxBlockExecutionUnits`, ordering by arrival,
  witness sets and auxiliary data, `invalidTransactions` for phase-2 failures
  (requires strict Plutus evaluation first).
- Body hash computed the way `bodyHash.ts` verifies it.
- Done 2026-09-05: `src/pool/forge.ts` encodes the Babbage/Conway header body
  (10 fields, nested opcert and protocol version) with the node's CBOR copy,
  proves the slot VRF (`vrf03Prove`), KES-signs at evolution
  `slotKesPeriod − opcert.kesPeriod`, and assembles `[era, block]` and the
  ChainSync `[era − 1, #6.24(header)]` forms. An empty block forged with the
  cli fixture keys parses in ledger-ts, passes `validateHeader` (VRF, opcert,
  KES), `verifyBlockBodyHash` and `blockFetchHeaderIdentity`; wrong nonce or
  a flipped signature byte fails. `src/pool/bodyAssembly.ts` splits submitted
  transactions into the column-wise block segments (bodies, witness sets,
  auxiliary data map, invalid list) with cardano-binary's collection rule
  (≤ 23 elements definite, more indefinite); rebuilding preview block 11663879
  from its 30 transactions reproduces every segment byte for byte and the
  body hash. Open: acceptance by a Haskell node (§8).

## 4. Mempool for production — partial (greedy assembly done 2026-09-05)

- **have**: shared mempool fed by TxSubmission from peers and the local submit
  API; `mempool.maxSize`, TTL expiry.
- **need**: validate every incoming transaction against the current ledger
  with the same rules the block validator uses (`rules/txRules.ts`,
  `alonzoRules.ts`, Plutus evaluation) before admitting it; re-validate on
  chain switch and epoch change; fee-based ordering; eviction of transactions
  whose inputs were spent by an adopted block.

## 5. Chain selection and self-adoption — partial (self-adoption done 2026-09-05)

- **have**: multi-peer chain selection, rollback within k, body-hash-bound fetch.
- **need**: apply our own forged block through the same validation path,
  publish it to peers immediately (ChainSync server already serves stored
  blocks: `N2NChainSyncHost` / `N2NBlockFetchHost`), handle a competing block
  in the same slot (VRF tie-break: lower leader VRF wins in Praos).

### Producer service (2026-09-05)

`src/pool/BlockProducer.ts` ties §1–§5 together: loads the cardano-cli key
files from `config.producer`, checks the operational certificate against the
current KES period and the on-chain counter (`opcert_counters`), computes the
leader schedule for the current and next epoch in a worker
(`scheduleWorker.ts`) from `epoch_nonces` and the ledger's snapshot, ticks
the wall clock (`slotClock.ts`) and, when a slot is ours, assembles the
mempool transactions under `max_block_size`, forges and applies the block
through `ConsensusOrchestrator.adoptLocalBlock` — the same strict path a
fetched range takes — so a block that fails our rules is never published
(one retry with an empty body). One block per slot is enforced across
restarts through `stateFile`; `dryRun` logs leadership only. `role:
"producer"` keeps the inbound N2N listener on so relays pull the blocks.
Tests drive slots by hand against a fake node whose adopt step is our own
header validator.

## 6. Relay topology for a pool — partial

- **have**: inbound N2N listener (`role: relay`), peer sharing, governor.
- **need**: the two-hop layout SPOs run (block producer behind relays, no
  public inbound on the producer, only its own relays as local roots,
  `advertise: false`); duplex on outbound connections (found broken in the
  Dingo peering test: the responder side is not started on connections we
  open); primary-peer silence watchdog (also found in that test).

## 7. Operational safety — need

- KES period expiry warnings, opcert rotation without restart, refuse to forge
  when the KES key is expired or the opcert counter is stale.
- Fork/rollback awareness: never forge on a chain more than k behind the
  network tip ("sync tolerance"), never double-forge the same slot after a
  restart (persist the last forged slot).
- Clock sanity: refuse to forge if the wall clock disagrees with peers' tips by
  more than a few slots.
- Metrics: leader schedule, forged / adopted / orphaned counts, KES period
  remaining, on the existing `/metrics` + WebSocket feed and the desktop.

## 8. Testing — need

- Local testnet: `cardano-node` + Gerolamo producer forging on a private
  network (the repo already has `cardano-node` 11 binaries under
  `/media/bakon/data/cardano/cardano-node`); verify blocks are accepted by the
  Haskell node and by Dingo.
- Preprod pool: register a real pool, forge on preprod, compare our leader
  schedule against `cardano-cli query leadership-schedule`.
- Fuzz the assembly path against the validator: every block we forge must pass
  our own strict validation before publication.

## Order of work

1. Finish and prove the ledger (validation plan Phases 3 and 4; verification of
   snapshots, rewards and parameters against a reference).
2. Keys + opcert loading and checks (1). — done 2026-09-05
3. Slot ticker + leader schedule for our pool (2), first read-only: log
   "would have led slot N" and compare with `cardano-cli` on preprod. — done
   (schedule + `dryRun`); the cardano-cli comparison needs a preview pool
4. Header + empty-body forging on a local testnet (3, 5). — forging and
   self-adoption done; Haskell-node acceptance pending (preview pool or
   private testnet, the latter needs genesis-derived epoch geometry)
5. Mempool validation + body assembly (4). — assembly done; per-tx mempool
   validation still relies on the block-level strict check at adoption
6. Relay/producer topology, duplex, watchdog (6).
7. Operational safety and metrics (7), preprod pool (8).
