# Gerolamo Network - TypeScript Cardano Relay/Node (Bun Runtime)

Gerolamo is a lightweight, modular **Cardano node/relay** implementation in **TypeScript** using **Bun** runtime. It supports:
- **P2P networking** (Ouroboros mini-protocols: Handshake, ChainSync, BlockFetch).
- **Multi-era chain sync** (Byron → Shelley → Alonzo → Babbage → Conway) from genesis/tip/point.
- **Block/header parsing** (`@harmoniclabs/cardano-ledger-ts`).
- **SQLite3 storage** (volatile → immutable chunks, WAL concurrency).
- **Peer categorization** (hot/warm/cold/bootstrap/new).
- **Block serving API** (HTTP `/block/{slot|hash}`).

**No consensus validation** (yet)—focuses on networking/storage. Inspired by Cardano node specs.

## 🚀 Quick Start (Noob-Friendly)

### Prerequisites
- **Bun** v1.0+ (fast JS/TS runtime): [bun.sh](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
- No Node.js/SQLite install needed (Bun bundles `bun:sqlite`).

### 1. Clone & Install
```bash
git clone https://github.com/HarmonicLabs/gerolamo-network.git
cd gerolamo-network
bun install  # Installs @harmoniclabs/* deps (5s)
```

### 2. Run (Preprod Default)
```bash
bun src/start.ts
```
- Syncs **preprod** chain (edit `NETWORK=mainnet` for mainnet).
- Starts **peer server** (port 3000), **block API** (port 3030).
- Logs: `./src/logs/preprod/*.jsonl` (debug/info/warn/error).

**Done!** Gerolamo handshakes peers, syncs chain, stores blocks.

### 3. Monitor
```bash
# Tail logs
tail -f src/logs/preprod/*.jsonl | jq -r '.level, .args[] | @text'

# Block API test
curl http://localhost:3030/block/3542390  # Slot → hex CBOR
curl http://localhost:3030/block/f93e682d5b91a94d8660e748aef229c19cb285bfb9830db48941d6a78183d81f  # Hash
```

## ⚙️ Configuration (src/config/{preprod|mainnet}/config.json)

**Single file per network**. Set `NETWORK=preprod` / `mainnet`.

### Key Fields
```json
{
  "network": "preprod",  // or "mainnet\"
  "networkMagic": 1,       // Preprod=1, Mainnet=0
  "topologyFile": "./src/config/preprod/topology.json",  // Peers list
  "dbPath": "./src/db/preprod/Gerolamo.db",  // SQLite DB
  "logs": {
    "logDirectory": "./src/logs/preprod/",  // JSONL logs
    "logToFile": true,
    "logToConsole": true
  },
  "syncFromTip": false,    // Sync to chain tip
  "syncFromPoint": true,   // From specific slot/hash
  "syncFromPointSlot": 3542390n,
  "syncFromPointBlockHash": "f93e682d...",
  "shelleyGenesisFile": "...",  // Era genesis (auto-loaded)
  "ip": "0.0.0.0",
  "port": 3000             // P2P listen
}```

- **Topology** (`topology.json`): Add relays under `localRoots.accessPoints` / `bootstrapPeers`.
- **Genesis**: Pre-loaded Cardano JSONs (Byron/Shelley/Alonzo/Conway).

## 🏗️ Architecture & Data Flow

```
start.ts ──(config)──> initDB (SQLite schema/WAL)
         │
         └─(await import)──> peerBlockServer (HTTP API port 3030)
         │
         └─(config)──> startPeerManager ──(workerData=config)──> peerManagerWorker
                                                           │
                                                           ├─ parseTopology ──> addPeers (hot/bootstrap)
                                                           │
                                                           └─ spawn ──> peerClientWorker ──(msg.config)──> config
                                                                                 │
                                                                                 ├─ new PeerClient (per peer)
                                                                                 │   ├── handshake
                                                                                 │   ├── chainSync (rollForward/RollBack)
                                                                                 │   └── blockFetch
                                                                                 │
                                                                                 └─ rollForward ──> parse header/block ──> batch insert volatile ──> GC (2160 slots)
```

### Key Components
1. **start.ts**: Entry. Loads config (`bun src/config/[network]/config.json`), inits DB/server/manager.
2. **db/**: 
   - `DB.ts`: Unified class for init/read/write/GC (volatile → immutable chunks every 2160 slots).
   - `schemas.sql`: Cardano-inspired schema (volatile/immutable/ledger/transactions).
3. **peerManagerWorker.ts**: Orchestrates peers from topology. Posts to peerClientWorker.
4. **peerClientWorker.ts**: Spawns `PeerClient` per peer. ChainSync → rollForward → parse → DB batch (50).
5. **PeerClient.ts**: Mini-protocols (Handshake/ChainSync/BlockFetch).
6. **peerBlockServer.ts**: `Bun.serve` `/block/{slot|hash}` → `DB.getBlock*` → hex CBOR.
7. **utils/logger.ts**: Colored console + per-level JSONL (`debug.jsonl` etc.).

### Storage Schema (schemas.sql)
- `volatile_blocks/headers`: Recent (batch insert, GC trigger).
- `immutable_blocks/headers`: Chunked (slot ranges).
- Indexes/triggers for perf.

## 🔍 Block Fetching API

**GET** `http://localhost:3030/block/{slot|hash}`
- **Slot**: `curl http://localhost:3030/block/3542390` → hex `83a...` (RawCbor).
- **Hash**: `curl http://localhost:3030/block/f93e682d5b91a94d8660e748aef229c19cb285bfb9830db48941d6a78183d81f`
- **Response**: `application/cbor` hex (decode: `cbhex <hex>`).
- Serves from SQLite (volatile + immutable).

## 🛠️ Development

### Env Vars
```
NETWORK=mainnet  # Switch network
```

### Customize
- **Peers**: Edit `topology.json` → restart.
- **Sync Point**: `config.json` → `syncFromPointSlot`/`BlockHash`.
- **Logs**: `tail -f src/logs/preprod/error.jsonl | jq`.
- **DB Inspect**: `sqlite3 src/db/preprod/Gerolamo.db "SELECT * FROM immutable_chunks;"`.

### Build/Run Workers
- No build (Bun native TS).
- `bun --inspect src/start.ts` debug.

## 📚 Resources
- [Cardano Ouroboros](https://ouroboros-network.cardano.intersectmbo.org/)
- [HarmonicLabs Libs](https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts)
- [Bun Docs](https://bun.sh/docs)

**Issues?** Check `error.jsonl` / terminal. Happy syncing! 🚀

