/**
 * Gap-fill applier — parses already-downloaded immutable chunks into the
 * Gerolamo DB while the Mithril download keeps running.
 *
 * Safety:
 *   - PID lockfile (.apply.lock) prevents two appliers from writing the
 *     same snapshot/DB concurrently. Two concurrent writers is exactly how
 *     "database is locked" + phantom progress (lastApplied advancing with
 *     zero blocks written) happened. Stale locks (dead PID) are taken over.
 *   - Single writer on the DB (download process never touches SQLite).
 *   - Applies only complete trios at least MARGIN chunks behind the
 *     download frontier (never reads a chunk mid-extract).
 *   - Idempotent: blocks INSERT OR IGNORE; utxo INSERT OR REPLACE; MiniBF
 *     ON CONFLICT DO UPDATE — partially applied chunks re-apply cleanly.
 *   - Progress advances ONLY for chunks that applied at least one block.
 *     A chunk with errors and ZERO applied blocks halts the run (exit 2)
 *     without advancing progress — resume retries that chunk.
 *   - Progress state in snapshots/mithril/.apply-state.json (resumable).
 *
 * Usage:
 *   bun scripts/mithril-apply-gapfill.ts                 # apply to frontier-margin
 *   APPLY_LIMIT=2 bun scripts/mithril-apply-gapfill.ts   # smoke: 2 chunks max
 *   GEROLAMO_DB_PATH=./.live/test.db bun scripts/mithril-apply-gapfill.ts
 *
 * Exit codes: 0 ok (limit or frontier reached), 2 halted on all-error chunk,
 *             3 locked by another live applier.
 */
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ensureInitialized } from "../src/db";
import { processChunk } from "../src/state/legacy";
import { initSql, getSqlFilename, sql } from "../src/sql";
import { Logger, LogLevel, logger as globalLogger } from "../src/utils/logger";

const IMM_DIR = resolve(
    process.env.IMMUTABLE_DIR || "./snapshots/mithril/immutable",
);
const SNAP_ROOT = resolve(process.env.SNAPSHOT_DIR || "./snapshots/mithril");
const DB_PATH = resolve(
    process.env.GEROLAMO_DB_PATH || "./.live/test.db",
);
const STATE_PATH = join(SNAP_ROOT, ".apply-state.json");
const LOCK_PATH = join(SNAP_ROOT, ".apply.lock");
/**
 * Chunks closer than MARGIN to the download frontier are not applied yet
 * (never read a chunk mid-extract). MARGIN=0 is valid and means "apply up
 * to and including the frontier" — used by the runner's final sweep after
 * the download has exited. Default 3.
 */
const MARGIN = Math.max(0, parseInt(process.env.MARGIN ?? "3", 10));
const APPLY_LIMIT = process.env.APPLY_LIMIT
    ? parseInt(process.env.APPLY_LIMIT, 10)
    : null;

function pad(n: number): string {
    return n.toString().padStart(5, "0");
}

function trioComplete(n: number): boolean {
    return [".chunk", ".primary", ".secondary"].every((ext) =>
        existsSync(join(IMM_DIR, pad(n) + ext)),
    );
}

function maxCompleteTrio(): number {
    let best = -1;
    for (const name of readdirSync(IMM_DIR)) {
        const m = /^(\d+)\.chunk$/.exec(name);
        if (!m) continue;
        const n = parseInt(m[1]!, 10);
        if (n > best && trioComplete(n)) best = n;
    }
    return best;
}

type ApplyState = { lastApplied: number; partialChunks?: number[] };

function loadState(): ApplyState {
    try {
        const raw = readFileSync(STATE_PATH, "utf8");
        const s = JSON.parse(raw) as ApplyState;
        if (typeof s.lastApplied === "number") return s;
    } catch {
        /* fresh start */
    }
    return { lastApplied: -1 };
}

function saveState(s: ApplyState): void {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Exclusive lockfile (O_EXCL). If the holder PID is dead, take over.
 * Prevents the double-writer incident that produced SQLITE lock storms
 * while lastApplied kept advancing.
 */
function acquireLock(dbPath: string): void {
    mkdirSync(dirname(LOCK_PATH), { recursive: true });
    const payload = JSON.stringify(
        { pid: process.pid, db: dbPath, startedAt: new Date().toISOString() },
        null,
        2,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(LOCK_PATH, payload, { flag: "wx" });
            return;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            let holder: { pid?: number; db?: string } = {};
            try {
                holder = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
            } catch {
                /* corrupt lock — treat as stale */
            }
            if (typeof holder.pid === "number" && pidAlive(holder.pid)) {
                console.log(
                    JSON.stringify({
                        phase: "locked",
                        byPid: holder.pid,
                        db: holder.db ?? "?",
                    }),
                );
                console.log("APPLY_LOCKED_BY_OTHER_PID");
                process.exit(3);
            }
            try {
                rmSync(LOCK_PATH, { force: true });
            } catch {
                /* retry */
            }
        }
    }
    console.log("APPLY_LOCK_ACQUIRE_FAILED");
    process.exit(3);
}

function releaseLock(): void {
    try {
        rmSync(LOCK_PATH, { force: true });
    } catch {
        /* best effort */
    }
}

async function main(): Promise<void> {
    acquireLock(DB_PATH);
    let lockReleased = false;
    const release = (): void => {
        if (!lockReleased) {
            lockReleased = true;
            releaseLock();
        }
    };
    process.on("exit", release);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
            release();
            process.exit(sig === "SIGINT" ? 130 : 143);
        });
    }

    // Quiet apply path: suppress per-tx DEBUG spam from applyBlock/db.
    // Per-block errors still surface via the processChunk WARN logger.
    // Set BEFORE ensureInitialized so schema/init chatter is quiet too.
    globalLogger.setLogLevel(LogLevel.WARN);
    const logger = new Logger({ logLevel: LogLevel.WARN });

    initSql(DB_PATH);
    await ensureInitialized();
    // Defensive: brief tolerance if another writer momentarily holds the DB.
    try {
        await sql`PRAGMA busy_timeout = 10000`;
    } catch {
        /* best effort */
    }

    const frontier = maxCompleteTrio();
    const applyLimit = Math.max(-1, frontier - MARGIN);
    const state = loadState();
    // Total complete trios on disk (0..frontier inclusive when frontier>=0).
    const totalChunks = frontier >= 0 ? frontier + 1 : 0;
    const alreadyDone = Math.max(0, Math.min(state.lastApplied + 1, totalChunks));

    console.log(
        JSON.stringify({
            phase: "start",
            db: getSqlFilename(),
            immDir: IMM_DIR,
            frontierTrio: frontier,
            totalChunks,
            applyLimit,
            margin: MARGIN,
            lastApplied: state.lastApplied,
            chunksDone: alreadyDone,
            chunksLeft: Math.max(0, applyLimit - state.lastApplied),
            applyLimitEnv: APPLY_LIMIT,
            lockPid: process.pid,
        }),
    );

    if (applyLimit < 0) {
        console.log("APPLY_NOTHING (no complete trios yet)");
        return;
    }

    let applied = 0;
    const partialThisRun: number[] = [];
    for (
        let n = state.lastApplied + 1;
        n <= applyLimit;
        n++
    ) {
        if (APPLY_LIMIT !== null && applied >= APPLY_LIMIT) break;
        if (!trioComplete(n)) {
            console.log(
                JSON.stringify({ phase: "gap_halt", at: n }),
            );
            break;
        }
        const t0 = Date.now();
        const result = await processChunk(IMM_DIR, n, logger);
        applied++;

        if (result.applied === 0) {
            // Nothing landed for this chunk — either an environmental
            // failure (database locked / disk full) or corrupt/empty
            // chunk data. Do NOT advance progress: resume retries this
            // chunk; persistent halt needs human triage.
            console.log(
                JSON.stringify({
                    phase: "halt_zero_applied",
                    chunk: n,
                    blocks: result.blocks,
                    applied: result.applied,
                    errors: result.errors,
                    lastAppliedKept: state.lastApplied,
                    chunksDone: Math.max(0, state.lastApplied + 1),
                    chunksLeft: Math.max(0, applyLimit - state.lastApplied),
                    totalChunks,
                }),
            );
            console.log("APPLY_HALTED_ZERO_APPLIED");
            process.exit(2);
        }

        if (result.errors > 0) {
            // Partial chunk (e.g. unparseable Byron EBB header shape):
            // everything parseable applied; record and continue. Re-apply
            // of this chunk stays idempotent.
            partialThisRun.push(n);
        }

        state.lastApplied = n;
        state.partialChunks = Array.from(
            new Set([...(state.partialChunks ?? []), ...partialThisRun]),
        );
        saveState(state);

        const chunksDone = n + 1; // 0-indexed chunks → count completed
        const chunksLeft = Math.max(0, applyLimit - n);
        const pct = totalChunks > 0
            ? Number(((chunksDone / totalChunks) * 100).toFixed(2))
            : 0;
        // One line per chunk: progress first, then optional body stats.
        console.log(
            JSON.stringify({
                phase: "chunk",
                chunk: n,
                chunksDone,
                chunksLeft,
                totalChunks,
                pct,
                blocks: result.blocks,
                applied: result.applied,
                errors: result.errors,
                txs: result.txs,
                inputs: result.inputs,
                outputs: result.outputs,
                eras: result.eras,
                firstSlot: result.firstSlot,
                lastSlot: result.lastSlot,
                ms: Date.now() - t0,
                appliedThisRun: applied,
            }),
        );
    }

    const caughtUp = state.lastApplied >= applyLimit;
    console.log(
        JSON.stringify({
            phase: "done",
            appliedThisRun: applied,
            lastApplied: state.lastApplied,
            chunksDone: Math.max(0, state.lastApplied + 1),
            chunksLeft: Math.max(0, applyLimit - state.lastApplied),
            totalChunks,
            frontier,
            applyLimit,
            caughtUp,
            partialChunksThisRun: partialThisRun,
        }),
    );
    if (caughtUp) console.log("APPLY_CAUGHT_UP");
}

main().catch((e) => {
    console.error("APPLY_GAPFILL_ERROR", e);
    process.exit(1);
});
