#!/usr/bin/env bun
/**
 * Bug 246: compare the governance state a dual-mode rebuild would derive from a node's SQLite
 * ledger with the node's LMDB governance state, database by database. Read-only: the node's SQLite
 * is opened read-only and its governance tables copied to a scratch file (the seed reads through
 * the process' SQL client, which must never point at the node's file), the LMDB store read-only.
 *
 *   bun scripts/gov-store-compare.ts --node <node dir> [--network preview] [--stake-epochs 2] [--verbose]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node"), network = opt("network", "preview")!, verbose = argv.includes("--verbose");
if (!node) { console.error("usage: bun scripts/gov-store-compare.ts --node <node dir> [--network preview] [--stake-epochs N] [--verbose]"); process.exit(2); }
const scratch = `/tmp/gov-store-compare-${process.pid}.db`;
process.env.GEROLAMO_DB_PATH = scratch;
const { attachReadOnlyLedgerStore, getLedgerStore, seedGovFromSqlite } = await import("../src/ledger/nodeLedgerStore");
const { LedgerStore } = await import("../src/ledger/LedgerStore");
const { GDB, GovReads, GovWrites } = await import("../src/ledger/govStore");
const { initSql } = await import("../src/sql");
const { setEpochNetwork, epochForSlot } = await import("../src/utils/epochFromSlotCalculations");
const { logger, LogLevel } = await import("../src/utils/logger");
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);

// ── the node's LMDB, read-only
const store = attachReadOnlyLedgerStore({ dbPath: join(node, `${network}.db`), ledgerDir: join(node, "ledger"), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
if (!store) { console.error("no LMDB ledger store under the node directory"); process.exit(1); }
const lmdb = new GovReads(store);
const tipEpoch = store.anchor() ? Number(epochForSlot(store.anchor()!.slot)) : 0;
const stakeEpochs = Number(opt("stake-epochs", "2"));

// ── the node's SQLite governance tables, read-only, copied to the scratch file
const src = new Database(join(node, `${network}.db`), { readonly: true });
const dst = new Database(scratch);
const tables = ["gov_dreps", "gov_drep_delegations", "gov_committee", "gov_committee_auth", "gov_state", "gov_proposals", "gov_votes", "gov_enacted", "epoch_params", "pparam_proposals", "epoch_nonces", "gov_pulser_snapshot", "gov_drep_boot_delegs", "schema_migrations"];
let copied = 0;
const t0 = performance.now();
dst.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF");
for (const t of [...tables, "epoch_drep_stake"]) {
    const ddl = src.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as { sql: string } | null;
    if (!ddl) continue;
    dst.exec(ddl.sql);
    const where = t === "epoch_drep_stake" ? ` WHERE taken_at >= ${tipEpoch - stakeEpochs}` : "";
    const cols = (src.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    const ins = dst.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    dst.exec("BEGIN");
    for (const row of src.query(`SELECT ${cols.join(", ")} FROM ${t}${where}`).values() as unknown[][]) { ins.run(...(row as any[])); copied++; }
    dst.exec("COMMIT");
}
src.close(); dst.close();
console.log(`gov-store-compare ${node}: ${copied} SQLite row(s) copied read-only (${((performance.now() - t0) / 1000).toFixed(1)} s); DRep stake epochs ≥ ${tipEpoch - stakeEpochs}`);

// ── seed a scratch LMDB from the copy, as rebuildFromSqlite does
initSql(scratch);
const seedDir = `${scratch}-ledger`;
if (existsSync(seedDir)) rmSync(seedDir, { recursive: true, force: true });
const fresh = LedgerStore.open(seedDir);
await seedGovFromSqlite(fresh, new GovWrites(fresh));
const derived = new GovReads(fresh);

// ── compare database by database (keys and values)
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const dumpDb = (st: InstanceType<typeof LedgerStore>, db: string, keep: (k: Uint8Array) => boolean = () => true) => { const m = new Map<string, string>(); for (const [k, v] of st.range(db, new Uint8Array(0))) if (keep(k)) m.set(hex(k), hex(v)); return m; };
let differing = 0;
for (const db of Object.values(GDB)) {
    const keep = db === GDB.drepStake ? (k: Uint8Array) => new DataView(k.buffer, k.byteOffset).getUint32(0, false) >= tipEpoch - stakeEpochs : () => true;
    const a = dumpDb(store, db, keep), b = dumpDb(fresh, db, keep);
    const onlyLmdb = [...a.keys()].filter((k) => !b.has(k)), onlyDerived = [...b.keys()].filter((k) => !a.has(k)), changed = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k));
    const n = onlyLmdb.length + onlyDerived.length + changed.length;
    differing += n;
    console.log(`  ${db.padEnd(24)} lmdb ${String(a.size).padStart(7)}  sqlite-derived ${String(b.size).padStart(7)}  ${n ? `DIFFER: ${onlyLmdb.length} only in lmdb, ${onlyDerived.length} only sqlite-derived, ${changed.length} changed` : "equal"}`);
    const show = (label: string, ks: string[], from: Map<string, string>) => { for (const k of ks.slice(0, verbose ? 20 : 3)) console.log(`      ${label} ${k.slice(0, 40)}… = ${Buffer.from(from.get(k)!, "hex").toString("latin1").replace(/[^\x20-\x7e]/g, ".").slice(0, 100)}`); };
    show("only lmdb", onlyLmdb, a); show("only derived", onlyDerived, b);
    for (const k of changed.slice(0, verbose ? 20 : 3)) console.log(`      changed ${k.slice(0, 40)}…: lmdb ${Buffer.from(a.get(k)!, "hex").toString("latin1").replace(/[^\x20-\x7e]/g, ".").slice(0, 90)} | derived ${Buffer.from(b.get(k)!, "hex").toString("latin1").replace(/[^\x20-\x7e]/g, ".").slice(0, 90)}`);
}
console.log(`state: lmdb credSchema ${lmdb.state()?.credSchema ?? "-"}, derived ${derived.state()?.credSchema ?? "-"}; pulser epochs lmdb [${lmdb.pulserEpochs()}] derived [${derived.pulserEpochs()}]`);
console.log(differing ? `${differing} key(s) differ between the LMDB state and the SQLite-derived state` : "the SQLite-derived governance state equals the LMDB state");
fresh.close(); getLedgerStore()?.close();
rmSync(seedDir, { recursive: true, force: true }); for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) if (existsSync(f)) rmSync(f);
process.exit(0);
