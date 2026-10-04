#!/usr/bin/env bun
/**
 * Serve a block store over node-to-node (ChainSync + BlockFetch) on localhost — a local
 * relay for a Mithril-certified chain, so a fresh node replays history under full validation at
 * local speed without depending on public peers. Two sources:
 *
 *   --db <chain.db>          a SQLite `blocks` table (fill it with
 *                            `bun src/index.ts mithril-bootstrap --network preview --blocks-only --db <chain.db> --download-dir <dir>`)
 *   --block-store <dir>      a cardano-node-format block store (`<dir>/immutable/NNNNN.{chunk,primary,secondary}`,
 *                            optional `volatile/`), e.g. a node's `db/` directory or a copy of a range of its chunks.
 *                            Opened READ-ONLY (never writes into it: a running node's store is safe to serve); block
 *                            lookups by hash use `<dir>/gerolamo/hash-index.bin` when present. `--index` builds that
 *                            index first — only for a copy (it writes `<dir>/gerolamo/` and repairs the chunk tail).
 *
 *   bun scripts/serve-chain.ts --db <chain.db> --network preview [--port 3101] [--host 127.0.0.1]
 *   bun scripts/serve-chain.ts --block-store <dir> --network preview [--index] [--port 3101]
 */
import { initSql, closeSql, sql } from "../src/sql";
import { getMaxSlot } from "../src/db";
import { startN2NServer } from "../src/network/n2n/N2NServer";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import type { RelayChainStore } from "../src/network/n2n/RelayChainStore";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : []).filter((x) => x.length));
if (!args.db && !args["block-store"]) { console.error("usage: (--db <chain.db> | --block-store <dir> [--index]) --network <preview|preprod|mainnet> [--port 3101] [--host 127.0.0.1]"); process.exit(2); }
const net = args.network ?? "preview";
const magic = net === "mainnet" ? 764824073 : net === "preprod" ? 1 : 2;
setEpochNetwork(net);
const t0 = Date.now();
const step = (m: string) => console.log(`serve-chain: ${m} (+${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let store: RelayChainStore | undefined;
let source: string, tip: bigint;
if (args["block-store"]) {
    const { BlockStore } = await import("../src/storage/blockStore");
    const { ChunkRelayChainStore } = await import("../src/network/n2n/ChunkRelayChainStore");
    const dir = String(args["block-store"]);
    const k = Number(args.k ?? (net === "mainnet" ? 2160 : 432));
    if (args.index) { const w = await BlockStore.open(dir, { k }); await w.chunks.openHashIndex(); step(`hash index built for ${dir}`); }
    const bs = await BlockStore.open(dir, { k, readOnly: true });
    const imm = await bs.immutableTip();
    tip = BigInt(imm?.slot ?? 0);
    store = new ChunkRelayChainStore(bs);
    source = `${net} block store ${dir} (${bs.chunks.chunks().length} chunk(s), read-only)`;
} else {
    initSql(String(args.db));
    step("sql opened");
    // No ensureInitialized() here: on a store with millions of blocks it runs the once-per-database
    // ledger repairs (certificate history scans) that mean nothing for a block store and take minutes.
    // The bootstrap created the schema; we only read `blocks` / `volatile_headers` / `immutable_blocks`.
    const hasBlocks = ((await sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blocks'`.values()) as unknown[][]).length > 0;
    if (!hasBlocks) { console.error(`serve-chain: ${args.db} has no blocks table — fill it with mithril-bootstrap --blocks-only first`); process.exit(2); }
    tip = await getMaxSlot();
    source = `${net} block store ${args.db}`;
}
step(`tip slot ${tip}`);
const handle = await startN2NServer({
    host: args.host ?? "127.0.0.1",
    port: Number(args.port ?? 3101),
    networkMagic: magic,
    maxConnections: 8,
    maxRangeBlocks: 500,
    idleTimeoutMs: 600_000,
    store,
});
console.log(`serve-chain: ${source} (tip slot ${tip}) on ${handle.host}:${handle.port}`);
const stop = async () => { console.log("serve-chain: stopping"); await handle.stop(); if (args.db) await closeSql(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => console.log(`serve-chain: ${handle.clientCount()} client(s)`), 300_000);
