## Plan: Layout Cardano-Like SQLite Schema

Design SQLite tables to emulate Cardano's ImmutableDB (chunked immutable historical blocks/headers) and VolatileDB (recent mutable blocks/headers), clarifying data differences and movement after 2160 blocks behind the tip for stability.

### Steps
1. Create ImmutableDB schema with tables for chunks (chunk_no, tip_hash, block_no) and blocks (slot, hash, header_data, chunk_id foreign key) for stable storage.
2. Define VolatileDB schema with blocks table (slot, hash, header_data, offset, is_valid) for prunable recent data, without chunks.
3. Document differences: ImmutableDB uses indexed chunks for immutable data; VolatileDB stores raw, discardable entries on forks.
4. Implement data movement logic: Query and copy blocks >2160 behind tip from VolatileDB to ImmutableDB tables in `src/network/peerManagerWorkers/peerManagerWorker.ts`.
5. Integrate schemas into new DB init script, linking to sync processes in `peerManagerWorker.ts`.
6. Add GC emulation: Delete VolatileDB entries post-copy via triggers or scheduled queries.

### Further Considerations
1. Customize k=2160 as configurable in `src/config/preprod/config.json`?
2. How to handle block/header metadata details in tables (e.g., add fields like prev_hash)?
3. Include migration for existing data during schema adoption?
