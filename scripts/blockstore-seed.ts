/**
 * Seed a node's cardano-node-format block store from an existing immutable directory (a Mithril
 * snapshot or another node's db), then fill the volatile set from the node's SQLite `blocks`
 * table and promote k deep (docs/PLAN_CHUNK_STORE.md phase 3).
 *
 *   bun scripts/blockstore-seed.ts --src <immutable dir> --dst <block store dir> --db <sqlite file> [--k 432]
 *
 * Complete chunks (every chunk but the source's last) are hardlinked — cardano-node never
 * rewrites a complete chunk, so sharing the inode is safe; the open (last) chunk's three files
 * are copied. The SQLite file is opened read-only, so this can run beside a running node; the
 * node itself repeats the catch-up on its next start.
 */
import { join } from "node:path";
import { BlockStore } from "../src/storage/blockStore";
import { seedImmutableDir } from "../src/storage/seed";

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const src = opt("src"), dst = opt("dst"), db = opt("db");
const k = Number(opt("k") ?? 432);
if (!src || !dst || !db) {
    console.error("usage: bun scripts/blockstore-seed.ts --src <immutable dir> --dst <block store dir> --db <sqlite file> [--k 432]");
    process.exit(2);
}
const { initSettings } = await import("../src/config/settings");
initSettings({ dbPath: db }); // src/sql opens settings().dbPath on first use
const { closeSql, withReadOnlyConnection } = await import("../src/sql");
const { catchUpFromSqlite } = await import("../src/storage/nodeBlockStore");

const t0 = performance.now();
const seeded = await seedImmutableDir(src, join(dst, "immutable"));
console.log(`immutable: ${seeded.chunks} chunks (last ${seeded.last}); ${seeded.linked} files hardlinked, ${seeded.copied} copied (open chunk), ${seeded.skipped} already present, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const store = await BlockStore.open(dst, { k });
const imm = await store.immutableTip();
console.log(`chunk store tip: ${imm ? `slot ${imm.slot}` : "none"}; volatile ${store.volatile.size} block(s); hash index built`);
const r = await withReadOnlyConnection(() => catchUpFromSqlite(store, k)); // reads on the read-only connection: safe beside a running node
console.log(`catch-up from ${db}: ${r.copied} block(s) copied into volatile, ${r.promoted} promoted, SQLite tip slot ${r.tipSlot}`);
const after = await store.immutableTip();
console.log(`done: immutable tip slot ${after?.slot}, volatile ${store.volatile.size} block(s)`);
await closeSql();
process.exit(0);
