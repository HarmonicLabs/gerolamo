/**
 * ChunkStore: cardano-node's immutable directory as Gerolamo's block store (docs/PLAN_CHUNK_STORE.md).
 *
 * Read side: random access by slot through the primary/secondary indices, sequential iteration
 * for chain-sync serving, and the tip. Chunk files are read with ranged `Bun.file().slice()`;
 * the index files of recently used chunks stay cached (17 KB + a few KB each).
 *
 * Write side (`append`): the block's bytes go to the end of the current `.chunk`, one entry to
 * `.secondary`, and `.primary` is extended from the last written relative slot to the block's
 * slot. Files are synced in that order so a crash leaves at worst a trailing block the index
 * does not know about, which `open()` trims back to the index, exactly as cardano-node's
 * validation does. A block at a slot in a later chunk finalises the current primary (padding
 * to `chunkSlots + 2` offsets) and starts the new files.
 */
import { existsSync } from "node:fs";
import { mkdir, open as openFile, readdir, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HashIndex } from "./hashIndex";
import {
    SECONDARY_ENTRY_SIZE,
    cborItemLength,
    chunkFileName,
    chunkNoOf,
    crc32,
    decodePrimary,
    decodeSecondaryEntry,
    encodePrimary,
    encodeSecondaryEntry,
    filledRelativeSlots,
    locateHeader,
    primaryOffsetCount,
    relativeSlot,
    type SecondaryEntry,
} from "./chunkFormat";

export interface StoredBlock {
    slot: number;
    /** Block header hash (32 bytes). */
    hash: Uint8Array;
    /** The block exactly as stored: `[eraTag, block]` disk/wire envelope. */
    bytes: Uint8Array;
    headerOffset: number;
    headerSize: number;
    isEbb: boolean;
    chunkNo: number;
}

export interface ChunkIndex {
    chunkNo: number;
    offsets: number[];
    entries: SecondaryEntry[];
    /** Byte size of the chunk file as known to the index (= last entry end). */
    chunkBytes: number;
}

export interface ChunkStoreOptions {
    /** Slots per chunk: 10 · k (4 320 preview/preprod, 21 600 mainnet). */
    chunkSlots: number;
    /** Index cache size in chunks (default 64). */
    cacheChunks?: number;
    /**
     * Never modify the directory: no tail recovery on open, `append` refused. Required for a
     * directory another node may be writing (a running cardano-node's db) and for checkers.
     */
    readOnly?: boolean;
    /**
     * Path of the hash → slot record file (default `<dir>/../gerolamo/hash-index.bin`, i.e. beside
     * the immutable directory, never inside it). `false` disables hash lookups.
     */
    hashIndexPath?: string | false;
}

export class ChunkStore {
    readonly dir: string;
    readonly chunkSlots: number;
    private readonly cache = new Map<number, ChunkIndex>();
    private readonly cacheMax: number;
    readonly readOnly: boolean;
    private hashIndex: HashIndex | null = null;
    private readonly hashIndexPath: string | false;
    private chunkNos: number[] = [];
    /** The open chunk (last one) as an in-memory mirror of its files, for appends. */
    private tail: { chunkNo: number; offsets: number[]; entries: SecondaryEntry[]; chunkBytes: number } | null = null;

    private constructor(dir: string, opts: ChunkStoreOptions) {
        this.dir = dir;
        this.chunkSlots = opts.chunkSlots;
        this.cacheMax = opts.cacheChunks ?? 64;
        this.readOnly = !!opts.readOnly;
        this.hashIndexPath = opts.hashIndexPath === undefined ? join(dirname(dir), "gerolamo", "hash-index.bin") : opts.hashIndexPath;
    }

    /** Open (creating the directory if needed) and trim any trailing bytes the index does not cover. */
    static async open(dir: string, opts: ChunkStoreOptions): Promise<ChunkStore> {
        const store = new ChunkStore(dir, opts);
        if (!store.readOnly) await mkdir(dir, { recursive: true });
        await store.scan();
        if (!store.readOnly) await store.recoverTail();
        if (store.hashIndexPath !== false && !store.readOnly) await store.openHashIndex();
        return store;
    }

    /** Chunk numbers present (sorted). */
    chunks(): readonly number[] {
        return this.chunkNos;
    }

    private async scan(): Promise<void> {
        const names = await readdir(this.dir);
        const nos = new Set<number>();
        for (const n of names) {
            const m = /^(\d{5})\.chunk$/.exec(n);
            if (m) nos.add(Number(m[1]));
        }
        this.chunkNos = [...nos].sort((a, b) => a - b);
    }

    private path(chunkNo: number, ext: "chunk" | "primary" | "secondary"): string {
        return join(this.dir, chunkFileName(chunkNo, ext));
    }

    /** The parsed indices of a chunk (cached). */
    async index(chunkNo: number): Promise<ChunkIndex | null> {
        if (this.tail && this.tail.chunkNo === chunkNo) return { chunkNo, offsets: this.tail.offsets, entries: this.tail.entries, chunkBytes: this.tail.chunkBytes };
        const hit = this.cache.get(chunkNo);
        if (hit) return hit;
        if (!existsSync(this.path(chunkNo, "primary")) || !existsSync(this.path(chunkNo, "secondary"))) return null;
        const [pri, sec] = await Promise.all([Bun.file(this.path(chunkNo, "primary")).bytes(), Bun.file(this.path(chunkNo, "secondary")).bytes()]);
        const idx = ChunkStore.parseIndex(chunkNo, pri, sec, await this.fileSize(this.path(chunkNo, "chunk")));
        this.cache.set(chunkNo, idx);
        if (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value!);
        return idx;
    }

    static parseIndex(chunkNo: number, pri: Uint8Array, sec: Uint8Array, chunkFileBytes: number): ChunkIndex {
        const offsets = decodePrimary(pri);
        const filled = filledRelativeSlots(offsets);
        const n = Math.floor(sec.length / SECONDARY_ENTRY_SIZE);
        const entries: SecondaryEntry[] = [];
        for (let i = 0; i < n; i++) entries.push(decodeSecondaryEntry(sec, i, filled[i] === 0));
        // The index covers the chunk file up to the end of its last entry; beyond that is a torn write.
        const chunkBytes = entries.length ? chunkFileBytes : 0;
        return { chunkNo, offsets, entries, chunkBytes };
    }

    private async fileSize(p: string): Promise<number> {
        try {
            return (await stat(p)).size;
        } catch {
            return 0;
        }
    }

    private async readBlockBytes(chunkNo: number, idx: ChunkIndex, i: number): Promise<Uint8Array> {
        const e = idx.entries[i]!;
        const end = i + 1 < idx.entries.length ? idx.entries[i + 1]!.blockOffset : idx.chunkBytes;
        return Bun.file(this.path(chunkNo, "chunk")).slice(e.blockOffset, end).bytes();
    }

    private toStored(chunkNo: number, e: SecondaryEntry, bytes: Uint8Array): StoredBlock {
        return { slot: e.slotOrEbb, hash: e.headerHash, bytes, headerOffset: e.headerOffset, headerSize: e.headerSize, isEbb: e.isEbb, chunkNo };
    }

    /** The block at an exact slot, or null. EBBs are not addressable by slot (they share the epoch's first slot). */
    async blockAt(slot: number): Promise<StoredBlock | null> {
        const chunkNo = chunkNoOf(slot, this.chunkSlots);
        const idx = await this.index(chunkNo);
        if (!idx) return null;
        const rel = relativeSlot(slot, chunkNo, this.chunkSlots);
        if (rel + 1 >= idx.offsets.length || idx.offsets[rel + 1]! <= idx.offsets[rel]!) return null;
        const i = idx.offsets[rel]! / SECONDARY_ENTRY_SIZE;
        const e = idx.entries[i];
        if (!e || e.slotOrEbb !== slot) return null;
        return this.toStored(chunkNo, e, await this.readBlockBytes(chunkNo, idx, i));
    }

    /**
     * Load the hash index and bring it up to date with the store (records for every block above
     * the index's last slot are added from the secondary indices; a missing file is rebuilt whole).
     */
    async openHashIndex(): Promise<HashIndex> {
        if (this.hashIndex) return this.hashIndex;
        if (this.hashIndexPath === false) throw new Error("hash index disabled");
        const approx = this.chunkNos.length * 200;
        const ix = await HashIndex.open(this.hashIndexPath, approx);
        const from = ix.maxSlot + 1;
        const tip = await this.tip();
        if (tip && tip.slot >= from) {
            const items: { hash: Uint8Array; slot: number }[] = [];
            const firstChunk = chunkNoOf(from, this.chunkSlots);
            for (const chunkNo of this.chunkNos) {
                if (chunkNo < firstChunk) continue;
                const idx = await this.index(chunkNo);
                if (!idx) continue;
                for (const e of idx.entries) if (!e.isEbb && e.slotOrEbb >= from) items.push({ hash: e.headerHash, slot: e.slotOrEbb });
            }
            if (items.length) await ix.addMany(items);
        }
        this.hashIndex = ix;
        return ix;
    }

    /** The block with this header hash, or null (EBBs are not indexed). */
    async blockByHash(hash: Uint8Array): Promise<StoredBlock | null> {
        const slot = await this.slotOfHash(hash);
        return slot == null ? null : this.blockAt(slot);
    }

    /** Slot of the block with this header hash, confirmed against the chunk's index entry. */
    async slotOfHash(hash: Uint8Array): Promise<number | null> {
        const ix = this.hashIndex ?? (this.hashIndexPath === false ? null : await this.openHashIndexReadSafe());
        if (!ix) return null;
        for (const slot of ix.lookup(hash)) {
            const chunkNo = chunkNoOf(slot, this.chunkSlots);
            const idx = await this.index(chunkNo);
            if (!idx) continue;
            const rel = relativeSlot(slot, chunkNo, this.chunkSlots);
            if (rel + 1 >= idx.offsets.length || idx.offsets[rel + 1]! <= idx.offsets[rel]!) continue;
            const e = idx.entries[idx.offsets[rel]! / SECONDARY_ENTRY_SIZE];
            if (e && e.slotOrEbb === slot && Buffer.from(e.headerHash).equals(Buffer.from(hash))) return slot;
        }
        return null;
    }

    /** A read-only store may still use an existing, up-to-date index file (never writes one). */
    private async openHashIndexReadSafe(): Promise<HashIndex | null> {
        if (this.hashIndexPath === false || !existsSync(this.hashIndexPath)) return null;
        this.hashIndex = await HashIndex.open(this.hashIndexPath, this.chunkNos.length * 200);
        return this.hashIndex;
    }

    /** Header bytes of the block at a slot (no body read). */
    async headerAt(slot: number): Promise<{ slot: number; hash: Uint8Array; header: Uint8Array } | null> {
        const chunkNo = chunkNoOf(slot, this.chunkSlots);
        const idx = await this.index(chunkNo);
        if (!idx) return null;
        const rel = relativeSlot(slot, chunkNo, this.chunkSlots);
        if (rel + 1 >= idx.offsets.length || idx.offsets[rel + 1]! <= idx.offsets[rel]!) return null;
        const e = idx.entries[idx.offsets[rel]! / SECONDARY_ENTRY_SIZE];
        if (!e || e.slotOrEbb !== slot) return null;
        const header = await Bun.file(this.path(chunkNo, "chunk")).slice(e.blockOffset + e.headerOffset, e.blockOffset + e.headerOffset + e.headerSize).bytes();
        return { slot, hash: e.headerHash, header };
    }

    /** Last block in the store (highest slot), or null when empty. */
    async tip(): Promise<StoredBlock | null> {
        for (let c = this.chunkNos.length - 1; c >= 0; c--) {
            const chunkNo = this.chunkNos[c]!;
            const idx = await this.index(chunkNo);
            if (!idx || idx.entries.length === 0) continue;
            const i = idx.entries.length - 1;
            return this.toStored(chunkNo, idx.entries[i]!, await this.readBlockBytes(chunkNo, idx, i));
        }
        return null;
    }

    /** Blocks with slot in [fromSlot, toSlot], ascending. */
    async *iterate(fromSlot: number, toSlot = Number.MAX_SAFE_INTEGER, opts: { includeEbb?: boolean } = {}): AsyncGenerator<StoredBlock> {
        const first = chunkNoOf(fromSlot, this.chunkSlots), last = chunkNoOf(Math.min(toSlot, Number.MAX_SAFE_INTEGER), this.chunkSlots);
        for (const chunkNo of this.chunkNos) {
            if (chunkNo < first) continue;
            if (chunkNo > last) break;
            const idx = await this.index(chunkNo);
            if (!idx || idx.entries.length === 0) continue;
            const whole = await Bun.file(this.path(chunkNo, "chunk")).slice(0, idx.chunkBytes).bytes();
            for (let i = 0; i < idx.entries.length; i++) {
                const e = idx.entries[i]!;
                if (e.isEbb) {
                    if (!opts.includeEbb) continue;
                } else if (e.slotOrEbb < fromSlot) continue;
                else if (e.slotOrEbb > toSlot) return;
                const end = i + 1 < idx.entries.length ? idx.entries[i + 1]!.blockOffset : idx.chunkBytes;
                yield this.toStored(chunkNo, e, whole.subarray(e.blockOffset, end));
            }
        }
    }

    /** Whole-chunk verification: index shape, CRC of every block, header location, slot mapping. */
    async verifyChunk(chunkNo: number): Promise<{ blocks: number; bytes: number; errors: string[] }> {
        const errors: string[] = [];
        const idx = await this.index(chunkNo);
        if (!idx) return { blocks: 0, bytes: 0, errors: [`chunk ${chunkNo}: missing index files`] };
        const filled = filledRelativeSlots(idx.offsets);
        if (filled.length !== idx.entries.length) errors.push(`chunk ${chunkNo}: primary marks ${filled.length} slots, secondary has ${idx.entries.length} entries`);
        if (idx.offsets[idx.offsets.length - 1] !== idx.entries.length * SECONDARY_ENTRY_SIZE) errors.push(`chunk ${chunkNo}: last primary offset ${idx.offsets[idx.offsets.length - 1]} ≠ secondary size`);
        const whole = await Bun.file(this.path(chunkNo, "chunk")).bytes();
        if (idx.entries.length && whole.length !== idx.chunkBytes) errors.push(`chunk ${chunkNo}: file ${whole.length} bytes, index expects ${idx.chunkBytes}`);
        for (let i = 0; i < idx.entries.length && errors.length < 20; i++) {
            const e = idx.entries[i]!;
            const end = i + 1 < idx.entries.length ? idx.entries[i + 1]!.blockOffset : whole.length;
            const bytes = whole.subarray(e.blockOffset, end);
            if (crc32(bytes) !== e.crc) errors.push(`chunk ${chunkNo} entry ${i} slot ${e.slotOrEbb}: CRC mismatch`);
            try {
                const h = locateHeader(bytes);
                if (h.headerOffset !== e.headerOffset || h.headerSize !== e.headerSize) errors.push(`chunk ${chunkNo} entry ${i}: header at ${h.headerOffset}+${h.headerSize}, index says ${e.headerOffset}+${e.headerSize}`);
            } catch (err) {
                errors.push(`chunk ${chunkNo} entry ${i}: ${(err as Error).message}`);
            }
            if (!e.isEbb && filled[i] !== relativeSlot(e.slotOrEbb, chunkNo, this.chunkSlots)) errors.push(`chunk ${chunkNo} entry ${i}: slot ${e.slotOrEbb} at relative slot ${filled[i]}`);
        }
        return { blocks: idx.entries.length, bytes: whole.length, errors };
    }

    // ---------------------------------------------------------------- write side

    /** Load the last chunk's index into the append mirror and trim torn trailing bytes. */
    private async recoverTail(): Promise<void> {
        const chunkNo = this.chunkNos[this.chunkNos.length - 1];
        if (chunkNo === undefined) return;
        const priPath = this.path(chunkNo, "primary"), secPath = this.path(chunkNo, "secondary"), chunkPath = this.path(chunkNo, "chunk");
        let offsets: number[] = [0];
        let secBytes = new Uint8Array(0);
        if (existsSync(priPath)) {
            try {
                offsets = decodePrimary(await Bun.file(priPath).bytes());
            } catch {
                offsets = [0];
            }
        }
        if (existsSync(secPath)) secBytes = await Bun.file(secPath).bytes();
        // A half-written secondary entry is dropped; the primary is cut back to what the secondary covers.
        const fullEntries = Math.floor(secBytes.length / SECONDARY_ENTRY_SIZE);
        const covered = fullEntries * SECONDARY_ENTRY_SIZE;
        while (offsets.length > 1 && offsets[offsets.length - 1]! > covered) offsets.pop();
        if (offsets.length === 0) offsets = [0];
        const filled = filledRelativeSlots(offsets);
        const entries: SecondaryEntry[] = [];
        for (let i = 0; i < Math.min(fullEntries, filled.length); i++) entries.push(decodeSecondaryEntry(secBytes, i, filled[i] === 0));
        // Chunk bytes the index covers = end of the last indexed block; the true end is the file size
        // when the file is intact, so compute the boundary from the last entry's block length.
        const chunkSize = await this.fileSize(chunkPath);
        let chunkBytes = chunkSize;
        if (entries.length) {
            const lastStart = entries[entries.length - 1]!.blockOffset;
            const tailBytes = await Bun.file(chunkPath).slice(lastStart, chunkSize).bytes();
            // The last block ends where its CBOR item ends.
            const len = tailBytes.length ? cborLen(tailBytes) : 0;
            chunkBytes = lastStart + len;
        } else chunkBytes = 0;
        if (chunkBytes !== chunkSize) await truncate(chunkPath, chunkBytes);
        if (entries.length !== fullEntries) await truncate(secPath, entries.length * SECONDARY_ENTRY_SIZE);
        const priNow = existsSync(priPath) ? await this.fileSize(priPath) : 0;
        if (priNow !== 1 + 4 * offsets.length) await Bun.write(priPath, encodePrimary(offsets));
        this.tail = { chunkNo, offsets, entries, chunkBytes };
    }

    /**
     * Append the next immutable block. `bytes` is the disk/wire envelope `[eraTag, block]`;
     * `hash` the header hash. Slots must be strictly increasing (an EBB shares its epoch's
     * first slot and is placed at relative slot 0 of a new chunk).
     */
    async append(block: { slot: number; hash: Uint8Array; bytes: Uint8Array; isEbb?: boolean; epoch?: number }): Promise<void> {
        if (this.readOnly) throw new Error("append: store opened read-only");
        const chunkNo = chunkNoOf(block.slot, this.chunkSlots);
        const isEbb = !!block.isEbb;
        if (this.tail && chunkNo < this.tail.chunkNo) throw new Error(`append: slot ${block.slot} is in chunk ${chunkNo}, store is at chunk ${this.tail.chunkNo}`);
        if (this.tail && chunkNo > this.tail.chunkNo) await this.finaliseTail();
        if (!this.tail || this.tail.chunkNo !== chunkNo) {
            await this.startChunk(chunkNo);
        }
        const t = this.tail!;
        const rel = isEbb ? 0 : relativeSlot(block.slot, chunkNo, this.chunkSlots);
        if (rel < t.offsets.length - 1) throw new Error(`append: slot ${block.slot} (relative ${rel}) is not after the last written relative slot ${t.offsets.length - 2}`);
        const h = locateHeader(block.bytes);
        const entry = { blockOffset: t.chunkBytes, headerOffset: h.headerOffset, headerSize: h.headerSize, crc: crc32(block.bytes), headerHash: block.hash, slotOrEbb: isEbb ? (block.epoch ?? 0) : block.slot };
        const secEnd = t.entries.length * SECONDARY_ENTRY_SIZE;
        // 1. chunk bytes
        await appendSync(this.path(chunkNo, "chunk"), block.bytes);
        // 2. secondary entry
        await appendSync(this.path(chunkNo, "secondary"), encodeSecondaryEntry(entry));
        // 3. primary: repeat the current end offset for the gap, then the new end
        const add: number[] = [];
        while (t.offsets.length + add.length < rel + 1) add.push(secEnd);
        add.push(secEnd + SECONDARY_ENTRY_SIZE);
        await appendSync(this.path(chunkNo, "primary"), encodePrimary(add).subarray(1));
        t.offsets.push(...add);
        t.entries.push({ ...entry, isEbb });
        t.chunkBytes += block.bytes.length;
        this.cache.delete(chunkNo);
        if (!isEbb && this.hashIndex) await this.hashIndex.add(block.hash, block.slot);
    }

    private async startChunk(chunkNo: number): Promise<void> {
        await Bun.write(this.path(chunkNo, "primary"), encodePrimary([0]));
        await Bun.write(this.path(chunkNo, "secondary"), new Uint8Array(0));
        await Bun.write(this.path(chunkNo, "chunk"), new Uint8Array(0));
        if (!this.chunkNos.includes(chunkNo)) this.chunkNos = [...this.chunkNos, chunkNo].sort((a, b) => a - b);
        this.tail = { chunkNo, offsets: [0], entries: [], chunkBytes: 0 };
    }

    /** Pad the open chunk's primary to its full length so the chunk is complete. */
    private async finaliseTail(): Promise<void> {
        const t = this.tail;
        if (!t) return;
        const want = primaryOffsetCount(this.chunkSlots);
        if (t.offsets.length < want) {
            const last = t.offsets[t.offsets.length - 1]!;
            const add = new Array<number>(want - t.offsets.length).fill(last);
            await appendSync(this.path(t.chunkNo, "primary"), encodePrimary(add).subarray(1));
            t.offsets.push(...add);
        }
        this.cache.set(t.chunkNo, { chunkNo: t.chunkNo, offsets: t.offsets, entries: t.entries, chunkBytes: t.chunkBytes });
        this.tail = null;
    }

    /**
     * Drop every block above `slot`: later chunks are deleted, the chunk holding `slot` is
     * rewritten with only its entries at or below it (chunk bytes, secondary entries, primary
     * offsets up to that relative slot). Used by the snapshot bootstrap to align the chunk store
     * with the imported ledger state. Returns the number of blocks removed.
     */
    async truncateAfter(slot: number): Promise<number> {
        if (this.readOnly) throw new Error("truncateAfter: store opened read-only");
        const keepChunk = chunkNoOf(slot, this.chunkSlots);
        let removed = 0;
        const { unlink } = await import("node:fs/promises");
        for (const n of [...this.chunkNos]) {
            if (n <= keepChunk) continue;
            const idx = await this.index(n);
            removed += idx?.entries.length ?? 0;
            for (const ext of ["chunk", "primary", "secondary"] as const) await unlink(this.path(n, ext)).catch(() => {});
            this.cache.delete(n);
        }
        this.chunkNos = this.chunkNos.filter((n) => n <= keepChunk);
        if (this.tail && this.tail.chunkNo > keepChunk) this.tail = null;
        const idx = await this.index(keepChunk);
        if (idx) {
            const keep = idx.entries.filter((e) => e.isEbb || e.slotOrEbb <= slot);
            if (keep.length !== idx.entries.length) {
                removed += idx.entries.length - keep.length;
                const cutBytes = keep.length ? (idx.entries[keep.length] ? idx.entries[keep.length]!.blockOffset : idx.chunkBytes) : 0;
                const rel = keep.length ? (keep[keep.length - 1]!.isEbb ? 0 : relativeSlot(keep[keep.length - 1]!.slotOrEbb, keepChunk, this.chunkSlots)) : -1;
                const offsets = idx.offsets.slice(0, rel + 2); // through the kept block's end offset
                await truncate(this.path(keepChunk, "chunk"), cutBytes);
                await truncate(this.path(keepChunk, "secondary"), keep.length * SECONDARY_ENTRY_SIZE);
                await Bun.write(this.path(keepChunk, "primary"), encodePrimary(offsets));
                this.cache.delete(keepChunk);
                this.tail = { chunkNo: keepChunk, offsets, entries: keep, chunkBytes: cutBytes };
            } else if (this.tail?.chunkNo !== keepChunk) {
                // the kept chunk is now the open one: load it as the tail (padding is undone on the next append)
                await this.recoverTail();
            }
        }
        return removed;
    }

    /** Finalise the open chunk when the store is closed at a chunk boundary (optional). */
    async close(): Promise<void> {
        /* files are synced per append; nothing to flush */
    }
}

async function appendSync(path: string, bytes: Uint8Array): Promise<void> {
    const fh = await openFile(path, "a");
    try {
        await fh.write(bytes);
        await fh.sync();
    } finally {
        await fh.close();
    }
}

/** Encoded length of the CBOR item at the start of `b` (0 when truncated). */
function cborLen(b: Uint8Array): number {
    try {
        const n = cborItemLength(b, 0);
        return n <= b.length ? n : 0;
    } catch {
        return 0;
    }
}
