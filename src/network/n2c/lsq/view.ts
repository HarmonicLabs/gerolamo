/**
 * The ledger state a LocalStateQuery client acquired (ouroboros-consensus `getReadOnlyForker`): the
 * volatile tip, the immutable tip, or any block of the selected chain within the last k blocks, as
 * a frozen read view over the LMDB ledger store (the anchor state plus the selected chain's diffs
 * down from the acquired block). Acquire failures follow cardano-node's LedgerDB: a point whose
 * slot is below the anchor's is `AcquireFailurePointTooOld` (whatever its hash), any other point
 * off the selected volatile chain `AcquireFailurePointNotOnChain`.
 *
 * sqlite mode keeps no per-block ledger history: only the tip can be acquired there; an older block
 * of the chain answers PointTooOld rather than serving tip data under a past point.
 */
import type { LedgerDiff } from "../../../ledger/LedgerDiff";
import { readU64, u64 } from "../../../ledger/LedgerDiff";
import type { LedgerStore, LedgerView } from "../../../ledger/LedgerStore";
import { getLedgerStore, ledgerStoreMode } from "../../../ledger/nodeLedgerStore";
import { GovReads } from "../../../ledger/govStore";
import { StakeReads } from "../../../ledger/stakeStore";
import { UtxoReads } from "../../../ledger/utxoStore";
import { primaryBlockStore } from "../../../storage/nodeBlockStore";
import { locateHeader } from "../../../storage/chunkFormat";
import { blockNoOf } from "../../../storage/volatileStore";
import { getChainTipFromHeader } from "../../../db";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export interface LsqPoint { slot: bigint; hash: string; blockNo: bigint; /** HFC era index (Byron 0 … Conway 6). */ era: number }
export type LsqTarget = { kind: "volatile" } | { kind: "immutable" } | { kind: "point"; slot: bigint; hash: string } | { kind: "origin" };
export const ACQUIRE_POINT_TOO_OLD = 0, ACQUIRE_POINT_NOT_ON_CHAIN = 1;

/** Reads the query answers use; the ledger groups are null in sqlite mode. */
export interface LsqView {
    point: LsqPoint | null;
    stake: StakeReads | null;
    gov: GovReads | null;
    utxo: UtxoReads | null;
    /** The acquired block is the selected tip (sqlite fallbacks may read the live tables). */
    atTip: boolean;
    /** Hashes of the selected chain's volatile blocks up to the acquired one, oldest first (raw-fact overlays). */
    volatileHashes: string[];
    /** Key of the store state the view was built on (rebuild when the anchor moves). */
    anchorKey: string;
}

type OvEntry = { hit: boolean; value: Uint8Array | undefined; delta: bigint };

/**
 * LMDB plus a fixed chain of diffs, folded once into per-database maps (the LedgerStore overlay,
 * frozen at one block). Structurally a `LedgerView` for the group readers.
 */
export class PointView {
    private readonly maps = new Map<string, Map<string, OvEntry>>();
    constructor(private readonly store: LedgerStore, private readonly chain: LedgerDiff[]) {
        for (let i = chain.length - 1; i >= 0; i--) fold(this.maps, chain[i]!);
    }
    get(db: string, key: Uint8Array): Uint8Array | undefined {
        const e = this.maps.get(db)?.get(hex(key));
        if (e?.hit) return e.value;
        return this.store.env.read((t) => t.get(db, key));
    }
    getU64(db: string, key: Uint8Array): bigint {
        const e = this.maps.get(db)?.get(hex(key));
        if (e?.hit) return readU64(e.value) + e.delta;
        return readU64(this.store.env.read((t) => t.get(db, key))) + (e?.delta ?? 0n);
    }
    /**
     * Ascending scan of `prefix`: LMDB merged with the overlay, streamed (a whole-UTxO scan of 3 M
     * entries must not be materialised: collecting it first took 17 GB).
     */
    *range(db: string, prefix: Uint8Array, opts: { limit?: number } = {}): Generator<[Uint8Array, Uint8Array]> {
        const ph = hex(prefix);
        const ov: Array<[string, Uint8Array | undefined]> = [];
        for (const [k, e] of this.maps.get(db) ?? []) {
            if (!k.startsWith(ph)) continue;
            if (e.delta !== 0n) { const v = this.getU64(db, unhex(k)); ov.push([k, v === 0n ? undefined : u64(v)]); }
            else if (e.hit) ov.push([k, e.value]);
        }
        ov.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        let i = 0, n = 0;
        const limit = opts.limit ?? Infinity;
        // open the database handle in a short transaction first: a handle first opened inside the
        // long scan would be invalid for the point reads the consumer makes meanwhile (EINVAL)
        this.store.env.read((t) => t.count(db));
        const txn = this.store.env.beginRead();
        try {
            for (const [k, v] of txn.range(db, { prefix })) {
                const kh = hex(k);
                while (i < ov.length && ov[i]![0] < kh) { const [ok, od] = ov[i++]!; if (od !== undefined) { if (n++ >= limit) return; yield [unhex(ok), od]; } }
                if (i < ov.length && ov[i]![0] === kh) { const od = ov[i++]![1]; if (od !== undefined) { if (n++ >= limit) return; yield [unhex(kh), od]; } continue; }
                if (n++ >= limit) return;
                yield [k, v];
            }
            while (i < ov.length) { const [ok, od] = ov[i++]!; if (od !== undefined) { if (n++ >= limit) return; yield [unhex(ok), od]; } }
        } finally { txn.commit(); }
    }
}

function fold(maps: Map<string, Map<string, OvEntry>>, d: LedgerDiff): void {
    const table = (db: string) => { let m = maps.get(db); if (!m) maps.set(db, (m = new Map())); return m; };
    for (const [db, m] of d.writes) { const om = table(db), adds = d.adds.get(db); for (const [k, e] of m) om.set(k, { hit: true, value: e.after, delta: adds?.get(k) ?? 0n }); }
    for (const [db, m] of d.adds) {
        const om = table(db), writes = d.writes.get(db);
        for (const [k, delta] of m) { if (writes?.has(k)) continue; const cur = om.get(k); if (cur) cur.delta += delta; else om.set(k, { hit: false, value: undefined, delta }); }
    }
}

/** The store's volatile diffs (private in LedgerStore; read here only, never mutated). */
function diffsOf(store: LedgerStore): Map<string, LedgerDiff> { return (store as unknown as { diffs: Map<string, LedgerDiff> }).diffs; }
/** The selected chain's diffs from `fromHex` down to the anchor, newest first. */
function chainFrom(store: LedgerStore, fromHex: string | null): LedgerDiff[] {
    const diffs = diffsOf(store), out: LedgerDiff[] = [], seen = new Set<string>();
    let cur = fromHex ? diffs.get(fromHex) : undefined;
    while (cur && !seen.has(hex(cur.hash))) { seen.add(hex(cur.hash)); out.push(cur); cur = cur.prevHash ? diffs.get(hex(cur.prevHash)) : undefined; }
    return out;
}

let refresher: (() => Promise<void>) | null = null;
/** Tools serving a running node's stores read-only re-attach them before each acquire (scripts/lsq-host.ts). */
export function setLsqRefresher(fn: (() => Promise<void>) | null): void { refresher = fn; }

const cache = new Map<string, LsqView>(); // by acquired hash; dropped when the anchor moves
/** LMDB changes only when the anchor moves (promotion): a view's overlay stays valid until then. */
export const anchorKeyOf = (store: LedgerStore) => { const a = store.anchor(); return a ? `${a.slot}:${hex(a.hash)}` : "none"; };
/** Is the view still consistent with the store (its diffs not yet promoted into LMDB)? */
export function viewCurrent(v: LsqView): boolean { const s = ledgerStoreMode() === "sqlite" ? null : getLedgerStore(); return !s || v.anchorKey === anchorKeyOf(s); }

async function pointInfo(hashHex: string, fallbackSlot: bigint): Promise<LsqPoint> {
    const bs = primaryBlockStore();
    const b = bs ? await bs.byHash(unhex(hashHex)) : null;
    if (b) { const h = locateHeader(b.bytes); return { slot: BigInt(b.slot), hash: hashHex, blockNo: BigInt(blockNoOf(b.bytes, h) ?? 0), era: Math.max(0, h.eraTag - 1) }; }
    const t = await getChainTipFromHeader();
    if (t && t.hashHex === hashHex) return { slot: t.slot, hash: hashHex, blockNo: t.blockNumber, era: Math.max(0, t.era - 1) };
    return { slot: fallbackSlot, hash: hashHex, blockNo: 0n, era: 6 };
}

function viewOver(store: LedgerStore, chain: LedgerDiff[], point: LsqPoint | null, atTip: boolean): LsqView {
    const pv = new PointView(store, chain) as unknown as LedgerView;
    return { point, stake: new StakeReads(pv), gov: new GovReads(pv), utxo: new UtxoReads(pv), atTip, volatileHashes: chain.map((d) => hex(d.hash)).reverse(), anchorKey: anchorKeyOf(store) };
}

/**
 * Which block a target names in the store, with the selected chain's diffs down from it, or the
 * failure (ouroboros-consensus LedgerDB `openStateRefAtTarget`: a point not on the volatile chain
 * is PointTooOld when its slot is below the anchor's, PointNotOnChain otherwise).
 */
export function resolveAcquireTarget(store: LedgerStore, target: LsqTarget): { wantHex: string; tipHex: string | null; chain: LedgerDiff[] } | { failure: number } {
    const anchor = store.anchor();
    const tipHash = store.selectedTip();
    const tipHex = tipHash ? hex(tipHash) : anchor ? hex(anchor.hash) : null;
    let wantHex: string | null;
    if (target.kind === "volatile") wantHex = tipHex;
    else if (target.kind === "immutable") wantHex = anchor ? hex(anchor.hash) : null;
    else if (target.kind === "origin") return { failure: anchor ? ACQUIRE_POINT_TOO_OLD : ACQUIRE_POINT_NOT_ON_CHAIN };
    else {
        const h = target.hash.toLowerCase();
        const onSelected = (anchor && hex(anchor.hash) === h) || chainFrom(store, tipHex).some((d) => hex(d.hash) === h);
        if (!onSelected) {
            if (anchor && target.slot < BigInt(anchor.slot)) return { failure: ACQUIRE_POINT_TOO_OLD };
            return { failure: ACQUIRE_POINT_NOT_ON_CHAIN };
        }
        wantHex = h;
    }
    if (!wantHex) return { failure: ACQUIRE_POINT_NOT_ON_CHAIN };
    return { wantHex, tipHex, chain: anchor && wantHex === hex(anchor.hash) ? [] : chainFrom(store, wantHex) };
}

/** Acquire a view, or the AcquireFailure code (0 PointTooOld, 1 PointNotOnChain). */
export async function acquireView(target: LsqTarget): Promise<{ view: LsqView } | { failure: number }> {
    if (refresher) await refresher();
    const store = ledgerStoreMode() === "sqlite" ? null : getLedgerStore();
    if (!store) {
        const t = await getChainTipFromHeader();
        const tip: LsqPoint | null = t ? { slot: t.slot, hash: t.hashHex, blockNo: t.blockNumber, era: Math.max(0, t.era - 1) } : null;
        const view: LsqView = { point: tip, stake: null, gov: null, utxo: null, atTip: true, volatileHashes: [], anchorKey: "sqlite" };
        if (target.kind === "volatile" || target.kind === "immutable") return { view }; // no history: the tip is the only state there is
        if (target.kind === "point" && tip && target.hash === tip.hash) return { view };
        return { failure: target.kind === "point" && tip && target.slot >= tip.slot ? ACQUIRE_POINT_NOT_ON_CHAIN : ACQUIRE_POINT_TOO_OLD };
    }
    const key = anchorKeyOf(store);
    for (const [h, v] of cache) if (v.anchorKey !== key) cache.delete(h);
    const r = resolveAcquireTarget(store, target);
    if ("failure" in r) return r;
    const { wantHex, tipHex, chain } = r;
    const hit = cache.get(wantHex);
    if (hit) return { view: { ...hit, atTip: wantHex === tipHex } };
    const slotGuess = chain.length ? BigInt(chain[0]!.slot) : BigInt(store.anchor()?.slot ?? 0);
    const view = viewOver(store, chain, await pointInfo(wantHex, slotGuess), wantHex === tipHex);
    cache.set(wantHex, view);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    return { view };
}

/** Drop cached views (tests, re-attach). */
export function clearLsqViews(): void { cache.clear(); }
