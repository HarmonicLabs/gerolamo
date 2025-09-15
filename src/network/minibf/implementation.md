Supported Endpoints in miniBf for Dolos
The miniBf component in Dolos provides a lightweight HTTP service that implements a subset of the Blockfrost API for querying the local Cardano ledger state. Below is a list of supported endpoints, which can serve as a reference for implementing a similar REST API layer in Gerolamo using cardano-ledger-ts for ledger queries and Bun as the runtime for efficient HTTP request handling.
Endpoints
The following endpoints are supported by miniBf in Dolos. Note that this list is not exhaustive, as Dolos may add more endpoints in future releases, but it covers the core set from their documentation.
Block Endpoints

/blocks/latestRetrieves the latest block in the chain.
/blocks/{hash_or_number}Retrieves a specific block by its hash or height.
/blocks/{hash_or_number}/txsLists transactions contained in a specific block.
/blocks/{hash_or_number}/nextRetrieves blocks that follow a specific block.
/blocks/{hash_or_number}/previousRetrieves blocks that precede a specific block.

Transaction Endpoints

/txs/{hash}Retrieves a specific transaction by its hash.
/txs/{hash}/utxosLists UTxOs associated with a specific transaction.

Address Endpoints

/addresses/{address}Retrieves details for a specific Cardano address.
/addresses/{address}/utxosLists UTxOs associated with a specific address.
/addresses/{address}/txsLists transactions associated with a specific address.

Asset Endpoints

/assets/{asset}Retrieves details for a specific asset, where {asset} is policy_id + asset_name in hex format.
/assets/{asset}/txsLists transactions involving a specific asset.
/assets/{asset}/historyRetrieves the mint and burn history for a specific asset.

Network Endpoints

/networkRetrieves general network information.

Epoch Endpoints

/epochs/latestRetrieves the latest epoch.
/epochs/{number}Retrieves details for a specific epoch by number.
/epochs/{number}/stakesLists stake distributions for a specific epoch.
/epochs/{number}/stakes/{pool_id}Lists stakes for a specific pool in a given epoch.

Pool Endpoints

/pools/{pool_id}Retrieves details for a specific stake pool.
/pools/{pool_id}/metadataRetrieves metadata for a specific stake pool.
/pools/{pool_id}/updatesLists updates for a specific stake pool.
/pools/metadataRetrieves metadata for all stake pools in bulk.

Script Endpoints

/scripts/{hash}Retrieves details for a specific script.
/scripts/{hash}/redeemersLists redeemers associated with a specific script.
/scripts/{hash}/datum/{datum_hash}Retrieves the datum for a specific datum hash associated with a script.
/scripts/{hash}/jsonRetrieves the JSON representation of a specific script.

Implementation Notes for Gerolamo
To mirror these endpoints in Gerolamo, we can build a REST API layer using TypeScript and Bun’s built-in HTTP server or a framework like Express. The API would leverage cardano-ledger-ts for querying the ledger state and ouroboros-miniprotocols-ts for chain synchronization. This modular approach ensures compatibility with Cardano’s ledger and network specifications, enabling efficient query handling for a lightweight node.
File Structure for Endpoint Definitions in Dolos
In the Dolos repository, the miniBf endpoints are defined within the minibf crate, implemented in Rust using the Warp framework. The structure is modular, allowing for easy extension, and can serve as a model for Gerolamo’s API design.
Main Entrypoint

File: crates/minibf/src/main.rsSets up the HTTP server using the Warp framework and loads the routes.

Endpoint Handlers
The endpoint definitions and handlers are organized in the crates/minibf/src/api/ directory, split into modular files:

blocks.rsHandles block-related endpoints (e.g., /blocks/latest, /blocks/{hash_or_number}, /next, /previous).
txs.rsHandles transaction-related endpoints (e.g., /txs/{hash}, /txs/{hash}/utxos).
addresses.rsHandles address-related endpoints (e.g., /addresses/{address}, /utxos, /txs).
assets.rsHandles asset-related endpoints (e.g., /assets/{asset}, /txs, /history).
epochs.rsHandles epoch and stake-related endpoints (e.g., /epochs/latest, /stakes).
pools.rsHandles pool-related endpoints (e.g., /pools/{pool_id}, /metadata).
scripts.rsHandles script-related endpoints (e.g., /scripts/{hash}, /redeemers, /datum).

Routing Composition

File: crates/minibf/src/service.rsAggregates the routes and handlers into the Warp service, composing filters for the HTTP server.

Application to Gerolamo
The modular structure of Dolos’ miniBf can be adapted for Gerolamo by creating a similar directory layout in TypeScript:

Directory: src/api/Organize endpoint handlers in files like blocks.ts, txs.ts, addresses.ts, etc.
Framework: Use Bun’s built-in HTTP server or Express to define routes.
Integration: Connect to cardano-ledger-ts for ledger state queries and ouroboros-miniprotocols-ts for chain synchronization, ensuring compatibility with Cardano’s protocols.

This approach allows Gerolamo to efficiently handle HTTP requests while maintaining a lightweight node architecture, similar to Dolos.