# Chunk store: cardano-node's immutable format as Gerolamo's block store (plan, 2026-09-14)

## Goal

Gerolamo stores blocks the way cardano-node does: an `immutable/` directory of `NNNNN.chunk`,
`NNNNN.primary` and `NNNNN.secondary` files, extended block by block as blocks become immutable.
A Mithril snapshot is then used as-is, a cardano-node can start from Gerolamo's directory and
Gerolamo from a cardano-node's, and nothing is parsed twice. SQLite keeps only the ledger tables
it has today and the explorer / mini-Blockfrost projection.

Why now: the September 7 preview bootstrap spent 1 h 38 min applying 4.6 million blocks from the
snapshot into `preview.db`, then the extractor parsed the same chunks a second time for the
explorer. `preview.db` is 57 GB, of which 14 GB is block bytes and 4 GB header bytes in the
`blocks` table. The relay we are bringing up next to the producer had to download the snapshot
again because the chunk files were deleted after the apply. `immutable_blocks` and
`immutable_chunks` (an earlier attempt to mirror the concept in SQLite) hold 0 rows.

## The format (verified against ouroboros-consensus `Storage/ImmutableDB/Impl/Index/*.hs`)

- **Chunk size** is `10 · k` slots for every era: 21 600 on mainnet, 4 320 on preview and
  preprod (`k = 432`). Check: the preview snapshot at slot 122 087 503 had 28 261 chunks,
  122 087 503 / 4 320 = 28 260.5. Chunk `n` covers slots `[n · 10k, (n + 1) · 10k)`.
- **`NNNNN.chunk`**: the blocks of that chunk, in slot order, each in cardano-node's on-disk
  encoding (`encodeDisk`), concatenated with no framing. `parseChunk` in `src/state/legacy.ts`
  already slices these bytes out and decodes them as `MultiEraBlock`; the writer emits the same
  bytes. Phase 1 confirms by byte comparison that the on-disk encoding equals the block-fetch
  `MsgBlock` payload for Shelley-era blocks (both are the hard-fork-combinator envelope) and
  documents the Byron difference if any.
- **`NNNNN.secondary`**: one fixed-size entry per block in the chunk, big-endian:
  `blockOffset u64 | headerOffset u16 | headerSize u16 | checksum u32 (CRC-32 of the block's
  bytes in the chunk file) | headerHash 32 bytes | blockOrEBB u64`. Entry size 56 bytes.
  `blockOrEBB` is the slot for a regular block and the epoch number for a Byron EBB.
- **`NNNNN.primary`**: one version byte (`1`), then `(relative slots + 1)` big-endian u32
  offsets into the secondary file. Offset `i` is the secondary offset of relative slot `i`'s
  entry; an empty slot repeats the previous offset. The first offset is 0; the last is the
  secondary file size. Chunks that may hold an EBB (Byron) have one extra relative slot at
  the front for it. File size = `1 + (slots + 1) · 4` = 17 285 bytes on preview.
- cardano-node validates the most recent chunk on start and rebuilds its index files when
  they are missing or wrong (`ValidateMostRecentChunk`, the default); `--validate-db` does
  it for every chunk. We still write correct indices ourselves so a start is instant.

## Design

Three stores behind one interface, replacing the `blocks` table on the hot path:

1. **`ChunkStore`** (`src/storage/chunkStore.ts`): the immutable directory.
   - Reader: `blockAt(slot)`, `blockByHash(hash)`, `headerAt(slot)`, `range(fromSlot, toSlot)`,
     `tip()`, `iterate(fromPoint)` for chain-sync serving. Slot → chunk number is arithmetic;
     hash → slot uses a small persistent index (see 3) because the node's format has none.
     Chunk files are read with `Bun.file(...).slice(off, end)`; the last chunk's three files
     are kept open for appends. Hot chunks are cached (a few MB each).
   - Writer: `append(block)` rewrites nothing: it appends the block bytes to `.chunk`, one
     56-byte entry to `.secondary`, and extends `.primary` from the last written relative slot
     to the block's slot (repeat offsets for the gap, then the new offset). Starting a new chunk
     writes the version byte and the initial 0 offset; the previous chunk is finalised by
     padding its primary to `slots + 1` offsets. Appends are fsynced in the order chunk,
     secondary, primary so a crash leaves at worst a trailing block without index, which the
     validator on open trims or re-indexes exactly as cardano-node does.
2. **`VolatileStore`** (`src/storage/volatileStore.ts`): the last `k` blocks plus any fork
   branches, keyed by hash, with prev-hash links: an in-memory map backed by an append-only
   `volatile/blocks-NNNN.dat` file with a small record framing (length, hash, slot, bytes) so a
   restart replays it. A block moves to the ChunkStore when it is `k` deep on the selected
   chain; the volatile file is truncated on every full garbage collection. Forks drop entries
   above the intersection; nothing in the chunk directory ever changes.
3. **Hash index**: `hash → slot` for immutable blocks, needed by `findIntersect`, block-fetch
   by point and the explorer. Kept as a compact on-disk table (32 + 8 bytes per block, 190 MB
   for preview, 500 MB for mainnet) rebuilt from the secondary indices in one pass when missing.
   SQLite is not on this path.

The ledger store is untouched by this plan: the ledger tables (or LMDB, phase F of
`PLAN_SNAPSHOT_BOOTSTRAP.md`) stay as they are; `utxo_deltas` keeps serving rollbacks until
the volatile-diff layer of phase F replaces it. The explorer keeps its own database, fed by
the extractor reading chunks (unchanged) and by the worker at the tip.

## Phases

### Phase 1: read path and proof of format (2 days)

- `ChunkStore` reader over an existing Mithril directory, unit-tested against the numbers
  above (primary size, entry layout, EBB chunk) and integration-tested against the preview
  relay's downloaded directory (`cardano-node/preview-relay/db/immutable`).
- Byte comparison: for 100 random blocks, the chunk-file bytes equal what our block-fetch
  client receives from a peer for the same point, per era. Document the Byron envelope.
- CRC-32 check of every block in the relay's directory (the same routine the writer uses).
- Acceptance: `bun scripts/chunk-store-check.ts <immutable dir>` reports all chunks consistent
  on the relay's snapshot, in minutes, on all cores.

### Phase 2: writer and cardano-node acceptance (3 days)

- `append()` with the fsync order above; chunk rollover; primary finalisation; recovery on
  open (trailing unindexed bytes, half-written entry).
- Test: copy the relay's last three chunks to a scratch directory, append the next 5 000
  blocks fetched from the preview network through our block-fetch client, then start a
  cardano-node on that directory. It must start without re-validating anything but the last
  chunk and serve `query tip` at the appended height. This is the acceptance test for the
  whole plan; nothing else ships before it passes.
- Property test: write N blocks with random gaps, re-read with `parseChunk`, compare.

### Phase 3: volatile store and the switch (4 days)

- `VolatileStore` with replay-on-start and fork drop; `k`-deep promotion into the ChunkStore
  driven by the consensus layer's immutable-point advance (the same place that today marks
  rows stable).
- One `BlockStore` facade (`src/storage/blockStore.ts`) with the union of the read methods,
  answering from volatile first, then chunks. Every reader moves to it:
  `db.ts` (`getBlockBySlot`, `getBlockByHash`, `getChainTipFromHeader`, `getRecentBlockPoints`,
  `getValidBlocksBefore` and the other block readers), `SqliteRelayChainStore` (becomes
  `ChunkRelayChainStore` behind the unchanged `RelayChainStore` interface), `GerolamoChainDb`
  (node-to-client chain sync), `peerBlockServer`, the producer adapter (`tip`, `blockAtSlot`),
  `ConsensusOrchestratooor` (adoption writes into the volatile store), `nonceReplay`,
  `retypeStakeCreds`, `miniBlockfrost` / `openApi` (which should read the explorer database,
  not the block store; fix where they don't).
- `insertBlockVolatile` / `insertBlockBatchVolatile` / `insertImmutableBlocks` write to the
  new stores; the `blocks` and `volatile_headers` tables stop being written. The
  `blocks.block_no` drift (bug 106) disappears with the table.
- Acceptance: the preview producer runs a full epoch on the new store, forges its leader
  slots, serves chain-sync and block-fetch to inbound peers, and the relay stays in sync with
  it. `/stats` unchanged.

### Phase 4: bootstrap without the double parse (2 days)

- `mithril-bootstrap` stops applying blocks. It downloads and verifies the chunk files into
  `<nodeDir>/db/immutable` (our pure-TS client already does; `--blocks-only` and the apply
  loop go), verifies the ancillary set, imports the ledger state (`importState`, unchanged),
  builds the hash index, and starts the extractor for the explorer in the background.
- The node then syncs from the snapshot's slot to the tip through the volatile store.
- Acceptance: a fresh preview node from `mithril-bootstrap` to tip in the download time plus
  minutes, no `blocks` table, explorer complete once the extractor finishes.
- Same directory layout as cardano-node (`db/immutable`, `db/volatile`, `db/ledger`), so the
  relay's `--database-path` and ours are interchangeable, and `startPreviewRelay.sh` can point
  at a copy of the producer's directory.

### Phase 5: migration of the running preview databases (1 day)

- `scripts/blocks-to-chunks.ts`: one-off export of the `blocks` table of an existing database
  into a chunk directory (4.66 million rows, ~18 GB of bytes, an hour). Alternative for
  preview: re-bootstrap, since the download is 50 minutes.
- After the export, `VACUUM` the ledger database; expected size roughly 35 GB smaller.
- Drop `immutable_blocks`, `immutable_chunks`, `blocks`, `volatile_headers` in a migration
  once the node has run a day on the new store.

## Risks and decisions

- **Byron chunks**: EBB slot and Byron annotations. Preview has no Byron history that
  matters, mainnet does; phase 1 documents the envelope from the mainnet snapshot's first
  chunks before the writer is trusted for mainnet.
- **Concurrent readers**: cardano-node must never open a directory Gerolamo is appending to.
  Sharing is by copy (or by stopping one side), same as between two cardano-nodes.
- **CRC**: cardano-node checks CRC-32 only when validating; wrong checksums would surface on
  its first start from our directory, which phase 2 tests.
- **Header offsets** in the secondary entry are needed by cardano-node to serve headers
  without decoding blocks; our writer computes them from the block CBOR structure (the header
  is the first element of the block array after the era envelope), verified in phase 1
  against the snapshot's own entries.
- **Ordering with phase F (LMDB ledger store)**: independent. This plan removes block bytes
  from SQLite; phase F removes the ledger state. Either can go first; this one is smaller and
  unblocks the relay and the bootstrap time.

## Estimate

Twelve working days for phases 1 to 5, with the cardano-node start in phase 2 as the gate.

## Status

### 2026-09-14, phases 1 and 2 built the same day the plan was written

- Format verified byte for byte on two real directories: the preview Mithril snapshot
  (28 411 chunks, 4 661 949 blocks, 14.04 GB, checked in 46 s by `scripts/chunk-store-check.ts`)
  and the preprod cardano-node db (6 189 chunks, 5 174 174 blocks, Byron EBBs included).
  Facts the code relies on, all confirmed: CRC-32 is `Bun.hash.crc32`; the header sits at
  offset 3 in every era (Byron blocks are `[0|1, [header, body, extra]]`, no inner kind tag);
  a regular block at slot s occupies relative slot `s − chunkStart + 1`, relative slot 0 is the
  EBB (its `blockOrEBB` field is the epoch); the era tag byte is the block-fetch wire tag
  (0 Byron EBB, 1 Byron, 2 Shelley, 5 Alonzo, 6 Babbage, 7 Conway); the open chunk's primary
  file is partial (grows by one offset per slot) and only complete chunks are padded.
- `src/storage/chunkFormat.ts` (encode/decode, header locator, CBOR skipper),
  `chunkStore.ts` (reader; appender with fsync order chunk → secondary → primary; torn-tail
  recovery on open; `readOnly` for directories another node writes — the checker and every
  test on the relay's live directory use it), `hashIndex.ts` (hash → slot, record file under
  `<db>/gerolamo/`, open-addressing table in RAM, rebuilt or caught up from the secondary
  indices), `volatileStore.ts` (cardano-node's `volatile/blocks-N.dat` layout, header-hash and
  slot and prev-hash recovered from the bytes, Byron hash rule `blake2b([kind, header])`),
  `blockStore.ts` (facade: volatile first, then chunks; `promote(tipHash, k)` moves blocks
  more than k deep into the chunk store in slot order and garbage-collects volatile files).
  14 tests in `src/storage/`, run against the real snapshot.
- The writer re-creates the node's own files exactly: chunks 1000, 28408, 28409 and 28410
  of the preview snapshot rebuilt by `append()` are byte-identical (`.chunk`, `.secondary`,
  `.primary`) to cardano-node's.
- cardano-node acceptance (phase 2 gate): a db whose chunks 28408–28410 were written by
  Gerolamo, the rest hardlinked from the snapshot, ledger snapshot 122726861 copied, started
  without a `clean` marker so cardano-node 11.0.1 validates every chunk. **Passed 16:58 UTC**:
  all 28 411 chunks validated (ours: "Validated chunk no. 28408/28409/28410", no
  RewriteSecondaryIndex / InvalidChunkFile for them; the node did rewrite the secondary index of
  the snapshot's chunk 0, which is its own business), ledger replayed from the snapshot, the node
  synced to the network tip (block 4 662 406) and served `query tip` and later `query tip` again
  30 s on. The node also ignored our `gerolamo/` directory beside `immutable/`. Log kept at
  the scratch copy; the scratch db was removed afterwards.
- Reference node: the preview cardano-node relay (`cardano-node/preview-relay`, port 6424,
  db from the Mithril snapshot via the official client) is at the tip and is a hot local root of
  the producer since 16:37 UTC. It doubles as the LocalStateQuery oracle: with it the
  node-to-client era history got its real Conway start (epoch 646) and horizon end, and the
  pparams reply became byte-identical to cardano-node's (indefinite-length cost-model lists).

### Phase 3 plan of record (next)

The `blocks` table is read by `db.ts` helpers (`getBlockBySlot`, `getBlockByHash`,
`getChainTip[FromHeader]`, `getMaxSlot`, `getRecentBlockPoints/Headers`, `getLastBlockBefore`,
`getBlockListRow*`, `blockHashesAbove`, `getValidBlocksBefore`, `getMaxBlockNo`) used from the
orchestrator, PeerClient, peerBlockServer, GerolamoChainDb, the producer, the APIs, and by
`SqliteRelayChainStore` directly. The switch keeps those helper signatures and re-implements
them over `BlockStore` behind a config flag (`blockStore: "chunks"`), so consumers change
only where they need block numbers (read from the header, which also retires bug 106).
Writes: `insertBlockVolatile` → `BlockStore.put`; the orchestrator calls `promote(tipHash, k)`
after each applied range; `rollbackChainTo` drops nothing from the chunk store (blocks above
the fork stay in the volatile set until GC) and keeps its ledger work. Roll-out on the second
preview node (port 3036) first, then the producer.

### 2026-09-14 evening, phase 3 first half live on the second preview node

- **Dual write**: `ConsensusOrchestrator.mirrorToBlockStore` runs after every committed range
  (own forged blocks included, they go through `applyRange` too): the range's `[era, block]`
  bytes into the volatile set, then `promote(tipHash, k)`. Never fails the range; SQLite stays
  primary. `src/storage/nodeBlockStore.ts` opens the store at startup (`<dir of dbPath>/db`, or
  `blockStoreDir`; `GEROLAMO_BLOCK_STORE=0` disables), `catchUpFromSqlite` copies the `blocks`
  rows above the immutable tip and promotes, and registers the process-wide instance.
- **Seeding**: `bun scripts/blockstore-seed.ts --src <immutable dir> --dst <nodeDir>/db --db
  <sqlite>` hardlinks the complete chunks of a snapshot directory (85 233 files in 3.5 s),
  copies the open chunk, builds the hash index (178 MB for preview) and fills the volatile set
  from SQLite through the read-only connection. Done for node 3036 and the producer.
- **Live proof** on node 3036 (`gerolamo-preview-mithril2`): one minute after relaunch its open
  chunk `28411.{chunk,secondary,primary}` was byte-identical to the relay cardano-node's own
  files at the same immutable tip (122 736 919), both appending the same chain independently.
- **Serving from chunks**: `ChunkRelayChainStore` implements `RelayChainStore` over the
  BlockStore (tip from the header's block number, `[era − 1, #6.24(header)]` payloads, hash-linked
  ranges, forks resolved through the consensus layer's selected tip via `noteSelectedTip`).
  Enabled with `relayStore: "chunks"` in config (or `GEROLAMO_RELAY_STORE=chunks`); node 3036
  runs it on a loopback listener (127.0.0.1:3002). `bun scripts/n2n-probe.ts --host 127.0.0.1
  --port 3002 --magic 2 --immutable <dir>`: handshake 12 ms, intersect, RollBackward first,
  5 headers and a 5-block range all byte-identical to the chunk files, tip blockNo 4 662 455.
- Next: soak on 3036, then the producer (`relayStore: "chunks"` once its store is seeded);
  then move the remaining readers (`db.ts` helpers, GerolamoChainDb, peerBlockServer,
  producer adapter) behind the BlockStore and stop writing the `blocks` table (phase 3 second
  half), then phase 4 (bootstrap without block apply) and phase 5 (migration, VACUUM).

### 2026-09-14 later, phase 3 second half: "primary" mode

- `blockStoreMode: "primary"` (config, or `GEROLAMO_BLOCK_STORE_MODE`): the `blocks` and
  `volatile_headers` tables are no longer written; `insertBlockVolatile` puts the block into the
  volatile files and makes it the selected tip at once, so the "applied tip" every reader sees
  advances block by block as before. `src/storage/blockReads.ts` answers the `db.ts` helpers
  (`getBlockBySlot/ByHash`, `getChainTip[FromHeader]`, `getMaxSlot`, `getMaxBlockNo`,
  `getRecentBlockPoints/Headers`, `getLastBlockBefore`, `getBlockListRow*`, `blockHashesAbove`,
  `blockExists`, `storedBlocksInSlotRange`, the tx-count fallback) in their exact shapes; a
  failed range restores the pre-range tip, a rollback moves it (`rollbackSelectedTip`), and
  `rollbackChainTo` takes the gone hashes and their slots from the store so the UTxO deltas are
  still reverted. `pruneLedgerJournal` resolves block slots through the store; the orphaned-deltas
  migration is skipped (it would judge new blocks orphaned against the frozen table).
- Startup in primary mode resolves the selected tip from the **ledger journal's newest block**
  (the block the ledger tables last applied), else the persisted `gerolamo/selected-tip.hex`,
  else the SQLite `blocks` newest row; if none is in the store at or above the immutable tip the
  node logs an error and runs in mirror mode. First attempt on 3036 (17:19 UTC) served the
  immutable tip instead: the fallback walk did not recognise a volatile chain that passes
  through the immutable tip (volatile files keep blocks at and below it until GC). No block was
  applied in that window and no ledger error occurred; fixed (`chainConnects`) and covered by a
  test, second attempt 17:30 UTC started with "selected tip slot 122750935 (ledger journal)".
  Five-minute soak: served tip = network tip (122 751 396), immutable tip advanced by promotion
  (122 738 981 → 122 739 471), open chunk still byte-identical to the relay's, no errors. The API
  block lists (`listBlocksDesc`, `listBlocksInSlotRange`, `countBlocksInSlotRange`) and the stats
  page's recent-blocks panel were then routed to the store as well.
- Still reading the frozen table in primary mode, deliberately: the mini-Blockfrost / explorer
  block lists in `db.ts` (they move to the explorer database), `peerBlockServer`'s recent-blocks
  panel, `retypeStakeCreds` (offline tool), `chainSelection.evaluateChains` (legacy heuristic).
- Also fixed on the way: `GerolamoChainDb` (node-to-client chain sync) read object fields off
  the positional rows `getBlockBySlot` returns, so its tip was always origin.

### Phase 4 built (2026-09-14 evening): bootstrap without the block apply

`bun src/index.ts mithril-bootstrap --network preview --download-dir <nodeDir>/db --block-store
<nodeDir>/db --ledger-state --db <nodeDir>/preview.db` now: verifies the certificate chain,
downloads the chunks (into the block store's own `immutable/` when the two directories coincide,
otherwise hardlinks them there — `src/storage/seed.ts`, shared with `scripts/blockstore-seed.ts`),
verifies the ancillary manifest, imports the UTxO tables and the NewEpochState into the ledger
tables **without** trimming or numbering any SQLite block rows (there are none), builds the hash
index, and pins `gerolamo/selected-tip.hex` to the ledger state's block after checking that the
chunk at that slot carries the state's hash. A node started on the directory with
`blockStoreMode: "primary"` resumes at the state's block and fetches the rest from peers; the
few blocks of the last chunk above the state are already in the store and are skipped on promote.
Acceptance run started 17:35 UTC into `/media/bakon/data/cardano/gerolamo-preview-chunks`
(full preview download, snapshot 3b0af5e2… epoch 1420, 28 410 chunks). **Result**: 17:35 → 18:08
UTC, 33 minutes end to end — certificate chain 45 s, 28 411 chunks in 27 min at 17–18 chunks/s
with our own client, ancillary verified, 3 169 305 UTxOs imported in 293 s, NewEpochState
imported, hash index built in 12 s, selected tip pinned to the state's block (slot 122 735 066;
the 706 slots of chunks above it are skipped on promote). Against 1 h 38 min for the September 7
bootstrap that applied every block into SQLite. The resulting `preview.db` is 3.2 GB (ledger
tables only) beside a 15 GB `db/`. The first node start on it (18:08 UTC, port 3037) found two
defects: the startup-tip resolver rejected the pinned tip because it sat below the chunk tip (the
last chunk holds blocks after the state), and the fallback to mirror mode on an empty `blocks`
table made the node sync from genesis onto the imported ledger, which the strict rules halted at
slot 320 ("stake credential already registered"). Fixes: the bootstrap now trims the chunk store
to the state's block (`ChunkStore.truncateAfter`, tested to re-create the node's files exactly when
the dropped blocks are appended again), and a primary-mode start with no resolvable tip and no
SQLite blocks refuses to start instead of falling back. Ledger re-imported (18:11–18:16 UTC, 22
blocks trimmed from the last chunk) and the node started again at 18:17:16: "Block store is
PRIMARY: selected tip slot 122735066 (persisted tip)", chain sync resumed there, and **21 seconds
later it was at the network tip** (122 753 839, block 4 662 617), no errors, 660 volatile blocks,
promotion had advanced the immutable tip to 122 742 220. Its chunks 28410 (rewritten by the
trim), 28411 and 28412 (written live) are byte-identical to the relay cardano-node's files.
**Phase 4 accepted**: a preview node from nothing to the tip in 33 minutes of download and
import plus 21 seconds of sync, against 1 h 38 min plus the double parse before.

### Phase 5 tooling (2026-09-14 evening)

`bun scripts/blocks-to-chunks.ts --db <sqlite> --dst <nodeDir>/db` exports an existing node's
SQLite `blocks` table into a block store (read-only connection, resumable from the store's tip,
promotes as it goes). Checked on node 3036's table: 40 089 blocks exported in 15 s, all 261
complete chunks byte-identical to the relay cardano-node's. For a node that has a snapshot directory at hand, `scripts/blockstore-seed.ts`
(hardlinks) is the faster path. Dropping the `blocks` / `volatile_headers` / `immutable_*` tables
and the `VACUUM` wait for a day of primary-mode operation on each node.

### Clean cut-over (2026-09-14 night, before the 06:49 UTC leader slot)

- **Primary is the default** (`blockStoreMode` unset ⇒ primary; `"mirror"` is the legacy
  option for a node whose store cannot resolve the ledger's tip — it then logs an error and keeps
  SQLite's `blocks` table primary; a node with an empty `blocks` table refuses to start instead).
- `chainSelection.evaluateChains` and `findIntersection` no longer scan `blocks`; they take the
  tip and height from the routed helpers.
- `bun scripts/blocks-table-cleanup.ts --db <sqlite> --store <nodeDir>/db --port <port>` (node
  stopped; refuses while the port is bound): checks that the ledger journal's newest block and the
  `blocks` table's newest row are in the store and that the persisted selected tip is at or above
  the SQLite tip, then empties `blocks`, `volatile_headers`, `immutable_blocks`, `immutable_chunks`
  and runs `VACUUM`. The tables stay (every legacy reader is harmless on empty tables; the
  one-off migrations are marked done in `schema_migrations`).
- Order: node 3036 first, then the producer (`relayStore: "chunks"` at the same time), each
  followed by the startup line "Block store is PRIMARY: selected tip slot … (ledger journal)", the
  served tip against the relay's, and for the producer the block-production panel and a forge dry
  run against the store.

#### 22:30–23:00 UTC: what the cut-over night actually found

- Node 3036 (primary since 17:39) had been sitting since 17:44 on the losing block of a
  same-slot fork at 122 751 625 (bug 124 in VALIDATION_STATUS.md): the peer that fed it was on
  the losing side, the network's RollBackward to the common ancestor was deferred "until its next
  headers show a fork", and the deferred rollback was then **cancelled** because the winning
  header sat in `pendingHeaders` (accepted, never applied) and counted as "our chain". The range
  check kept refusing the winner, the ChainSync restarted from our tip, and the cycle held for
  five hours. The producer, whose primary is the relay cardano-node, carried the winner and held
  the loser as a fork candidate — unaffected.
- Fixes (consensus, both store modes): "ours" in the deferred-rollback check means *applied*;
  a failed range clears `pendingHeaders`. Primary-mode side: block existence / already-applied
  means *on the selected chain* (dead-fork blocks stay in the volatile files until GC), the
  applied-tip hashes are the selected tip only, a rollback lands on the block the peer named.
- 3036 recovered with a fresh ledger database: `import-utxo` + `import-state` from the snapshot's
  `ledger/122735066`, chunks trimmed to the state slot, tip pinned, relaunched in primary mode.
  Its previous ledger database is kept as `preview.db.bak-fork-20260914`.
- A second landmine defused in the same hour: with primary now the default, a node whose store
  cannot resolve the ledger's tip fell back to mirror mode using a *routed* helper to decide
  whether SQLite had blocks — on a fresh database that answered from the store, the node
  started syncing from genesis onto an empty ledger. The check now reads the SQLite table
  itself; on a fresh database the node refuses to start.
- **Producer decision**: it stays on `blockStoreMode: "mirror"` / `relayStore: "sqlite"`
  (now explicit in its config) and is **not relaunched** before the 2026-09-15 leader slots
  (06:49 and 21:40 UTC). It has run unchanged since 17:09, its chunk store is byte-identical to
  the relay's, and the fork it saw today was handled. The switch to primary and the block-table
  cleanup follow after the slots, once 3036 has soaked overnight on the fixed code.

#### 01:05 UTC 2026-09-15: bug 124 closed on 3036

The second same-slot fork (122 776 947, 00:42 UTC) stalled 3036 again on the "fixed" code and gave
the real cause: `rollbackOurChainTo` counts the blocks above the fork point with
`countBlocksAfterSlot`, a `blocks`-table query that was still unrouted — 0 on the frozen table, so
the rollback returned early ("0 block(s) behind our tip"). `countBlocksAfterSlot` and `blockAtSlot`
are routed now. Relaunched at 01:05:16 with the dead block as its tip, the node rolled it back on
its own within three seconds ("1 block(s) behind our tip … fork confirmed … 36 deltas deleted,
journal undone") and was at the network tip 30 s later. Every `FROM blocks` read in `db.ts` is now
routed, guarded, or harmless on an empty table (checked line by line).
