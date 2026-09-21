/**
 * Phase 5 (docs/PLAN_CHUNK_STORE.md): empty the frozen SQLite block tables of a node that runs the
 * block store as primary, then VACUUM. Run with the node STOPPED (it refuses while the port is bound).
 *
 *   bun scripts/blocks-table-cleanup.ts --db <sqlite> --store <nodeDir>/db --port <node port> [--k 432] [--no-vacuum]
 *
 * Safety checks before deleting anything: the ledger journal's newest block and the `blocks`
 * table's newest row must both be in the block store, and the store's selected tip (persisted)
 * must be at or above the SQLite tip. The tables stay (legacy readers see them empty); only rows go.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BlockStore } from "../src/storage/blockStore";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const db = opt("db"), storeDir = opt("store"), port = opt("port");
const k = Number(opt("k") ?? 432);
if (!db || !storeDir || !port) { console.error("usage: bun scripts/blocks-table-cleanup.ts --db <sqlite> --store <nodeDir>/db --port <port> [--k 432] [--no-vacuum]"); process.exit(2); }
const bound = Bun.spawnSync(["ss", "-ltn"]).stdout.toString().split("\n").some((l) => l.includes(`:${port} `));
if (bound) { console.error(`port ${port} is bound: stop the node first`); process.exit(1); }
if (!existsSync(db)) { console.error(`no such database ${db}`); process.exit(1); }

const store = await BlockStore.open(storeDir, { k });
const imm = await store.immutableTip();
const tipFile = join(storeDir, "gerolamo", "selected-tip.hex");
const selected = existsSync(tipFile) ? (await Bun.file(tipFile).text()).trim() : null;
const sel = selected ? await store.byHash(Uint8Array.from(Buffer.from(selected, "hex"))) : null;
console.log(`store: immutable tip ${imm?.slot ?? "none"}, ${store.volatile.size} volatile, selected tip ${sel ? `slot ${sel.slot}` : "none"}`);

const sq = new Database(db);
const counts = sq.query("SELECT (SELECT COUNT(*) FROM blocks) AS b, (SELECT COUNT(*) FROM volatile_headers) AS h").get() as { b: number; h: number };
const sqTip = sq.query("SELECT slot, hash FROM blocks WHERE is_valid = TRUE ORDER BY slot DESC LIMIT 1").get() as { slot: number; hash: string } | null;
const journal = sq.query("SELECT block_hash FROM ledger_journal ORDER BY id DESC LIMIT 1").get() as { block_hash: Uint8Array | string } | null;
console.log(`sqlite: ${counts.b} blocks rows, ${counts.h} header rows, newest block ${sqTip ? `slot ${sqTip.slot}` : "none"}`);
const problems: string[] = [];
if (sqTip) {
    const b = await store.byHash(Uint8Array.from(Buffer.from(String(sqTip.hash), "hex")));
    if (!b) problems.push(`sqlite newest block ${String(sqTip.hash).slice(0, 16)}… (slot ${sqTip.slot}) is not in the store`);
    if (sel && sel.slot < sqTip.slot) problems.push(`store selected tip (slot ${sel.slot}) is below the sqlite tip (slot ${sqTip.slot})`);
}
if (journal) {
    const raw = journal.block_hash;
    const hex = raw instanceof Uint8Array ? Buffer.from(raw).toString("hex") : String(raw);
    const b = await store.byHash(Uint8Array.from(Buffer.from(hex, "hex")));
    if (!b) problems.push(`ledger journal's newest block ${hex.slice(0, 16)}… is not in the store`);
    else console.log(`ledger journal newest block: slot ${b.slot} (in the store)`);
}
if (!sel) problems.push("no persisted selected tip (gerolamo/selected-tip.hex): the node has not run in primary mode on this store yet");
if (problems.length) { console.error("REFUSING:\n  " + problems.join("\n  ")); sq.close(); process.exit(1); }

const t0 = performance.now();
sq.exec("BEGIN");
const b = sq.query("DELETE FROM blocks").run();
const h = sq.query("DELETE FROM volatile_headers").run();
sq.exec("DELETE FROM immutable_blocks"); sq.exec("DELETE FROM immutable_chunks");
sq.exec("COMMIT");
console.log(`deleted ${b.changes} blocks rows and ${h.changes} header rows in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (!argv.includes("--no-vacuum")) {
    const before = Bun.file(db).size;
    const t1 = performance.now();
    sq.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sq.exec("VACUUM");
    console.log(`VACUUM: ${(before / 1e9).toFixed(1)} GB → ${(Bun.file(db).size / 1e9).toFixed(1)} GB in ${((performance.now() - t1) / 60000).toFixed(1)} min`);
}
sq.close();
process.exit(0);
