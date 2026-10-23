---
CIP: ?
Title: Node-to-Node over WebSocket
Category: Network
Status: Proposed
Authors:
    - Mike (Harmonic Labs) <mike@onchainapps.io>
Implementors:
    - Harmonic Labs: Gerolamo (server), Gerolamino (browser client)
Discussions:
    - To be opened
Created: 2026-10-23
License: CC-BY-4.0
---

## Abstract

This CIP lets a Cardano node run inside a web browser and talk to ordinary relays using the node-to-node (N2N)
protocols it would use over TCP. Browsers cannot open TCP sockets, so the N2N byte stream is carried over a
WebSocket instead: the multiplexer, the mini-protocols and the handshake stay exactly as they are; only the bearer
changes. The CIP also defines how a server announces the services it offers before any N2N byte is sent, an optional
"light query" service that gives a browser node the few facts it cannot derive from headers alone, the limits a
server applies to browser peers, and how browsers discover WebSocket relays.

## Motivation: why is this CIP necessary?

A browser-based node is the most accessible way to verify the chain yourself: no installation, no disk to
provision, nothing to keep running. It can verify headers, follow the tip, store the blocks it has checked, and
submit transactions without trusting a third-party API. Harmonic Labs runs one today, Gerolamino, a browser
extension written in TypeScript.

Every browser node faces the same three problems:

1. **No TCP.** Browsers only offer WebSocket, WebTransport and WebRTC. Cardano relays only speak N2N over TCP, so
   browser nodes need a proxy or a relay that speaks something a browser can open.
2. **No standard.** Without an agreed path, framing and handshake rules, every browser node needs its own server,
   and every relay operator who wants to help needs custom software.
3. **Facts a browser cannot compute.** Verifying a Praos header needs the epoch nonce and the issuing pool's
   relative stake, which come from ledger state a light node does not have. Today each implementation invents its
   own side channel for them.

A common, minimal bearer lets any node implementation (cardano-node behind a proxy, Gerolamo, Dingo, Amaru) serve
browser peers, and lets any browser node use any of them. It also makes the diversity of nodes useful to light
clients: a browser can follow one relay and cross-check another run by someone else.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in RFC 2119.

### 1. Transport

- A connection is a WebSocket ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)). Servers reachable from the
  public internet MUST offer `wss://` (TLS), at the node or at a reverse proxy in front of it. Plain `ws://` MAY be
  used on loopback and private networks.
- Only binary messages are used. A text message is a protocol error; the receiver MUST close the connection.
- **The byte stream is unchanged.** The concatenation of all binary message payloads in one direction MUST be
  exactly the byte stream a TCP N2N peer would send: Ouroboros multiplexer segments, each an 8-byte header
  (32-bit timestamp, 1-bit mode and 15-bit mini-protocol number, 16-bit payload length) followed by at most 65 535
  payload bytes.
- **Message boundaries carry no meaning.** A sender SHOULD put whole segments in each message. A receiver MUST accept
  a segment split across messages and several segments in one message, exactly as over TCP.

### 2. Endpoint

- The canonical path is `/n2n`. A server MAY accept other paths. A request for a path it does not serve gets HTTP
  404.
- A server at its connection limit answers the upgrade with HTTP 503 and SHOULD include `Retry-After`.

### 3. Service announcement

A server announces what it offers during the WebSocket upgrade, through the subprotocol
(`Sec-WebSocket-Protocol`), so a client knows before sending any N2N byte which mini-protocols it may use.

| Subprotocol | Meaning |
|---|---|
| `cardano-n2n.v1` | The standard N2N mini-protocols of the negotiated N2N version, nothing else. |
| `cardano-n2n.v1+lightquery` | The same, plus the light query (section 6). |

- A client MUST offer the subprotocols it can use, best first, for example
  `Sec-WebSocket-Protocol: cardano-n2n.v1+lightquery, cardano-n2n.v1`.
- A server MUST select the richest offered subprotocol it supports. A server that implements this CIP MUST select
  one; a client that offered none gets none (see section 9).
- A client MUST NOT send traffic for a mini-protocol the selected subprotocol does not include. Probing is not
  allowed: a multiplexer may close the connection on traffic for a mini-protocol it does not run.
- Further services are added as further `+name` suffixes by later CIPs. Unknown suffixes are never selected.
- Browser JavaScript can read the selected subprotocol (`WebSocket.protocol`) but no other response header, which is
  why the announcement uses it.

The N2N handshake's version data is **not** extended. For N2N versions 14 and 15 it is a fixed record (network magic,
initiator-only diffusion mode, peer sharing, query) that nodes decode strictly; an extra field would break the
handshake for existing nodes.

### 4. Handshake and diffusion mode

- The N2N handshake (mini-protocol 0) runs first, unchanged. A client SHOULD propose the N2N versions it supports;
  the server answers with the highest common one.
- **Browsers are initiator-only.** A browser cannot accept connections or serve the chain to others. A client in a
  browser MUST set `initiatorOnlyDiffusionMode: true` and `peerSharing: 0`.
- A server MUST NOT start initiator-side mini-protocols toward a peer that is initiator-only, and MUST NOT count it
  as a duplex peer.

### 5. Mini-protocols

Over a `cardano-n2n.v1` connection, the mini-protocols, numbers and state machines are those of N2N over TCP:

| Number | Mini-protocol | Use by a browser node |
|---|---|---|
| 0 | Handshake | required |
| 2 | Chain-sync | follow headers |
| 3 | Block-fetch | fetch bodies |
| 4 | Tx-submission | submit transactions |
| 8 | Keep-alive | liveness |
| 10 | Peer-sharing | not used (initiator-only peers share no peers) |

### 6. Optional service: light query (`+lightquery`)

The light query is a request/response mini-protocol that answers the facts a light node needs and cannot derive from
headers alone. It is offered only on connections whose selected subprotocol includes `+lightquery`.

- **Mini-protocol number.** Gerolamo carries it on number 7, unused on N2N connections today. This CIP asks the
  ouroboros-network maintainers to assign a number reserved for it; until then, 7.
- **Messages.** One CBOR array per message; the client sends a request, the server answers. Replies come strictly in
  request order.

| Request | Reply | Meaning |
|---|---|---|
| `[4]` | `[5, network_magic, version, capabilities]` | Hello. `version` is 1. `capabilities` is a map of the request types the server serves (below). |
| `[0, epoch]` | `[1, epoch, nonce / null]` | The epoch nonce η₀ (32 bytes), for verifying VRF proofs. |
| `[2, epoch, pool_id]` | `[3, epoch, pool_stake / null, total_active_stake / null, f_num, f_den]` | A pool's active stake in the epoch's stake distribution and the active slot coefficient f, for the leader check. |
| `[6, chunk_no]` | `[7, chunk_no, chunk, primary, secondary]` or `[7, chunk_no, null, null, null]` | A complete immutable chunk in cardano-node's on-disk format, for a start that can be checked against a Mithril-certified digest. |
| `[8, id, path]` | `[9, id, status, body]` | A read-only Blockfrost query: `path` under `/api/v0`, `body` the JSON answer, `status` its HTTP status. |
| anything else | `[255, text]` | Unknown or failed request. |

- **Capabilities.** The hello's map has text keys: `"nonce"`, `"stake"` and `"chunk"` with boolean values, and
  `"blockfrost"` with a map of its limits (`"rate"` requests per `"window_ms"`, `"max_body"` bytes). A client MUST
  only send request types the map lists. Version 0 of the hello had no map; a client MUST treat it as "nonce, stake,
  chunk".
- **Blockfrost queries.** Only GET semantics. A server SHOULD rate-limit per peer (answering 429), cap answer size
  (answering 413 and suggesting paging), and refuse paths that leave `/api/v0` (400).

### 7. Liveness

- A client SHOULD send keep-alive at least every 20 seconds. Browser extensions also need traffic at least every 30
  seconds to keep their background worker alive.
- A server SHOULD close a connection that has carried no traffic for 120 seconds.

### 8. Limits and security

- **Do not trust the origin.** The `Origin` header is set by the browser and says nothing about the peer's
  intentions; servers MUST NOT use it for access control.
- **Caps.** A server SHOULD cap connections in total and per IP address, answering 503 beyond the cap.
- **Back-pressure.** Browsers buffer outgoing data without bound. A server SHOULD cap the bytes in flight per
  connection, and SHOULD bound block-fetch ranges per request.
- **Same rules as TCP.** Every N2N rule (protocol timeouts, size limits, misbehaviour handling) applies unchanged.

### 9. Compatibility

- **Existing TCP peers** are unaffected: nothing in the TCP bearer or the handshake changes.
- **Servers from before this CIP** select no subprotocol. Chrome treats a handshake where the client offered
  subprotocols and the server selected none as failed, so a client SHOULD retry once without offering any. Such a
  connection is "unannounced": the client MAY use the light query only if it knows by other means that the server is
  an implementation that offers it (in practice, Gerolamo before this CIP).
- **Clients from before this CIP** offer no subprotocol; servers accept them and select none.

### 10. Discovery

On-chain pool relay registrations carry IP addresses, DNS names or SRV names for TCP only. To find WebSocket relays:

- **Extended pool metadata** (the document referenced from a pool's registration, see
  [CIP-6](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0006)) SHOULD carry
  ```json
  "n2n_websocket": [
    { "url": "wss://relay1.example.com/n2n", "services": ["cardano-n2n.v1", "cardano-n2n.v1+lightquery"] }
  ]
  ```
  with the same service names as the subprotocols, so a browser can choose peers before connecting: standard-only
  peers for chain-sync, block-fetch and cross-checking; light-query peers for nonce, stake, certified starts and
  ledger queries.
- **DNS** MAY carry the same as a TXT record at `_cardano-n2n-ws.<relay domain>`:
  `url=wss://relay1.example.com/n2n services=cardano-n2n.v1,cardano-n2n.v1+lightquery`.
- **Peer sharing** could later hand out WebSocket addresses; that needs a new address type and so a new N2N version,
  and is left to a later CIP.

## Rationale: how does this CIP achieve its goals?

- **Why WebSocket.** It is the one bidirectional byte stream every browser has, works through proxies and CDNs, and
  maps one to one onto a TCP stream. WebTransport is not in every browser and needs HTTP/3 on the server; WebRTC
  needs signalling and does not fit a client-server relay.
- **Why the same bytes.** Keeping multiplexer segments unchanged means a server implementation is a few dozen lines
  around its existing N2N stack (Gerolamo's adapter presents the WebSocket as an ordinary socket), and a proxy in
  front of an unmodified node works too. No new framing to specify, test or get wrong.
- **Why announce in the subprotocol and not the handshake.** The handshake's version data is decoded strictly by
  existing nodes and changing it means a new N2N version. The subprotocol is negotiated before the first N2N byte,
  is standard WebSocket, and is the only response detail browser code can read. Announcing also removes the need to
  probe, which can cost the connection on a strict multiplexer.
- **Why initiator-only.** A browser cannot accept inbound connections or reliably serve data, and treating it as a
  duplex peer would waste relay resources and confuse peer selection.
- **Why a light query, and why optional.** A light node needs a handful of facts that only ledger state provides.
  Making it a separate, announced service keeps plain relays plain: a cardano-node behind a proxy serves
  `cardano-n2n.v1` and is still useful to browsers for chain-sync, block-fetch and cross-checking.
- **Why metadata for discovery.** Relay registrations are on chain and changing their format is costly; the
  extended metadata document is already where operators publish facts about their relays.

## Path to Active

### Acceptance Criteria

- [ ] Two independent server implementations serve N2N over WebSocket with the service announcement.
- [ ] One browser client follows the chain from at least two of them, using standard-only and light-query peers.
- [ ] A mini-protocol number for the light query is assigned by the ouroboros-network maintainers.
- [ ] At least one stake pool publishes `n2n_websocket` in its extended metadata.

### Implementation Plan

- [x] Gerolamo (TypeScript node, Harmonic Labs): WebSocket bearer, `/n2n` endpoint, subprotocol selection, light query
      version 1 with capabilities and Blockfrost queries.
- [x] Gerolamino (browser extension, Harmonic Labs): offers both subprotocols with the fallback of section 9, gates the
      light query on the announcement, answers stored data locally and asks the peer for the rest.
- [ ] A reverse-proxy recipe that puts `cardano-n2n.v1` in front of an unmodified cardano-node.
- [ ] Discovery from extended pool metadata in Gerolamino.

## References

- RFC 6455, The WebSocket Protocol: https://www.rfc-editor.org/rfc/rfc6455
- The Shelley networking protocol specification (ouroboros-network): multiplexer and N2N mini-protocols.
- CIP-6, Stake Pool Extended Metadata: https://github.com/cardano-foundation/CIPs/tree/master/CIP-0006
- Gerolamo implementation: `src/network/n2n/N2NServer.ts`, `WsNodeSocket.ts`, `N2NLightQueryHost.ts`
- Gerolamino implementation: `src/node/browserNode.ts`, `lightQuery.ts`, `query.ts`

## Copyright

This CIP is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
