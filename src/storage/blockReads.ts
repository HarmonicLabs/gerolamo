/**
 * Block reads over the BlockStore in the shapes the `db.ts` helpers return (docs/PLAN_CHUNK_STORE.md
 * phase 3, "primary" mode): the `blocks` table is no longer written, so every helper that read it
 * is answered here from the chunk files and the volatile set instead.
 *
 * "Applied tip" = the selected chain's tip, which the orchestrator notes block by block as it
 * applies a range (`noteSelectedTip`), and moves back on a rollback (`rollbackSelectedTip`) or a
 * failed range (`restoreSelectedTip`). Volatile forks are resolved through that tip.
 *
 * Positional block rows follow `getBlockBySlot`'s SELECT:
 * `[id, chunk_id, slot, block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, is_valid, inserted_at, block_no]`
 * with `block_hash` / `prev_hash` as lowercase hex text (the `blocks.hash` column's form).
 */
import type { BlockRecord, BlockStore } from "./blockStore";
import { locateHeader } from "./chunkFormat";
import { blockNoOf, prevHashOf } from "./volatileStore";

let selectedTipHash: Uint8Array | null = null;
let persistPath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the selected tip (debounced) so a restart in primary mode resumes at the right block. */
export function persistSelectedTipTo(path: string | null): void {
    persistPath = path;
}

export function setSelectedTipHash(hash: Uint8Array | null): void {
    selectedTipHash = hash;
    if (persistPath && hash) {
        if (persistTimer) clearTimeout(persistTimer);
        const p = persistPath, h = hex(hash);
        persistTimer = setTimeout(() => { persistTimer = null; void Bun.write(p, h).catch(() => {}); }, 200);
    }
}

export function getSelectedTipHash(): Uint8Array | null {
    return selectedTipHash;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** The selected chain's tip: the noted hash, else the highest volatile block chaining to the immutable tip, else the immutable tip. */
export async function selectedTip(store: BlockStore): Promise<BlockRecord | null> {
    if (selectedTipHash) {
        const b = await store.byHash(selectedTipHash);
        if (b) return b;
    }
    const imm = await store.immutableTip();
    let best: BlockRecord | null = imm;
    for (const v of store.volatile.all()) {
        if (imm && v.slot <= imm.slot) continue;
        if (chainConnects(store, v.hash, imm) && (!best || v.slot > best.slot)) best = { slot: v.slot, hash: v.hash, bytes: v.bytes, headerOffset: v.headerOffset, headerSize: v.headerSize, immutable: false };
    }
    return best;
}

/**
 * Does the volatile chain down from `hash` join the immutable tip? Volatile files keep blocks at
 * and below the immutable slot until their file is garbage-collected, so the walk may pass
 * through the immutable tip itself (or an older immutable block) rather than stop right above it.
 */
export function chainConnects(store: BlockStore, hash: Uint8Array, imm: BlockRecord | null): boolean {
    if (!imm) return true;
    for (const v of store.volatileChain(hash)) {
        if (eq(v.hash, imm.hash)) return true;
        if (v.prevHash && eq(v.prevHash, imm.hash)) return true;
        if (v.slot <= imm.slot) return false; // reached the immutable region on another branch
    }
    return false;
}

/** True when `b` is on the selected chain (immutable, or on the volatile path down from the tip). */
export async function onSelectedChain(store: BlockStore, b: BlockRecord): Promise<boolean> {
    if (b.immutable) return true;
    const tip = await selectedTip(store);
    if (!tip) return false;
    if (eq(tip.hash, b.hash)) return true;
    return store.volatileChain(tip.hash).some((v) => eq(v.hash, b.hash));
}

/** The selected chain's blocks with slot in [fromSlot, toSlot], ascending. */
export async function* selectedChain(store: BlockStore, fromSlot: number, toSlot: number): AsyncGenerator<BlockRecord> {
    const tip = await selectedTip(store);
    if (!tip) return;
    const imm = await store.immutableTip();
    if (!imm || fromSlot <= imm.slot) {
        for await (const b of store.chunks.iterate(fromSlot, imm ? Math.min(toSlot, imm.slot) : toSlot)) {
            yield { slot: b.slot, hash: b.hash, bytes: b.bytes, headerOffset: b.headerOffset, headerSize: b.headerSize, immutable: true };
        }
    }
    const vol = store.volatileChain(tip.hash).reverse();
    for (const v of vol) {
        if (imm && v.slot <= imm.slot) continue;
        if (v.slot < fromSlot) continue;
        if (v.slot > toSlot) return;
        yield { slot: v.slot, hash: v.hash, bytes: v.bytes, headerOffset: v.headerOffset, headerSize: v.headerSize, immutable: false };
    }
}

/** The selected chain's newest `limit` blocks, newest first. */
export async function recentOnSelectedChain(store: BlockStore, limit: number): Promise<BlockRecord[]> {
    const out: BlockRecord[] = [];
    const tip = await selectedTip(store);
    if (!tip) return out;
    const imm = await store.immutableTip();
    for (const v of store.volatileChain(tip.hash)) {
        if (imm && v.slot <= imm.slot) break;
        out.push({ slot: v.slot, hash: v.hash, bytes: v.bytes, headerOffset: v.headerOffset, headerSize: v.headerSize, immutable: false });
        if (out.length >= limit) return out;
    }
    // then the immutable part, newest first, chunk by chunk
    const chunks = store.chunks.chunks();
    for (let c = chunks.length - 1; c >= 0 && out.length < limit; c--) {
        const idx = await store.chunks.index(chunks[c]!);
        if (!idx) continue;
        for (let i = idx.entries.length - 1; i >= 0 && out.length < limit; i--) {
            const e = idx.entries[i]!;
            if (e.isEbb) continue;
            const b = await store.chunks.blockAt(e.slotOrEbb);
            if (b) out.push({ slot: b.slot, hash: b.hash, bytes: b.bytes, headerOffset: b.headerOffset, headerSize: b.headerSize, immutable: true });
        }
    }
    return out;
}

// ---------------------------------------------------------------- db.ts helper shapes

export type PositionalBlockRow = [null, null, number, string, string | null, Uint8Array, Uint8Array, null, boolean, null, number | null];

export function positionalRow(b: BlockRecord): PositionalBlockRow {
    const header = b.bytes.slice(b.headerOffset, b.headerOffset + b.headerSize);
    const prev = prevHashOf(b.bytes);
    return [null, null, b.slot, hex(b.hash), prev ? hex(prev) : null, header, b.bytes, null, true, null, blockNoOf(b.bytes)];
}

export async function getBlockBySlot(store: BlockStore, slot: bigint | number): Promise<PositionalBlockRow | null> {
    const tip = await selectedTip(store);
    const b = await store.bySlot(Number(slot), tip?.hash);
    if (!b) return null;
    if (!b.immutable && !(await onSelectedChain(store, b))) {
        // several volatile blocks at this slot: pick the one on the selected chain, if any
        const onChain = store.volatile.atSlot(Number(slot)).find((v) => tip && store.volatileChain(tip.hash).some((c) => eq(c.hash, v.hash)));
        if (!onChain) return positionalRow(b);
        return positionalRow({ slot: onChain.slot, hash: onChain.hash, bytes: onChain.bytes, headerOffset: onChain.headerOffset, headerSize: onChain.headerSize, immutable: false });
    }
    return positionalRow(b);
}

/**
 * A block by hash — only when it is on the selected chain. Volatile files keep dead-fork blocks
 * until garbage collection; SQLite deleted them on rollback, and every caller ("do we have this
 * block", "is it already applied", "is this a known parent") means "is it on our chain".
 */
export async function getBlockByHash(store: BlockStore, hashHex: string): Promise<PositionalBlockRow | null> {
    if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) return null;
    const b = await store.byHash(Uint8Array.from(Buffer.from(hashHex, "hex")));
    if (!b) return null;
    if (!b.immutable && !(await onSelectedChain(store, b))) return null;
    return positionalRow(b);
}

/** True when the block is on the selected chain (immutable, or volatile on the path down from the tip). */
export async function hasOnSelectedChain(store: BlockStore, hashHex: string): Promise<boolean> {
    if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) return false;
    const b = await store.byHash(Uint8Array.from(Buffer.from(hashHex, "hex")));
    return !!b && (b.immutable || (await onSelectedChain(store, b)));
}

export async function getMaxSlot(store: BlockStore): Promise<bigint> {
    const tip = await selectedTip(store);
    return tip ? BigInt(tip.slot) : 0n;
}

export async function getChainTip(store: BlockStore): Promise<{ slot: bigint; blockNumber: bigint; hashHex: string } | null> {
    const tip = await selectedTip(store);
    if (!tip) return null;
    return { slot: BigInt(tip.slot), blockNumber: BigInt(blockNoOf(tip.bytes) ?? 0), hashHex: hex(tip.hash) };
}

export async function getChainTipFromHeader(store: BlockStore): Promise<{ slot: bigint; blockNumber: bigint; hashHex: string; dbBlockNumber: bigint; era: number } | null> {
    const tip = await selectedTip(store);
    if (!tip) return null;
    const bn = BigInt(blockNoOf(tip.bytes) ?? 0);
    return { slot: BigInt(tip.slot), blockNumber: bn, hashHex: hex(tip.hash), dbBlockNumber: bn, era: locateHeader(tip.bytes).eraTag };
}

export async function getMaxBlockNo(store: BlockStore): Promise<number> {
    const tip = await selectedTip(store);
    return tip ? (blockNoOf(tip.bytes) ?? 0) : 0;
}

export async function getRecentBlockPoints(store: BlockStore, limit: number): Promise<Array<{ slot: bigint; hash: unknown }>> {
    return (await recentOnSelectedChain(store, limit)).map((b) => ({ slot: BigInt(b.slot), hash: hex(b.hash) }));
}

export async function getRecentBlockHeaders(store: BlockStore, limit: number): Promise<Array<{ slot: bigint; header_data: Uint8Array }>> {
    return (await recentOnSelectedChain(store, limit)).map((b) => ({ slot: BigInt(b.slot), header_data: b.bytes.slice(b.headerOffset, b.headerOffset + b.headerSize) }));
}

/** Highest selected-chain block strictly below `slot`. */
export async function getLastBlockBefore(store: BlockStore, slot: number): Promise<{ slot: number; hash: string; prevHash: string | null } | null> {
    const tip = await selectedTip(store);
    if (!tip) return null;
    const imm = await store.immutableTip();
    for (const v of store.volatileChain(tip.hash)) {
        if (imm && v.slot <= imm.slot) break;
        if (v.slot < slot) return { slot: v.slot, hash: hex(v.hash), prevHash: v.prevHash ? hex(v.prevHash) : null };
    }
    // immutable part: walk chunks downwards from the chunk of `slot`
    const chunks = store.chunks.chunks();
    const startChunk = Math.floor(Math.min(slot - 1, imm ? imm.slot : slot - 1) / store.chunks.chunkSlots);
    for (let c = chunks.length - 1; c >= 0; c--) {
        const n = chunks[c]!;
        if (n > startChunk) continue;
        const idx = await store.chunks.index(n);
        if (!idx) continue;
        for (let i = idx.entries.length - 1; i >= 0; i--) {
            const e = idx.entries[i]!;
            if (e.isEbb || e.slotOrEbb >= slot) continue;
            const b = await store.chunks.blockAt(e.slotOrEbb);
            if (b) { const p = prevHashOf(b.bytes); return { slot: b.slot, hash: hex(b.hash), prevHash: p ? hex(p) : null }; }
        }
    }
    return null;
}

export interface BlockListRowLike {
    slot: number;
    hash: string;
    prevHash: string | null;
    blockNo: number | null;
    size: number | null;
    blockData: Uint8Array | null;
    headerData: Uint8Array | null;
}

export function blockListRow(b: BlockRecord): BlockListRowLike {
    const prev = prevHashOf(b.bytes);
    return { slot: b.slot, hash: hex(b.hash), prevHash: prev ? hex(prev) : null, blockNo: blockNoOf(b.bytes), size: b.bytes.length, blockData: b.bytes, headerData: b.bytes.slice(b.headerOffset, b.headerOffset + b.headerSize) };
}

export async function getBlockListRowByHash(store: BlockStore, hashHex: string): Promise<BlockListRowLike | null> {
    if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) return null;
    const b = await store.byHash(Uint8Array.from(Buffer.from(hashHex, "hex")));
    return b ? blockListRow(b) : null;
}

export async function getBlockListRowBySlot(store: BlockStore, slot: number): Promise<BlockListRowLike | null> {
    const row = await getBlockBySlot(store, slot);
    if (!row) return null;
    const b = await store.byHash(Uint8Array.from(Buffer.from(row[3], "hex")));
    return b ? blockListRow(b) : null;
}

/** Block by height: only the volatile part and the immutable tip's neighbourhood are searched (no height index). */
export async function getBlockListRowByHeight(store: BlockStore, blockNo: number): Promise<BlockListRowLike | null> {
    const tip = await selectedTip(store);
    if (!tip) return null;
    const tipNo = blockNoOf(tip.bytes);
    if (tipNo == null || blockNo > tipNo) return null;
    const back = tipNo - blockNo;
    if (back > 5000) return null;
    const recent = await recentOnSelectedChain(store, back + 1);
    const b = recent[back];
    return b && blockNoOf(b.bytes) === blockNo ? blockListRow(b) : null;
}

/** Hex hashes of selected-chain blocks above `slot` (what a rollback to `slot` removes). */
export async function blockHashesAbove(store: BlockStore, slot: bigint | number): Promise<string[]> {
    const tip = await selectedTip(store);
    if (!tip) return [];
    const imm = await store.immutableTip();
    const out: string[] = [];
    for (const v of store.volatileChain(tip.hash)) {
        if (imm && v.slot <= imm.slot) break;
        if (BigInt(v.slot) > BigInt(slot)) out.push(hex(v.hash));
    }
    return out;
}

/** Hashes at the tip slot (a Byron EBB shares its slot with the epoch's first block). */
export async function tipHashes(store: BlockStore): Promise<string[] | null> {
    const tip = await selectedTip(store);
    if (!tip) return null;
    // Only the selected tip (and, for a Byron epoch boundary, the EBB sharing its slot on our
    // chain): other volatile blocks at that slot are fork losers and must not count as our tip.
    const hs = [hex(tip.hash)];
    for (const v of store.volatile.atSlot(tip.slot)) if (v.eraTag === 0 && !eq(v.hash, tip.hash) && (await onSelectedChain(store, { slot: v.slot, hash: v.hash, bytes: v.bytes, headerOffset: v.headerOffset, headerSize: v.headerSize, immutable: false }))) hs.push(hex(v.hash));
    return hs;
}

/**
 * Move the selected tip to the selected-chain block at `slot` (rollback target). Returns the
 * hex hashes of the blocks that were above it, or null when no block sits at `slot`.
 */
export async function rollbackSelectedTip(store: BlockStore, slot: bigint | number, pointHashHex?: string | null): Promise<string[] | null> {
    const above = await blockHashesAbove(store, slot);
    // The rollback point names a block: land on it when we have it (a same-slot fork can leave two
    // volatile blocks at `slot`; the one the peer names is the common ancestor).
    if (pointHashHex && /^[0-9a-fA-F]{64}$/.test(pointHashHex)) {
        const b = await store.byHash(Uint8Array.from(Buffer.from(pointHashHex, "hex")));
        if (b && BigInt(b.slot) === BigInt(slot)) { selectedTipHash = b.hash; return above; }
    }
    const target = await getBlockBySlot(store, slot);
    if (target) {
        selectedTipHash = Uint8Array.from(Buffer.from(target[3], "hex"));
        return above;
    }
    // No block at `slot`: the tip becomes the selected chain's last block at or below it (computed
    // against the current tip before it moves), else the immutable tip when that is at or below.
    const last = await getLastBlockBefore(store, Number(slot) + 1);
    if (last) { selectedTipHash = Uint8Array.from(Buffer.from(last.hash, "hex")); return above; }
    const imm = await store.immutableTip();
    if (imm && BigInt(imm.slot) <= BigInt(slot)) { selectedTipHash = imm.hash; return above; }
    return null;
}

/** Newest-first block list for the API: `limit` blocks below `beforeSlot` (exclusive) on the selected chain. */
export async function listBlocksDesc(store: BlockStore, limit: number, beforeSlot?: number): Promise<BlockListRowLike[]> {
    const want = Math.max(1, Math.min(100, Math.trunc(limit)));
    if (beforeSlot == null) return (await recentOnSelectedChain(store, want)).map(blockListRow);
    const out: BlockListRowLike[] = [];
    // walk back from the last block before the cursor
    let cursor = await getLastBlockBefore(store, Math.trunc(beforeSlot));
    while (cursor && out.length < want) {
        const b = await store.byHash(Uint8Array.from(Buffer.from(cursor.hash, "hex")));
        if (!b) break;
        out.push(blockListRow(b));
        cursor = cursor.prevHash ? await (async () => { const p = await store.byHash(Uint8Array.from(Buffer.from(cursor!.prevHash!, "hex"))); return p ? { slot: p.slot, hash: cursor!.prevHash!, prevHash: (prevHashOf(p.bytes) ? hex(prevHashOf(p.bytes)!) : null) } : null; })() : null;
    }
    return out;
}

/** Oldest-first blocks of a slot range on the selected chain, with offset/limit (epoch pages). */
export async function listBlocksInSlotRange(store: BlockStore, fromSlot: number, toSlotExclusive: number, limit: number, offset = 0): Promise<BlockListRowLike[]> {
    const out: BlockListRowLike[] = [];
    let skip = Math.max(0, Math.trunc(offset));
    const want = Math.max(1, Math.min(100, Math.trunc(limit)));
    for await (const b of selectedChain(store, Math.trunc(fromSlot), Math.trunc(toSlotExclusive) - 1)) {
        if (skip > 0) { skip--; continue; }
        out.push(blockListRow(b));
        if (out.length >= want) break;
    }
    return out;
}

export async function countBlocksInSlotRange(store: BlockStore, fromSlot: number, toSlotExclusive: number): Promise<number> {
    let n = 0;
    for await (const _ of selectedChain(store, Math.trunc(fromSlot), Math.trunc(toSlotExclusive) - 1)) n++;
    return n;
}
