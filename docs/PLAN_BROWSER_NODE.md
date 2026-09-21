# Browser Gerolamo over N2N-over-WebSocket (direction, 2026-09-15)

Correction from the user: the WebSocket is not an ops feed. It carries the **node-to-node
mini-protocols** (handshake, keep-alive, chain-sync, block-fetch, tx-submission) so that a
browser build of Gerolamo can connect to a Gerolamo relay, sync the chain and verify it in the
browser. `/ws/stats` (`wsHub.ts`) stays what it is; this is a second, separate endpoint.

## What already fits

- `@harmoniclabs/ouroboros-miniprotocols-ts` speaks over a `SocketLike`, and its
  `SocketLike.d.ts` already defines `WebSocketLike` (send / close / message events) beside the
  Node socket shape: the multiplexer, handshake, chain-sync and block-fetch clients run
  unchanged in a browser on a WebSocket. The same library is what `N2NServer.attachClient`
  wraps today for TCP peers.
- The wire format is the same mux framing, so a Gerolamo relay serving N2N over WebSocket is
  byte-compatible with what it serves cardano-nodes over TCP — one `RelayChainStore`, one set
  of hosts (`N2NChainSyncHost`, `N2NBlockFetchHost`), two bearers.
- The block store (PLAN_CHUNK_STORE.md) gives the browser a well-defined sync target: chunk
  files can be fetched or built on the client side, headers verified against the same rules.

## Server side (relay)

- `n2n.ws: { enabled, port | path }`: a Bun `WebSocket` upgrade on the peer block server (same
  origin as `/stats`) or a dedicated port, `binaryType: "arraybuffer"`, each connection wrapped
  as a `WebSocketLike` and handed to the existing `attachClient(socket, clients, store, options)`.
  Handshake, keep-alive, chain-sync and block-fetch hosts serve exactly as for TCP clients;
  inbound tx-submission (the mempool pull) too, so a browser wallet can submit through its own
  node.
- Limits: connection cap and per-connection range limits as for TCP (`maxConnections`,
  `maxRangeBlocks`), origin allow-list, TLS terminated by the reverse proxy in front of the
  relay (`wss://`).
- The stats page lists WebSocket clients beside TCP clients (`InboundClientInfo.transport`).

## Browser side (the actual project)

- A browser build of the consensus core: header parsing and validation (VRF and KES over the
  existing pure-TS crypto — `phase-4-pure-ts-crypto-research.md`), body-hash binding, the
  chain-sync client with the intersect/rollback logic, block-fetch ranges, chain selection.
  Ledger rules on the client are a later step (a "verifying light client" first: headers +
  body hashes + the k-deep immutable rule, full ledger validation later).
- Storage in the browser: chunk files in OPFS (`navigator.storage.getDirectory()`), the same
  `chunkFormat.ts` reader/writer (pure TypeScript, no Bun APIs), the hash index in memory or
  IndexedDB; the volatile blocks in memory.
- Bootstrap in the browser: a Mithril snapshot cannot be downloaded whole (15 GB); the browser
  syncs from a trusted point (the relay's immutable tip, or a Mithril-certified point whose
  certificate chain is verified in the browser with the pure-TS verifier we already have) and
  keeps a rolling window, or fetches chunk files from the relay over HTTP (`/chunks/NNNNN`) —
  the chunk format makes this a plain byte range.
- Build: the `src/storage`, `src/consensus/blockHeaderParser`, `BlockHeaderValidator`,
  `CandidateSet`, `RangeScheduler` and the mini-protocol clients must stay free of `bun:*`
  imports (they are, except the store's `Bun.file`/`Bun.hash.crc32` calls, which get a
  platform shim: `crc32` pure TS, file access via OPFS handles).

## Order

After the LMDB ledger (PLAN_LMDB_LEDGER.md) or in parallel by a second person: the server
endpoint is a day's work and independently useful (a browser dashboard that follows the chain
from the relay); the browser node is its own project with the light-client stage first.

## Built 2026-09-15 (stage 1)

**Relay side** — `n2n.ws: { enabled, host, port }` in the node config (or `GEROLAMO_N2N_WS_PORT` /
`GEROLAMO_N2N_WS_HOST`) starts a Bun WebSocket listener beside the TCP listener. Each connection
is wrapped by `src/network/n2n/WsNodeSocket.ts` into the Node-socket shape and handed to the same
`attachClient` as a TCP peer: handshake, keep-alive, chain-sync, block-fetch, peer-sharing and
tx-submission hosts are shared, the connection cap is shared, and the stats page tags such
clients "ws". Node 3036 runs it on `ws://127.0.0.1:3003`.

**Browser project** — `browser/` (SolidJS + Vite, own `package.json`):

```
GEROLAMO_WS_N2N=ws://127.0.0.1:3003 bun run browser:dev      # page on http://127.0.0.1:5180
GEROLAMO_WS_N2N=ws://127.0.0.1:3003 bun run browser:probe    # the same client core under Bun, prints stats JSON
bun run browser:build                                       # static bundle in browser/dist
```

`GEROLAMO_WS_N2N` (and `GEROLAMO_NETWORK_MAGIC`, default 2) are read at build/dev time through
Vite's `envPrefix`; the page also has an endpoint field. `browser/src/node/browserNode.ts` is the
client core (no DOM, no Bun APIs): a `Multiplexer` over the browser `WebSocket`, N2N handshake,
intersect at the relay's tip (or origin, or a point), the RollBackward/RollForward loop, and per
header: header hash recomputed (blake2b-256), prev-hash link checked, block fetched and its
body hash checked against the header (`hashTxSeq`, Alonzo+ four segments). `browser/src/node/cbor.ts`
walks block bytes without decoding.

Probe against 3036 (04:24 UTC): N2N v14 accepted, intersect at the tip, RollBackward first,
4 headers linked, 4 blocks fetched, 4 body hashes ok, ~9 KB transferred, state `at-tip`.

**Not yet**: VRF/KES header validation in the page (the pure-TS crypto exists in the main
repo; needs a Bun-free build of `BlockHeaderValidator`), ledger rules, persistent chunk storage
in OPFS (the chunk writer is pure TS already), a Mithril-certified starting point verified in
the browser, `wss://` behind the reverse proxy for a public relay.

## Stage 2 built (2026-09-15 05:05 UTC): everything over the one WebSocket

User direction: the browser node syncs from the tip and requests what it needs to verify over the
WebSocket — no HTTP side channel. The standard N2N protocols carry neither the epoch nonce nor the
stake distribution, so the relay now serves a small **Gerolamo light-query mini-protocol** on
every inbound N2N connection (TCP and WebSocket alike), mux protocol 7 — the node-to-client
LocalStateQuery number, which never appears on a node-to-node connection; the multiplexer
library forwards only known protocol numbers, which ruled out a fresh one. Messages are single
CBOR arrays (`src/network/n2n/N2NLightQueryHost.ts`):

```
[4]                      → [5, networkMagic, 0]                                         hello
[0, epoch]               → [1, epoch, nonce(32) | null]                                 η0
[2, epoch, poolId(28)]   → [3, epoch, poolStake | null, totalActiveStake | null, f.num, f.den]
```

The stake distribution is the epoch's "go" snapshot (`poolStakeForEpoch`, cached per epoch);
`f` is the active slot coefficient from the Shelley genesis.

**Verification in the browser per header** (`browser/src/node/headerVerify.ts`, same crypto as
the node: `fastVrf`, `@harmoniclabs/kes`, `vrfInputs`):
1. header hash and prev-hash link (stage 1);
2. operational certificate: cold key signs `kesVkey ‖ counter ‖ kesPeriod`;
3. KES signature over the header body at evolution `slot / slotsPerKESPeriod − opcert period`,
   evolutions bounded by `maxKESEvolutions`;
4. VRF proof for `blake2b(slot ‖ η0)` (Praos) or the nonce/leader seeds (TPraos), output = proof hash;
5. leader eligibility: `isSlotLeader(leaderValue, poolStake / totalActiveStake, f)` with the
   leader value `blake2b("L" ‖ vrfOutput)` (Praos) — the node's own `leaderMath`;
6. block fetched, body hash checked against the header (stage 1).

Preview/preprod/mainnet constants (epoch length, Shelley start, KES period, evolutions) live in
`browser/src/node/networks.ts`. The HTTP `apiBase` option remains as an optional fallback for a
relay without the light query; the page's default is empty.

Probe against 3036 at 05:02 UTC: handshake v14, light query supported, nonce for epoch 1421 over
the WebSocket, intersect at the tip, 4 headers: 4 linked, 4 body hashes ok, 4 header crypto ok,
4 leader checks ok. Tests: `bun run browser:test` verifies opcert/KES/VRF over 600 slots of real
preview headers plus tamper cases (wrong nonce fails VRF, altered body fails KES); each header
costs ~90 ms of pure-TS crypto in Bun.

**Still to do**: persistent chunk storage in OPFS (the chunk writer is pure TS), a
Mithril-certified starting point verified in the browser (the aggregator allows cross-origin
requests; the pure-TS verifier needs its `node:crypto` hashing swapped for `@harmoniclabs/crypto`),
`wss://` behind the reverse proxy for a public relay, and the relay's own tx-submission from the
page (wallet use). Ledger rules in the browser wait for the LMDB ledger.

## Stage 3 built (2026-09-15 05:10 UTC): persistent store in the browser

Verified blocks are written as cardano-node chunk files (`NNNNN.chunk|primary|secondary`) into
the browser's origin-private file system (`gerolamo/immutable/`) by `browser/src/node/chunkWriter.ts`
through a `FileSink` (`OpfsSink` in the page, `MemorySink` in tests). The open chunk lives in
memory and its three files are rewritten per block (≤ 1 MB); a finished chunk is padded and
written once. A client that starts at the tip begins mid-chunk: the primary index carries
repeated 0 offsets up to the first stored slot, a valid index for a chunk whose earlier slots are
empty, readable by the node-format reader. On reload the writer resumes at its last stored block
and the client intersects there (falls back to the relay tip if that block is no longer on the
relay's chain). The CRC-32 in `src/storage/chunkFormat.ts` is now platform-neutral (Bun's native
routine under Bun, a table in the browser).

Test (`browser:test`): a full chunk fed from its first block is byte-identical to the node's
three files; the open chunk is a prefix of the node's; resume continues the same bytes; a
mid-chunk start yields exactly the expected relative slots. The page has a "store chunks in the
browser (OPFS)" toggle, a stored-blocks card and a wipe button.

Still to do: a Mithril-certified starting point verified in the browser; `wss://` behind the
reverse proxy; tx-submission from the page; a Worker with sync access handles for Safari, which
lacks `createWritable`.

## Stage 4 built (2026-09-15 05:20 UTC): a Mithril-certified starting point, verified in the browser

`browser/src/node/mithrilAnchor.ts`, start option "mithril" in the page and `--mithril` in the probe:
1. newest cardano-database snapshot from the aggregator (JSON; the aggregator sends CORS headers,
   its CDN does not — so no chunk archives are fetched from the CDN);
2. certificate chain verified in the browser with the node's own pure-TS verifier
   (`src/mithril/dualRun.ts` and `pureTs/*`), whose Node `crypto` hashing became a portable shim
   on `@noble/hashes` (`pureTs/hash.ts`; the node's Mithril tests still pass) and whose local-disk
   helper is stubbed out of the bundle;
3. the certificate's signed message must bind the snapshot's merkle root;
4. the digests list from the aggregator must reproduce that root (`mkTree`);
5. the last certified chunk (the beacon's immutable file) comes from the **relay over the
   WebSocket** — light query `[6, n] → [7, n, chunk, primary, secondary]`, served only for
   complete chunks — and its three files must hash to the certified digests;
6. the chunk's last block is the certified point; the client intersects there and syncs forward
   with the stage-2 checks.

The relay supplies bytes only; every trust decision is made from Mithril's certificate chain and
the network's genesis key, both fetched by the browser itself.

Probe against 3036 at 05:19 UTC: chain OK ("walked 294 certs to genesis; Ed25519 OK"), 85 263
digests match the root, chunk 28420 matches, certified point slot 122 778 693, intersect there,
syncing with header crypto and leader checks passing. The chain walk takes about a minute
(294 aggregator fetches); a later pass can cache verified certificates in OPFS.

### Public relay: `wss://`

Terminate TLS at the reverse proxy and forward to the relay's WebSocket port; the page then takes
`wss://relay.example/n2n`. Caddy:

```
relay.example {
    reverse_proxy /n2n 127.0.0.1:3003
}
```

nginx: `location /n2n { proxy_pass http://127.0.0.1:3003; proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 1h; }`.

Remaining from the plan: tx-submission from the page (wallet use), a Worker with sync access
handles for Safari's OPFS, certificate caching, and ledger rules in the browser after the LMDB
ledger lands.
