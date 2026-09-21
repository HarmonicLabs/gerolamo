/**
 * Phase 5 migration tool (docs/PLAN_CHUNK_STORE.md): export an existing node's SQLite `blocks`
 * table into a cardano-node-format block store, so a node built before the chunk store (or one
 * without a snapshot directory to seed from) gets its history as chunk files.
 *
 *   bun scripts/blocks-to-chunks.ts --db <sqlite file> --dst <block store dir> [--k 432] [--from <slot>]
 *
 * Reads through the read-only SQLite connection (safe beside a running node), appends every
 * valid block in slot order after the store's current tip, and leaves the last k blocks in the
 * volatile set. Re-runnable: it resumes from the store's tip.
 */
import { BlockStore } from "../src/storage/blockStore";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const db = opt("db"), dst = opt("dst");
const k = Number(opt("k") ?? 432);
if (!db || !dst) { console.error("usage: bun scripts/blocks-to-chunks.ts --db <sqlite> --dst <block store dir> [--k 432] [--from <slot>]"); process.exit(2); }
process.env.GEROLAMO_DB_PATH = db;
const { sql, closeSql, withReadOnlyConnection } = await import("../src/sql");

const store = await BlockStore.open(dst, { k });
const imm = await store.immutableTip();
let cursor = Math.max(Number(opt("from") ?? -1), imm ? imm.slot : -1);
console.log(`store ${dst}: immutable tip ${imm ? `slot ${imm.slot}` : "none"}; exporting SQLite blocks above slot ${cursor}`);
const t0 = performance.now();
let n = 0, lastHash: Uint8Array | null = null;
await withReadOnlyConnection(async () => {
    for (;;) {
        const rows = (await sql`SELECT slot, hash, block_data FROM blocks WHERE slot > ${cursor} AND is_valid = TRUE ORDER BY slot ASC LIMIT 2000`.values()) as unknown[][];
        if (!rows.length) break;
        for (const r of rows) {
            cursor = Number(r[0]);
            const hashHex = String(r[1]).toLowerCase();
            const bytes = r[2] instanceof Uint8Array ? r[2] : null;
            if (!bytes || !/^[0-9a-f]{64}$/.test(hashHex)) continue;
            const hash = Uint8Array.from(Buffer.from(hashHex, "hex"));
            if (!store.volatile.has(hash)) await store.put(bytes, hash);
            lastHash = hash;
            n++;
        }
        // promote as we go so the volatile files stay small
        if (lastHash) await store.promote(lastHash, k);
        if (n % 20000 < 2000) console.log(`  ${n} blocks, slot ${cursor}, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
});
if (lastHash) await store.promote(lastHash, k);
const tip = await store.immutableTip();
console.log(`done: ${n} blocks exported in ${((performance.now() - t0) / 1000).toFixed(0)} s; immutable tip slot ${tip?.slot}, ${store.volatile.size} volatile`);
await closeSql();
process.exit(0);
