# Gerolamo Network Developer Guide

## Overview
Gerolamo Network is a TypeScript Cardano relay/node using Bun runtime, `@harmoniclabs/ouroboros-miniprotocols-ts` for P2P (Mux/Handshake/ChainSync/BlockFetch), `@harmoniclabs/cardano-ledger-ts` for serialization/parsing, SQLite WAL for storage (volatile/immutable/ledger snapshots). Focus: networking + storage; consensus/NES/Praos pending.

**Current Status**: Syncs headers/blocks from preprod peers, stores raw CBOR in `volatile_blocks`/`volatile_headers` (batch 50, GC 2160 slots), serves via HTTP/UDS (`peerBlockServer.ts`). Parse error on blocks ~slot 10M+ (fix below). No validation/NES yet.

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

## Setup/Run/Debug
```
bun install
bun src/initDB.ts  # or auto in start.ts
bun src/start.ts   # preprod default
tail -f src/logs/preprod/info.jsonl | jq
curl --unix-socket Gerolamo.sock http://gerolamo/block/9158475  # serve raw blockFetch CBOR
```

## Current Issues & Fixes
1. **Block Parse Fail** (`error.jsonl`: "invalid 'outputs' field" slot~10M+): `blockParsers.ts` `MultiEraBlock.fromCbor(toHex(blockData))` → `fromCbor(blockData)` (bytes, not hex).
2. **Relay Loop**: Replace manager relay → post parsed block/NES events to consensus.
3. **No Validation**: Header hash check only (todo body hash, tx valid).

## TODOs (Priority Order)
1. **Fix Parse**: Edit `blockParsers.ts` (bytes). Rerun → stores blocks.
2. **Consensus Worker**:
   - Create `peerManagerWorkers/consensusWorker.ts`: recv `rollForward` → headerParser → post 'fetchBlock' {peerId,slot,hash} → clientWorker fetch → post back 'blockReady' → consensus: blockParser → basic validate (prevHash?) → if epoch boundary: load prev NES → applyBlock → store `ledger_snapshots` BLOB.
   - Remove relay.
3. **NES/Praos**:
   - `@harmoniclabs/cardano-*-ts`: `NewEpochStateShelley.fromCbor`, `applyBlock`, epochNonce (Blockfrost/calc).
   - Snapshots per epoch start: `state_data` CBOR.
4. **Immutable GC**: `gcVolatileToImmutable` → chunk → `immutable_blocks`.
5. **Tx Extract**: Parse `MultiEraBlock.txs` → `transactions` table.
6. **Peer Mgmt**: Promote new→warm→hot, askForPeers, topology update.
7. **Serve**: `peerBlockServer.ts` raw CBOR → parsed JSON? Multi-era TxOut etc.
8. **Multi-Era Full**: Byron/era0? Validate signatures/UTxO rules.
9. **Mainnet**: Config switch.

## Libs/Resources
- Ouroboros Mini-Protocols: [GitHub](https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts)
- Cardano Ledger TS: [GitHub](https://github.com/HarmonicLabs/cardano-ledger-ts)
- Specs: [Network](https://ouroboros-network.cardano.intersectmbo.org/), [Ledger](https://intersectmbo.github.io/formal-ledger-specifications/)
- Cardano Node: [GitHub](https://github.com/IntersectMBO/cardano-node)

Follow [TS Best Practices](https://github.com/HarmonicLabs/ts-best-practices). Preserve worker msgs/LMDB schemas (SQLite transition).

**Pick Up**: Fix parse → consensus worker → NES snapshots → immutable GC → txs.
