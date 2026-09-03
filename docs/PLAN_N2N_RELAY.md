# Gerolamo: batch BlockFetch + inbound N2N relay

**Specs:** `/media/bakon/data/Dev/HarmonicLabs/cardano-docs/network-spec.pdf`, `network-design.pdf`.

## #1 Catch-up BlockFetch ranges — LANDED (Gerolamo)

Ouroboros BlockFetch has two client messages:

- `MsgRequestRange from to` — inclusive range, server streams `MsgStartBatch` + `MsgBlock*` + `MsgBatchDone` (or `MsgNoBlocks`)
- Single-block fetch is just `RequestRange(p, p)`

**Do:** one `blockFetchClient.requestRange(first, last)` per contiguous header batch.

**Do not:** loop `request(point)` / `requestRange(p, p)` per header.

Gerolamo: `PeerClient.fetchBlockRange` + `ConsensusOrchestratooor` rollForward batch. Keep `fetchBlock` for one-shot.

## Node role (config `role`, 2026-09-03)

`role: "data"` (default) — outbound only. Handshake advertises
`InitiatorOnlyDiffusionMode` + PeerSharing **disabled**, as the network spec
requires of nodes that are not reachable at the address they connect from.
Peer discovery then comes from topology only: bootstrap / publicRoot DNS names
are expanded into one peer per A record (`peerGovernor.resolveDns`, default
on), which is how `preprod-node.play.dev.cardano.org` alone yields 8 peers.

`role: "relay"` — additionally starts the inbound N2N listener below
(`n2n.host/port`), advertises `InitiatorAndResponder` + PeerSharing enabled and
asks peers for addresses. Shared addresses that fail
`peerGovernor.maxSharedPeerFailures` (default 3) connects are forgotten.
`peerGovernor.peerSharing: true|false` overrides the role default. Legacy
`n2n.enabled: true` / `GEROLAMO_N2N_PORT` still imply relay.

Desktop: Node › config › `role` select; Overview shows a `data node` / `relay · N in`
badge; `/metrics` carries `role` and `inbound {listening, host, port, clients}`.

## #2 Inbound N2N relay — LANDED (listener), PeerSharing/TxSubmission responders still open

A peer connecting **to us** needs:

1. TCP listen (not HTTP `:3030` MiniBF)
2. Multiplexer `protocolType: "node-to-node"`
3. Handshake **server** — library gap, now `HandshakeServer` in `@harmoniclabs/ouroboros-miniprotocols-ts` (N2N versions 7–14, magic check)
4. After Accept: `ChainSyncServer` + `BlockFetchServer` over local chain DB (`IChainDb`)
5. KeepAlive + optional PeerSharing/TxSubmission servers

N2C `HandshakeResponder` / `node.socket` is **not** this. Inbound relay is N2N TCP.

**Split:** library HandshakeServer here; Gerolamo `N2NServer` listen + ChainSync/BlockFetch responders = @don-gerolamo-dev.

Preprod magic `1`. Do not bind MiniBF port.
