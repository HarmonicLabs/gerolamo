/**
 * Main-thread side of the explorer indexer (see explorerWorker.ts): buffers per-transaction
 * deltas and posts them in ledger order, applies back-pressure when the worker falls far
 * behind, forwards rollbacks, and hands readers a connection to the explorer file.
 * Inactive unless `startExplorerIndexer` ran (tests and scripts keep the inline writer).
 */
import { SQL } from "bun";
import { existsSync } from "node:fs";
import { logger } from "../../utils/logger";
import { sql } from "../../sql";
import type { MbBlockMsg, MbTxDelta } from "./writer";

const BATCH_ITEMS = 64;
const BATCH_MS = 40;
const MAX_OUTSTANDING = 20_000;
/** Above this many transactions per second the node is bulk-syncing: the history copy in the worker waits. */
const BUSY_TX_PER_SEC = 20;

class ExplorerIndexer {
    private worker: Worker | null = null;
    private ready: Promise<void> | null = null;
    private buffer: Array<MbTxDelta | MbBlockMsg> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;
    private outstanding = 0;
    private drainWaiters: Array<() => void> = [];
    private acks = new Map<number, () => void>();
    private reader: SQL | null = null;
    private enqueued = 0;
    private paceTimer: ReturnType<typeof setInterval> | null = null;
    private busy: boolean | null = null;
    path: string | null = null;
    tipSlot = 0;
    migrating = false;
    /** Batches the worker could not apply (logged by the worker); the projection has a gap. */
    failedBatches = 0;

    get active(): boolean { return this.worker != null; }

    start(explorerPath: string, mainDbPath: string | null): Promise<void> {
        if (this.worker) return this.ready!;
        this.path = explorerPath;
        const w = new Worker(new URL("./explorerWorker.ts", import.meta.url).href);
        this.worker = w;
        this.ready = new Promise<void>((resolve) => {
            w.onmessage = (ev: MessageEvent<any>) => {
                const m = ev.data;
                switch (m?.t) {
                    case "ready": this.tipSlot = Number(m.tipSlot ?? 0); this.migrating = !!m.migrating; resolve(); break;
                    case "ack": {
                        if (m.failed) this.failedBatches++;
                        this.outstanding = Math.max(0, this.outstanding - Number(m.n ?? 0));
                        this.tipSlot = Number(m.tipSlot ?? this.tipSlot);
                        const cb = this.acks.get(Number(m.seq)); if (cb) { this.acks.delete(Number(m.seq)); cb(); }
                        if (this.outstanding < MAX_OUTSTANDING / 2) { for (const r of this.drainWaiters) r(); this.drainWaiters = []; }
                        break;
                    }
                    case "migrate": logger.info(`explorer: copying ${m.table} ${m.rowid}/${m.max}`); break;
                    case "log": (logger as any)[m.level ?? "info"](String(m.message)); if (String(m.message).includes("migration complete")) this.migrating = false; break;
                    case "stopped": break;
                }
            };
            w.onerror = (e: any) => {
                logger.error(`explorer worker error: ${e?.message ?? e}`);
                // whatever happened, the applier must not wait on a dead queue
                this.outstanding = 0;
                for (const r of this.drainWaiters) r();
                this.drainWaiters = [];
            };
        });
        w.postMessage({ t: "init", path: explorerPath, mainDbPath });
        // pace the history copy: every 5 s tell the worker whether the node is bulk-syncing
        this.paceTimer = setInterval(() => {
            // hysteresis: busy above the threshold, idle only well below it (no flapping at the edge)
            const rate = this.enqueued / 5;
            const busy = this.busy ? rate > BUSY_TX_PER_SEC / 4 : rate > BUSY_TX_PER_SEC;
            this.enqueued = 0;
            if (busy !== this.busy) { this.busy = busy; this.worker?.postMessage({ t: "pace", busy }); }
        }, 5_000);
        return this.ready;
    }

    /** Queue one transaction's projection; waits only when the worker is far behind. */
    async enqueue(d: MbTxDelta): Promise<void> {
        this.enqueued++;
        this.buffer.push(d);
        if (this.buffer.length >= BATCH_ITEMS) this.post();
        else if (!this.timer) this.timer = setTimeout(() => this.post(), BATCH_MS);
        if (this.outstanding >= MAX_OUTSTANDING) await new Promise<void>((r) => this.drainWaiters.push(r));
    }

    /** Queue a block for the v2 indexes, ordered after its transactions' deltas. */
    async enqueueBlock(m: MbBlockMsg): Promise<void> {
        this.buffer.push(m);
        if (this.buffer.length >= BATCH_ITEMS) this.post();
        else if (!this.timer) this.timer = setTimeout(() => this.post(), BATCH_MS);
        if (this.outstanding >= MAX_OUTSTANDING) await new Promise<void>((r) => this.drainWaiters.push(r));
    }

    private post(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (!this.worker || this.buffer.length === 0) return;
        const items = this.buffer; this.buffer = [];
        this.outstanding += items.length;
        this.worker.postMessage({ t: "apply", seq: ++this.seq, items });
    }

    /** Ordered after everything queued so far. */
    rollback(slot: number): void {
        if (!this.worker) return;
        this.post();
        this.worker.postMessage({ t: "rollback", seq: ++this.seq, slot });
    }

    /** Resolve once everything posted so far is applied (bounded wait). */
    flush(timeoutMs = 10_000): Promise<void> {
        if (!this.worker) return Promise.resolve();
        this.post();
        const seq = ++this.seq;
        return new Promise<void>((resolve) => {
            const t = setTimeout(() => { this.acks.delete(seq); resolve(); }, timeoutMs);
            this.acks.set(seq, () => { clearTimeout(t); resolve(); });
            this.worker!.postMessage({ t: "flush", seq });
        });
    }

    async stop(): Promise<void> {
        if (!this.worker) return;
        await this.flush(15_000);
        const w = this.worker;
        await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5_000);
            const prev = w.onmessage;
            w.onmessage = (ev: MessageEvent<any>) => { if (ev.data?.t === "stopped") { clearTimeout(t); resolve(); } else prev?.call(w, ev); };
            w.postMessage({ t: "stop" });
        });
        w.terminate();
        this.worker = null;
        if (this.paceTimer) { clearInterval(this.paceTimer); this.paceTimer = null; }
        try { this.reader?.close(); } catch { /* */ }
        this.reader = null;
    }

    /** Read connection for the projection: the explorer file when the worker runs, else the ledger DB. */
    readSql(): SQL {
        if (!this.worker || !this.path) return sql;
        if (!this.reader) {
            if (!existsSync(this.path)) return sql;
            this.reader = new SQL({ adapter: "sqlite", filename: this.path, readonly: true } as any);
        }
        return this.reader;
    }
}

export const explorerIndexer = new ExplorerIndexer();

/** `<ledger.db>` → `<ledger>.explorer.db` next to it. */
export function explorerDbPathFor(dbPath: string): string {
    return dbPath.replace(/\.(db|sqlite|sqlite3)$/i, "") + ".explorer.db";
}

/** Start the worker for the node's database (GEROLAMO_EXPLORER_WORKER=0 keeps the inline writer). */
export async function startExplorerIndexer(dbPath: string): Promise<boolean> {
    if (process.env.GEROLAMO_EXPLORER_WORKER === "0" || dbPath === ":memory:") return false;
    const path = explorerDbPathFor(dbPath);
    await explorerIndexer.start(path, dbPath);
    logger.info(`Explorer indexer: mb_* projection in ${path} (worker; tip ${explorerIndexer.tipSlot}${explorerIndexer.migrating ? ", migrating history in the background" : ""})`);
    return true;
}

export function stopExplorerIndexer(): Promise<void> { return explorerIndexer.stop(); }

/** Connection the mini-Blockfrost readers use for mb_* tables. */
export function mbSql(): SQL { return explorerIndexer.readSql(); }
