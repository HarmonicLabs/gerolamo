/**
 * Key-by-key comparison of two LMDB ledger stores (scripts/store-compare.ts): each store is opened
 * read-only, pinned to one block it holds (its LMDB state plus the volatile diffs down to that
 * block, LedgerStore.viewAt) under one long read transaction, and every named database is streamed
 * in key order from both sides (LedgerView.scan) and merged. Safe beside running nodes: nothing is
 * written, and the read transaction pins the LMDB state the diffs were loaded against (a promotion
 * between the two is detected and the pin retried).
 *
 * Databases whose keys start with a big-endian u32 epoch (report history, snapshots, parameters,
 * nonces …) are compared from the newest of the two stores' oldest epochs on: retention windows
 * and where each store's history starts (a snapshot import vs a genesis sync) are not differences.
 */
import { LedgerStore, type LedgerView } from "./LedgerStore";
import type { LmdbTxn } from "./lmdb";
import { decodeRow, keyRef } from "./utxoStore";
import { readU64 } from "./LedgerDiff";

/** Epoch-prefixed databases (u32 big-endian epoch first in the key). */
export const EPOCH_PREFIXED = new Set([
    "blocks_made", "mir", "snap_cred", "snap_pool", "snap_pparams", "snap_totals", "snap_pool_zero", "snap_pool_meta", "pending_rew", "reward_epochs",
    "reward_payouts", "reward_pool_epochs", "pot_snap", "nonmyopic", "drep_stake", "epoch_params", "pparam_props", "nonces", "gov_enacted", "gov_pulser",
]);
/** Databases that describe the store rather than the ledger (compared, reported apart). */
export const INFORMATIONAL = new Set(["meta"]);
/** u64 counter databases (values printed as numbers). */
const COUNTERS = new Set(["reward", "stake_bal", "utxo_stats", "pots", "blocks_made", "pending_rew", "counters", "drep_stake", "reward_payouts", "snap_pool"]);

/**
 * Fields a Mithril snapshot import cannot know — the NewEpochState carries no registration slots,
 * activity epochs, vote slots or submission order — so importLmdb.ts writes placeholders (slot 0 or
 * the snapshot's slot, `expiry − drepActivity`, list order) where a store synced from genesis holds
 * the real values. With `placeholders` the comparison drops them (snapshot store vs genesis store).
 */
const dropJson = (...keys: string[]) => (v: Uint8Array): Uint8Array => {
    try { const o = JSON.parse(new TextDecoder().decode(v)); for (const k of keys) delete o[k]; return new TextEncoder().encode(JSON.stringify(o)); } catch { return v; }
};
export const PLACEHOLDER_FIELDS: Record<string, (v: Uint8Array) => Uint8Array> = {
    pool: dropJson("registeredSlot"),
    pool_pending: dropJson("registeredSlot"),
    pool_relays: dropJson("updatedSlot"),
    opcert: (v) => v.subarray(0, 4), // u32 counter ‖ u64 slot of the last header: the counter is the ledger's
    gov_dreps: dropJson("registeredSlot", "lastActiveEpoch"),
    gov_votes: dropJson("slot"),
    gov_proposals: dropJson("seq"),
};

export interface Pinned {
    name: string;
    dir: string;
    store: LedgerStore;
    view: LedgerView;
    txn: LmdbTxn;
    at: { slot: number; hash: string };
    anchorSlot: number | null;
    depth: number;
    close(): void;
}

export function openReadOnly(dir: string): LedgerStore { return LedgerStore.open(dir, { readOnly: true }); }

/** The newest block both stores hold a complete state for, or null. */
export function commonBlock(a: LedgerStore, b: LedgerStore): { slot: number; hash: string } | null {
    const inB = new Map(b.heldBlocks().map((x) => [x.hash, x.slot]));
    let best: { slot: number; hash: string } | null = null;
    for (const x of a.heldBlocks()) if (inB.has(x.hash) && (!best || x.slot > best.slot)) best = x;
    return best;
}

/**
 * Pin a store at `hashHex`: the view and a read transaction whose anchor is the one the store's
 * diffs were loaded against. Returns null when the store does not hold that block, throws
 * "moved" when the node promoted in between (reopen and retry).
 */
export function pin(name: string, dir: string, store: LedgerStore, hashHex: string): Pinned | null {
    const hash = Uint8Array.from(Buffer.from(hashHex, "hex"));
    const view = store.viewAt(hash);
    if (!view) return null;
    const txn = store.env.beginRead();
    const raw = txn.get("meta", new TextEncoder().encode("anchor"));
    const a = store.anchor();
    const txnAnchor = raw && raw.length >= 40 ? Buffer.from(raw.subarray(8, 40)).toString("hex") : null;
    if (txnAnchor !== (a ? Buffer.from(a.hash).toString("hex") : null)) { txn.abort(); throw new Error("moved"); }
    let slot = a?.slot ?? -1;
    for (const b of store.heldBlocks()) if (b.hash === hashHex) slot = b.slot;
    return { name, dir, store, view, txn, at: { slot, hash: hashHex }, anchorSlot: a?.slot ?? null, depth: view.depth, close: () => { try { txn.abort(); } catch { /* closed */ } store.close(); } };
}

export interface DbReport {
    db: string;
    countA: number;
    countB: number;
    same: number;
    differ: number;
    onlyA: number;
    onlyB: number;
    /** Epoch-prefixed: keys below this epoch were not compared (and how many on each side). */
    fromEpoch?: number;
    skippedA?: number;
    skippedB?: number;
    samples: string[];
    seconds: number;
}

const epochOf = (k: Uint8Array) => (k.length >= 4 ? new DataView(k.buffer, k.byteOffset, k.byteLength).getUint32(0, false) : 0);
const cmpBytes = (x: Uint8Array, y: Uint8Array) => Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength), Buffer.from(y.buffer, y.byteOffset, y.byteLength));

/** A readable form of one entry for the report. */
export function describeEntry(db: string, key: Uint8Array, value: Uint8Array | undefined): string {
    const kh = Buffer.from(key).toString("hex");
    let k = kh.length > 72 ? `${kh.slice(0, 72)}…` : kh;
    if (db === "utxo" && key.length === 34) k = keyRef(key);
    else if (db === "meta" || db === "pots" || db === "counters" || db === "utxo_stats" || db === "gov_state") k = new TextDecoder().decode(key);
    if (value === undefined) return `${k} = (absent)`;
    let v: string;
    if (db === "utxo" && key.length === 34) { try { const r = decodeRow(keyRef(key), value); v = `${r.lovelace} lovelace @ ${r.address?.slice(0, 40)} ${r.tx_out.length > 160 ? r.tx_out.slice(0, 160) + "…" : r.tx_out}`; } catch { v = Buffer.from(value).toString("hex").slice(0, 120); } }
    else if (COUNTERS.has(db) && value.length === 8) v = readU64(value).toString();
    else {
        const s = new TextDecoder("utf-8", { fatal: false }).decode(value);
        v = /^[\x20-\x7e]*$/.test(s) && s.length ? (s.length > 200 ? `${s.slice(0, 200)}…` : s) : Buffer.from(value).toString("hex").slice(0, 120) + (value.length > 60 ? "…" : "");
    }
    return `${k} = ${v}`;
}

function oldestEpoch(p: Pinned, db: string): number | null {
    for (const [k] of p.view.scan(db, p.txn)) return epochOf(k);
    return null;
}

/** Stream one database from both pinned stores and merge. */
export function compareDb(db: string, a: Pinned, b: Pinned, opts: { maxSamples?: number; fromEpoch?: number; placeholders?: boolean } = {}): DbReport {
    const norm = opts.placeholders ? PLACEHOLDER_FIELDS[db] : undefined;
    const t0 = performance.now();
    const max = opts.maxSamples ?? 5;
    const r: DbReport = { db, countA: 0, countB: 0, same: 0, differ: 0, onlyA: 0, onlyB: 0, samples: [], seconds: 0 };
    let from = opts.fromEpoch;
    if (EPOCH_PREFIXED.has(db) && from === undefined) {
        const ea = oldestEpoch(a, db), eb = oldestEpoch(b, db);
        if (ea !== null && eb !== null) from = Math.max(ea === 0xffffffff ? 0 : ea, eb === 0xffffffff ? 0 : eb);
    }
    if (from !== undefined && EPOCH_PREFIXED.has(db)) { r.fromEpoch = from; r.skippedA = 0; r.skippedB = 0; } else from = undefined;
    const sample = (s: string) => { if (r.samples.length < max) r.samples.push(s); };
    const ia = a.view.scan(db, a.txn)[Symbol.iterator](), ib = b.view.scan(db, b.txn)[Symbol.iterator]();
    const next = (it: Iterator<[Uint8Array, Uint8Array]>, side: "A" | "B"): [Uint8Array, Uint8Array] | null => {
        for (;;) {
            const n = it.next();
            if (n.done) return null;
            // 0xffffffff is epoch −1 (a genesis chain's first reward update reports "performance epoch −1"): below any window
            if (from !== undefined && (epochOf(n.value[0]) < from || epochOf(n.value[0]) === 0xffffffff)) { if (side === "A") r.skippedA!++; else r.skippedB!++; continue; }
            if (side === "A") r.countA++; else r.countB++;
            return n.value;
        }
    };
    let x = next(ia, "A"), y = next(ib, "B");
    while (x || y) {
        const c = !x ? 1 : !y ? -1 : cmpBytes(x[0], y[0]);
        if (c < 0) { r.onlyA++; sample(`only in ${a.name}: ${describeEntry(db, x![0], x![1])}`); x = next(ia, "A"); }
        else if (c > 0) { r.onlyB++; sample(`only in ${b.name}: ${describeEntry(db, y![0], y![1])}`); y = next(ib, "B"); }
        else {
            if (cmpBytes(x![1], y![1]) === 0 || (norm && cmpBytes(norm(x![1]), norm(y![1])) === 0)) r.same++;
            else { r.differ++; sample(`differs: ${a.name} ${describeEntry(db, x![0], x![1])}  |  ${b.name} ${describeEntry(db, y![0], y![1]).replace(/^.*? = /, "")}`); }
            x = next(ia, "A"); y = next(ib, "B");
        }
    }
    r.seconds = (performance.now() - t0) / 1000;
    return r;
}

/** Every named database of either store (sorted), from LMDB's main database plus the diffs' own. */
export function databasesOf(p: Pinned): string[] { return [...new Set([...p.txn.databaseNames(), ...p.view.touchedDatabases()])].sort(); }
