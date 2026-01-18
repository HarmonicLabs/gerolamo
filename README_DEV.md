# Gerolamo Network Developer Guide

## Overview
Gerolamo Network is a TypeScript Cardano relay/node using Bun runtime, `@harmoniclabs/ouroboros-miniprotocols-ts` for P2P (Mux/Handshake/ChainSync/BlockFetch), `@harmoniclabs/cardano-ledger-ts` for serialization/parsing, SQLite WAL for storage (volatile/immutable/ledger snapshots). Focus: networking + storage; consensus/NES/Praos pending.

**Current Status**: Full chain sync (headers/blocks post-Babbage), parsing, batch storage in SQLite3 (`volatile_*` → GC to immutable), HTTP serve. Consensus validation/NES/Praos pending.

## Key Files
- `src/start.ts`: Entry → load config → `initDB` → dynamic `peerBlockServer` → `startPeerManager`
- `src/network/peerManagerWorkers/peerManagerWorker.ts`: Parse topology → spawn `peerClientWorker` → addPeers (hot/bootstrap) → `startSync` hotPeers
- `src/network/peerClientWorkers/peerClientWorker.ts` / `PeerClient.ts`: Per-peer: Handshake/KeepAlive/ChainSync/BlockFetch/PeerSharing. `chainSync.on('rollForward')` → postMessage manager
- `src/utils/blockParsers.ts`: `headerParser`/`blockParser` (MultiEraBlock era 2-7)
- `src/db/*`: `DB.ts` (unified init/read/write/GC singleton WAL), `schemas.sql`
- `src/utils/logger.ts`: JSONL per-level (`debug/info/warn/error.jsonl`)
- Config: `src/config/preprod/config.json` (dbPath, logs, syncFrom*, genesis/topology)

## Worker Message Flow (Current - Temp Relay)
```
PeerClient.chainSync.on('rollForward' header CBOR) 
→ peerClientWorker.parentPort.postMessage('rollForward' {peerId, rollForwardCborBytes, tip})
→ peerManagerWorker.peerClientWorker.postMessage('rollForward')  // RELAY (TODO remove)
→ peerClientWorker: headerParser(era/slot/hash) → peer.fetchBlock(slot,hash) → blockParser(MultiEraBlock)
→ compute epoch → batch store raw CBORs (header/block/blockFetch) → GC volatile → prettyBlockValidationLog
```
- **Relay Temp**: manager relays back to clientWorker for fetch/parse/store. TODO: post to `consensusWorker` for validation/NES.

## Storage (SQLite `Gerolamo.db`)
- `volatile_blocks/headers`: Raw CBOR, slot PK/index, GC invalid/old
- `immutable_*`: GC'd chunks (todo populate)
- `ledger_snapshots`: NES BLOB snapshots (todo)
- `transactions`: Unified txs (todo extract/parse)

## Logging
- `src/utils/logger.ts`: Levels DEBUG/INFO/WARN/ERROR.
- Console: Colored.
- Files: `./logs/preprod/{debug|info|warn|error}.jsonl` (JSONL: timestamp/level/args).
- Config via `config.json`.

## Setup/Run/Debug
```
bun install
bun src/start.ts   # preprod default (includes initDB)
tail -f logs/preprod/info.jsonl | jq
curl http://localhost:3030/block/9158475  # HTTP port 3030, raw CBOR
```

## Current Issues & Fixes
1. **Block Parse Fail** (`error.jsonl`: "invalid 'outputs' field" slot~10M+): `blockParsers.ts` `MultiEraBlock.fromCbor(toHex(blockData))` → `fromCbor(blockData)` (bytes, not hex).
2. **Relay Loop**: Replace manager relay → post parsed block/NES events to consensus.
3. **No Validation**: Header hash check only (todo body hash, tx valid).

## TODOs (Priority)
1. **Consensus Components**:
   - Implement `./src/consensus/chainSelection.ts` (chain selection logic).
   - `./src/consensus/StableState.ts` (stable chain state).
   - `./src/consensus/AnchoredVolatileState.ts` (volatile state).
   - `./src/consensus/BlockApplication.ts` (block application/validation).
2. **NES/Praos**: Load/apply NewEpochState, epochNonce (Blockfrost/calc).
3. **Immutable GC**: Populate `immutable_*` chunks.
4. **Tx Parsing**: Extract/parse txs to `transactions` table.
5. **Peer Promotion**: new→warm→hot, PeerSharing.
6. **Multi-Era**: Full Byron/Shelley validation.
7. **Mainnet Sync**.

## Developer Workflows

### Setup
- `bun install` to install dependencies (Bun runtime, no Node.js).
- Set `NETWORK=preprod` or `mainnet` env var to switch networks.
- Config loaded from `src/config/{network}/`.

### Run
- `bun src/start.ts` (default preprod; loads config, starts peer server/API/manager/TUI).
- Starts P2P peer server (port 3000), block API (3030), manager workers.
- **TUI**: Keyboard handler, press 'q' to quit.
- Debug: `bun --inspect src/start.ts`.

### Sync
- Config: `syncFromTip`/`syncFromPointSlot` (e.g., 3542390), `syncFromPointBlockHash`.
- `populateSnapshotsFromBlockfrost` option.
- Hot peers actively sync (via peerManagerWorker "hot").
- Bootstrap from `topology.json`.

### Debug & Monitoring
- Tail logs: `tail -f logs/preprod/*.jsonl | jq -r '.level, .args[] | @text'` or `tail -f logs/preprod/info.jsonl | jq`.
- Block API: `curl http://localhost:3030/block/&lt;slot&gt;` or `/block/&lt;hash&gt;` (raw hex CBOR).
- DB inspect: `sqlite3 store/db/preprod/Gerolamo.db "SELECT * FROM immutable_chunks;"`.
- TUI: Pretty logs for block validation (era/slot/tip/GC counters).
- Worker flow: PeerClient → manager relay → fetch/parse/store (temp; consensus pending).

### Logging
- `src/utils/logger.ts`: Levels DEBUG/INFO/WARN/ERROR/NONE/MEMPOOL; methods `logger.info(...)`.
- Console: Colored timestamps/prefixes.
- Files: Per-level JSONL `./logs/preprod/{debug,info,warn,error,mempool}.jsonl`.
- Format: `{"timestamp":"ISO","level":"INFO","args":[...JSON-safe...]}` (BigInt→str, Error→obj).
- Config: `GerolamoConfig.logs`; TUI disables console if enabled.

### Storage
- SQLite WAL: `store/db/preprod/Gerolamo.db` (or `config.dbPath`).
- Tables: `volatile_blocks/headers` (raw CBOR, slot PK, GC invalid/old), `immutable_*` (GC'd chunks), `ledger_snapshots` (NES BLOBs), `transactions` (unified txs).
- Schema: `src/db/Gerolamo_schema.sql`; `DB.ts` handles init/read/write/GC singleton.
- GC: Volatile → immutable purge (counters in TUI/logs).

### Configuration
- Single `config.json` per network (`src/config/{preprod|mainnet}/`).
- Key: `dbPath`/`logs`/`sync*`/`host: "0.0.0.0"`/`port`/`genesis*`/`conwayGenesisHash`.
- Logs/snapshot/mempool toggles.
- `p2p: "enabled"`.
- Genesis/topology auto-loaded.

### Development Notes
- Key files: `start.ts` (entry), `peerManagerWorker.ts` (orchestration), `PeerClient.ts` (mini-protocols), `DB.ts` (storage), consensus pending (`src/consensus/*.ts`).
- Worker messages: Preserve types (e.g., `rollForward`).
- Multi-era: `@harmoniclabs/cardano-ledger-ts`.
- Libs: Ouroboros mini-protocols TS, Blockfrost fetches.
- TODOs: Consensus validation/NES/Praos, immutable population, tx extraction.
- `src/config/pointsOfInterest.md`: Inspect points.
- TS best practices (HarmonicLabs).
