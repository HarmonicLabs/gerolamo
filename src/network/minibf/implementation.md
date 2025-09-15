# MiniBf Endpoints in Dolos

The `miniBf` component in Dolos provides a lightweight HTTP service implementing a subset of the Blockfrost API for querying the local Cardano ledger state. This document outlines the supported endpoints and their implementation details in Dolos, serving as a reference for building a similar REST API layer in Gerolamo using `cardano-ledger-ts` for ledger queries and Bun for efficient HTTP request handling.

## Supported Endpoints

The following endpoints are supported by `miniBf` in Dolos. This list covers the core set from the Dolos documentation, though additional endpoints may be added in future releases.

### Block Endpoints
- **`/blocks/latest`**  
  Retrieves the latest block in the chain.
- **`/blocks/{hash_or_number}`**  
  Retrieves a specific block by its hash or height.
- **`/blocks/{hash_or_number}/txs`**  
  Lists transactions contained in a specific block.
- **`/blocks/{hash_or_number}/next`**  
  Retrieves blocks that follow a specific block.
- **`/blocks/{hash_or_number}/previous`**  
  Retrieves blocks that precede a specific block.

### Transaction Endpoints
- **`/txs/{hash}`**  
  Retrieves a specific transaction by its hash.
- **`/txs/{hash}/utxos`**  
  Lists UTxOs associated with a specific transaction.

### Address Endpoints
- **`/addresses/{address}`**  
  Retrieves details for a specific Cardano address.
- **`/addresses/{address}/utxos`**  
  Lists UTxOs associated with a specific address.
- **`/addresses/{address}/txs`**  
  Lists transactions associated with a specific address.

### Asset Endpoints
- **`/assets/{asset}`**  
  Retrieves details for a specific asset, where `{asset}` is `policy_id + asset_name` in hex format.
- **`/assets/{asset}/txs`**  
  Lists transactions involving a specific asset.
- **`/assets/{asset}/history`**  
  Retrieves the mint and burn history for a specific asset.

### Network Endpoints
- **`/network`**  
  Retrieves general network information.

### Epoch Endpoints
- **`/epochs/latest`**  
  Retrieves the latest epoch.
- **`/epochs/{number}`**  
  Retrieves details for a specific epoch by number.
- **`/epochs/{number}/stakes`**  
  Lists stake distributions for a specific epoch.
- **`/epochs/{number}/stakes/{pool_id}`**  
  Lists stakes for a specific pool in a given epoch.

### Pool Endpoints
- **`/pools/{pool_id}`**  
  Retrieves details for a specific stake pool.
- **`/pools/{pool_id}/metadata`**  
  Retrieves metadata for a specific stake pool.
- **`/pools/{pool_id}/updates`**  
  Lists updates for a specific stake pool.
- **`/pools/metadata`**  
  Retrieves metadata for all stake pools in bulk.

### Script Endpoints
- **`/scripts/{hash}`**  
  Retrieves details for a specific script.
- **`/scripts/{hash}/redeemers`**  
  Lists redeemers associated with a specific script.
- **`/scripts/{hash}/datum/{datum_hash}`**  
  Retrieves the datum for a specific datum hash associated with a script.
- **`/scripts/{hash}/json`**  
  Retrieves the JSON representation of a specific script.

> **Note**: This list is not exhaustive, as Dolos may introduce additional endpoints in future releases. Refer to the Dolos documentation for updates.

## Implementation in Gerolamo

To implement a similar API in Gerolamo, we can create a REST API layer using TypeScript and Bun’s built-in HTTP server or a framework like Express. The API would leverage `cardano-ledger-ts` for querying the ledger state and `ouroboros-miniprotocols-ts` for chain synchronization, ensuring compatibility with Cardano’s protocols.

## File Structure for Endpoint Definitions in Dolos

In the Dolos repository, the `miniBf` endpoints are defined within the `minibf` crate, implemented in Rust using the Warp framework. The structure is modular, allowing for easy extension, and can serve as a model for Gerolamo’s API design.

### Main Entrypoint
- **File**: `crates/minibf/src/main.rs`  
  Sets up the HTTP server using the Warp framework and loads the routes.

### Endpoint Handlers
The endpoint definitions and handlers are organized in the `crates/minibf/src/api/` directory, split into modular files:
- **`blocks.rs`**  
  Handles block-related endpoints (e.g., `/blocks/latest`, `/blocks/{hash_or_number}`, `/next`, `/previous`).
- **`txs.rs`**  
  Handles transaction-related endpoints (e.g., `/txs/{hash}`, `/txs/{hash}/utxos`).
- **`addresses.rs`**  
  Handles address-related endpoints (e.g., `/addresses/{address}`, `/utxos`, `/txs`).
- **`assets.rs`**  
  Handles asset-related endpoints (e.g., `/assets/{asset}`, `/txs`, `/history`).
- **`epochs.rs`**  
  Handles epoch and stake-related endpoints (e.g., `/epochs/latest`, `/stakes`).
- **`pools.rs`**  
  Handles pool-related endpoints (e.g., `/pools/{pool_id}`, `/metadata`).
- **`scripts.rs`**  
  Handles script-related endpoints (e.g., `/scripts/{hash}`, `/redeemers`, `/datum`).

### Routing Composition
- **File**: `crates/minibf/src/service.rs`  
  Aggregates the routes and handlers into the Warp service, composing filters for the HTTP server.

## Application to Gerolamo

The modular structure of Dolos’ `miniBf` can be adapted for Gerolamo by creating a similar directory layout in TypeScript:
- **Directory**: `src/api/`  
  Organize endpoint handlers in files like `blocks.ts`, `txs.ts`, `addresses.ts`, etc.
- **Framework**: Use Bun’s built-in HTTP server or Express to define routes.
- **Integration**: Connect to `cardano-ledger-ts` for ledger state queries and `ouroboros-miniprotocols-ts` for chain synchronization, ensuring compatibility with Cardano’s protocols.

This approach allows Gerolamo to efficiently handle HTTP requests while maintaining a lightweight node architecture, similar to Dolos.