Gerolamo is Harmonic Labs' Cardano node implementation in TypeScript, running on Bun. It implements the Ouroboros
networking and Praos consensus protocols, validates blocks against the full ledger rules including Plutus script
evaluation on its own UPLC machine, and produces blocks. It stores the chain in cardano-node's immutable chunk
format, bootstraps from Mithril, and also runs in the browser as a light node over node-to-node on WebSocket.
