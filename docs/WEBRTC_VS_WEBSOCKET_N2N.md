# WebRTC vs WebSocket for N2N (Gerolamino browser peers)

Research note, 2026-11-13. Question: should the browser node speak Ouroboros N2N
over WebRTC data channels instead of WebSocket? Sources are primary (IETF,
libp2p, Cardano CIP) unless marked as judgement.

## 1. What N2N is

Ouroboros node-to-node is a set of mini-protocols multiplexed over one bearer:

| Mini-protocol | Traffic shape |
|---|---|
| ChainSync | small, frequent, latency-critical headers |
| BlockFetch | bursty ~90 KB blocks, pipelined (up to 32 concurrent ranges) |
| TxSubmission | small bursts, request/response |
| PeerSharing | rare |

The bearer only has to provide reliable, ordered, framed bytes. The multiplexer,
the CBOR codecs and the protocol state machines sit above it and do not care what
carries those bytes. This is why N2N-over-WebSocket works at all: a browser cannot
open TCP sockets, so a WebSocket carries the same byte stream.

## 2. What WebRTC data channels are

RFC 8831: data channels are SCTP encapsulated in DTLS over ICE/UDP.

Properties that matter here, from the RFC:

- Multiple streams with independent ordering. "SCTP defines a stream as a
  unidirectional logical channel existing within an SCTP association to another
  SCTP endpoint. The streams are used to provide the notion of in-sequence
  delivery and for multiplexing. Each user message is sent on a particular
  stream, either ordered or unordered. Ordering is preserved only for ordered
  messages sent on the same stream" (section 6.3).
- Ordered or unordered is chosen per message, not per connection.
- Partial reliability (PR-SCTP, RFC 3758): a sender can declare a message
  lifetime, and abandoned messages do not block later ones on the same stream.
- The WebRTC context requires congestion control (section 5, requirement 3).
- Multiple SCTP streams per association must be supported (section 6.1).

So: WebSocket is one globally ordered reliable byte stream. A WebRTC data channel
is N independently ordered, partially reliable message streams over UDP.

## 3. Gains and costs

Real gains:

| Gain | Why it matters for N2N |
|---|---|
| No cross-protocol head-of-line blocking | ChainSync, BlockFetch and TxSubmission can each live on their own SCTP stream. A block body in flight no longer delays the next header. On WS-over-TCP one lost segment stalls every mini-protocol on that socket. |
| Unordered and partial reliability | Stale headers are worthless; dropping them instead of retransmitting is a latency win under loss. |
| No global retransmit queue | Matters on mobile and lossy last-mile links, which is most of a browser node's audience. |

Costs:

| Cost | Detail |
|---|---|
| Signaling | Out of band and required: offer, answer, ICE candidates. |
| ICE / STUN / TURN | NAT traversal. Corporate and mobile networks block UDP routinely, so production needs TURN, which is a relay you operate anyway. |
| Server stack | ICE, DTLS, SCTP and data-channel framing are not in the Bun/Node standard library. libp2p spent years and multiple languages on this (`node-datachannel`, `werift`). Budget months. |
| Proxying and ops | WS rides Nginx and Cloudflare as a normal HTTP/1.1 upgrade on 443. WebRTC needs UDP 443 plus a TURN allocation, so existing ingress breaks. |
| Throughput | DTLS/SCTP in browsers is CPU-bound on encryption and historically single-threaded. For 90 KB block bursts it is plausibly slower than TCP-backed WS. Suspected, not measured: see section 6. |
| Identity | DTLS-SRTP uses self-signed certificates with fingerprint pinning, no PKI chain. Ouroboros does its own session-key handshake, so this is survivable but it is one more surface. |
| Diagnosability | WS is tcpdump-and-curl friendly. SCTP inside DTLS inside ICE is not, and every "why did the peer stall" investigation starts from a tool that speaks WebSocket. |

## 4. Where it actually matters

The headline feature of WebRTC is browser-to-browser connectivity: two peers
behind separate NATs, neither listening on an inbound socket, talking directly.
That is the only capability here that a WebSocket relay cannot offer.

In Gerolamino's normal mode, browser client to a relay that already has a public
address, WebRTC buys per-stream independence and costs signaling, TURN and months
of server work. The same independence from WebSocket is a configuration change:
one socket per mini-protocol.

## 5. Cardano precedent: CIP-45

CIP-45, Decentralized WebRTC dApp-Wallet Communication (Status: Active,
created 2022-11-29, Cardano Foundation), standardises WebRTC data channels
between dApps and wallets for exactly this reason: browsers cannot open sockets,
and the state of the art at the time (WalletConnect over WebRTC) needed a central
signaling server whose failure was a single point of failure. CIP-45 moves
discovery to WebTorrent trackers so no central component is required.

Takeaways:

1. WebRTC in Cardano is precedent, not novelty. It is already used for dApp to
   wallet.
2. The ecosystem's reaction to the signaling requirement was to engineer it
   away, because a central service reintroduces the dependency it was meant to
   remove.
3. CIP-45 solves dApp to wallet, not node to node: no headers, no block
   pipelining, no peer sharing.

## 6. Recommendation for Gerolamino

1. Keep WebSocket as the default N2N to relay transport. Lowest friction, one
   HTTPS port, proxies as-is, the mux already works, diagnosis is trivial.
2. Get the head-of-line win without changing transport: run separate WS
   connections per mini-protocol (ChainSync, BlockFetch, TxSubmission). Three
   sockets, no signaling, no TURN, no new server stack. This recovers most of
   what SCTP streams would give. Measure first.
3. WebTransport (HTTP/3 over QUIC) is the better middle option if true
   independent streams from a server are later needed: multiple QUIC streams,
   UDP 443, no ICE, STUN, TURN or signaling. libp2p's own comparison agrees that
   WebRTC is the more complex of the two. Caveat: Chromium first, Safari
   historically weak.
4. Reach for WebRTC only when the product needs browser-to-browser: a swarm
   with no relay, or a censorship-resistant path. Then budget for signaling and
   TURN, and remember CIP-45's lesson: whoever runs the signaling service
   owns the network.

One line: WebSocket is not the compromise, TCP-over-WebSocket is. Fix the
multiplexing first, then choose a transport with measurements in hand.

## 7. Measurements to take before any of this

| Metric | Why |
|---|---|
| p50/p99 header latency, 1 socket vs 3 sockets | Does the head-of-line cost actually show up? |
| Block fetch throughput at 1 percent packet loss | Where UDP stops paying for SCTP |
| CPU per MB of blocks: WS vs DTLS/SCTP | Is the throughput cheaper or costlier |
| Handshake and first-block time on mobile NAT | Signaling and TURN cost, end to end |
| Browser fleet support for WebTransport | Safari and older Chromium coverage |

Related: `docs/PLAN_BROWSER_NODE.md`, `docs/N2N_BATCH_SYNC_AND_RELAY_SPEC.md`.

## 8. Sources

- RFC 8831, RTCDataChannel Establishment Protocol: SCTP over DTLS over UDP,
  streams, ordering, PR-SCTP, sections 6.1 to 6.4.
  https://www.rfc-editor.org/rfc/rfc8831
- RFC 3758, SCTP Partial Reliability Extension.
- libp2p docs, WebRTC transport: signalling server and TURN requirement; browser
  nodes cannot dial TCP or QUIC, WebRTC versus WebTransport.
  https://docs.libp2p.io/concepts/transports/webrtc/
- CIP-45, Decentralized WebRTC dApp-Wallet Communication, Status Active,
  Cardano Foundation, 2022-11-29.
  https://github.com/cardano-foundation/CIPs/tree/master/CIP-0045
- RFC 6455, The WebSocket Protocol (a single ordered message stream over TCP).
