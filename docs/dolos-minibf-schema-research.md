# Dolos MiniBF — schema & implementation research

**Source:** `/media/bakon/data/Dev/HarmonicLabs/dolos` (local clone, 2026-08-02)  
**Goal of this note:** extract *how Dolos powers MiniBF* so Gerolamo can grow a compatible surface **without poisoning** the ledger apply path.

---

## 1. Architecture (Dolos)

MiniBF is **not** a separate database. It is an HTTP façade over a multi-store **Domain**:

```
HTTP :3000  →  crates/minibf (Axum Router)
                    ↓
              Facade<D: Domain>
                    ↓
     ┌──────────┬──────────┬───────────┬──────────┐
     │  State   │ Archive  │  Indexes  │  Mempool │
     │ (ledger  │ (blocks  │ (tags →   │ (submit) │
     │  entity) │  / txs)  │  slots /  │          │
     │          │          │  TxoRefs) │          │
     └──────────┴──────────┴───────────┴──────────┘
        fjall/redb backends (config: storage.state / archive / index)
```

Key files:

| Piece | Path |
|-------|------|
| Router + all routes | `crates/minibf/src/lib.rs` → `build_router_with_facade` |
| Route handlers | `crates/minibf/src/routes/{addresses,txs,blocks,accounts,assets,pools,...}.rs` |
| BF JSON mapping | `crates/minibf/src/mapping.rs` (uses `blockfrost_openapi` models) |
| Domain trait | `crates/core/src/lib.rs` (`State` + `Archive` + `Indexes` + `Wal` + `Mempool`) |
| Index traits | `crates/core/src/indexes.rs` |
| Cardano index delta | `crates/cardano/src/indexes/delta.rs` |
| Tag dimensions | `crates/cardano/src/indexes/dimensions.rs` |
| Entity models | `crates/cardano/src/model/{accounts,assets,pools,epochs}.rs` |
| Docs coverage table | `docs/content/apis/minibf.mdx` |
| Config | `[serve.minibf]` in `dolos.toml` |

**Path prefix:** Dolos MiniBF serves **root** paths (`/blocks/latest`, `/addresses/...`).  
Gerolamo today mounts under **`/api/v0/*`** (BF cloud style). Both are valid; Lab must point `base_url` at the live root (probe first). Prefer keeping `/api/v0` + optional unversioned aliases later.

---

## 2. What MiniBF actually queries

Handlers almost never scan raw chain. Pattern:

1. **Index lookup** → slots or `TxoRef` set (cheap keys).  
2. **Archive / State fetch** → block body, entity CBOR, UTxO payload.  
3. **mapping.rs** → Blockfrost OpenAPI JSON (`AddressContent`, `TxContent`, …).

### 2.1 Index plane (`IndexStore`)

Two layers of tags (string dimensions):

**UTxO filter (current set)** — `utxo::*`

| Dimension | Meaning |
|-----------|---------|
| `address` | full address bytes → live TxoRefs |
| `payment` | payment credential → live TxoRefs |
| `stake` | stake credential → live TxoRefs |
| `policy` | policy id → live TxoRefs |
| `asset` | policy\|\|name subject → live TxoRefs |

Updated on produce/consume (`UtxoIndexDelta`).

**Archive (historical)** — `archive::*`

| Dimension | Meaning |
|-----------|---------|
| `address` / `payment` / `stake` | slots (or txs) touching key |
| `asset` / `policy` | mint/use history |
| `datum` / `script` | datum/script appearance |
| `spent_txo` | spent output tracking |
| `account_certs` / `pool_certs` | cert history |
| `account_withdrawals` | withdrawal history |
| `metadata` | label → slots/txs |

Plus exact maps:

- `slot_by_block_hash` / `slot_by_block_number` / `slot_by_tx_hash`
- `slots_by_tag(dimension, key, start, end)` for pagination

Cursor on index must track chain tip (sync with state/archive).

### 2.2 State plane (entities)

Namespaced entities (not SQL tables), e.g.:

| Entity | NS | MiniBF use |
|--------|-----|------------|
| `AccountState` | accounts | `/accounts/{stake}` balance, rewards, delegation |
| `PoolState` | pools | `/pools/{id}`, delegators, history, metadata hooks |
| `AssetState` | assets | quantity, initial_tx/slot, mint_tx_count, metadata_tx |
| `EpochState` / pparams | epochs | `/epochs/*/parameters` |
| `DRepState` | gov | `/governance/dreps/{id}` |

### 2.3 Archive plane

Block bodies + tx CBOR by slot/hash so routes can rebuild:

- full `/txs/{hash}/utxos` (inputs **and** outputs, not only live UTxO)
- metadata / redeemers / certs derived from body
- `/blocks/*/txs/cbor`

### 2.4 Endpoint families (Dolos coverage)

From `docs/content/apis/minibf.mdx` + `lib.rs` routes:

- **Core:** `/`, `/health`, `/health/clock`, `/metrics`, `/genesis`, `/network`, `/network/eras`
- **Blocks:** latest, by hash/number/slot, next/prev, txs, txs/cbor, addresses-in-block
- **Addresses:** summary, total, utxos, utxos/{asset}, transactions (+ `/txs` alias)
- **Txs:** by hash, cbor, utxos, metadata(+cbor), redeemers, withdrawals, delegations, mirs, pool_updates/retires, stakes; `POST /tx/submit`
- **Accounts:** stake summary, addresses, utxos, rewards, withdrawals, registrations, delegations
- **Assets:** subject, addresses, transactions
- **Pools:** by id, extended, retiring, delegators, history, metadata, relays
- **Epochs:** latest/by-number parameters, epoch blocks
- **Scripts/datums:** by hash (+ json/cbor)
- **Metadata labels:** json + cbor
- **Governance:** drep by id

---

## 3. Gerolamo ledger today (live `.live/test.db`)

### 3.1 Ledger / consensus tables (apply owns these)

| Table | Role | Poison risk if MiniBF writes? |
|-------|------|-------------------------------|
| `blocks` | tip + optional CBOR | **High** — apply/GC |
| `volatile_headers` | header window | **High** |
| `utxo` | live set | **High** |
| `utxo_deltas` | rollback journal | **High** |
| `stake` / `delegations` / `rewards` | soft stake | **Medium–High** |
| `chain_account_state` | treasury/reserves | **High** |
| `epoch_nonces` | η0 | **Medium** |
| `protocol_params` | empty today | **Medium** if dual-written |
| `immutable_*` / epoch_state scaffolding | sparse | leave alone |

### 3.2 Already-existing MiniBF-ish indexes (thin)

| Table | Purpose | Density (live sample) |
|-------|---------|------------------------|
| `tx_index` | hash → slot/fee/size | ~2k rows; lags tip until forward index live |
| `address_tx` | addr → tx_hash | thin; output-heavy |
| `block_tx` | block → txs | thin |

These were added for MiniBF and are **already mixed into the same SQLite file** as ledger. That is OK **if**:

- only index writers touch them;
- apply path never depends on them for consensus;
- rollback clears or rewinds them with tip.

### 3.3 What ledger cannot answer (needs index/archive)

| Dolos capability | Gerolamo gap |
|------------------|--------------|
| UTxO by payment/stake/asset tags | only `json_extract(tx_out.address)` O(N) |
| Full tx IO | unspent-only via `utxo` |
| Asset inventory | assets nested in JSON, no `AssetState` |
| Account BF surface | `stake`/`delegations` not BF-shaped / no addr map |
| Pool BF surface | `pool_distr` empty/incomplete |
| Metadata / datum / script stores | not extracted |
| Block height / wall time | mostly null in MiniBF mapping |
| Historical address totals | no received/sent accumulators |

---

## 4. Non-poisoning principle (locked)

> **Ledger tables = source of truth for sync/apply/rollback.**  
> **MiniBF tables = derived projections.**  
> Consensus must never read MiniBF tables to decide validity or tip.

### Allowed

- Same SQLite file, **separate table namespace** (prefix `mb_` or dedicated schema section).
- Same transaction as apply **only** for forward-index upserts that are best-effort / rewindable.
- Separate `.live/minibf.db` attached read-only from HTTP (optional later) — still fed from ledger events.

### Forbidden

- MiniBF HTTP handlers writing `utxo` / `blocks` / deltas.
- Hydrate dual-write on `.hydrate/batch.db` from MiniBF backfill while soak runs.
- Changing packed `tx_out` shape in a breaking way without migration + dual-read.
- Claiming Dolos parity while indexes are empty.

---

## 5. Target MiniBF schema (Gerolamo SQLite)

All new tables optional until phase enables them. Prefer prefix **`mb_`** for anything not already shipped (`tx_index` may stay for compat or migrate → `mb_tx`).

### 5.1 Cursor

```sql
CREATE TABLE IF NOT EXISTS mb_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tip_slot INTEGER NOT NULL,
  tip_hash BLOB,
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

Indexer lag = `ledger_tip - mb_cursor.tip_slot` (expose on `/network` / metrics).

### 5.2 Tx archive projection (P0)

```sql
-- extend or replace tx_index
CREATE TABLE IF NOT EXISTS mb_tx (
  tx_hash TEXT PRIMARY KEY,
  block_hash BLOB NOT NULL,
  slot INTEGER NOT NULL,
  block_height INTEGER,          -- when known
  tx_index INTEGER NOT NULL,     -- ordinal in block
  fee TEXT,
  size INTEGER,
  invalid_before TEXT,
  invalid_hereafter TEXT,
  valid_contract INTEGER,        -- 0/1/null
  metadata_label_count INTEGER,
  -- optional raw for /txs/{hash}/cbor (or point into blocks.block_data)
  body_cbor BLOB,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_mb_tx_slot ON mb_tx(slot);
CREATE INDEX IF NOT EXISTS idx_mb_tx_block ON mb_tx(block_hash);
```

### 5.3 Full IO (P0–P1) — enables real `/txs/{hash}/utxos`

```sql
CREATE TABLE IF NOT EXISTS mb_tx_out (
  tx_hash TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  payment_cred TEXT,             -- hex optional
  stake_cred TEXT,               -- hex optional
  lovelace TEXT NOT NULL,
  assets_json TEXT,              -- [{unit,quantity}] or nested map
  datum_hash TEXT,
  inline_datum_cbor BLOB,
  script_ref_hash TEXT,
  spent_by_tx TEXT,              -- null if unspent (denorm)
  spent_at_slot INTEGER,
  PRIMARY KEY (tx_hash, output_index)
);
CREATE INDEX IF NOT EXISTS idx_mb_tx_out_addr ON mb_tx_out(address);
CREATE INDEX IF NOT EXISTS idx_mb_tx_out_unspent ON mb_tx_out(address) WHERE spent_by_tx IS NULL;

CREATE TABLE IF NOT EXISTS mb_tx_in (
  tx_hash TEXT NOT NULL,         -- spending tx
  input_index INTEGER NOT NULL,
  prev_tx_hash TEXT NOT NULL,
  prev_output_index INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, input_index)
);
CREATE INDEX IF NOT EXISTS idx_mb_tx_in_prev ON mb_tx_in(prev_tx_hash, prev_output_index);
```

### 5.4 Address history (P0)

```sql
-- can evolve from address_tx
CREATE TABLE IF NOT EXISTS mb_address_tx (
  address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  slot INTEGER NOT NULL,
  tx_index INTEGER DEFAULT 0,
  direction TEXT CHECK(direction IN ('in','out','both')),
  PRIMARY KEY (address, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_mb_address_tx_slot ON mb_address_tx(address, slot DESC);
```

### 5.5 Block ↔ tx (P0/P1)

```sql
-- evolve block_tx
CREATE TABLE IF NOT EXISTS mb_block_tx (
  block_hash BLOB NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  PRIMARY KEY (block_hash, tx_hash)
);
```

### 5.6 UTxO tag filters (P1 — Dolos utxo::* )

```sql
CREATE TABLE IF NOT EXISTS mb_utxo_tag (
  dimension TEXT NOT NULL,      -- address|payment|stake|policy|asset
  tag_key TEXT NOT NULL,         -- bech32 or hex subject
  utxo_ref TEXT NOT NULL,        -- txhash:idx
  PRIMARY KEY (dimension, tag_key, utxo_ref)
);
CREATE INDEX IF NOT EXISTS idx_mb_utxo_tag_ref ON mb_utxo_tag(utxo_ref);
```

Maintain on create/spend **in parallel** with ledger `utxo` (index writer only).

### 5.7 Assets (P1–P2)

```sql
CREATE TABLE IF NOT EXISTS mb_asset (
  unit TEXT PRIMARY KEY,         -- policy+name hex
  policy TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL,        -- decimal string / big
  initial_tx TEXT,
  initial_slot INTEGER,
  mint_tx_count INTEGER DEFAULT 0,
  metadata_tx TEXT
);
CREATE TABLE IF NOT EXISTS mb_asset_tx (
  unit TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  slot INTEGER NOT NULL,
  PRIMARY KEY (unit, tx_hash)
);
```

### 5.8 Scripts / datums / metadata (P2)

```sql
CREATE TABLE IF NOT EXISTS mb_datum (
  datum_hash TEXT PRIMARY KEY,
  cbor BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS mb_script (
  script_hash TEXT PRIMARY KEY,
  type TEXT,                     -- timelock|plutusv1|...
  cbor BLOB,
  json TEXT
);
CREATE TABLE IF NOT EXISTS mb_metadata (
  tx_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  json TEXT,
  cbor BLOB,
  PRIMARY KEY (tx_hash, label)
);
CREATE INDEX IF NOT EXISTS idx_mb_metadata_label ON mb_metadata(label, tx_hash);
```

### 5.9 Accounts / pools (P2 — only if product needs)

Prefer projecting from existing `stake`/`delegations` first; add:

```sql
CREATE TABLE IF NOT EXISTS mb_account (
  stake_address TEXT PRIMARY KEY,
  controlled_amount TEXT,
  rewards_sum TEXT,
  withdrawals_sum TEXT,
  pool_id TEXT,
  drep_id TEXT,
  active_epoch INTEGER
);
-- pool metadata/history tables as needed; do not invent empty BF lies
```

### 5.10 Block enrichment (P1)

Either columns on a **projection** table or nullable extras — **do not** rewrite consensus `blocks` PK layout casually:

```sql
CREATE TABLE IF NOT EXISTS mb_block_meta (
  hash BLOB PRIMARY KEY,
  slot INTEGER NOT NULL,
  height INTEGER,
  epoch INTEGER,
  epoch_slot INTEGER,
  block_time INTEGER,            -- wall clock if known
  tx_count INTEGER,
  total_output TEXT,
  total_fees TEXT,
  prev_hash BLOB,
  slot_leader TEXT
);
```

---

## 6. Write path (mirror Dolos IndexDelta)

On each applied block (after ledger UTxO apply succeeds):

1. Build `MbIndexDelta` from `MultiEraBlock` (same info backfill script already parses).  
2. Apply in **one SQLite transaction** optional: ledger already committed → separate short txn OK.  
3. On rollback to slot S: `DELETE FROM mb_* WHERE slot > S` (+ restore `mb_tx_out.spent_*` from `mb_tx_in` / deltas).  
4. Advance `mb_cursor`.

**Never** block ChainSync forever: index failures → log + metrics `minibf_index_errors`, tip still advances (honest degraded MiniBF).

Forward path already started: `indexTransaction` in `src/db.ts` + `BlockApplication` indexCtx (v0.3). Plan expands that into full `MbIndexer`.

---

## 7. Read path (Gerolamo)

```
peerBlockServer → handleMiniBlockfrost
                      ↓
              src/api/minibf/* handlers
                      ↓
              src/db/minibf/*.ts queries  (mb_* only + read-only ledger joins)
```

Ledger joins allowed **read-only**:

- `blocks` / `utxo` for tip and live balances when projection lagging.
- Prefer `mb_*` when `mb_cursor` caught up.

---

## 8. Honest parity matrix (summary)

| Family | Dolos | Gerolamo now | After P0 schema+index | Full Dolos-like |
|--------|-------|--------------|------------------------|-----------------|
| Tip / blocks thin | ✅ | ✅ | ✅ richer meta | ✅ |
| Address UTxOs | ✅ | ✅ slow | ✅ tagged | ✅ |
| Address txs | ✅ | thin | ✅ | ✅ |
| Tx by hash | ✅ rich | subset | ✅ core fields | ✅ + redeemers |
| Tx full IO | ✅ | unspent only | ✅ mb_tx_in/out | ✅ |
| Assets | ✅ | ❌ | basic | ✅ |
| Accounts / pools | ✅ | ❌/stub | optional | hard |
| Scripts/metadata | ✅ | ❌ | P2 | ✅ |
| Network supply | ✅ | thin nulls | thin | needs pots |

---

## 9. References

- Dolos MiniBF docs: `dolos/docs/content/apis/minibf.mdx`
- Gerolamo gap: `docs/gerolamo-vs-dolos-gap.md`
- Existing MiniBF: `src/api/miniBlockfrost.ts`, `scripts/backfill-tx-index.mjs`
- Prior plan (WS + thin parity): `.hermes/plans/2026-07-31_013608-bun-ws-streaming-and-minibf-parity.md`
