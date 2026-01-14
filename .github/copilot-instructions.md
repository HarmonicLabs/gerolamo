# Gerolamo Network Copilot Instructions

## Project Overview
Gerolamo Network is a TypeScript implementation of a Cardano node/relay using Bun runtime. It handles P2P networking, chain synchronization, block fetching, and storage. Key components include:
- **Peer Management**: Manages peers in categories (hot, warm, cold, bootstrap, new) via workers (`peerManagerWorker.ts`, `peerClientWorker.ts`).
- **Chain Sync & Block Fetch**: Uses `@harmoniclabs/ouroboros-miniprotocols-ts` for mini-protocols; syncs from genesis, tip, or specific point (see `GerolamoConfig` in `peerManagerWorker.ts`).
- **Data Flow**: Peers handshake, sync chain, fetch headers/blocks, store in SQLite3 database.
- **Why Structured This Way**: Worker threads for concurrent peer handling; modular design for Cardano compatibility; SQLite3 for storage (transitioning from LMDB).

**Note**: Currently simplifying to focus on networking and storage. Not handling consensus validation yet. Fetch headers, perform basic validation, fetch blocks, and store in SQLite3 using schema inspired by Cardano node

## Key Files and Directories
- `src/network/peerManagerWorkers/peerManagerWorker.ts`: Core peer orchestration and sync logic.
- `src/network/peerClientWorkers/PeerClient.ts`: Individual peer handling, mini-protocol clients.
- `src/network/utils/`: Utilities like `calcEpochNonce.ts` (may be deprecated during simplification).
- `src/config/preprod/`: Cardano preprod genesis/config files; similar for mainnet.
- (Upcoming) SQLite3 integration for block/header storage, replacing `src/network/lmdbWorkers/lmdbWorker.ts`.

## Developer Workflows
- **Setup**: Run `bun install` to install deps (Bun-specific). Install SQLite3 if needed.
- **Run**: `bun run index.ts` (extend to start peer manager via `startPeerManager.ts`).
- **Sync Chain**: Configure `GerolamoConfig` in topology/config files; init starts handshake and sync loop.
- **Debug Peers**: Set `logLevel` in config; logs peer connections, sync progress.
- **Storage**: Blocks/headers stored in SQLite3; schema based on Kupo for efficiency.

## Project-Specific Conventions
- **Peer Categories**: Add/move peers via worker messages; hot peers sync actively (see `addPeer` in worker). Preserve worker message types.
- **Era Handling**: Multi-era support via `@harmoniclabs/cardano-ledger-ts`.
- **Dependencies**: Use `@harmoniclabs/*` for Cardano primitives; Bun for runtime (no Node.js specifics). Transitioning storage from LMDB to SQLite3; preserve LMDB schemas during edits if needed.

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
  - Network Spec: https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf
  - Ledger Spec: https://intersectmbo.github.io/formal-ledger-specifications/cardano-ledger.pdf
- Cardano Node Repository: https://github.com/IntersectMBO/cardano-node
- Bun Runtime: https://bun.com/docs

## Coding Standards
Follow TypeScript best practices as outlined in
https://github.com/HarmonicLabs/ts-best-practices

## Extra Information and refrences
Cardanno Node Github Repository (https://github.com/IntersectMBO/cardano-node)
Kupo Github Repository (https://github.com/CardanoSolutions/kupo/blob/master/src/Kupo/Data/Database.hs)

Refer to `README.md` for basic setup. When editing, preserve worker message types and any remaining LMDB schemas during transition to SQLite3.
