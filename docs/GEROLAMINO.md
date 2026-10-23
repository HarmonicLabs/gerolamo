# Gerolamino and Gerolamo (2026-10-16)

Gerolamino is HarmonicLabs' standalone Cardano node for the browser, shipped as a Chrome MV3 extension. It is a
separate codebase: the `ts-rebuild` branch of HarmonicLabs/gerolamino, worked on in `../gerolamino-ts`. It does
not import Gerolamo. Gerolamo's role is to be the peer it connects to, over N2N-over-WebSocket, until other
nodes serve that bearer too.

**Role (2026-10-22).** Gerolamino is the light member of the family: a data and information node, perhaps a relay
for other browser peers later, never a stake pool. Most users will sync from the tip; chunk and Mithril starts
and an OPFS ledger state are extras. Its UI follows Gerolamo's desktop app (`desktop/`, Electrobun), simpler and
lighter, rebuilt in plain TypeScript and CSS; it does not follow the web dashboard.

Gerolamino's own status, measurements and roadmap are in its `docs/STATUS.md`, and its requirements on a peer
are in `docs/WEBSOCKET_BEARER.md`. This page covers the Gerolamo side.

## What Gerolamo serves

| Setting | Value |
|---|---|
| Enabled by | `GEROLAMO_N2N_WS_PORT=<port>`, or `n2n.ws: { enabled, host, port }` in config (`src/network/n2n/config.ts`) |
| Bearer | `src/network/n2n/N2NServer.ts` and `WsNodeSocket.ts` |
| Paths (`WS_N2N_PATHS`) | `/n2n` canonical, `/`, and `/relay` (the path the first Gerolamino build always appended); others get 404 |
| Connection cap | `maxConnections`, default 64; the upgrade is refused with 503 when full |
| Idle close | 120 s without traffic |

- **Same hosts as TCP.** Each WebSocket connection is handed to the same inbound path as a TCP peer, with the
  same mux framing and the same hosts: handshake, chain-sync, block-fetch, tx-submission, keep-alive and
  peer-sharing.
- **Handshake.** Gerolamo answers WebSocket peers with `initiatorOnlyDiffusionMode: true`, so it never tries
  to sync from a browser.
- **Light query.** Gerolamo serves its light-query mini-protocol (mux protocol 7, `N2NLightQueryHost.ts`) on
  the same connection: epoch nonce, pool stake and immutable chunk files. With it, a browser verifies headers
  and starts from a Mithril-certified chunk without a second channel.

Tests: `src/network/n2n/N2NServer.test.ts`, "N2N over WebSocket", handshakes and runs chain-sync on `/n2n`,
`/relay` and `/`, and checks that another path gets 404.

## Deployment

| Node | WebSocket bearer |
|---|---|
| Server preview relay | `ws://192.168.1.173:3004/n2n`, LAN only; since 2026-10-14 |
| Server preview producer | none |
| Laptop node 3037 | none (inbound N2N is off) |

- **`/relay`** is not on the server yet; it ships with the next relay image.
- **Public access** needs `wss://` through TLS at a reverse proxy, and a router forward; neither exists yet.
  `docs/PLAN_BROWSER_NODE.md` has Caddy and nginx examples.
- **Preprod** has no Gerolamo relay yet. The server's root disk is 98 % full; a second, unmounted disk is
  waiting on a decision.

## What the tests against Gerolamo showed

| Client | Result |
|---|---|
| Gerolamino's own N2N stack (Bun harness, `packages/miniprotocols/src/__tests__/gerolamo-ws-e2e.ts` in the clone) | handshake v15, keep-alive, chain-sync from origin, intersect at tip, block-fetch, follows the tip |
| Old Gerolamino extension, built for preview (local branch `gerolamo-ws-preview`) | streamed 6 215 blocks over the bearer in three minutes; its WASM LSM storage failed every write. That storage and its Effect stack are why it was rebuilt. |
| Gerolamino node core, Bun, against the server relay | 517 / 517 headers verified, 516 blocks stored, one real rollback handled |
| Gerolamino extension, headless Chrome for Testing | verified blocks in OPFS in 2.8 s, offscreen recreate and resume |
| Gerolamino Mithril start | 325 certificates to genesis, then 552 / 552 headers |

## Library findings that concern Gerolamo too

- **`@harmoniclabs/crypto` `verifyEd25519Signature_sync` is unsafe.** With the identity public key, R = identity
  and S = 0 verify for any message. It also accepts S + ℓ and non-canonical points.
  - **Gerolamo's header checks are not exposed.** `src/consensus/fastEd25519.ts` uses the strict noble port
    bundled in `@harmoniclabs/crypto` (`dist/noble/ed25519.js`, `zip215: false`).
  - **Fallback.** It falls back to the BigInt verifier only if that module is missing.
  - **Other callers.** `src/pool/operator.ts` and `src/pool/keystore.ts` use the BigInt verifier on our own keys
    only.
  - **To do.** Fix it upstream, and make the fallback fail closed.
- **`VrfProof03.verify` accepts a non-canonical scalar.** Gerolamo verifies VRF with `src/consensus/fastVrf.ts`
  (@noble/curves), not `VrfProof03`.
- **BLS12-381 uncompress accepts x ≥ p.** The Plutus builtins `bls12_381_G1_uncompress` / `G2_uncompress` should
  reject it, as blst does.
- **`ouroboros-miniprotocols-ts` 0.0.5-dev7.** `HandshakeClient.propose(versionTable)` never recognises a version
  table, and the default proposal stops at v14. Gerolamo's own handshake does not use `propose`.

## Next steps on the Gerolamo side

1. Ship `/relay` with the next relay image.
2. Serve `wss://` publicly: a TLS reverse proxy in front of port 3004, a router forward, and a hostname.
3. A preprod relay with the bearer, once the server disk is settled.
4. A CIP for N2N over WebSocket, written with Gerolamino (see its `docs/WEBSOCKET_BEARER.md` for the open
   questions: path, subprotocol, discovery, light query, limits).
5. Make the ed25519 fallback fail closed instead of using the unsafe BigInt verifier.
