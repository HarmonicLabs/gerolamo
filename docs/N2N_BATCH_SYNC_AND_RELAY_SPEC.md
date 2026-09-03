# Gerolamo N2N batch-sync and inbound-relay specification

Status: implementation contract
Network: preprod first; mainnet remains configuration-equivalent but is not the first interoperability gate.

## Authoritative references

- `cardano-docs/network-spec.pdf`
  - §3.6 Handshake mini-protocol
  - §3.7 Chain-Sync mini-protocol
  - §3.8 Block-Fetch mini-protocol
  - §3.4 CBOR/CDDL and the node-to-node mini-protocol numbers
- `cardano-docs/network-design.pdf`
  - data diffusion, duplex bearers, validation/forwarding interleaving, and resource-exhaustion constraints
- `@harmoniclabs/ouroboros-miniprotocols-ts`
  - concrete multiplexer and message codecs used by Gerolamo
- `cardano-ledger-ts` CDDL and multi-era codecs
  - ledger/header/block wire-shape validation

The network specification defines BlockFetch as an inclusive range protocol: the client sends `MsgRequestRange(from,to)`; the server either sends `MsgNoBlocks`, or `MsgStartBatch`, one `MsgBlock` per block in chain order, and `MsgBatchDone`. The handshake server selects the highest mutually supported version after checking version data, including network magic.

## Part A — true BlockFetch range catch-up

### Problem

Current sync receives one ChainSync `RollForward`, validates its header, and calls `BlockFetchClient.request(point)`. The library implements that helper as `requestRange(point, point)`, so every round trip fetches exactly one block. The existing `fetchMultipleBlocks()` repeats one-point ranges and is not batching.

### Required pipeline

1. A hot peer collects ChainSync `RollForward` messages into a bounded FIFO.
2. Catch-up flushes at `batchSize` (default 32). A short `flushMs` deadline (default 25 ms) flushes a partial batch at the live tail.
3. No more than one batch is handed to consensus at a time per peer. The queue is bounded to `batchSize + one in-flight ChainSync response`.
4. Consensus parses and validates every advertised header before asking for bodies.
5. Consensus creates inclusive points from the first and last validated headers and performs exactly one `requestRange(first,last)`.
6. The returned `MsgBlock` sequence must have the same length and order as the validated header sequence. Each decoded block header hash and slot must equal its advertised ChainSync header.
7. Blocks are body-validated and applied strictly in ascending chain order. A failure stops the batch; no later block may be applied.
8. On a range mismatch, `MsgNoBlocks`, parse failure, rollback, demotion, or socket failure, discard uncommitted queued headers and terminate/demote that peer. A replacement peer resumes from the durable DB tip through `FindIntersect`.
9. At the live tail, the same path handles a one-item partial batch. There is no separate correctness path for single-block sync.
10. Rollback is serialized after any already-started apply prefix and before subsequent range batches. Headers waiting only in the peer FIFO are discarded before rollback.

### Backpressure and memory

- Default `batchSize`: 32 blocks.
- Configurable range: 1–256.
- Default `flushMs`: 25 ms.
- Only header messages are buffered before BlockFetch.
- Block bodies are bounded by one requested range; no unbounded history queue is permitted.
- BlockFetch and consensus work remain serialized per peer; SQLite writes remain on the existing global apply chain.

### Batch acceptance tests

- 32 advertised headers cause one `requestRange(first,last)`, not 32 point requests.
- A partial live-tail batch flushes by deadline.
- Returned blocks are matched by slot and header hash in order.
- A missing, extra, duplicate, reordered, or wrong-hash body rejects the batch and applies no later body.
- Rollback drops pending headers and is ordered after an in-flight apply prefix.
- Existing one-header behavior remains valid as a one-item range.

## Part B — inbound N2N relay

### Scope

Gerolamo accepts TCP N2N bearers and serves the minimum relay surface:

- Handshake responder (mini-protocol 0)
- ChainSync producer (mini-protocol 2)
- BlockFetch server (mini-protocol 3)
- KeepAlive responder (mini-protocol 8)

HTTP/MiniBF on port 3030 and N2C `node.socket` are separate services and must not be reused or described as the N2N listener.

### Configuration

Inbound N2N is opt-in.

```json
"n2n": {
  "enabled": false,
  "host": "0.0.0.0",
  "port": 3001,
  "maxConnections": 64,
  "maxRangeBlocks": 256,
  "handshakeTimeoutMs": 10000,
  "idleTimeoutMs": 120000
}
```

Environment overrides:

- `GEROLAMO_N2N=0|false` disables.
- `GEROLAMO_N2N_HOST` overrides bind host.
- `GEROLAMO_N2N_PORT` enables/overrides the TCP port.

### Handshake contract

1. Parse an N2N `MsgProposeVersions` table.
2. Intersect it with Gerolamo-supported N2N versions 7–14.
3. Select the highest mutual version.
4. Reject an empty intersection or mismatched network magic.
5. Negotiate N2N version data with `initiatorOnlyDiffusionMode=false`, peer sharing only when mutually supported, and query disabled.
6. Do not start ChainSync or BlockFetch hosts until `MsgAcceptVersion` has been sent.
7. Close on timeout, malformed CBOR, protocol violation, or refusal.

### ChainSync producer contract

- `FindIntersect(points)` checks points in client preference order against Gerolamo’s selected chain. Origin always intersects.
- `IntersectFound` returns the exact stored point and current tip; `IntersectNotFound` returns current tip.
- `RequestNext` returns the next stored header strictly after the client cursor.
- Header payload is the original ChainSync header data, not a nested stored `RollForward` message.
- If no next header exists, send `AwaitReply`, poll/subscribe for tip advance, then send the next header.
- The cursor is slot/hash based, not `slot + 1` and not a fake dense block number. SQLite queries choose the next existing block with `slot > cursorSlot`.
- On rollback of Gerolamo’s selected chain, send `RollBackward` to the surviving intersection before further `RollForward` messages.

### BlockFetch server contract

1. Validate that `from` and `to` are non-origin points on the selected local chain and `from.slot <= to.slot`.
2. Query inclusive blocks in ascending slot order.
3. Require exact endpoint hash matches.
4. Reject absent endpoints, reversed ranges, disconnected ranges, or ranges exceeding `maxRangeBlocks` with `MsgNoBlocks`.
5. Otherwise send `MsgStartBatch`, one `MsgBlock(raw multi-era block CBOR)` per stored block, then `MsgBatchDone`.
6. Never send a stored full `BlockFetchBlock` envelope as `blockData`; unwrap it when only the envelope is available.

### Storage adapter

The relay store reads both immutable and volatile storage as one selected chain:

- immutable rows from `immutable_blocks`
- volatile rows from `blocks`, joined to `volatile_headers`
- duplicate slot/hash rows are deduplicated with volatile precedence
- tip is the greatest selected slot across both stores
- byte decoding accepts SQLite BLOBs and the legacy JSON byte-array representation
- rows without recoverable raw block CBOR are not advertised as relay tips or intersections
- when the original RollForward envelope is absent, Shelley+ ChainSync header data is derived from the stored multi-era block
- point/tip lookups use indexed per-table `ORDER BY ... LIMIT 1` queries; they must never run a full-chain window function

The serving path is read-only. It must never write consensus or MiniBF tables.

### Resource and lifecycle controls

- Opt-in listener; default disabled.
- Hard maximum accepted connections.
- Per-connection handshake and idle deadlines.
- One outstanding ChainSync response and one outstanding BlockFetch range per mini-protocol state machine.
- Hard maximum range size.
- On close: dispose all protocol listeners, close the multiplexer once, remove the connection from accounting.
- Graceful node shutdown stops accepting, destroys active sockets, and waits for server close.

### Relay acceptance tests

- N2N client and server negotiate the highest mutual version on matching network magic.
- Wrong magic and no mutual version are refused.
- KeepAlive echoes the request cookie on an established bearer.
- `FindIntersect` and sequential `RequestNext` serve two sparse-slot headers without duplication.
- Inclusive BlockFetch range emits StartBatch, ordered blocks, BatchDone.
- Wrong endpoint or oversized range emits NoBlocks.
- Listener enforces max connections and cleans up counts on disconnect.
- A real second Ouroboros client connects over TCP, completes handshake, finds an intersection, receives headers, and fetches the same block range from Gerolamo.

## Delivery gates

1. Focused unit tests for batching and each responder state machine.
2. `bun x tsc --noEmit -p tsconfig.json`.
3. Existing focused networking/consensus tests.
4. Isolated temporary SQLite + loopback N2N integration test.
5. Preprod live-only smoke on a dedicated port and DB; do not touch hydrate/soak writers.
6. Confirm HTTP/MiniBF 3030 and optional N2C remain independent and healthy.
