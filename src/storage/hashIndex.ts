/**
 * Header-hash → slot index for the ChunkStore (docs/PLAN_CHUNK_STORE.md, design point 3).
 *
 * cardano-node's format has no hash lookup; chain-sync `findIntersect`, block-fetch by point
 * and the explorer need one. Layout: an append-only record file `hash-index.bin` in slot order
 * (40 bytes per block: 32-byte hash, u64 slot) kept beside the immutable directory, plus an
 * in-memory open-addressing table keyed by the hash's first 8 bytes → slot, rebuilt from the
 * record file on open (a few seconds for 5 M blocks, 16 bytes per slot of table). A hit is
 * confirmed by the caller against the chunk's secondary entry, so the table never needs the
 * full hash. When the record file is missing or behind the store, `rebuild()` regenerates it
 * from the secondary indices (no block bytes read).
 */
import { existsSync } from "node:fs";
import { mkdir, open as openFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const HASH_INDEX_RECORD = 40;

export class HashIndex {
    readonly path: string;
    private keys!: BigUint64Array; // hash prefix (first 8 bytes, big-endian) + 1, 0 = empty
    private vals!: Float64Array; // slot
    private count = 0;
    private capacity = 0;
    /** Highest slot recorded (for catching up with the store). */
    maxSlot = -1;
    /** The record file's directory exists (created once: a mkdir per appended block was 1–3 % of a sync's main thread, bug 382). */
    private dirReady = false;

    private constructor(path: string) {
        this.path = path;
    }

    static async open(path: string, expectedBlocks = 1_000_000): Promise<HashIndex> {
        const ix = new HashIndex(path);
        ix.allocate(Math.max(expectedBlocks, 1024));
        if (existsSync(path)) await ix.load();
        return ix;
    }

    get size(): number {
        return this.count;
    }

    private allocate(n: number): void {
        let cap = 1024;
        while (cap < n * 2) cap *= 2; // load factor ≤ 0.5
        this.capacity = cap;
        this.keys = new BigUint64Array(cap);
        this.vals = new Float64Array(cap);
        this.count = 0;
    }

    private static prefix(hash: Uint8Array): bigint {
        const dv = new DataView(hash.buffer, hash.byteOffset, 8);
        return dv.getBigUint64(0, false) + 1n; // +1 so 0 marks an empty bucket
    }

    private insert(hash: Uint8Array, slot: number): void {
        if ((this.count + 1) * 2 > this.capacity) this.grow();
        const k = HashIndex.prefix(hash);
        const mask = BigInt(this.capacity - 1);
        let i = Number(k & mask);
        for (;;) {
            const cur = this.keys[i]!;
            if (cur === 0n) {
                this.keys[i] = k;
                this.vals[i] = slot;
                this.count++;
                return;
            }
            if (cur === k && this.vals[i] === slot) return; // duplicate append
            i = (i + 1) & (this.capacity - 1);
        }
    }

    private grow(): void {
        const oldK = this.keys, oldV = this.vals, oldCap = this.capacity;
        this.allocate(oldCap);
        for (let i = 0; i < oldCap; i++) {
            if (oldK[i] !== 0n) {
                const k = oldK[i]!;
                let j = Number(k & BigInt(this.capacity - 1));
                while (this.keys[j] !== 0n) j = (j + 1) & (this.capacity - 1);
                this.keys[j] = k;
                this.vals[j] = oldV[i]!;
                this.count++;
            }
        }
    }

    /**
     * Candidate slots for a hash (prefix collisions are possible; the caller confirms against the
     * block's header hash). Usually one element; empty when unknown.
     */
    lookup(hash: Uint8Array): number[] {
        const k = HashIndex.prefix(hash);
        const mask = this.capacity - 1;
        let i = Number(k & BigInt(mask));
        const out: number[] = [];
        for (;;) {
            const cur = this.keys[i]!;
            if (cur === 0n) return out;
            if (cur === k) out.push(this.vals[i]!);
            i = (i + 1) & mask;
        }
    }

    /** Record a block (persisted, in slot order). */
    async add(hash: Uint8Array, slot: number): Promise<void> {
        if (hash.length !== 32) throw new RangeError("hash must be 32 bytes");
        const rec = new Uint8Array(HASH_INDEX_RECORD);
        rec.set(hash, 0);
        new DataView(rec.buffer).setBigUint64(32, BigInt(slot), false);
        await this.ensureDir();
        const fh = await openFile(this.path, "a");
        try {
            await fh.write(rec);
        } finally {
            await fh.close();
        }
        this.insert(hash, slot);
        if (slot > this.maxSlot) this.maxSlot = slot;
    }

    /** Append many records with one file handle (rebuild / catch-up). */
    async addMany(items: Iterable<{ hash: Uint8Array; slot: number }>): Promise<number> {
        await this.ensureDir();
        const fh = await openFile(this.path, "a");
        let n = 0;
        try {
            let buf = new Uint8Array(HASH_INDEX_RECORD * 4096), used = 0;
            for (const it of items) {
                buf.set(it.hash, used);
                new DataView(buf.buffer).setBigUint64(used + 32, BigInt(it.slot), false);
                used += HASH_INDEX_RECORD;
                this.insert(it.hash, it.slot);
                if (it.slot > this.maxSlot) this.maxSlot = it.slot;
                n++;
                if (used === buf.length) {
                    await fh.write(buf);
                    used = 0;
                }
            }
            if (used) await fh.write(buf.subarray(0, used));
            await fh.sync();
        } finally {
            await fh.close();
        }
        return n;
    }

    private async ensureDir(): Promise<void> {
        if (this.dirReady) return;
        await mkdir(dirname(this.path), { recursive: true });
        this.dirReady = true;
    }

    private async load(): Promise<void> {
        const size = (await stat(this.path)).size;
        const whole = Math.floor(size / HASH_INDEX_RECORD) * HASH_INDEX_RECORD;
        const file = Bun.file(this.path);
        const step = HASH_INDEX_RECORD * 65536;
        for (let off = 0; off < whole; off += step) {
            const buf = await file.slice(off, Math.min(whole, off + step)).bytes();
            const dv = new DataView(buf.buffer, buf.byteOffset);
            for (let p = 0; p + HASH_INDEX_RECORD <= buf.length; p += HASH_INDEX_RECORD) {
                const slot = Number(dv.getBigUint64(p + 32, false));
                this.insert(buf.subarray(p, p + 32), slot);
                if (slot > this.maxSlot) this.maxSlot = slot;
            }
        }
        if (whole !== size) {
            // torn last record: drop it
            const fh = await openFile(this.path, "r+");
            try {
                await fh.truncate(whole);
            } finally {
                await fh.close();
            }
        }
    }
}
