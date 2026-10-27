/**
 * Explorer indexer worker: owns the mini-Blockfrost projection (mb_* tables) in its own
 * SQLite file so the applier's main thread no longer writes it (option A of the 2026-09-06
 * plan: those writes were half of the remaining main-thread SQL). Messages arrive in ledger
 * order — transaction deltas per block and rollbacks — and are applied in order. A one-time
 * background copy migrates the mb_* rows of the ledger database (chunked, interleaved with
 * live messages), then repairs the spent marks of outputs that were spent during the copy.
 */
import { receiveSettings } from "../../config/settings";
import { Database } from "bun:sqlite";
import { applyMbBlock, applyMbTx, rollbackMbToSlot, type MbBlockMsg, type MbTxDelta } from "./writer";
import { ensureMinibfOutIndexes, ensureMinibfSchema } from "./schema";
import { sqliteClient as client } from "./sqliteClient";

declare const self: Worker;

type Msg =
    | { t: "init"; path: string; mainDbPath: string | null }
    | { t: "apply"; seq: number; items: Array<MbTxDelta | MbBlockMsg> }
    | { t: "rollback"; seq: number; slot: number }
    | { t: "flush"; seq: number }
    | { t: "pace"; busy: boolean }
    | { t: "stop" };

let db: Database | null = null;
const queue: Msg[] = [];
let wake: (() => void) | null = null;
let migrating: { src: string; tables: string[]; ti: number; rowid: number; max: number; switchSlot: number } | null = null;
let tipSlot = 0;
/** Set by the main thread while the node bulk-syncs: the history copy waits (it competes for disk with the applier). */
let paused = false;
/** The credential indexes over mb_tx_out are built once, after `ready` (a table scan on a populated file). */
let outIndexesPending = true;
const MB_TABLES = ["mb_tx", "mb_block_tx", "mb_tx_in", "mb_tx_out", "mb_address_tx"];
const COPY_CHUNK = 20_000;

function post(m: Record<string, unknown>): void { self.postMessage(m); }
function log(level: "info" | "warn" | "error", message: string): void { post({ t: "log", level, message }); }

async function init(path: string, mainDbPath: string | null): Promise<void> {
    db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -65536");
    db.run("PRAGMA busy_timeout = 5000");
    await ensureMinibfSchema(client(db), { deferOutIndexes: true });
    db.run("CREATE TABLE IF NOT EXISTS mb_meta (key TEXT PRIMARY KEY, value TEXT)");
    const tip = db.query("SELECT tip_slot FROM mb_cursor WHERE id = 1").get() as any;
    tipSlot = Number(tip?.tip_slot ?? 0);
    const migrated = db.query("SELECT value FROM mb_meta WHERE key = 'migrated_from'").get() as any;
    if (mainDbPath && !migrated) {
        try {
            db.run(`ATTACH DATABASE ? AS src`, [mainDbPath]);
            const has = db.query("SELECT name FROM src.sqlite_master WHERE type = 'table' AND name = 'mb_tx'").get();
            if (has) {
                const saved = db.query("SELECT value FROM mb_meta WHERE key = 'migrate_pos'").get() as any;
                const pos = saved ? JSON.parse(String(saved.value)) as { ti: number; rowid: number; switchSlot: number } : null;
                const ti = pos ? Math.min(pos.ti, MB_TABLES.length) : 0;
                migrating = { src: mainDbPath, tables: MB_TABLES, ti, rowid: pos?.rowid ?? 0, max: MB_TABLES[ti] ? maxRowid(MB_TABLES[ti]!) : 0, switchSlot: pos?.switchSlot ?? tipSlot };
                log("info", `explorer: migrating mb_* tables from ${mainDbPath} in the background (${MB_TABLES.join(", ")})`);
            } else {
                db.run("DETACH DATABASE src");
                db.run("INSERT OR REPLACE INTO mb_meta (key, value) VALUES ('migrated_from', ?)", ["none"]);
            }
        } catch (err) {
            log("warn", `explorer: could not attach ${mainDbPath} for migration: ${err instanceof Error ? err.message : String(err)}`);
            migrating = null;
        }
    }
    post({ t: "ready", tipSlot, migrating: !!migrating });
}

function maxRowid(table: string): number {
    const r = db!.query(`SELECT COALESCE(MAX(rowid), 0) AS m FROM src.${table}`).get() as any;
    return Number(r?.m ?? 0);
}

function commonColumns(table: string): string[] {
    const cols = (t: string) => (db!.query(`PRAGMA ${t}.table_info(${table})`).all() as any[]).map((c) => String(c.name));
    const mine = new Set((db!.query(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)));
    return cols("src").filter((c) => mine.has(c));
}

/** Copy one chunk of the current table; returns true while migration continues. */
function migrateStep(): boolean {
    const m = migrating;
    if (!m || !db) return false;
    const table = m.tables[m.ti];
    if (!table) {
        // all tables copied: outputs spent by transactions applied since the switch had no row to mark
        const t0 = performance.now();
        const fixed = db.run(`UPDATE mb_tx_out SET spent_by_tx = i.tx_hash, spent_at_slot = t.slot
            FROM mb_tx_in i JOIN mb_tx t ON t.tx_hash = i.tx_hash
            WHERE mb_tx_out.tx_hash = i.prev_tx_hash AND mb_tx_out.output_index = i.prev_output_index
              AND mb_tx_out.spent_by_tx IS NULL AND t.slot >= ?`, [Math.max(0, m.switchSlot - 1000)]);
        db.run("DETACH DATABASE src");
        db.run("INSERT OR REPLACE INTO mb_meta (key, value) VALUES ('migrated_from', ?)", [m.src]);
        db.run("DELETE FROM mb_meta WHERE key = 'migrate_pos'");
        log("info", `explorer: migration complete; repaired spent marks for ${fixed.changes} output(s) in ${Math.round(performance.now() - t0)} ms`);
        migrating = null;
        return false;
    }
    if (m.rowid >= m.max) {
        log("info", `explorer: copied ${table} (${m.max} source rows)`);
        m.ti++; m.rowid = 0;
        db.run("INSERT OR REPLACE INTO mb_meta (key, value) VALUES ('migrate_pos', ?)", [JSON.stringify({ ti: m.ti, rowid: 0, switchSlot: m.switchSlot })]);
        m.max = m.tables[m.ti] ? maxRowid(m.tables[m.ti]!) : 0;
        return true;
    }
    const cols = commonColumns(table).join(", ");
    const lo = m.rowid, hi = Math.min(m.max, lo + COPY_CHUNK);
    db.run(`INSERT OR IGNORE INTO ${table} (${cols}) SELECT ${cols} FROM src.${table} WHERE rowid > ? AND rowid <= ?`, [lo, hi]);
    m.rowid = hi;
    db.run("INSERT OR REPLACE INTO mb_meta (key, value) VALUES ('migrate_pos', ?)", [JSON.stringify({ ti: m.ti, rowid: m.rowid, switchSlot: m.switchSlot })]);
    if (hi % (COPY_CHUNK * 50) === 0 || hi === m.max) post({ t: "migrate", table, rowid: hi, max: m.max });
    return true;
}

async function handle(m: Msg): Promise<void> {
    if (!db) return;
    const c = client(db);
    if (m.t === "apply") {
        db.run("BEGIN"); // deferred: IMMEDIATE would also try to reserve the attached ledger database
        try {
            for (const d of m.items) {
                if ((d as MbBlockMsg).kind === "block") await applyMbBlock(c, d as MbBlockMsg);
                else await applyMbTx(c, d as MbTxDelta);
                if (d.slot > tipSlot) tipSlot = d.slot;
            }
            db.run("COMMIT");
        } catch (err) {
            try { db.run("ROLLBACK"); } catch { /* not in a transaction */ }
            log("error", `explorer: apply batch of ${m.items.length} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        post({ t: "ack", seq: m.seq, n: m.items.length, tipSlot });
    } else if (m.t === "rollback") {
        db.run("BEGIN"); // deferred: IMMEDIATE would also try to reserve the attached ledger database
        try {
            await rollbackMbToSlot(c, m.slot);
            db.run("COMMIT");
            if (m.slot < tipSlot) tipSlot = m.slot;
        } catch (err) {
            try { db.run("ROLLBACK"); } catch { /* */ }
            log("error", `explorer: rollback to ${m.slot} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        post({ t: "ack", seq: m.seq, n: 0, tipSlot });
    } else if (m.t === "flush") {
        post({ t: "ack", seq: m.seq, n: 0, tipSlot });
    } else if (m.t === "pace") {
        if (paused !== m.busy) log("info", m.busy ? "explorer: history copy paused while the node bulk-syncs" : "explorer: history copy resumed");
        paused = m.busy;
    }
}

async function loop(): Promise<void> {
    for (;;) {
        while (queue.length) {
            const m = queue.shift()!;
            if (m.t === "stop") { try { db?.run("PRAGMA wal_checkpoint(TRUNCATE)"); db?.close(); } catch { /* */ } post({ t: "stopped" }); return; }
            try {
                if (m.t === "init") { await init(m.path, m.mainDbPath); continue; }
                await handle(m);
            } catch (err) {
                // never let one message kill the loop; the main thread must still get its ack
                log("error", `explorer: ${m.t} failed: ${err instanceof Error ? err.message : String(err)}`);
                try { db?.run("ROLLBACK"); } catch { /* not in a transaction */ }
                if ("seq" in m) post({ t: "ack", seq: m.seq, n: m.t === "apply" ? m.items.length : 0, tipSlot, failed: true });
            }
        }
        if (outIndexesPending && db) {
            outIndexesPending = false;
            try {
                const t0 = performance.now();
                await ensureMinibfOutIndexes(client(db));
                const ms = Math.round(performance.now() - t0);
                if (ms > 1000) log("info", `explorer: built the output credential indexes in ${ms} ms`);
            } catch (err) { log("warn", `explorer: output credential indexes: ${err instanceof Error ? err.message : String(err)}`); }
            continue;
        }
        if (migrating && !paused) {
            try { migrateStep(); } catch (err) { log("error", `explorer: migration step failed: ${err instanceof Error ? err.message : String(err)}`); migrating = null; }
            await new Promise<void>((r) => setTimeout(r, 0)); // let messages in between chunks
            continue;
        }
        // idle, or copy paused: wait for a message (re-check the pause flag every second)
        await new Promise<void>((r) => { wake = r; if (migrating) setTimeout(r, 1000); });
        wake = null;
    }
}

self.onmessage = (ev: MessageEvent<Msg>) => {
    if (receiveSettings(ev.data)) return;
    queue.push(ev.data);
    wake?.();
};
void loop();
