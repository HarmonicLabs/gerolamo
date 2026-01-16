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

## Libs/Resources
- Ouroboros Mini-Protocols: [GitHub](https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts)
- Cardano Ledger TS: [GitHub](https://github.com/HarmonicLabs/cardano-ledger-ts)
- Specs: [Network](https://ouroboros-network.cardano.intersectmbo.org/), [Ledger](https://intersectmbo.github.io/formal-ledger-specifications/)
- Cardano Node: [GitHub](https://github.com/IntersectMBO/cardano-node)

Follow [TS Best Practices](https://github.com/HarmonicLabs/ts-best-practices). Preserve worker msgs/LMDB schemas (SQLite transition).

**Pick Up**: Fix parse → consensus worker → NES snapshots → immutable GC → txs.
