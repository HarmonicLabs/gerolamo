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
import { decodeRow, encodeRow, keyRef } from "./utxoStore";
import { readU64 } from "./LedgerDiff";

/** Epoch-prefixed databases (u32 big-endian epoch first in the key). */
export const EPOCH_PREFIXED = new Set([
    "blocks_made", "mir", "snap_cred", "snap_pool", "snap_pparams", "snap_totals", "snap_pool_zero", "snap_pool_meta", "pending_rew", "reward_epochs",
    "reward_payouts", "reward_pool_epochs", "pot_snap", "nonmyopic", "drep_stake", "epoch_params", "pparam_props", "nonces", "gov_enacted", "gov_pulser",
]);
/** Databases that describe the store rather than the ledger (compared, reported apart). */
/**
 * Epoch-prefixed databases whose own oldest epoch says nothing about their window: a snapshot may list
 * no zero-stake pool, so a store missing them (a Mithril import before bug 370) would start its window
 * later and hide them. They share the stake snapshot's credential window.
 */
export const WINDOW_OF: Record<string, string> = { snap_pool_zero: "snap_cred" };
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

const td = new TextDecoder(), te = new TextEncoder();
/** JSON with every object's keys sorted (key order is a property of the writer, not of the ledger). */
function sortedJson(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(sortedJson);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sortedJson((x as Record<string, unknown>)[k])]));
    return x;
}
const parseJson = (v: Uint8Array): Record<string, unknown> | null => { if (v[0] !== 0x7b) return null; try { return JSON.parse(td.decode(v)); } catch { return null; } };
const reduce = (n: bigint, d: bigint): [bigint, bigint] => { let a = n < 0n ? -n : n, b = d; while (b) [a, b] = [b, a % b]; const g = a || 1n; return [n / g, d / g]; };
function reducedMargin(o: Record<string, any>): void {
    const p = o.params ?? o;
    if (p && p.marginNum != null && p.marginDen != null) { const [n, d] = reduce(BigInt(p.marginNum), BigInt(p.marginDen || 1)); p.marginNum = String(n); p.marginDen = String(d); }
}

/**
 * Row forms that differ between writers but not in ledger content (bugs 353–355), compared in one
 * canonical form whatever the mode:
 *   utxo          the applier's ordinary output form (`assets` carries the lovelace under the empty
 *                 policy) vs the former collateral-return form (no lovelace entry, a
 *                 `collateral_return` flag): both compared without the flag and the lovelace entry —
 *                 the lovelace itself stays compared through `amount` and the row's lovelace column;
 *   pool, pool_pending, snap_pparams   the margin reduced (a certificate's 0/1000000 is the ledger's 0/1);
 *   any JSON row  object keys sorted.
 */
export function canonicalValue(db: string, v: Uint8Array, key?: Uint8Array): Uint8Array {
    if (db === "utxo" && key?.length === 34) {
        try {
            const r = decodeRow(keyRef(key), v);
            const j = JSON.parse(r.tx_out);
            delete j.collateral_return;
            if (j.assets && typeof j.assets === "object") delete j.assets[""];
            return encodeRow({ ...r, tx_out: JSON.stringify(sortedJson(j)) });
        } catch { return v; }
    }
    const o = parseJson(v);
    if (!o) return v;
    if (db === "pool" || db === "pool_pending" || db === "snap_pparams") reducedMargin(o);
    return te.encode(JSON.stringify(sortedJson(o)));
}

/**
 * Snapshot store vs genesis store (`placeholders`): store metadata and resume checkpoints that
 * depend on how and when each store was built, not on the ledger.
 *   pots `init_epoch`                    the epoch the store's pots were initialised (import epoch vs 0);
 *   gov_state `seededEpoch`              the epoch governance was seeded (import epoch vs the first Conway epoch);
 *   gov_pulser `source`                  "boundary" vs "backfill-exact" (how the frozen snapshot was written);
 *   nonces before the newest epoch       only η0 (`nonceHex`, `source`) is ledger state: the evolving /
 *                                        candidate nonces of a past epoch are the last per-range resume
 *                                        checkpoint written in it (timing-dependent), the start fields the
 *                                        import's mid-epoch placeholders.
 */
function snapshotMeta(db: string, key: Uint8Array, v: Uint8Array, newestEpoch: number): Uint8Array {
    if (db === "pots" && td.decode(key) === "init_epoch") return new Uint8Array(0);
    if (db === "gov_state") { const o = parseJson(v); if (o) { delete o.seededEpoch; return te.encode(JSON.stringify(o)); } }
    if (db === "gov_pulser") { const o = parseJson(v); if (o) { delete o.source; return te.encode(JSON.stringify(o)); } }
    if (db === "nonces" && epochOf(key) < newestEpoch) { const o = parseJson(v); if (o) return te.encode(JSON.stringify({ nonceHex: o.nonceHex, source: o.source })); }
    return v;
}

/** Databases keyed by a committee credential: typed (0x00/0x01 ‖ 28) or a bare hash from before bug 153. */
const CRED_KEYED = new Set(["gov_committee", "gov_cc_auth"]);
/** Counter databases where a zero is the absence of an entry (the importer writes zero-stake DReps, the boundary code omits them). */
const ZERO_IS_ABSENT = new Set(["drep_stake"]);
const isZeroU64 = (v: Uint8Array) => v.length === 8 && v.every((b) => b === 0);

/**
 * One-sided entries a snapshot import cannot hold — history before its epoch — when they are in
 * the store whose history starts earlier (`placeholders` only): decided governance actions with
 * their votes and anchors, registration pointers, the relays of pools registered before the import.
 */
function historyOnly(db: string, p: Pinned, key: Uint8Array, v: Uint8Array): boolean {
    const proposalLive = (k36: Uint8Array) => { const raw = p.view.withTxn(p.txn).get("gov_proposals", k36); const o = raw ? parseJson(raw) : null; return o?.status === "active"; };
    switch (db) {
        case "pointer": case "pool_relays": return true;
        case "gov_proposals": return parseJson(v)?.status !== "active";
        case "gov_votes": return key.length > 36 && !proposalLive(key.subarray(0, 36));
        case "gov_constitution_anchor": return key.length === 36 && !proposalLive(key);
        default: return false;
    }
}
/** Where a store's history starts: the epoch its pots were initialised (a snapshot's import epoch; 0 from genesis). */
function historyStart(p: Pinned): number {
    const v = p.view.withTxn(p.txn).get("pots", te.encode("init_epoch"));
    return v && v.length >= 4 ? new DataView(v.buffer, v.byteOffset).getUint32(0, false) : 0;
}

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
    /** One-sided entries classified as history the other store cannot hold (`placeholders`), per side. */
    historyA?: number;
    historyB?: number;
    /** Zero counters present on one side only (equal to absent). */
    zeros?: number;
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
    if (CRED_KEYED.has(db)) return compareCredKeyed(db, a, b, opts);
    const norm = opts.placeholders ? PLACEHOLDER_FIELDS[db] : undefined;
    const t0 = performance.now();
    const max = opts.maxSamples ?? 5;
    const r: DbReport = { db, countA: 0, countB: 0, same: 0, differ: 0, onlyA: 0, onlyB: 0, samples: [], seconds: 0 };
    let from = opts.fromEpoch;
    if (EPOCH_PREFIXED.has(db) && from === undefined) {
        const wdb = WINDOW_OF[db] ?? db, ea = oldestEpoch(a, wdb), eb = oldestEpoch(b, wdb);
        if (ea !== null && eb !== null) from = Math.max(ea === 0xffffffff ? 0 : ea, eb === 0xffffffff ? 0 : eb);
        // one side has none of it (a snapshot store's gov_enacted / pparam_props): the other's from the later history start
        else if (opts.placeholders && (ea !== null || eb !== null)) from = Math.max(historyStart(a), historyStart(b));
    }
    if (from !== undefined && EPOCH_PREFIXED.has(db)) { r.fromEpoch = from; r.skippedA = 0; r.skippedB = 0; } else from = undefined;
    const newestEpoch = db === "nonces" && opts.placeholders ? Math.max(newestEpochOf(a, db), newestEpochOf(b, db)) : 0;
    // the store whose history starts earlier holds the history the other cannot (placeholders)
    const histSide = opts.placeholders ? (historyStart(a) < historyStart(b) ? "A" : historyStart(b) < historyStart(a) ? "B" : null) : null;
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
    const canon = (k: Uint8Array, v: Uint8Array) => { let c = canonicalValue(db, v, k); if (opts.placeholders) c = snapshotMeta(db, k, c, newestEpoch); return norm ? norm(c) : c; };
    const oneSided = (side: "A" | "B", e: [Uint8Array, Uint8Array]): void => {
        const p = side === "A" ? a : b;
        if (ZERO_IS_ABSENT.has(db) && isZeroU64(e[1])) { r.zeros = (r.zeros ?? 0) + 1; return; }
        if (histSide === side && historyOnly(db, p, e[0], e[1])) { if (side === "A") r.historyA = (r.historyA ?? 0) + 1; else r.historyB = (r.historyB ?? 0) + 1; return; }
        if (side === "A") r.onlyA++; else r.onlyB++;
        sample(`only in ${p.name}: ${describeEntry(db, e[0], e[1])}`);
    };
    let x = next(ia, "A"), y = next(ib, "B");
    while (x || y) {
        const c = !x ? 1 : !y ? -1 : cmpBytes(x[0], y[0]);
        if (c < 0) { oneSided("A", x!); x = next(ia, "A"); }
        else if (c > 0) { oneSided("B", y!); y = next(ib, "B"); }
        else {
            if (cmpBytes(x![1], y![1]) === 0 || cmpBytes(canon(x![0], x![1]), canon(y![0], y![1])) === 0) r.same++;
            else { r.differ++; sample(`differs: ${a.name} ${describeEntry(db, x![0], x![1])}  |  ${b.name} ${describeEntry(db, y![0], y![1]).replace(/^.*? = /, "")}`); }
            x = next(ia, "A"); y = next(ib, "B");
        }
    }
    r.seconds = (performance.now() - t0) / 1000;
    return r;
}

function newestEpochOf(p: Pinned, db: string): number {
    let e = 0;
    for (const [k] of p.view.scan(db, p.txn)) { const x = epochOf(k); if (x !== 0xffffffff && x > e) e = x; }
    return e;
}

/**
 * Committee databases: a key typed on one side and bare (from before bug 153; the readers accept
 * both, govLedgerView.ccCredsOf) on the other is one credential; so is a hot credential typed on one
 * side and bare on the other. Two typed forms must agree. Small databases: materialised.
 */
function compareCredKeyed(db: string, a: Pinned, b: Pinned, opts: { maxSamples?: number }): DbReport {
    const t0 = performance.now();
    const r: DbReport = { db, countA: 0, countB: 0, same: 0, differ: 0, onlyA: 0, onlyB: 0, samples: [], seconds: 0 };
    const load = (p: Pinned) => { const m = new Map<string, { typed: string | null; v: Uint8Array }>(); for (const [k, v] of p.view.scan(db, p.txn)) { const kh = Buffer.from(k).toString("hex"); m.set(kh.slice(-56), { typed: kh.length === 58 ? kh : null, v }); } return m; };
    const ma = load(a), mb = load(b);
    r.countA = ma.size; r.countB = mb.size;
    const sample = (s: string) => { if (r.samples.length < (opts.maxSamples ?? 5)) r.samples.push(s); };
    for (const [h, x] of ma) {
        const y = mb.get(h);
        if (!y) { r.onlyA++; sample(`only in ${a.name}: ${describeEntry(db, Buffer.from(x.typed ?? h, "hex"), x.v)}`); continue; }
        const xo = parseJson(x.v), yo = parseJson(y.v);
        const sameType = !x.typed || !y.typed || x.typed === y.typed;
        if (xo && yo && typeof xo.hot === "string" && typeof yo.hot === "string" && xo.hot !== yo.hot && xo.hot.slice(-56) === yo.hot.slice(-56) && (xo.hot.length === 56 || yo.hot.length === 56)) xo.hot = yo.hot = (xo.hot.length === 58 ? xo.hot : yo.hot);
        const eq = xo && yo ? JSON.stringify(sortedJson(xo)) === JSON.stringify(sortedJson(yo)) : cmpBytes(x.v, y.v) === 0;
        if (sameType && eq) r.same++;
        else { r.differ++; sample(`differs: ${a.name} ${describeEntry(db, Buffer.from(x.typed ?? h, "hex"), x.v)}  |  ${b.name} ${describeEntry(db, Buffer.from(y.typed ?? h, "hex"), y.v).replace(/^.*? = /, "")}`); }
    }
    for (const [h, y] of mb) if (!ma.has(h)) { r.onlyB++; sample(`only in ${b.name}: ${describeEntry(db, Buffer.from(y.typed ?? h, "hex"), y.v)}`); }
    r.seconds = (performance.now() - t0) / 1000;
    return r;
}

/** Every named database of either store (sorted), from LMDB's main database plus the diffs' own. */
export function databasesOf(p: Pinned): string[] { return [...new Set([...p.txn.databaseNames(), ...p.view.touchedDatabases()])].sort(); }
