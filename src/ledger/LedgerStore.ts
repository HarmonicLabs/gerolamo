/**
 * LedgerStore (docs/PLAN_LMDB_LEDGER.md §3): the ledger state at the immutable point in LMDB plus
 * one in-memory `LedgerDiff` per volatile block. Reads walk the selected chain's diffs newest-first,
 * then LMDB. `promote` writes diffs to LMDB in one transaction, verifying every recorded `before`
 * against the stored value, and advances `meta.anchor`. `rollbackTo` drops the diffs above a block.
 *
 * Databases are named strings; keys and values are bytes. The UTxO layout and the other groups'
 * encodings live in `encodings.ts` / the group modules; this class is the storage mechanism.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LedgerDiff, decodeDiff, encodeDiff, hex, readU64, u64, unhex } from "./LedgerDiff";
import { LmdbEnv, type LmdbTxn } from "./lmdb";

export interface LedgerStoreOptions {
    mapSize?: number;
    readOnly?: boolean;
    /** Keep the volatile diffs on disk (`<dir>/diffs/<hash>.diff`) so a restart reloads them (default true when writable). */
    persistDiffs?: boolean;
}

export interface Anchor { slot: number; hash: Uint8Array }

const META = "meta";
const ANCHOR_KEY = new TextEncoder().encode("anchor");
/** fsync each diff file before its rename (`GEROLAMO_LEDGER_DIFF_FSYNC=0` skips it: a crash then loses more recent diffs, which the recovery rolls past). */
const DIFF_FSYNC = process.env.GEROLAMO_LEDGER_DIFF_FSYNC !== "0";

export class LedgerStore {
    readonly env: LmdbEnv;
    /** Volatile diffs by block hash (hex). */
    private readonly diffs = new Map<string, LedgerDiff>();
    /** Currently open block diff (between beginBlock and commitBlock). */
    private open: LedgerDiff | null = null;
    /** Selected tip (hex) — the volatile branch reads follow. */
    private tip: string | null = null;
    private anchorCache: Anchor | null | undefined;
    /**
     * Read index over the diffs of one chain (newest wins per key): a read is one map lookup instead
     * of a walk over up to k diffs with a hex conversion per diff (2026-09-26: the epoch-1432 stake
     * snapshot did 160 k counter reads through 432 diffs and blocked the producer for 19 minutes).
     * Extended in place when a block commits on top of it; dropped when diffs leave (rollback,
     * promotion — promoted values move into LMDB and must not be counted twice).
     */
    private ov: { tip: string | null; chain: LedgerDiff[]; maps: Map<string, Map<string, OvEntry>> } | null = null;
    /** Directory of persisted diffs (always read at open; written and pruned only when `persist`). */
    private readonly diffDir: string;
    private readonly persist: boolean;
    /** Diffs found on disk at open (before any chain check). */
    readonly loadedDiffs: number;
    /** Files at open that were not a complete diff (a write cut short by a crash): ignored, removed when writable. */
    readonly tornDiffs: number;
    /**
     * Diffs at open of blocks at or below the anchor: a promotion whose LMDB commit reached the disk
     * but whose file unlink did not (bug 245: the 2026-09-30 reboot left the anchor block's own diff
     * behind, the chain walked through it to a parent that had no diff, and every restart halted).
     * Their writes are in LMDB already, so they are ignored and removed when writable.
     */
    readonly staleDiffs: number;

    private constructor(env: LmdbEnv, diffDir: string, persist: boolean) {
        this.env = env;
        this.diffDir = diffDir;
        this.persist = persist;
        let loaded = 0, torn = 0, stale = 0;
        if (persist) mkdirSync(diffDir, { recursive: true });
        if (existsSync(diffDir)) {
            const a = this.anchor();
            const drop = (f: string) => { if (persist) rmSync(join(diffDir, f), { force: true }); };
            for (const f of readdirSync(diffDir)) {
                if (f.endsWith(".tmp")) { drop(f); continue; } // a write that never got to its rename
                if (!f.endsWith(".diff")) continue;
                let d: LedgerDiff;
                try { d = decodeDiff(new Uint8Array(readFileSync(join(diffDir, f)))); }
                catch { torn++; drop(f); continue; } // a torn write from a crash: incomplete, so absent
                if (a && (d.slot <= a.slot || hex(d.hash) === hex(a.hash))) { stale++; drop(f); continue; } // promoted before the crash
                this.diffs.set(hex(d.hash), d);
                loaded++;
            }
        }
        this.loadedDiffs = loaded;
        this.tornDiffs = torn;
        this.staleDiffs = stale;
    }

    static open(dir: string, opts: LedgerStoreOptions = {}): LedgerStore {
        const env = LmdbEnv.open(dir, { mapSize: opts.mapSize, maxDbs: 64, readOnly: opts.readOnly });
        const persist = opts.persistDiffs ?? !opts.readOnly;
        return new LedgerStore(env, join(dir, "diffs"), persist);
    }

    close(): void { this.env.close(); }

    private diffPath(hashHex: string): string { return join(this.diffDir, `${hashHex}.diff`); }
    /**
     * Temp file, fsync, rename: after a crash the final name holds either the complete diff or
     * nothing (a leftover `.tmp` is swept at open), and the trailer catches a file that came back
     * short anyway (bug 245).
     */
    private saveDiff(d: LedgerDiff): void {
        if (!this.persist) return;
        const p = this.diffPath(hex(d.hash));
        const buf = encodeDiff(d);
        const fd = openSync(p + ".tmp", "w");
        try {
            let off = 0;
            while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
            if (DIFF_FSYNC) fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(p + ".tmp", p);
    }
    private dropDiffFile(hashHex: string): void {
        if (!this.persist) return;
        const p = this.diffPath(hashHex);
        if (existsSync(p)) rmSync(p, { force: true });
    }

    /**
     * Does the chain of diffs from `tip` end at the anchor? True when `tip` is the anchor itself,
     * or every diff down from it is present and the oldest one's parent is the anchor block.
     */
    chainReachesAnchor(tip: Uint8Array | null): boolean {
        return this.chainGap(tip) === null;
    }

    /**
     * Why `chainReachesAnchor(tip)` is false: the block (hex, shortened) on the way down whose diff is
     * missing, or "no diff for the tip" — null when the chain reaches the anchor.
     */
    chainGap(tip: Uint8Array | null): string | null {
        const a = this.anchor();
        if (!tip) return a === null ? null : "no tip";
        if (a && hex(tip) === hex(a.hash)) return null;
        const chain = this.chain(hex(tip));
        if (!chain.length || hex(chain[0]!.hash) !== hex(tip)) return `no diff for the tip ${hex(tip).slice(0, 16)}`;
        const oldest = chain[chain.length - 1]!;
        if (!a) return oldest.prevHash === null ? null : `no diff for ${hex(oldest.prevHash).slice(0, 16)} (parent of ${hex(oldest.hash).slice(0, 16)}@${oldest.slot})`;
        if (oldest.prevHash !== null && hex(oldest.prevHash) === hex(a.hash)) return null;
        return `no diff for ${oldest.prevHash ? hex(oldest.prevHash).slice(0, 16) : "genesis"} (parent of ${hex(oldest.hash).slice(0, 16)}@${oldest.slot}; anchor ${hex(a.hash).slice(0, 16)}@${a.slot})`;
    }

    /**
     * After an unclean stop: the newest block of `chainNewestFirst` (the block store's selected
     * chain, newest first, ending with its immutable tip) whose diffs reach the anchor — the newest
     * block both stores hold with a complete state. The anchor itself qualifies (every volatile
     * diff dropped). Null when no block of the chain does. Merely having a diff for a block is not
     * enough (bug 245: the fallback picked the tip, whose chain was broken further down).
     */
    recoveryTip(chainNewestFirst: Array<{ slot: number; hash: Uint8Array }>): { slot: number; hash: Uint8Array } | null {
        return chainNewestFirst.find((b) => this.chainReachesAnchor(b.hash)) ?? null;
    }

    // ------------------------------------------------------------------ anchor / tip

    anchor(): Anchor | null {
        if (this.anchorCache !== undefined) return this.anchorCache;
        const raw = this.env.read((t) => t.get(META, ANCHOR_KEY));
        this.anchorCache = raw && raw.length >= 40 ? { slot: Number(readU64(raw.subarray(0, 8))), hash: raw.slice(8, 40) } : null;
        return this.anchorCache;
    }

    /** Set the anchor directly (importer: the snapshot's block). */
    async setAnchor(a: Anchor): Promise<void> {
        await this.env.write((t) => t.put(META, ANCHOR_KEY, concat(u64(BigInt(a.slot)), a.hash)));
        this.anchorCache = a;
    }

    selectTip(hash: Uint8Array | null): void { this.tip = hash ? hex(hash) : null; }
    selectedTip(): Uint8Array | null { return this.tip ? unhex(this.tip) : null; }

    /**
     * The selected chain's diffs, newest first, down to (not including) the anchor. The walk never
     * continues through the anchor block: its state is in LMDB, so a diff of it (or of anything
     * below it) that somehow lingers must not be read or counted (bug 245).
     */
    private chain(fromHex: string | null = this.tip): LedgerDiff[] {
        const out: LedgerDiff[] = [];
        const a = this.anchor();
        const anchorHex = a ? hex(a.hash) : null;
        let cur = fromHex && fromHex !== anchorHex ? this.diffs.get(fromHex) : undefined;
        const seen = new Set<string>();
        while (cur && !seen.has(hex(cur.hash))) {
            seen.add(hex(cur.hash));
            out.push(cur);
            const p = cur.prevHash ? hex(cur.prevHash) : null;
            cur = p && p !== anchorHex ? this.diffs.get(p) : undefined;
        }
        return out;
    }

    volatileCount(): number { return this.diffs.size; }
    volatileBytes(): number { let n = 0; for (const d of this.diffs.values()) n += d.bytes; return n; }
    hasDiff(hash: Uint8Array): boolean { return this.diffs.has(hex(hash)); }

    // ------------------------------------------------------------------ block lifecycle

    beginBlock(hash: Uint8Array, prevHash: Uint8Array | null, slot: number): void {
        if (this.open) throw new Error("beginBlock: a block is already open");
        this.open = new LedgerDiff(hash, prevHash, slot);
    }

    /**
     * First key of `db` in LMDB alone (no volatile overlay): a raw cursor read that touches one
     * entry. For history databases whose oldest entries are always promoted (retention pruning);
     * `range` would materialise the whole database to honour the overlay.
     */
    firstStoredKey(db: string): Uint8Array | null {
        const txn = this.env.beginRead();
        try { for (const [k] of txn.range(db, { limit: 1 })) return k; return null; } finally { txn.commit(); }
    }

    /** Keys under `prefix` in LMDB alone (no volatile overlay), collected before any write. */
    storedKeys(db: string, prefix: Uint8Array): Uint8Array[] {
        const out: Uint8Array[] = [];
        const txn = this.env.beginRead();
        try { for (const [k] of txn.range(db, { prefix })) out.push(k); } finally { txn.commit(); }
        return out;
    }

    /**
     * Write keys straight into LMDB only where the store (open block, volatile diffs, LMDB) has no
     * value yet — synchronously, so no block can commit in between the check and the write. For
     * backfilling databases that older diffs never touch. Returns keys written.
     */
    fillAbsentSync(db: string, entries: Array<[Uint8Array, Uint8Array]>): number {
        const todo = entries.filter(([k]) => this.get(db, k) === undefined);
        if (todo.length) this.env.writeSync((t) => { for (const [k, v] of todo) t.put(db, k, v); });
        return todo.length;
    }

    /** Forget specific diffs (an aborted range's blocks) without touching the tip. */
    dropDiffs(hashes: Uint8Array[]): number {
        let n = 0;
        for (const h of hashes) { const k = hex(h); if (this.diffs.delete(k)) { this.dropDiffFile(k); n++; } }
        if (n) this.ov = null;
        return n;
    }

    /** `knows` for a lower-case hex hash, without conversions (per-step test of the header rules' chain walk). */
    knowsHex(hashHex: string): boolean {
        if (this.diffs.has(hashHex)) return true;
        const a = this.anchor();
        if (!a) return false;
        if (this.anchorHexMemo?.a !== a) this.anchorHexMemo = { a, h: hex(a.hash) };
        return this.anchorHexMemo.h === hashHex;
    }
    private anchorHexMemo: { a: Anchor; h: string } | null = null;

    /** True when `hash` is the anchor block or a volatile block the store holds. */
    knows(hash: Uint8Array | null): boolean {
        if (!hash) return this.anchor() === null;
        const a = this.anchor();
        return this.diffs.has(hex(hash)) || (!!a && hex(a.hash) === hex(hash));
    }

    /** Seal the open diff, make its block the selected tip; `persist` false for synthetic diffs (seeding). */
    commitBlock(persist = true): LedgerDiff {
        const d = this.open;
        if (!d) throw new Error("commitBlock: no open block");
        this.open = null;
        this.diffs.set(hex(d.hash), d);
        const prevHex = d.prevHash ? hex(d.prevHash) : null;
        if (this.ov && this.ov.tip === prevHex && this.diffs.has(prevHex ?? "")) { applyToOverlay(this.ov.maps, d); this.ov.chain = [d, ...this.ov.chain]; this.ov.tip = hex(d.hash); }
        else this.ov = null;
        this.tip = hex(d.hash);
        if (persist) this.saveDiff(d);
        return d;
    }

    abortBlock(): void { this.open = null; }

    /**
     * Write straight into LMDB (seeding, imports): `fn` runs inside a synthetic block whose diff is
     * applied and forgotten at once; the anchor and the selected tip are untouched.
     */
    async applyDirect(fn: () => void | Promise<void>): Promise<number> {
        if (this.open) throw new Error("applyDirect: a block is open");
        const tip = this.tip;
        const d = new LedgerDiff(new Uint8Array(32), null, 0);
        this.open = d;
        try { await fn(); } catch (err) { this.open = null; throw err; }
        this.open = null;
        await this.env.write((t) => applyDiff(t, d));
        this.tip = tip;
        return d.size;
    }

    // ------------------------------------------------------------------ reads (diffs then LMDB)

    /** The overlay of the chain below the open block (or below the selected tip when no block is open). */
    private overlayFor(tipHex: string | null): { chain: LedgerDiff[]; maps: Map<string, Map<string, OvEntry>> } {
        if (this.ov && this.ov.tip === tipHex) return this.ov;
        const chain = this.chain(tipHex); // newest first
        const maps = new Map<string, Map<string, OvEntry>>();
        for (let i = chain.length - 1; i >= 0; i--) applyToOverlay(maps, chain[i]!);
        this.ov = { tip: tipHex, chain, maps };
        return this.ov;
    }
    private baseTipHex(): string | null { return this.open ? (this.open.prevHash ? hex(this.open.prevHash) : null) : this.tip; }

    /** Diffs to consult for a read: the open block first, then the selected chain. */
    private readChain(): LedgerDiff[] {
        const c = this.overlayFor(this.baseTipHex()).chain;
        return this.open ? [this.open, ...c] : c;
    }

    get(db: string, key: Uint8Array): Uint8Array | undefined {
        const kh = hex(key);
        if (this.open) { const hit = this.open.lookupHex(db, kh); if (hit) return hit.value; }
        const e = this.overlayFor(this.baseTipHex()).maps.get(db)?.get(kh);
        if (e?.hit) return e.value;
        return this.env.read((t) => t.get(db, key));
    }

    has(db: string, key: Uint8Array): boolean { return this.get(db, key) !== undefined; }

    /** u64 counter: LMDB value plus the chain's deltas (missing = 0). */
    getU64(db: string, key: Uint8Array): bigint {
        const kh = hex(key);
        let delta = 0n;
        if (this.open) {
            delta += this.open.addDeltaHex(db, kh);
            const hit = this.open.lookupHex(db, kh);
            if (hit) return readU64(hit.value) + delta;
        }
        const e = this.overlayFor(this.baseTipHex()).maps.get(db)?.get(kh);
        if (e) { delta += e.delta; if (e.hit) return readU64(e.value) + delta; }
        return readU64(this.env.read((t) => t.get(db, key))) + delta;
    }

    /**
     * Ascending scan of keys with `prefix`: LMDB entries merged with the chain's touched keys
     * (deleted keys masked, set keys taking their newest value). Bounded by `limit`.
     */
    *range(db: string, prefix: Uint8Array, opts: { limit?: number } = {}): Generator<[Uint8Array, Uint8Array]> {
        yield* mergedRange(this.env, this.readChain(), (k) => this.getU64(db, k), db, prefix, opts);
    }

    // ------------------------------------------------------------------ writes (into the open diff)

    put(db: string, key: Uint8Array, value: Uint8Array): void {
        const d = this.open;
        if (!d) throw new Error("put outside a block");
        d.set(db, key, value, d.lookup(db, key) ? undefined : this.getBelowOpen(db, key));
    }

    del(db: string, key: Uint8Array): void {
        const d = this.open;
        if (!d) throw new Error("del outside a block");
        d.del(db, key, d.lookup(db, key) ? undefined : this.getBelowOpen(db, key));
    }

    addU64(db: string, key: Uint8Array, delta: bigint): void {
        const d = this.open;
        if (!d) throw new Error("addU64 outside a block");
        d.add(db, key, delta);
    }

    /** Value below the open block (older diffs, then LMDB) — the `before` a write records. */
    private getBelowOpen(db: string, key: Uint8Array): Uint8Array | undefined {
        const e = this.overlayFor(this.open?.prevHash ? hex(this.open.prevHash) : null).maps.get(db)?.get(hex(key));
        if (e?.hit) return e.value;
        return this.env.read((t) => t.get(db, key));
    }

    // ------------------------------------------------------------------ chain management

    /**
     * Drop every diff above `hash` on any branch (keeps `hash` and below). Returns dropped count.
     * `hash` must be the anchor, a block with a diff, or null (drop everything volatile): rolling back
     * to an unknown block would silently discard the whole volatile layer, so it is refused.
     */
    rollbackTo(hash: Uint8Array | null): number {
        if (hash) {
            const a = this.anchor();
            if (!this.diffs.has(hex(hash)) && !(a && hex(a.hash) === hex(hash))) throw new Error(`rollbackTo: block ${hex(hash).slice(0, 16)} is neither the anchor nor a volatile block (${this.diffs.size} diffs, anchor ${a ? hex(a.hash).slice(0, 16) + " @" + a.slot : "none"})`);
        }
        const keep = new Set<string>();
        for (const d of this.chain(hash ? hex(hash) : null)) keep.add(hex(d.hash));
        // Blocks below the target on the selected chain are kept; everything else volatile goes.
        // (Other branches are dropped too: a rollback means the network chose; they re-arrive if needed.)
        let dropped = 0;
        for (const k of [...this.diffs.keys()]) if (!keep.has(k)) { this.diffs.delete(k); this.dropDiffFile(k); dropped++; }
        if (dropped) this.ov = null;
        this.tip = hash ? hex(hash) : null;
        return dropped;
    }

    /**
     * Roll the selected chain back to the newest block at or below `slot`: diffs above it on the
     * selected chain are dropped (other branches too), the tip moves there. Returns the new tip
     * (null when the anchor is the tip) and the dropped count. Refuses a slot below the anchor.
     */
    rollbackToSlot(slot: number): { tip: Uint8Array | null; dropped: number } {
        const a = this.anchor();
        if (a && slot < a.slot) throw new Error(`rollbackToSlot: slot ${slot} is below the anchor (slot ${a.slot}); the immutable state cannot be rolled back`);
        const chain = this.chain(); // newest first
        const target = chain.find((d) => d.slot <= slot);
        if (!target && chain.length && chain[chain.length - 1]!.prevHash && a && hex(chain[chain.length - 1]!.prevHash!) !== hex(a.hash)) {
            throw new Error(`rollbackToSlot: the selected chain does not reach the anchor`);
        }
        const dropped = this.rollbackTo(target ? target.hash : a ? a.hash : null);
        return { tip: target ? target.hash : a ? a.hash : null, dropped };
    }

    /** Synchronous `applyDirect` for importers (nothing else may be writing the environment). */
    applyDirectSync(fn: () => void): number {
        if (this.open) throw new Error("applyDirectSync: a block is open");
        const tip = this.tip;
        const d = new LedgerDiff(new Uint8Array(32), null, 0);
        this.open = d;
        try { fn(); } catch (err) { this.open = null; throw err; }
        this.open = null;
        this.env.writeSync((t) => applyDiff(t, d));
        this.tip = tip;
        return d.size;
    }

    /**
     * Write straight into LMDB while a block may be open: the writes bypass the open diff (they are
     * not recorded in it and do not touch its before-images). For derived per-epoch state only.
     */
    async applyDirectBeside(fn: () => void | Promise<void>): Promise<void> {
        const saved = this.open;
        const savedTip = this.tip;
        this.open = null;
        try { await this.applyDirect(fn); } finally { this.open = saved; this.tip = savedTip; }
    }

    /**
     * Apply the given diffs (oldest first, each extending the anchor) to LMDB in one transaction,
     * verifying each recorded `before`, then advance the anchor and forget them.
     */
    async promote(hashes: Uint8Array[]): Promise<{ promoted: number; anchor: Anchor | null }> {
        if (!hashes.length) return { promoted: 0, anchor: this.anchor() };
        const diffs = hashes.map((h) => { const d = this.diffs.get(hex(h)); if (!d) throw new Error(`promote: no diff for ${hex(h).slice(0, 16)}`); return d; });
        let anchor = this.anchor();
        for (const d of diffs) {
            if (anchor && d.prevHash && hex(d.prevHash) !== hex(anchor.hash)) throw new Error(`promote: block ${hex(d.hash).slice(0, 16)} (slot ${d.slot}) does not extend the anchor ${hex(anchor.hash).slice(0, 16)} (slot ${anchor.slot})`);
            anchor = { slot: d.slot, hash: d.hash };
        }
        await this.env.write((t) => {
            for (const d of diffs) applyDiff(t, d);
            const a = diffs[diffs.length - 1]!;
            t.put(META, ANCHOR_KEY, concat(u64(BigInt(a.slot)), a.hash));
        });
        for (const d of diffs) { this.diffs.delete(hex(d.hash)); this.dropDiffFile(hex(d.hash)); }
        this.ov = null; // promoted values are in LMDB now: the overlay must not count them again
        this.anchorCache = anchor;
        return { promoted: diffs.length, anchor };
    }

    /** Promote everything on the selected chain deeper than `k` blocks. */
    async promoteDeep(k: number): Promise<{ promoted: number; anchor: Anchor | null }> {
        const chain = this.chain(); // newest first
        const toPromote = chain.slice(k).reverse(); // oldest first
        return this.promote(toPromote.map((d) => d.hash));
    }

    /**
     * Frozen read view of the state after `hash` — the anchor or a volatile block the store holds —
     * whatever the selected tip; null when the store does not hold it. Header rules that depend on
     * chain state as of a header's parent (the opcert counters) read through it.
     */
    viewAt(hash: Uint8Array): LedgerView | null {
        if (!this.knows(hash)) return null;
        const chain = this.chain(hex(hash)), a = this.anchor();
        const oldest = chain[chain.length - 1];
        if (oldest && (a ? !oldest.prevHash || hex(oldest.prevHash) !== hex(a.hash) : oldest.prevHash !== null)) return null; // a gap: not a complete state
        return new LedgerView(this.env, chain);
    }

    /** Frozen read view (no open block, no later mutations affect it): a snapshot of the chain now. */
    snapshot(): LedgerView {
        const chain = this.chain();
        return new LedgerView(this.env, chain);
    }

    stats(): { anchor: Anchor | null; volatileBlocks: number; volatileBytes: number; tip: string | null } {
        return { anchor: this.anchor(), volatileBlocks: this.diffs.size, volatileBytes: this.volatileBytes(), tip: this.tip };
    }
}

function applyDiff(t: LmdbTxn, d: LedgerDiff): void {
    for (const [db, m] of d.writes) {
        for (const [k, e] of m) {
            const key = unhex(k);
            const stored = t.get(db, key);
            if (e.hadBefore !== (stored !== undefined) || (e.hadBefore && stored && e.before && !eq(stored, e.before))) {
                throw new Error(`promote: ${db}/${k.slice(0, 16)}… stored value differs from the block's before-image (block ${hex(d.hash).slice(0, 16)})`);
            }
            if (e.after !== undefined) t.put(db, key, e.after); else t.del(db, key);
        }
    }
    for (const [db, m] of d.adds) {
        for (const [k, delta] of m) {
            if (delta === 0n) continue;
            const key = unhex(k);
            const cur = readU64(t.get(db, key));
            const next = cur + delta;
            if (next < 0n) throw new Error(`promote: ${db}/${k.slice(0, 16)}… counter would go negative (${cur} + ${delta})`);
            if (next === 0n) t.del(db, key); else t.put(db, key, u64(next));
        }
    }
}

/** Read-only view over LMDB plus a fixed list of diffs (newest first). */
export class LedgerView {
    constructor(private readonly env: LmdbEnv, private readonly chain: LedgerDiff[]) {}
    get(db: string, key: Uint8Array): Uint8Array | undefined {
        for (const d of this.chain) { const hit = d.lookup(db, key); if (hit) return hit.value; }
        return this.env.read((t) => t.get(db, key));
    }
    getU64(db: string, key: Uint8Array): bigint {
        let delta = 0n, base: Uint8Array | undefined, found = false;
        for (const d of this.chain) { delta += d.addDelta(db, key); const hit = d.lookup(db, key); if (hit) { base = hit.value; found = true; break; } }
        if (!found) base = this.env.read((t) => t.get(db, key));
        return readU64(base) + delta;
    }
    *range(db: string, prefix: Uint8Array, opts: { limit?: number } = {}): Generator<[Uint8Array, Uint8Array]> {
        yield* mergedRange(this.env, this.chain, (k) => this.getU64(db, k), db, prefix, opts);
    }
}

/**
 * Ascending scan of `prefix` in `db`: LMDB entries merged with the keys the chain touched — a set
 * key takes its newest value, a deleted key is masked, a counter key (u64 adds) takes its
 * effective value (absent when it is zero, as `applyDiff` would store it).
 */
function* mergedRange(env: LmdbEnv, chain: LedgerDiff[], getU64: (key: Uint8Array) => bigint, db: string, prefix: Uint8Array, opts: { limit?: number }): Generator<[Uint8Array, Uint8Array]> {
    const prefixHex = hex(prefix);
    const keys = new Set<string>();
    for (const d of chain) for (const k of d.touchedKeys(db)) if (k.startsWith(prefixHex)) keys.add(k);
    const overlay = new Map<string, Uint8Array | undefined>();
    for (const k of keys) {
        const key = unhex(k);
        let hasAdd = false;
        for (const d of chain) if (d.addDelta(db, key) !== 0n) { hasAdd = true; break; }
        if (hasAdd) { const v = getU64(key); overlay.set(k, v === 0n ? undefined : u64(v)); continue; }
        for (const d of chain) { const hit = d.lookup(db, key); if (hit) { overlay.set(k, hit.value); break; } }
    }
    const merged: Array<[string, Uint8Array]> = [];
    const txn = env.beginRead();
    try {
        for (const [k, v] of txn.range(db, { prefix })) {
            const kh = hex(k);
            if (overlay.has(kh)) { const ov = overlay.get(kh); overlay.delete(kh); if (ov !== undefined) merged.push([kh, ov]); }
            else merged.push([kh, v]);
        }
    } finally { txn.commit(); }
    for (const [k, v] of overlay) if (v !== undefined) merged.push([k, v]);
    merged.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let n = 0;
    for (const [k, v] of merged) { if (opts.limit != null && n++ >= opts.limit) return; yield [unhex(k), v]; }
}

type OvEntry = { hit: boolean; value: Uint8Array | undefined; delta: bigint };

/** Fold one diff (newer than everything already folded) into an overlay. */
function applyToOverlay(maps: Map<string, Map<string, OvEntry>>, d: LedgerDiff): void {
    const table = (db: string) => { let m = maps.get(db); if (!m) maps.set(db, (m = new Map())); return m; };
    for (const [db, m] of d.writes) {
        const om = table(db), adds = d.adds.get(db);
        for (const [k, e] of m) om.set(k, { hit: true, value: e.after, delta: adds?.get(k) ?? 0n });
    }
    for (const [db, m] of d.adds) {
        const om = table(db), writes = d.writes.get(db);
        for (const [k, delta] of m) {
            if (writes?.has(k)) continue;
            const cur = om.get(k);
            if (cur) cur.delta += delta; else om.set(k, { hit: false, value: undefined, delta });
        }
    }
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
