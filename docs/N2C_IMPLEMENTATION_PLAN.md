# Gerolamo N2C `node.socket` — Implementation Plan

> Branch: `The-Lab`  
> Consumer: TheLab (`/media/bakon/data/Dev/HarmonicLabs/TheLab`) via `@harmoniclabs/ouroboros-miniprotocols-ts`  
> Goal: Gerolamo **serves** Node-to-Client on a Unix domain socket so Lab can connect like Dolos (`serve.ouroboros` / `node.socket`).

---

## 1. Product context (do not confuse)

| Layer | What exists today | What we need |
|-------|-------------------|--------------|
| **HTTP** | `peerBlockServer` on TCP `:3030` (or Bun `unix:` HTTP) | Keep for `/health`, `/block`, `/txsubmit` |
| **Config `unixSocket`** | Toggles **HTTP over Unix** (`./src/gerolamo.socket`) | **Separate** flag/path for Ouroboros N2C |
| **N2N** | `PeerClient` → TCP peers, `protocolType: "node-to-node"` | Unchanged |
| **N2C** | **Not implemented** | Unix IPC server + mini-protocol responders |
| **TheLab client** | `src/bun/dolos/n2cClient.ts` — `Multiplexer({ protocolType: "node-to-client" })` + `HandshakeClient.propose` + `ChainSyncClient` | Point at Gerolamo socket after server works |

**Naming:** introduce `n2cSocketPath` (or `ouroborosSocket`) — do **not** overload `unixSocket` (HTTP-only today). Lab docs already warn about this.

Default path for Lab instances (suggested):

```text
~/.local/share/thelab/gerolamo/<instanceId>/node.socket
```

Env override (spawn-friendly):

```text
GEROLAMO_N2C_SOCKET=/abs/path/node.socket
```

---

## 2. What the library actually gives us

Repo: `/media/bakon/data/Dev/HarmonicLabs/ouroboros-miniprotocols-ts` (`@harmoniclabs/ouroboros-miniprotocols-ts` **0.0.5-dev7** in Gerolamo deps).

### Multiplexer / socket

- `Multiplexer({ protocolType: "node-to-client" | "node-to-node", connect: () => SocketLike })`
- N2C uses **Unix** `net.connect({ path })` / `net.createServer` listen path.
- `SocketLike` = Node socket-like (`write`/`end`/`on`/`removeListener`) or WebSocket-like.
- N2C vs N2N: `isN2N = protocolType !== "node-to-client"`.
- Mini-protocol IDs (`MiniProtocol`):

| ID | Name | N2N / N2C |
|----|------|-----------|
| 0 | Handshake | both |
| 2 | ChainSync | **N2N** |
| 5 | LocalChainSync | **N2C** |
| 3 | BlockFetch | N2N |
| 4 | TxSubmission | N2N |
| 6 | LocalTxSubmission | N2C |
| 7 | LocalStateQuery | N2C |
| 8 | KeepAlive | both (N2N common) |
| 9 | LocalTxMonitor | N2C |
| 10 | PeerSharing | N2N |

### Handshake (client-only today)

- **`HandshakeClient`** only — no `HandshakeServer`.
- N2C version table defaults: **16, 17, 18, 19** (N2N: 7–14).
- N2C `VersionData` CBOR shape: `[networkMagic, query]` (not full N2N 4-tuple).
- Client flow (Lab): `propose({ networkMagic, query: false })` → wait `Accept` / `Refuse` / `QueryReply`.
- Server must: listen on `MiniProtocol.Handshake`, parse `HandshakeProposeVersion`, pick max mutual version, reply `HandshakeAcceptVersion` (or refuse).

### ChainSync

- **`ChainSyncClient`**: already switches mux protocol via `mplexer.isN2N` → `ChainSync` vs **`LocalChainSync`**.
- **`ChainSyncServer`**: exists but is **hard-coded to `MiniProtocol.ChainSync` (2)** for listen/send — **not N2C-ready as-is**.
  - Must either:
    1. **Upstream fix** in ouroboros-miniprotocols-ts: mirror client and use `LocalChainSync` when `!isN2N`, **or**
    2. Gerolamo thin fork/wrapper that listens/sends on protocol **5**.
- Server needs **`IChainDb`**:

```ts
interface IChainDb {
  findIntersect(...point: IChainPoint[]): Promise<IChainTip | undefined>;
  getBlockNo(blockIndex: bigint): Promise<Uint8Array>;
  getTip(): Promise<IChainTip>;
  getBlocksBetweenRange(from: IChainPoint, to: IChainPoint): Promise<ChainPoint[]>;
  on(evt: "extend" | "fork", cb: (tip: IExtendData) => any): void;
  off(evt: "extend" | "fork", cb?: (tip: IExtendData) => any): void;
}
```

Gerolamo has raw pieces (`getMaxSlot`, `getBlockBySlot`, `getBlockByHash`, headers/blocks tables) — **no `IChainDb` adapter yet**.

### Local TxSubmit / TxMonitor / LocalStateQuery

| Protocol | Client in lib | Server in lib | Notes |
|----------|---------------|---------------|-------|
| LocalTxSubmission (6) | `LocalTxSubmitClient` | **none** | Messages only; need Gerolamo `LocalTxSubmitServer` (or reuse mempool + Accept/Reject) |
| LocalTxMonitor (9) | `TxMonitorClient` | **none** | Optional later; map to `GerolamoMempool` |
| LocalStateQuery (7) | `LocalStateQueryClient` | **none** | Messages only (`QryAcquire`…`QryResult`); full ledger queries are large |
| N2N TxSubmission | `TxSubmitClient` + `TxSubmitServer` | yes | **Wrong mini-protocol for N2C** — do not use for node.socket |

### BlockFetchServer / KeepAlive

- BlockFetch is N2N — not required for first N2C Lab tip stream.
- KeepAlive server optional for first Lab connect (client may not require it for handshake+chain tip probe).

---

## 3. Target architecture

```text
                    ┌─────────────────────────────┐
  Lab / cardano-cli │  Unix: node.socket          │
  LocalStateQuery   │  Multiplexer N2C            │
  LocalChainSync    └─────────────┬───────────────┘
                                  │
                         N2CServer (new)
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
  HandshakeServer*        LocalChainSyncServer*     LocalTxSubmitServer*
  (new, thin)             (lib ChainSyncServer      (new, thin)
                           + N2C protocol fix +
                           IChainDb adapter)
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  ▼
                    SQLite via src/sql.ts + db.ts
                    GlobalSharedMempool (tx path)
```

\* = not exported as finished product in the lib today.

Wire-up in `start()` **after** `initSql` + `ensureInitialized`, **alongside** HTTP `startPeerBlockServer` (do not replace HTTP).

---

## 4. Phased plan

### Phase 0 — Spec lock & lib decision (½ day)

- [ ] Confirm Lab MVP: **Handshake + LocalChainSync tip stream** first (matches `n2cClient.ts` Phase 5a).
- [ ] Prefer **upstream PR** to ouroboros-miniprotocols-ts:
  - `ChainSyncServer` use `LocalChainSync` when `!mplexer.isN2N`
  - optionally add `HandshakeServer` (small, high reuse)
- [ ] If upstream lag: implement Gerolamo-local wrappers only; keep types imported from lib messages.
- [ ] Config schema:

```jsonc
{
  "n2c": {
    "enabled": true,
    "socketPath": "./node.socket"   // or absolute Lab instance path
  }
}
```

Env: `GEROLAMO_N2C_SOCKET`, `GEROLAMO_N2C=0` to disable.

### Phase 1 — Socket acceptor + Handshake (MVP connect)

**Files (proposed):**

- `src/network/n2c/N2CServer.ts` — `net.createServer`, path lifecycle (unlink stale socket, chmod)
- `src/network/n2c/HandshakeResponder.ts` — parse propose → accept/refuse
- `src/network/n2c/index.ts` — export `startN2CServer(config) / stopN2CServer()`
- Config + `start()` hook in `src/network/index.ts`

**Behavior:**

1. Listen on `socketPath` (create parent dirs).
2. On connection: `new Multiplexer({ protocolType: "node-to-client", connect: () => socket })`  
   (for accepted sockets, `connect` returns the already-open socket; reconnect policy: no auto-reconnect on server side).
3. Attach Handshake responder; accept max shared N2C version with matching `networkMagic`.
4. Log accept; leave other protocols idle until Phase 2.

**Verify:**

```bash
# terminal A
NETWORK=preprod GEROLAMO_N2C_SOCKET=/tmp/gerolamo-n2c.sock bun src/index.ts
# terminal B — reuse Lab client or a 30-line bun script
# Multiplexer N2C + HandshakeClient.propose({ networkMagic: 1 })
```

Success = accept (not refuse / hang).

### Phase 2 — `IChainDb` adapter + LocalChainSync

**Files:**

- `src/network/n2c/GerolamoChainDb.ts` implements `IChainDb` over `db.ts`:
  - `getTip` ← max slot + header hash from volatile/immutable
  - `findIntersect` ← walk client points vs DB (reuse `findIntersection` / header tables where possible)
  - `getBlockNo` / range helpers ← map index or slot→raw header/block CBOR as server expects
  - `on("extend"|"fork")` ← emit when PeerClient applies roll-forward / rollback (event bus)
- Fix LocalChainSync mux id (lib PR or wrapper).
- Instantiate server per N2C connection after handshake.

**Verify:** Lab `n2cClient.connect(socket, magic)` → `rollForward` / tip events fire.

### Phase 3 — LocalTxSubmission

- Thin server: on `LocalTxSubmitSubmit` → validate lightly / append mempool → `Accept` or `Reject`.
- Reuse `GlobalSharedMempool` + existing HTTP `/txsubmit` validation if any.
- Optional: fan-out to N2N peers via existing `TxSubmitClient` path later.

### Phase 4 — LocalStateQuery (incremental)

**Do not** aim for full node query surface on day one.

Suggested order (Lab-useful):

1. Acquire tip / acquire point → `Acquired`
2. Hard-coded or minimal queries: system start, chain tip, current era (if encodable with available state)
3. UTxO-by-address / protocol params only when ledger snapshot state is trustworthy

Implementation: event-driven on mux protocol 7 using existing message codecs (`QryAcquire`, `QryQuery`, `QryResult`, …). Query payload decoding can start as “unsupported → `QryFailure`” for unknown tags.

### Phase 5 — LocalTxMonitor + polish

- Map monitor acquire/next/hasTx/sizes to mempool adapter.
- Concurrent clients, backpressure, metrics on `/health` (`n2c: { path, clients }`).
- Instance layout docs for TheLab spawn (`GEROLAMO_N2C_SOCKET` next to DB path).

### Phase 6 — TheLab wiring

- `gerolamoService`: set socket path under instance dir; surface in UI like Dolos.
- Reuse `dolosN2C` or clone as `gerolamoN2C` with same Multiplexer pattern.
- UI copy: remove “N2C not implemented” once Phase 2 green.

---

## 5. Config / lifecycle details

| Concern | Decision |
|---------|----------|
| Stale socket | `unlinkSync(path)` if exists before listen (standard node pattern) |
| Permissions | `0o660` or `0o600` under Lab home |
| Shutdown | close all client multiplexers, `server.close()`, unlink socket |
| Multiple clients | yes — one Multiplexer + protocol servers per socket connection |
| HTTP coexistence | always; N2C optional |
| DB readiness | N2C starts only after `initSql` + `ensureInitialized` |

---

## 6. Gaps & risks

| Risk | Mitigation |
|------|------------|
| `ChainSyncServer` hard-coded N2N protocol 2 | Upstream PR or Gerolamo wrapper (blocking for Lab tip stream) |
| No HandshakeServer | Small local responder using existing message classes |
| No Local* servers | Implement thin responders; message types already in lib |
| `IChainDb` block indexing model ≠ Gerolamo slot/hash tables | Adapter design + tests; may store dense block index or map slot→index |
| Incomplete consensus / NES | N2C can still serve **synced headers/blocks we store**; do not claim full ledger correctness for LSQ |
| Bun `net` IPC quirks | Smoke test early Phase 1 on Bun 1.3.x |
| Confusing `unixSocket` HTTP flag | New `n2c.socketPath`; leave HTTP flag alone |

---

## 7. Suggested file layout

```text
src/network/n2c/
  N2CServer.ts           # listen / accept / lifecycle
  HandshakeResponder.ts  # protocol 0
  LocalChainSyncHost.ts  # wraps ChainSyncServer + protocol fix
  LocalTxSubmitHost.ts   # protocol 6
  LocalStateQueryHost.ts # protocol 7 (phased)
  GerolamoChainDb.ts     # IChainDb adapter
  events.ts              # tip extend/fork bus from PeerClient → IChainDb
  index.ts
```

Tests (later):

```text
src/network/n2c/__tests__/
  handshake.smoke.ts
  chainsync.tip.smoke.ts
```

---

## 8. Acceptance criteria (MVP = Phase 1–2)

1. Process creates `node.socket` when N2C enabled.
2. TheLab-style client: Multiplexer N2C + Handshake propose → **Accept**.
3. LocalChainSync: findIntersect / requestNext yields tip-related events without crash.
4. HTTP `/health` still works; N2N peer path unchanged.
5. Clean shutdown removes socket; restart works without manual unlink (self-heal).

---

## 9. Out of scope (for this plan)

- Full cardano-node LocalStateQuery parity
- N2C over TCP (Unix only for Lab/Dolos parity)
- Serving N2C from Electrobun renderer (main process only, like Dolos)
- Replacing HTTP API

---

## 10. Execution order (when coding starts)

1. Phase 0 decision: lib PR vs local wrapper for LocalChainSync mux id  
2. Phase 1 socket + handshake smoke  
3. Phase 2 `GerolamoChainDb` + LocalChainSync  
4. TheLab connect proof  
5. Phase 3–4 as product needs  

**Do not start coding until this plan is accepted** (or explicitly scoped to Phase 1 only).

---

## 11. References

- Library README: connections are **your** responsibility; lib = codecs + multiplexer + some client/server helpers  
- TheLab: `src/bun/dolos/n2cClient.ts`  
- Gerolamo N2N client: `src/network/PeerClient.ts` (`protocolType: "node-to-node"`)  
- Misleading HTTP unix: `src/network/peerBlockServer.ts` + config `unixSocket`  
- Spec PDF (background): ouroboros network spec (linked from lib README)
