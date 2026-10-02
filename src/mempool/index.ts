/**
 * The node's validating mempool (one per process). `initMempool` wires it to the ledger store,
 * the shared-memory tx store the tx-submission clients serve peers from, and a dedicated worker
 * for signatures and Plutus scripts (so a heavy script never runs on the sync thread).
 */
import { logger } from "../utils/logger";
import { GlobalSharedMempool } from "../network/SharedMempool";
import { ValidationPool } from "../consensus/workers/ValidationPool";
import { setChainChangedListener } from "../network/liveEvents";
import { ValidatingMempool, type MempoolLedgerView } from "./ValidatingMempool";

let instance: ValidatingMempool | null = null;
let pool: ValidationPool | null = null;

export function getMempool(): ValidatingMempool | null {
    return instance;
}

/** Test / embedding hook: install a mempool built elsewhere (or clear it). */
export function setMempool(m: ValidatingMempool | null): void {
    instance = m;
}

export async function initMempool(config: any, opts: { view?: MempoolLedgerView; workers?: number } = {}): Promise<ValidatingMempool> {
    if (instance) return instance;
    const view = opts.view ?? (await import("./ledgerViewDb")).dbLedgerView(config);
    const workers = opts.workers ?? (Number(config?.validation?.workers) === 0 ? 0 : 1);
    pool = workers > 0 ? new ValidationPool(workers) : null;
    const shared = GlobalSharedMempool.getInstance();
    instance = new ValidatingMempool({
        view,
        pool,
        store: { append: (h, tx) => shared.append(h, tx), drop: (hs) => shared.drop(hs as any) },
        rejectFailedPlutus: config?.mempool?.rejectFailedPlutus !== false, // strict: 0 disagreements on 1 137 preview script txs (2026-09-29)
        rejectUncheckedPlutus: config?.mempool?.rejectUncheckedPlutus === true,
    });
    // Revalidate on every chain change (block adopted, rollback); coalesced inside.
    setChainChangedListener(() => instance?.noteTipChanged());
    logger.info(`Validating mempool ready (${workers ? `${workers} worker` : "inline"} signatures/scripts)`);
    return instance;
}

export function stopMempool(): void {
    setChainChangedListener(null);
    pool?.close();
    pool = null;
    instance = null;
}

/** /metrics JSON block. */
export function mempoolMetrics(): Record<string, unknown> | null {
    if (!instance) return null;
    const m = instance.measures();
    const s = instance.stats;
    return {
        txs: m.txCount, bytes: m.bytes, exUnitsMemory: { size: m.exUnitsMemory.size.toString(), capacity: m.exUnitsMemory.capacity.toString() },
        exUnitsSteps: { size: m.exUnitsSteps.size.toString(), capacity: m.exUnitsSteps.capacity.toString() }, referenceScriptsBytes: m.referenceScriptsBytes,
        accepted: s.accepted, rejected: s.rejected, droppedOnSync: s.droppedOnSync, syncs: s.syncs,
        phase2: { passed: s.phase2Passed, failed: s.phase2Failed, unchecked: s.phase2Unchecked },
        structuredOnly: s.structuredOnly, unmodelled: s.unmodelled, rejectReasons: s.rejectReasons,
        admitMs: { count: s.admitMs.count, avg: s.admitMs.count ? +(s.admitMs.total / s.admitMs.count).toFixed(2) : 0, max: +s.admitMs.max.toFixed(2), last: +s.admitMs.last.toFixed(2) },
        syncMs: { count: s.syncMs.count, avg: s.syncMs.count ? +(s.syncMs.total / s.syncMs.count).toFixed(2) : 0, max: +s.syncMs.max.toFixed(2), last: +s.syncMs.last.toFixed(2) },
    };
}
