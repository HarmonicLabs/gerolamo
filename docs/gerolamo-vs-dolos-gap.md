# Gerolamo vs Dolos / Blockfrost — data-node gap

Blunt audit of what Gerolamo has today vs a **Dolos-class data node** and a
**Blockfrost-class HTTP surface**. Soft hydrate / batch path is orthogonal:
density of SQLite ≠ product parity.

**Sources (repo, 2026-07):** `src/api/miniBlockfrost.ts`, `src/network/*`,
`src/network/n2c/*`, `src/db.ts`, `README.md`, `docs/N2C_IMPLEMENTATION_PLAN.md`.

---

## What Gerolamo already is

| Layer | Status | Notes |
|-------|--------|--------|
| **N2N peer sync** | Present | `PeerClient`: Handshake + ChainSync + BlockFetch; topology hot/bootstrap |
| **SQLite chain store** | Present | Headers/blocks, volatile→immutable chunks, WAL, soft apply UTxO + deltas |
| **HTTP raw** | Present | `/health`, `/metrics`, `/block/{slot\|hash}`, `/utxo/{ref}`, `POST /txsubmit` |
| **Mini-Blockfrost** | Subset | See below — honest “not full BF” banner in code |
| **N2C** | Scaffold + hosts | Handshake, LocalChainSync, LocalTxSubmit, LocalTxMonitor, minimal LSQ |
| **Bootstrap** | Partial | `mithril-bootstrap` wraps external `mithril-client` + chunk apply; ancillary A2 blocked |
| **Consensus** | Partial | KES pure-TS; soft body path; not full Praos leadership / gov |

**Role split (important):**

- **Dolos** ≈ indexer / query engine (fast lookups, rich schema, often fed by node or snapshots).
- **Gerolamo** ≈ TS node/relay + soft ledger + thin APIs.
- **Blockfrost** ≈ hosted multi-tenant query API over indexed chain.

Parity with Dolos is **not** “same binary”; it is “same *jobs* a dApp/wallet needs from a local data plane.”

---

## HTTP / Mini-Blockfrost

### Implemented (`handleMiniBlockfrost` v0.2.0)

| Method | Path | Honest limits |
|--------|------|----------------|
| GET | `/api/v0` | Lists endpoints + `version: 0.2.0` + subset note |
| GET | `/api/v0/health` | `{ is_healthy: true }` only |
| GET | `/api/v0/epochs/latest` | tip_slot, utxo_count, epoch_nonce; many BF fields `null` |
| GET | `/api/v0/epochs/latest/parameters` | Needs `protocol_params` row; else empty note |
| GET | `/api/v0/blocks/latest` | From tip slot |
| GET | `/api/v0/blocks/{slot\|hash}` | Slot or 64-hex |
| GET | `/api/v0/blocks/{slot\|hash}/txs` | Tx hashes from `block_tx` (empty until backfill) |
| GET | `/api/v0/addresses/{addr}/utxos` | Page/count; **no** datum/script/block fields filled |
| GET | `/api/v0/addresses/{addr}/transactions` | From `address_tx` (output-side only until spend join) |
| GET | `/api/v0/txs/{hash}` | From `tx_index` — fees/slot/size subset; many BF fields `null` |
| GET | `/api/v0/txs/{hash}/utxos` | **Unspent only** — not full tx IO |
| GET | `/api/v0/txs/{hash}/utxos/{index}` | Single unspent out |
| GET | `/api/v0/mempool` | Local SharedMempool snapshot (not full BF mempool shape) |
| POST | `/api/v0/tx/submit` | Returns `hash` = blake2b_256(raw body); + legacy `POST /txsubmit` |
| WS | `/ws/stats` | Ops stream: tip/peers/metrics/governor (not a Mini-BF WS) |

**Indexes:** `tx_index` / `address_tx` / `block_tx` created empty on DB init. Populate off hot path:

```bash
bun scripts/backfill-tx-index.mjs --db .live/test.db
# never dual-write soak `.hydrate/batch.db` while hydrate runs
```

### Missing for BF / Dolos-like wallets (high value first)

1. **Tx by hash (full)** — body, redeemers, metadata, full IO (index has fee/slot/size subset)  
2. **Address summary** — total amount, tx_count, received/sent  
3. **Address txs spend-side** — input-side history needs UTxO join at index time  
4. **Assets** — by policy/asset, address holdings, txs  
5. **Scripts / datums / redeemers** — Plutus surface  
6. **Pools / accounts / delegations / rewards** — stake query plane  
7. **Metadata labels**, **network**, **genesis** BF shapes  
8. **Epoch history** — not only “latest”  
9. **Stable BF field parity** — times, confirmations, output amounts as strings consistently  
10. **Forward index on apply** — backfill covers history; live apply path does not yet write indexes 

### Indexing gaps (root cause of many API holes)

Live tables support: tip, block by slot/hash, UTxO by ref/tx/address, stake/deleg dumps, epoch nonce, optional protocol_params.

**Not first-class:**

- `tx` table (hash → block, fee, size, validity, metadata hash)  
- `tx_in` / spent history (only deltas + current UTxO)  
- asset inverted index  
- pool/account epoch snapshots  
- script/datum store  

Without those, Mini-BF will stay a **tip + UTxO peek**, not an explorer backend.

---

## Peers / N2N

| Capability | Gerolamo | Dolos-class expectation |
|------------|----------|-------------------------|
| Topology load | Yes | Yes / or upstream only |
| Handshake | Yes | N/A if pure indexer |
| ChainSync client | Yes | Optional if snapshot-fed |
| BlockFetch client | Yes | Optional |
| Peer scoring / churn | Basic hot list | Often richer |
| Serve N2N to others | Limited (focus N2C + HTTP) | Rare for pure indexers |
| Tip equality / fork choice | Soft / partial | Trust upstream or full node |

**Gap:** production relay diversity (inbound peers, diffusion, DoS limits) is not the product goal; **keeping tip fresh after hydrate** and **reorg handling** matter more for a data node.

---

## N2C (Lab / wallet local)

| Protocol | Code | Parity note |
|----------|------|-------------|
| Handshake | `HandshakeResponder` | N2C versions wired |
| LocalChainSync | `LocalChainSyncHost` | Custom host (lib N2N id workaround) |
| LocalTxSubmission | `LocalTxSubmitHost` | Present |
| LocalTxMonitor | `LocalTxMonitorHost` | Present; lib Acquire/GetSizes encode bug — see `docs/OUROBOROS_TXMONITOR_ENCODING_BUG.md` |
| LocalStateQuery | `LocalStateQueryHost` | **Minimal**: tip / utxoCount / epochNonce map — **not** ledger query CDDL |

**Dolos/Lab gap:** clients that expect full LSQ (UTxO whole, PParams CDDL, stake, gov) will not be satisfied. Either grow LSQ query set from SQLite or document “HTTP Mini-BF only.”

`GerolamoChainDb` backs chain points from DB — good path for tip stream once DB is dense.

---

## Storage & hydrate

| | Gerolamo | Dolos-like |
|--|----------|------------|
| Engine | SQLite WAL | Often Rocks/Redb/custom |
| Density path | Immutable chunks + **batch** apply (`scripts/batch-hydrate.mjs`) | Snapshot import + tip follow |
| Mithril | External CLI download; **ancillary UTxO extract blocked (A2)** | Often full snapshot restore |
| Soft vs hard | Soft apply default | Indexer may skip validation entirely |

Batch path is the right density tool; **product APIs still need indexes** built during or after apply.

---

## Prioritized roadmap (data-node, not full cardano-node)

### P0 — usable local backend for The Lab / light dApps

1. Finish **full-chain soft DB** (batch soak) → point node `GEROLAMO_DB_PATH` at it or copy.  
2. **Tx index on apply** (hash, block hash/slot, fee, size) + Mini-BF `GET /txs/{hash}`.  
3. **Address → tx ids** (from spends/creates) + `GET /addresses/{addr}/transactions`.  
4. Fill UTxO BF fields: inline datum / ref script when present in stored tx_out.  
5. N2C Lab smoke: Handshake + LocalChainSync tip against hydrated DB.

### P1 — Dolos-adjacent query comfort

6. Block → tx list; asset multi-asset index.  
7. Protocol params always populated at era boundaries.  
8. Mempool BF-shaped endpoint (shared mempool already exists).  
9. Metrics: tip lag, peer count, apply rate, DB size.

### P2 — deeper parity

10. LSQ expand (PParams, UTxO filtered, stake) **or** explicit “HTTP-only” product line.  
11. Native Mithril client path (see `docs/mithril-native-client-research.md`) — cert verify + download; still chunk-apply for density.  
12. Historical epoch/pool/reward tables if wallets need them.

### Out of scope for “data node like Dolos”

- Full Praos leadership / block production  
- Full governance ledger parity  
- Replacing Blockfrost cloud multi-tenancy  
- Claiming ancillary Mithril UTxO until CBOR streaming lands  

---

## One-line summary

Gerolamo already has **peers + soft ledger + thin HTTP/N2C**. To be **up to par as a Dolos-like data node**, the missing center of mass is **query indexes + BF/LSQ breadth**, not another sync protocol — and **density** is already on the batch hydrate path.
