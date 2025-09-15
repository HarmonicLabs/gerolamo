Supported Endpoints in miniBf on dolos

/blocks/latest: Get the latest block.
/blocks/{hash_or_number}: Get a specific block by hash or height.
/blocks/{hash_or_number}/txs: Get transactions in a specific block.
/blocks/{hash_or_number}/next: Get the next blocks after a specific one.
/blocks/{hash_or_number}/previous: Get the previous blocks before a specific one.
/txs/{hash}: Get a specific transaction by hash.
/txs/{hash}/utxos: Get UTxOs for a specific transaction.
/addresses/{address}: Get details for a specific address.
/addresses/{address}/utxos: Get UTxOs for a specific address.
/addresses/{address}/txs: Get transactions for a specific address.
/assets/{asset}: Get details for a specific asset (where {asset} is policy_id + asset_name hex).
/assets/{asset}/txs: Get transactions for a specific asset.
/assets/{asset}/history: Get mint/burn history for a specific asset.
/network: Get network information.
/epochs/latest: Get the latest epoch.
/epochs/{number}: Get a specific epoch by number.
/epochs/{number}/stakes: Get stakes for a specific epoch.
/epochs/{number}/stakes/{pool_id}: Get stakes for a pool in a specific epoch.
/pools/{pool_id}: Get details for a specific pool.
/pools/{pool_id}/metadata: Get metadata for a specific pool.
/pools/{pool_id}/updates: Get updates for a specific pool.
/pools/metadata: Get metadata for all pools (bulk).
/scripts/{hash}: Get details for a specific script.
/scripts/{hash}/redeemers: Get redeemers for a specific script.
/scripts/{hash}/datum/{datum_hash}: Get datum for a specific datum hash associated with a script.
/scripts/{hash}/json: Get the JSON representation of a script.

These are not exhaustive, as Dolos adds more over releases, but this covers the core set from their docs. For Gerolamo, we could mirror this with a REST API layer on top of cardano-ledger-ts for ledger queries, using Bun for the runtime to handle HTTP requests efficiently.
File Where Endpoints Are Defined
The endpoints are defined in the minibf crate within the Dolos repository. Specifically:

The main entrypoint is in crates/minibf/src/main.rs, which sets up the HTTP server (using Warp framework in Rust) and loads the routes.
The actual endpoint definitions and handlers are modularized across files in crates/minibf/src/api/, such as:

blocks.rs: Handles block-related endpoints (e.g., /blocks/latest, /blocks/{hash_or_number}, next/previous).
txs.rs: Handles transaction endpoints (e.g., /txs/{hash}, /txs/{hash}/utxos).
addresses.rs: Handles address endpoints (e.g., /addresses/{address}, utxos, txs).
assets.rs: Handles asset endpoints (e.g., /assets/{asset}, txs, history).
epochs.rs: Handles epoch and stake endpoints (e.g., /epochs/latest, stakes).
pools.rs: Handles pool endpoints (e.g., /pools/{pool_id}, metadata).
scripts.rs: Handles script-related endpoints (e.g., /scripts/{hash}, redeemers, datum).


Routing is composed in crates/minibf/src/service.rs or a similar aggregator file, where filters and handlers are combined into the Warp service.

This modular structure allows easy extension. In Gerolamo, we could adopt a similar approach with TypeScript routes in a dedicated api/ directory, using Express or Bun's built-in server, integrated with ouroboros-miniprotocols-ts for chain interactions