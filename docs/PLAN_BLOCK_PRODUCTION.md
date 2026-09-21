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

## Preview pool (2026-09-10)

- Registered 2026-09-10 04:52 UTC: pool `8df215df1a762e84d826bae39516a424a76e81e649001a3f903eda12`,
  keys in `/media/bakon/data/cardano/gerolamo-preview-pool` (keygen/opcert/register from
  `scripts/pool-register.ts`), pledge 5 000 ADA, cost 170 ADA, margin 1 %, relay
  50.202.37.130:3001, tx 5beecbaf… at slot 122 359 348 (epoch 1416). It enters the mark snapshot
  at the 1417 boundary and can lead slots from epoch 1418 (2026-09-12).
- Found on the way, fixed 2026-09-10: `GlobalSharedMempool` allocated its SharedArrayBuffer
  without `SharedMempool.initMemory` (free space 0, every append `InsufficientSpace`);
  `PeerClient` never sent tx-submission's `MsgInit`, so no peer requested our transaction ids
  (now sent when the sync loop starts; peers pull within a second); the `/txsubmit` endpoint
  mapped the numeric append status to HTTP 400 even on success. Once peers did ask, two more
  surfaced within minutes: `GerolamoTxSubmitServer` was also attached to outbound connections
  and answered beside the library client (duplicate replies), and the library decodes the
  request's `blocking` flag (a CBOR boolean) as false and answers a blocking request on an
  empty mempool with an empty list, then MsgDone after 40 s — either way every peer reset the
  connection within a minute. `PeerClient` now parses `MsgRequestTxIds` itself and a blocking
  request waits until the mempool has something (`GEROLAMO_TXSUB_TRACE=1` logs the exchange).
  Upstream: ouroboros-miniprotocols-ts `TxSubmitRequestIds` encodes/decodes `blocking` as
  simple(0/1) instead of a boolean, and `replyTxIdsBlocking` sends MsgDone.
- Temporary greeting: `producer.greeting = { paymentSkeyFile, paymentAddress }` makes the first
  block the pool forges on a network open with a self-payment carrying the metadata message
  "Gerolamo was here!" (label 674, `messageMetadata` in `operator.ts`); remembered per network
  in `stateFile` (`greeted`), never repeated. `BlockProducer.test.ts` "greeting transaction".
- Still needed before forging: the router port-forward (TCP 3001 → this host) so relays can
  pull our blocks, then `role: "producer"` with `n2n` and `producer` in the node config
  (`gerolamo-preview-pool/config.producer.json` is the prepared fragment) — first with
  `dryRun: true` for one epoch to see the leadership log, then live.
- 2026-09-10 06:15 UTC: faucet delegation of 1 000 004 ADA received (≈ 2.8 blocks/epoch from 1418).
  Inbound: OpenWrt port-forward WAN 3001 → this host's VPN address (masqueraded zone), verified
  with a node-to-node handshake through 63.45.33.80:3001; relay entry updated to
  63.45.33.80:3001 (tx 0c4a273c…, `pool-register.ts --pool-update`). The tip node runs as a relay
  (inbound listener on 3001) until the producer switch.
- 2026-09-10 07:00 UTC: transaction propagation works end to end through our own node — the
  relay-update tx 0c4a273c… (relay → 63.45.33.80:3001) was announced, fetched by a preview
  relay and confirmed within a minute. What cardano-node 11.0.1 actually speaks on
  tx-submission2 (probed against the local Haskell node, `src/network/txSubmissionCodec.ts`
  with tests): MsgInit `[6]`; the server's first MsgRequestTxIds comes 60 s after ChainSync
  starts and is *blocking* (`[0, true, 0, 3]`) — a blocking request must wait for something to
  announce; a tx id is the hard-fork combinator's `[eraIndex, hash]` (Conway = 6), a tx is
  `[eraIndex, #6.24(txBytes)]`, and the id/tx lists of ReplyTxIds, RequestTxs and ReplyTxs are
  *indefinite-length* arrays — any definite list, bare hash or empty blocking reply makes the
  node close the connection at once. The peer acknowledges ids per request (`ack`); only ids
  outside the unacknowledged window may be announced (`PeerClient.txIdsUnacked`). The producer
  now starts after the HTTP server and skips the leader-schedule pass for epochs where the pool
  has no stake; it derives the network from the node's setting (bug: `config.network` unset →
  preprod geometry → "KES expired"). The inbound responder (`src/network/n2n/N2NTxSubmissionHost.ts`, pure core
  `TxSubmissionResponder` with tests) is done 2026-09-10 09:05 UTC: after the connecting peer's
  MsgInit we ask for ids (blocking, window 10), fetch the bodies we do not hold, check each parses
  and hashes to its announced id, append to the shared mempool, acknowledge per round. Proved end
  to end: a fee-only self-payment (d4d58e6d…) announced to the producer through the public port
  63.45.33.80:3001 was fetched, accepted, announced by the producer to its hot peers, fetched by
  two preview relays and included in a block within a minute. The old outbound `TxSubmitServer.ts`
  (a misnamed second answerer) is deleted. Remaining for §4: ledger-rule validation before
  admission (today: parse + hash; an invalid transaction costs a forged block one retry with an
  empty body), eviction on adoption/expiry, and the id window surviving a mempool drop.
- 2026-09-10 12:50 UTC: with a relay connected inbound, the producer's mempool filled from the
  network (12 transactions within minutes) and the outbound announcer re-announced ids the peer
  had already acknowledged (the unacknowledged window was the only memory) — every hot peer
  reset within a second of the second announcement round (94 resets in 15 min, none on the
  import node, which has no inbound). `AnnounceWindow` (codec module, tested) now remembers
  every id announced to a peer for the life of the connection. Also today: open item 16
  (promoted-verifier drain stall) in VALIDATION_STATUS.md.
- 2026-09-10 19:20 UTC: the block-production view lives on the node's own `/stats` page
  (role, inbound listener, pool, op-cert/KES, schedule, next leader slot, forged, last error);
  the web dashboard servers (3050/3051) and the node's `/explorer/` static route are retired —
  the only UIs are the desktop app and `/stats`, which also shows recent blocks and the mempool.

### Epoch 1418 schedule (2026-09-12)

Final schedule from the stored η0 `00c6c2f8eb5de83a…` (σ = 1009501687663 /
1545727609211407, expected ≈ 2.8 slots, got 5): slots 122520682 01:31:22Z,
122535169 05:32:49Z, 122538785 06:33:05Z, 122546676 08:44:36Z, 122567530
14:32:10Z. The producer's schedule from the evolver's pre-boundary peek
(first at 14:26 UTC, right after the candidate froze) was identical: η0(e+1)
= ηc ⋆ ηh with ηh carried from the *previous* boundary, so the next epoch's
nonce is final 4k/f slots (9.6 h on preview) before the boundary, the same
window `cardano-cli query leadership-schedule --next` relies on.
`BlockProducer` records the nonce each epoch was scheduled from and
reschedules only if it changes (rollback across the freeze).

### Producer panel (gLiveView terms), 2026-09-12

`ProducerStats` (node `/metrics.producer`, the `/stats` card and the desktop
Overview card) now carries what gLiveView's CORE / BLOCK PRODUCTION panel
shows: `kes` (current period, evolutions used / remaining of maxKESEvolutions,
expiry slot and time), `opcert.chainCounter` (last counter the chain saw for
the pool, beside the on-disk counter), `missedLeaderChecks` (slots the ticker
never evaluated), `leaderSlots[]` with an outcome each (`upcoming`, `adopted`,
`confirmed` = still ours 10 blocks deep, `invalid` = our rules rejected the
forge, `missed` = slot passed without a forge, with the verdict as note,
`ghosted` = adopted then rolled away, `stolen` = another pool's block at our
slot) and `epochStats` (leader, ideal = σ·f·epoch length, luck, and the
outcome counters for the clock epoch). Outcomes settle every 30 slots by an
index lookup of the slot on our chain. The `/stats` page script had been
broken by a quote escape in the page template since the card was added; a
scratch check renders the template and parses the script.

### Duplex outbound (2026-09-12)

Blocks leave a Cardano node only by being pulled. Inbound sessions on the
preview producer were short (most under 15 s; two long-lived in 36 h), so a
forged block could sit unseen. Relays and producers advertised
InitiatorAndResponder on outbound connections already, but nothing served that
side and the library clients ignore the mux direction bit. Now
`initiatorSideMux` (N2NDirection.ts) gives the clients a responder-direction-only
view of the bearer, and `DuplexResponders.ts` attaches the ChainSync, BlockFetch,
KeepAlive, PeerSharing and TxSubmission hosts to every outbound connection once
the handshake succeeds, so the hot peers we dial can pull our chain. The flag is
advertised only when the responder deps are registered (index.ts, with `n2n`).

### Propagation odds for a small pool (2026-09-12)

From the ouroboros-network source: a remote treats the connection we opened as
a duplex peer only 15 minutes after the handshake, adopts it into its known set
through "light peer sharing" (peer sharing on, below the known-peers target, a
coin flip, at most 10 per minute), and promotes it warm then hot by uniform
random picks on churn cycles of 15 to 55 minutes. Inbound sessions that end
within seconds are churn demotions, not protocol faults. With 0.065 % of the
preview stake the expected number of hot inbound peers is about 0.5, so the
producer now keeps 20 warm outbound connections to distinct relays (each a
duplex candidate), asks peers for addresses regardless of its own advertising
flag, and logs every protocol a remote starts over our connections. The
ledger-peer source now exists: every registration certificate writes the
pool's relays to `pool_relays` (`recordPoolRelays`), pools registered before
that come from `<node dir>/ledger-relays.json` written by
`scripts/ledger-relays.ts` from a Mithril ledger snapshot (preview: 564 relays
of 504 pools), and the governor seeds them into the cold tier a batch at a time
(`seedLedgerPeers`, source "ledger", after `useLedgerAfterSlot`). Peer-sharing
requests are independent of our own advertising flag, but remotes answer a
non-advertising client with peer sharing disabled, so ledger peers are the
working source.

### Epoch 1418 result and epoch 1419 schedule (2026-09-12)

Epoch 1418: five leader slots; one block confirmed on the network (slot
122538785, height 4655249), one ghosted (height off by one, bug 106), two
rejected by our own rules (bugs 105 and 110), one missed with the machine off
(battery). Epoch 1419 (2026-09-13): slots 122610920 02:35:20Z, 122619622
05:00:22Z, 122622853 05:54:13Z, 122650083 13:28:03Z; the greeting transaction
is still pending for the first accepted block with a body.

### Explorer badge: header protocol version 11.67 (2026-09-13)

Cardanoscan offered to badge blocks minted by Gerolamo if their headers carry a
distinctive protocol version (Dingo does the same). cardano-node writes its own
supported version into headers (11.0 on preview today), and the ledger checks
only that the major does not exceed a validating node's maximum, so the minor
is free. `producer.headerProtocolVersion` (default: the ledger's version) is set
to 11.67 on the preview producer; `scripts/forge-dry-run.ts` shows the header
version it would forge.

### The greeting landed (2026-09-14)

Block 4661888 at slot 122732819 (12:26:59 UTC), hash f79f3b1217d40600…,
carries transaction fc0a79223e3a… with `{674: {msg: ["Gerolamo was here!"]}}`.
Three inbound peers fetched it within 0.2 s and the network built on it. The
same forge exercised the stale-transaction retry (5 → 3 transactions), the
11.67 header version and the readiness checks (four pullers attached before
the slot). The temporary greeting is done for preview; the producer keeps the
flag with the block hash and would only repeat it if that block left the chain.


### Node-to-client socket works for cardano-cli (2026-09-14)

`cardano-cli query tip|protocol-parameters|utxo|stake-pools --testnet-magic 2 --socket-path <nodeDir>/node.socket`
decode Gerolamo's replies (bug 120 in VALIDATION_STATUS.md). The reference encodings came from a real
cardano-node via `bun scripts/n2c-oracle.ts --socket <cardano-node.socket> --magic <n> --era 6`, which prints the
hex and decoded CBOR of each reply; run it against Gerolamo's socket too and diff. Left for the next pass, once
the preview cardano-node relay (`startPreviewRelay.sh`, port 6424) reaches Conway and can be used as the oracle:
GetStakeDistribution (5), GetStakePoolParams (17; relays live in `pool_relays`, metadata is not stored yet),
GetGenesisConfig (11), GetGovState (24) and the other governance queries, plus LocalTxSubmission end to end
(submit a tx through the socket and see it in our block).
