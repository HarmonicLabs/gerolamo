#!/usr/bin/env bun
/**
 * Serve a block store over node-to-node (ChainSync + BlockFetch) on localhost — a local
 * relay for a Mithril-certified chain. Pair with
 *   bun src/index.ts mithril-bootstrap --network preview --blocks-only --db <chain.db> --download-dir <dir>
 * which fills `blocks` with the certified chain without touching the ledger; a fresh node whose
 * topology lists this server as a local root then replays it under full validation, at local
 * speed and without depending on public peers for history.
 *
 *   bun scripts/serve-chain.ts --db <chain.db> --network preview [--port 3101] [--host 127.0.0.1]
 */
import { initSql, closeSql, sql } from "../src/sql";
import { getMaxSlot } from "../src/db";
import { startN2NServer } from "../src/network/n2n/N2NServer";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : []).filter((x) => x.length));
if (!args.db) { console.error("usage: --db <chain.db> --network <preview|preprod|mainnet> [--port 3101] [--host 127.0.0.1]"); process.exit(2); }
const net = args.network ?? "preview";
const magic = net === "mainnet" ? 764824073 : net === "preprod" ? 1 : 2;
setEpochNetwork(net);
const t0 = Date.now();
const step = (m: string) => console.log(`serve-chain: ${m} (+${((Date.now() - t0) / 1000).toFixed(1)} s)`);
initSql(args.db);
step("sql opened");
// No ensureInitialized() here: on a store with millions of blocks it runs the once-per-database
// ledger repairs (certificate history scans) that mean nothing for a block store and take minutes.
// The bootstrap created the schema; we only read `blocks` / `volatile_headers` / `immutable_blocks`.
const hasBlocks = ((await sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blocks'`.values()) as unknown[][]).length > 0;
if (!hasBlocks) { console.error(`serve-chain: ${args.db} has no blocks table — fill it with mithril-bootstrap --blocks-only first`); process.exit(2); }
const tip = await getMaxSlot();
step(`tip slot ${tip}`);
const handle = await startN2NServer({
    host: args.host ?? "127.0.0.1",
    port: Number(args.port ?? 3101),
    networkMagic: magic,
    maxConnections: 8,
    maxRangeBlocks: 500,
    idleTimeoutMs: 600_000,
});
console.log(`serve-chain: ${net} block store ${args.db} (tip slot ${tip}) on ${handle.host}:${handle.port}`);
const stop = async () => { console.log("serve-chain: stopping"); await handle.stop(); await closeSql(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => console.log(`serve-chain: ${handle.clientCount()} client(s)`), 300_000);
