/**
 * Gap-fill applier — parses already-downloaded immutable chunks into the
 * Gerolamo DB while the Mithril download keeps running.
 *
 * Safety:
 *   - Single writer on the DB (download process never touches SQLite).
 *   - Applies only complete trios at least MARGIN chunks behind the
 *     download frontier (never reads a chunk mid-extract).
 *   - Idempotent: blocks INSERT OR IGNORE; MiniBF ON CONFLICT DO UPDATE.
 *   - Progress state in snapshots/mithril/.apply-state.json (resumable).
 *
 * Usage:
 *   bun scripts/mithril-apply-gapfill.ts                 # apply to frontier-margin
 *   APPLY_LIMIT=2 bun scripts/mithril-apply-gapfill.ts   # smoke: 2 chunks max
 *   GEROLAMO_DB_PATH=./.live/test.db bun scripts/mithril-apply-gapfill.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureInitialized } from "../src/db";
import { processChunk } from "../src/state/legacy";
import { initSql, getSqlFilename } from "../src/sql";
import { Logger, LogLevel } from "../src/utils/logger";

const IMM_DIR = resolve(
    process.env.IMMUTABLE_DIR || "./snapshots/mithril/immutable",
);
const SNAP_ROOT = resolve(process.env.SNAPSHOT_DIR || "./snapshots/mithril");
const DB_PATH = resolve(
    process.env.GEROLAMO_DB_PATH || "./.live/test.db",
);
const STATE_PATH = join(SNAP_ROOT, ".apply-state.json");
const MARGIN = Math.max(1, parseInt(process.env.MARGIN || "3", 10));
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

type ApplyState = { lastApplied: number };

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
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function main(): Promise<void> {
    initSql(DB_PATH);
    await ensureInitialized();
    const logger = new Logger({ logLevel: LogLevel.INFO });

    const frontier = maxCompleteTrio();
    const applyLimit = Math.max(-1, frontier - MARGIN);
    const state = loadState();

    console.log(
        JSON.stringify({
            phase: "start",
            db: getSqlFilename(),
            immDir: IMM_DIR,
            frontierTrio: frontier,
            applyLimit,
            margin: MARGIN,
            lastApplied: state.lastApplied,
            applyLimitEnv: APPLY_LIMIT,
        }),
    );

    if (applyLimit < 0) {
        console.log("APPLY_NOTHING (no complete trios yet)");
        return;
    }

    let applied = 0;
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
        await processChunk(IMM_DIR, n, logger);
        applied++;
        state.lastApplied = n;
        saveState(state);
        if (applied % 10 === 0 || n === applyLimit) {
            console.log(
                JSON.stringify({
                    phase: "progress",
                    chunk: n,
                    appliedThisRun: applied,
                    frontier,
                    applyLimit,
                    ms: Date.now() - t0,
                }),
            );
        }
    }

    const caughtUp = state.lastApplied >= applyLimit;
    console.log(
        JSON.stringify({
            phase: "done",
            appliedThisRun: applied,
            lastApplied: state.lastApplied,
            frontier,
            applyLimit,
            caughtUp,
        }),
    );
    if (caughtUp) console.log("APPLY_CAUGHT_UP");
}

main().catch((e) => {
    console.error("APPLY_GAPFILL_ERROR", e);
    process.exit(1);
});
