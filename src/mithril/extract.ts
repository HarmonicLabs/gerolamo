/**
 * `gerolamo extract`: the parse-only extractor of docs/PLAN_SNAPSHOT_BOOTSTRAP.md. Reads the
 * Mithril-certified immutable chunks and writes the explorer / mini-Blockfrost database
 * (mb_* tables) without any ledger rule: blocks, transactions, inputs, outputs, the address
 * index. Chunks are decoded by a pool of workers in any order and written by this thread in
 * one transaction per chunk; a marker per chunk makes the run resumable. Spent marks and the
 * input side of the address index need outputs that may live in a later-decoded chunk, so
 * they are completed by set-based SQL in `finalizeExtract` once every chunk is in.
 */
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";
import { ensureMinibfSchema } from "../db/minibf/schema";
import { sqliteClient } from "../db/minibf/sqliteClient";
import { applyMbTx, type MbTxDelta } from "../db/minibf/writer";
import type { ExtractedBlock } from "./extractDelta";

export interface ExtractOptions {
    immutableDir: string;
    explorerPath: string;
    fromChunk?: number;
    toChunk?: number;
    workers?: number;
    /** Skip the decode pass; only run finalize. */
    finalizeOnly?: boolean;
    /** Skip finalize after the decode pass. */
    noFinalize?: boolean;
    log?: (m: string) => void;
}

export interface ExtractResult {
    chunks: number;
    blocks: number;
    txs: number;
    errors: number;
    finalized: boolean;
    seconds: number;
}

/** Chunk numbers with a complete .chunk/.primary/.secondary trio. */
export function presentChunks(dir: string): number[] {
    const seen = new Map<number, number>();
    for (const f of readdirSync(dir)) {
        const m = /^(\d{5})\.(chunk|primary|secondary)$/.exec(f);
        if (!m) continue;
        const n = Number(m[1]);
        seen.set(n, (seen.get(n) ?? 0) | (m[2] === "chunk" ? 1 : m[2] === "primary" ? 2 : 4));
    }
    return [...seen.entries()].filter(([, bits]) => bits === 7).map(([n]) => n).sort((a, b) => a - b);
}

function toDelta(b: ExtractedBlock, tx: ExtractedBlock["txs"][number]): MbTxDelta {
    const addresses = new Map<string, "in" | "out" | "both">();
    for (const o of tx.outputs) if (o.a && o.a.length >= 10) addresses.set(o.a, "in");
    return {
        txHash: tx.txHash,
        blockHash: b.hash,
        slot: b.slot,
        txIndex: tx.txIndex,
        blockHeight: b.blockNo,
        fee: tx.fee,
        size: tx.size,
        invalidBefore: tx.invalidBefore,
        invalidHereafter: tx.invalidHereafter,
        addresses,
        inputs: tx.inputs.map(([inputIndex, prevTxHash, prevOutputIndex]) => ({ inputIndex, prevTxHash, prevOutputIndex })),
        outputs: tx.outputs.map((o) => ({ outputIndex: o.i, address: o.a, lovelace: o.l, assetsJson: o.j, datumHash: o.d, inlineDatumCbor: o.c, scriptRefHash: o.s })),
    };
}

export async function ensureExtractTables(db: Database): Promise<void> {
    await ensureMinibfSchema(sqliteClient(db));
    db.run(`CREATE TABLE IF NOT EXISTS mb_extract_chunks (
        chunk_no INTEGER PRIMARY KEY,
        blocks INTEGER NOT NULL,
        txs INTEGER NOT NULL,
        first_slot INTEGER,
        last_slot INTEGER,
        done_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
}

/**
 * Complete what the per-chunk pass cannot know: spent marks for outputs consumed in another
 * chunk, the input side of the address index ("out" / "both"), and the cursor.
 */
export function finalizeExtract(db: Database, log: (m: string) => void = () => {}): { spent: number; addressRows: number } {
    const t0 = performance.now();
    db.run("BEGIN");
    const spent = db.run(`
        UPDATE mb_tx_out SET spent_by_tx = s.tx_hash, spent_at_slot = s.slot
        FROM (SELECT i.prev_tx_hash, i.prev_output_index, i.tx_hash, t.slot FROM mb_tx_in i JOIN mb_tx t ON t.tx_hash = i.tx_hash) AS s
        WHERE mb_tx_out.tx_hash = s.prev_tx_hash AND mb_tx_out.output_index = s.prev_output_index
          AND (mb_tx_out.spent_by_tx IS NULL OR mb_tx_out.spent_by_tx <> s.tx_hash)`).changes;
    log(`finalize: ${spent} spent mark(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    const t1 = performance.now();
    const addressRows = db.run(`
        INSERT INTO mb_address_tx (address, tx_hash, slot, tx_index, direction)
        SELECT o.address, i.tx_hash, t.slot, t.tx_index, 'out'
        FROM mb_tx_in i
        JOIN mb_tx_out o ON o.tx_hash = i.prev_tx_hash AND o.output_index = i.prev_output_index
        JOIN mb_tx t ON t.tx_hash = i.tx_hash
        WHERE length(o.address) >= 10
        ON CONFLICT(address, tx_hash) DO UPDATE SET
            direction = CASE WHEN mb_address_tx.direction = 'out' THEN 'out' ELSE 'both' END`).changes;
    log(`finalize: ${addressRows} address row(s) on the input side in ${((performance.now() - t1) / 1000).toFixed(1)}s`);
    db.run(`UPDATE mb_cursor SET tip_slot = COALESCE((SELECT MAX(slot) FROM mb_tx), tip_slot),
        tip_hash = (SELECT block_hash FROM mb_tx ORDER BY slot DESC LIMIT 1), updated_at = strftime('%s','now') WHERE id = 1`);
    db.run("COMMIT");
    return { spent, addressRows };
}

export async function runExtract(opts: ExtractOptions): Promise<ExtractResult> {
    const log = opts.log ?? (() => {});
    const t0 = performance.now();
    const db = new Database(opts.explorerPath, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 10000");
    await ensureExtractTables(db);
    const mb = sqliteClient(db);
    const result: ExtractResult = { chunks: 0, blocks: 0, txs: 0, errors: 0, finalized: false, seconds: 0 };

    if (!opts.finalizeOnly) {
        const done = new Set<number>((db.query("SELECT chunk_no FROM mb_extract_chunks").all() as any[]).map((r) => Number(r.chunk_no)));
        const all = presentChunks(opts.immutableDir).filter((n) => (opts.fromChunk == null || n >= opts.fromChunk) && (opts.toChunk == null || n <= opts.toChunk));
        const pending = all.filter((n) => !done.has(n));
        const nWorkers = Math.max(1, Math.min(opts.workers ?? Math.max(1, cpus().length - 2), pending.length || 1));
        log(`extract: ${pending.length} chunk(s) to decode of ${all.length} present (${done.size} done), ${nWorkers} worker(s) → ${opts.explorerPath}`);
        const write = (chunkNo: number, blocks: ExtractedBlock[]): { blocks: number; txs: number } => {
            let txs = 0;
            db.run("BEGIN");
            try {
                for (const b of blocks) for (const tx of b.txs) { void applyMbTx(mb, toDelta(b, tx)); txs++; }
                const first = blocks.length ? blocks[0]!.slot : null, last = blocks.length ? blocks[blocks.length - 1]!.slot : null;
                db.query("INSERT OR REPLACE INTO mb_extract_chunks (chunk_no, blocks, txs, first_slot, last_slot) VALUES (?, ?, ?, ?, ?)").run(chunkNo, blocks.length, txs, first, last);
                db.run("COMMIT");
            } catch (err) {
                db.run("ROLLBACK");
                throw err;
            }
            return { blocks: blocks.length, txs };
        };
        await new Promise<void>((resolve, reject) => {
            let next = 0, inFlight = 0, failed: Error | null = null;
            const queue: Array<{ chunkNo: number; blocks: ExtractedBlock[]; errors: number }> = [];
            let writing = false;
            const workers: Worker[] = [];
            const drain = () => {
                if (writing) return;
                writing = true;
                try {
                    while (queue.length) {
                        const item = queue.shift()!;
                        const w = write(item.chunkNo, item.blocks);
                        result.chunks++; result.blocks += w.blocks; result.txs += w.txs; result.errors += item.errors;
                        if (result.chunks % 100 === 0 || result.chunks === pending.length) {
                            const s = (performance.now() - t0) / 1000;
                            log(`extract: ${result.chunks}/${pending.length} chunks, ${result.blocks} blocks, ${result.txs} txs, ${result.errors} error(s), ${(result.blocks / s).toFixed(0)} blocks/s`);
                        }
                    }
                } catch (err) { failed = err as Error; }
                writing = false;
                if (failed) { for (const w of workers) w.terminate(); reject(failed); return; }
                if (next >= pending.length && inFlight === 0) { for (const w of workers) w.terminate(); resolve(); }
            };
            const feed = (w: Worker) => {
                if (failed || next >= pending.length) return;
                inFlight++;
                w.postMessage({ t: "chunk", dir: opts.immutableDir, chunkNo: pending[next++] });
            };
            if (pending.length === 0) { resolve(); return; }
            for (let i = 0; i < nWorkers; i++) {
                const w = new Worker(new URL("./extractWorker.ts", import.meta.url).href);
                workers.push(w);
                w.onmessage = (ev: MessageEvent<any>) => {
                    inFlight--;
                    const m = ev.data;
                    if (m.t === "error") { failed = new Error(`chunk ${m.chunkNo}: ${m.message}`); }
                    else queue.push({ chunkNo: m.chunkNo, blocks: m.blocks, errors: m.errors });
                    feed(w);
                    drain();
                };
                w.onerror = (e: any) => { failed = new Error(String(e?.message ?? e)); drain(); };
                feed(w);
            }
        });
    }
    if (!opts.noFinalize) {
        finalizeExtract(db, log);
        result.finalized = true;
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    result.seconds = (performance.now() - t0) / 1000;
    return result;
}
