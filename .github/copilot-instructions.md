# Gerolamo Network Copilot Instructions

## Project Overview
Gerolamo Network is a TypeScript Cardano node/relay using Bun. **SQLite3 fully integrated** for blocks/headers (volatile/immutable, WAL/GC). P2P sync/fetch complete. **Consensus pending**: chainSelection, StableState, AnchoredVolatileState, BlockApplication.

**Note**: Post-Babbage/Conway sync & store achieved. Next: consensus validation in `./src/consensus/*.ts`.

## Key Files and Directories
- `src/network/peerManagerWorkers/peerManagerWorker.ts`: Peer orchestration/sync.
- `src/network/peerClientWorkers/PeerClient.ts`: Mini-protocol clients.
- `src/db/DB.ts`: SQLite storage (init/read/write/GC).
- `src/consensus/`: Pending - `chainSelection.ts`, `StableState.ts`, `AnchoredVolatileState.ts`, `BlockApplication.ts`.
- `src/utils/logger.ts`: Structured JSONL logging.
- `src/config/preprod/`: Cardano preprod genesis/config files; similar for mainnet.

## Developer Workflows
- **Setup**: `bun install`
- **Run**: `bun src/start.ts` (loads config, starts peer server/API/manager).
- **Sync**: Config `syncFromTip`/`syncFromPointSlot` etc.
- **Debug**: Logs `./logs/preprod/*.jsonl`; `tail -f logs/preprod/info.jsonl | jq`
- **Storage**: SQLite `store/db/preprod/Gerolamo.db` (or config.dbPath).

## Logging Architecture
- `src/utils/logger.ts`: `Logger` class, levels DEBUG/INFO/WARN/ERROR/NONE.
- **Console**: Colored timestamps/prefixes.
- **Files**: Per-level JSONL `./logs/preprod/{debug,info,warn,error}.jsonl`.
- **Format**: `{"timestamp":"ISO","level":"INFO","args":[...JSON-safe...]}` (BigInt→str, Error→obj).
- Configurable via `GerolamoConfig.logs`.

## Project-Specific Conventions
- **Peer Categories**: Add/move peers via worker messages; hot peers sync actively (see `addPeer` in worker). Preserve worker message types.
- **Era Handling**: Multi-era support via `@harmoniclabs/cardano-ledger-ts`.
- **Dependencies**: Use `@harmoniclabs/*` for Cardano primitives; Bun for runtime (no Node.js specifics). SQLite3 for storage.

## Integration Points
- **External APIs**: Fetches epoch params from Blockfrost (`blockFrostFetchEra.ts`).
- **Libraries**: Ouroboros for P2P, cardano-ledger-ts for types, SQLite3 for storage (replacing LMDB).
- **Cross-Component**: PeerClient posts messages to manager for block fetch/rollback.

## Additional Resources
- Gerolamo Repository: https://github.com/HarmonicLabs/gerolamo
- Harmonic Labs: https://github.com/harmonicLabs/
- Ouroboros Mini-Protocols TS: https://github.com/HarmonicLabs/ouroboros-miniprotocols-ts
- Cardano Ledger TS: https://github.com/HarmonicLabs/cardano-ledger-ts
- Cardano Specifications:
  - Shelley Ledger Spec: https://github.com/intersectmbo/cardano-ledger/releases/latest/download/shelley-ledger.pdf
  - Network Spec: https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf
  - Ledger Spec: https://intersectmbo.github.io/formal-ledger-specifications/cardano-ledger.pdf
- Cardano Node Repository: https://github.com/IntersectMBO/cardano-node
- Bun Runtime: https://bun.com/docs

## Coding Standards
Follow TypeScript best practices as outlined in
https://github.com/HarmonicLabs/ts-best-practices

## Extra Information and refrences
Cardanno Node Github Repository (https://github.com/IntersectMBO/cardano-node)

If you're not sure about sometthing, pause and ask the user for clarification.
Especially if it's about a structure of any cardano CBOR or CDDL.

Most answers about Cardano structure can be found in Cardano ledger ts Eras folder under CDDL files.

Refer to `README.md` for basic setup. When editing, preserve worker message types.
