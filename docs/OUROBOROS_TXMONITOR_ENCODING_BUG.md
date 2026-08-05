# ouroboros-miniprotocols-ts: LocalTxMonitor Acquire/GetSizes encode bug

**Source report (gravity-backend):**  
`/media/bakon/data/Dev/HarmonicLabs/gravity-dex/gravity-monorepo/gravity-backend/docs/OUROBOROS_TXMONITOR_ENCODING_BUG_2026-08-04.md`

**Package in Gerolamo:** `@harmoniclabs/ouroboros-miniprotocols-ts@0.0.5-dev7`  
**Status (2026-08-04):** lib still broken on disk; Gerolamo **host** has a partial workaround.

---

## The bug (client encode)

Three message classes share a copy-pasted encoder. In
`node_modules/@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/local-tx-monitor/messages/`:

| Message | Spec CBOR | Lib `toCborObj` emits |
|---------|-----------|------------------------|
| MsgDone | `[0]` | `[0]` ✅ |
| **MsgAcquire** | **`[1]`** | **`[3]`** ❌ (= Release) |
| MsgAcquired (node→client) | `[2, slot]` | n/a (parsed OK) |
| MsgRelease | `[3]` | `[3]` ✅ |
| MsgNextTx | `[5]` | `[5]` ✅ |
| **MsgGetSizes** | **`[9]`** | **`[3]`** ❌ (= Release) |

Decoder (`txMonitorMessageFromCborObj`) is correct: `1 → Acquire`, `3 → Release`, `9 → GetSizes`.

**Broken path:** `TxMonitorClient.acquire()` / `.getSizes()` hang forever and poison the multiplexer session.

**Upstream fix (2 lines):** Acquire → `CborUInt(1)`; GetSizes → `CborUInt(9)`.

---

## Does this affect Gerolamo?

| Path | Impact |
|------|--------|
| **Mithril** (list / cert / download / pure-TS extract / apply) | **None** |
| MiniBF / `.live` SQLite / chunk hydrate | **None** |
| P2P N2N (ChainSync, BlockFetch, PeerSharing, …) | **None** |
| N2C **server** `LocalTxMonitorHost` | **Partial** (client-shape only) |
| Gerolamo as `TxMonitorClient` outbound | **N/A** — not used |

Gerolamo is a TxMonitor **host** (decode inbound, encode replies). It does **not** call `TxMonitorClient.acquire()`.

### Host workaround (already in tree)

`src/network/n2c/LocalTxMonitorHost.ts`:

- Spec-correct clients (`[1]` Acquire, `[9]` GetSizes) → work (decoder OK).
- Broken lib client: Acquire as `[3]` while **idle** → treated as Acquire.
- Broken lib client: GetSizes as `[3]` while **acquired** → looks like Release → **GetSizes still broken**.

Server reply encoders (`TxMonitorAcquired`, `TxMonitorReplyGetSizes`, …) are not the buggy classes.

### When to care

1. Upstream fix + dep bump → drop or narrow the idle-Release→Acquire hack.
2. Lab/mempool clients using unfixed `TxMonitorClient` against Gerolamo N2C → use gravity’s wire workaround (`txMonitorWireFix`) until lib is fixed.
3. Never block Mithril / density work on this bug.

---

## Verify lib still broken

```bash
rg -n 'CborUInt\([0-9]+\)' \
  node_modules/@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/local-tx-monitor/messages/TxMonitorAcquire.js \
  node_modules/@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/local-tx-monitor/messages/TxMonitorGetSizes.js
# expect both → CborUInt(3) until upstream fix
```

## Related

- Host: `src/network/n2c/LocalTxMonitorHost.ts`
- N2C wire-up: `src/network/n2c/N2CServer.ts`
- Gap table: `docs/gerolamo-vs-dolos-gap.md` (LocalTxMonitor row)
