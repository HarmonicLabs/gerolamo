/**
 * Chain reads for UTxO RPC over the node's block store (immutable chunks + volatile set): block
 * lookup by point, history pages, and a follower that streams the selected chain from an
 * intersection: `reset` to the intersection first (like Dolos), then `apply` for every block after
 * it, and `undo` (with the rolled-back block's content) when the node switches away from blocks it
 * already streamed. The volatile set keeps fork blocks until garbage collection; a block that is
 * gone by then is reported as a `reset` to the newest common block instead.
 */
import type { BlockRecord, BlockStore } from "../../storage/blockStore";
import { getBlockListRowByHeight, getLastBlockBefore, onSelectedChain, selectedChain, selectedTip } from "../../storage/blockReads";
import { blockNoOf, prevHashOf } from "../../storage/volatileStore";
import { blockHeaderFacts } from "./mapper";

export interface Point { slot: bigint; hash: Uint8Array; height: bigint }
export type ChainEvent =
    | { kind: "apply"; block: BlockRecord }
    | { kind: "undo"; block: BlockRecord }
    | { kind: "reset"; point: Point };

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** Block number; Byron blocks read it from the header's difficulty (EBBs: the previous main block's). */
export function heightOf(b: { bytes: Uint8Array }): bigint {
    try {
        const n = blockNoOf(b.bytes);
        if (n != null) return BigInt(n);
        return blockHeaderFacts(b.bytes).height ?? 0n;
    } catch { return 0n; }
}

export function pointOf(b: BlockRecord): Point {
    return { slot: BigInt(b.slot), hash: b.hash, height: heightOf(b) };
}

export const ORIGIN: Point = { slot: 0n, hash: new Uint8Array(0), height: 0n };

/** A block of the selected chain by hash, else by height or slot (FetchBlock / DumpHistory lookups). */
export async function findBlock(store: BlockStore, ref: { slot?: bigint; hash?: Uint8Array; height?: bigint }): Promise<BlockRecord | null> {
    if (ref.hash && ref.hash.length) {
        const b = await store.byHash(ref.hash);
        if (b && (b.immutable || (await onSelectedChain(store, b)))) return b;
        return null;
    }
    if (ref.slot != null && ref.slot > 0n) {
        for await (const b of selectedChain(store, Number(ref.slot), Number(ref.slot))) return b;
        return null;
    }
    if (ref.height != null && ref.height > 0n) {
        const row = await getBlockListRowByHeight(store, Number(ref.height)); // the newest 5000 blocks (no height index)
        return row ? store.byHash(Buffer.from(row.hash, "hex")) : null;
    }
    return null;
}

/** Up to `max` selected-chain blocks from `fromSlot` (inclusive), ascending, plus the next block's point. */
export async function historyPage(store: BlockStore, fromSlot: number, max: number): Promise<{ blocks: BlockRecord[]; next: BlockRecord | null }> {
    const tip = await selectedTip(store);
    if (!tip) return { blocks: [], next: null };
    const blocks: BlockRecord[] = [];
    let next: BlockRecord | null = null;
    for await (const b of selectedChain(store, fromSlot, tip.slot)) {
        if (blocks.length >= max) { next = b; break; }
        blocks.push(b);
    }
    return { blocks, next };
}

/** True when the block is on the node's selected chain. */
async function isSelected(store: BlockStore, p: Point): Promise<boolean> {
    if (!p.hash.length) return true; // origin
    const b = await store.byHash(p.hash);
    return !!b && (b.immutable || (await onSelectedChain(store, b)));
}

/**
 * The first point of `intersect` on the selected chain (a point without a hash matches the block at
 * its slot), the selected tip when `intersect` is empty, null when none matches.
 */
export async function findIntersect(store: BlockStore, intersect: Array<{ slot: bigint; hash: Uint8Array }>): Promise<Point | null> {
    if (!intersect.length) {
        const t = await selectedTip(store);
        return t ? pointOf(t) : ORIGIN;
    }
    for (const p of intersect) {
        if (p.hash.length) {
            const b = await store.byHash(p.hash);
            if (b && (b.immutable || (await onSelectedChain(store, b)))) return pointOf(b);
            continue;
        }
        if (p.slot === 0n) return ORIGIN;
        for await (const b of selectedChain(store, Number(p.slot), Number(p.slot))) return pointOf(b);
    }
    return null;
}

export interface FollowOptions {
    signal: AbortSignal;
    /** Resolves when the chain may have changed (or after a poll interval). */
    waitForChange: (signal: AbortSignal) => Promise<void>;
}

/**
 * Stream the selected chain from `start`: `reset(start)`, then apply / undo events forever (until
 * the signal aborts). Every event is computed against the store's current selected chain, so a
 * rollback while the client catches up is reported as undo events for the blocks it already got.
 */
export async function* followChain(store: BlockStore, start: Point, opts: FollowOptions): AsyncGenerator<ChainEvent> {
    yield { kind: "reset", point: start };
    let cur: Point = start;
    while (!opts.signal.aborted) {
        // 1. roll back while the client's position left the selected chain
        let rolled = false;
        while (!opts.signal.aborted && cur.hash.length && !(await isSelected(store, cur))) {
            const b = await store.byHash(cur.hash);
            if (!b) {
                // the block is gone (volatile GC): reset to the newest selected block below its slot
                const prev = await getLastBlockBefore(store, Number(cur.slot) + 1);
                const pb = prev ? await store.byHash(Buffer.from(prev.hash, "hex")) : null;
                cur = pb ? pointOf(pb) : ORIGIN;
                yield { kind: "reset", point: cur };
                rolled = true;
                break;
            }
            yield { kind: "undo", block: b };
            rolled = true;
            const prevHash = prevHashOf(b.bytes);
            const pb = prevHash ? await store.byHash(prevHash) : null;
            cur = pb ? pointOf(pb) : ORIGIN;
        }
        if (rolled) continue;
        // 2. roll forward to the tip
        const tip = await selectedTip(store);
        if (tip && !eq(tip.hash, cur.hash) && tip.slot >= Number(cur.slot)) {
            let passedCur = false, moved = false;
            for await (const b of selectedChain(store, Number(cur.slot), tip.slot)) {
                if (opts.signal.aborted) return;
                // blocks at the client's slot: skip up to and including its block
                if (cur.hash.length && b.slot === Number(cur.slot) && !passedCur) { if (eq(b.hash, cur.hash)) passedCur = true; continue; }
                if (!b.immutable) {
                    const prev = prevHashOf(b.bytes);
                    if (cur.hash.length && prev && !eq(prev, cur.hash)) break; // the chain changed under us: re-check from the top
                }
                yield { kind: "apply", block: b };
                cur = pointOf(b);
                moved = true;
            }
            if (moved) continue;
        }
        await opts.waitForChange(opts.signal);
    }
}

