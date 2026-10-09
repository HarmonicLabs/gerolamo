/**
 * VolatileStore: the last k blocks and any fork branches, in cardano-node's VolatileDB file
 * format (docs/PLAN_CHUNK_STORE.md, design point 2).
 *
 * `volatile/blocks-N.dat` files hold disk-encoded blocks (`[eraTag, block]`, the same bytes the
 * chunk files store) back to back, at most `blocksPerFile` per file (the node's default 1000);
 * the node rebuilds its index by parsing the files on start, and so do we. Blocks are keyed by
 * header hash; several blocks may share a slot (forks). Garbage collection removes whole files
 * once every block in them is at or below the immutable slot, as the node does. A cardano-node
 * started on the directory picks these blocks up like its own.
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { existsSync } from "node:fs";
import { mkdir, open as openFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { cborItemLength, locateHeader } from "./chunkFormat";

export interface VolatileBlock {
    hash: Uint8Array;
    /** Previous block's header hash (null only for the first block of the chain). */
    prevHash: Uint8Array | null;
    slot: number;
    bytes: Uint8Array;
    headerOffset: number;
    headerSize: number;
    eraTag: number;
    /** File the block lives in. */
    fileNo: number;
}

/**
 * When block files are fsynced (GEROLAMO_BLOCK_FSYNC). `batch` (default): `put` writes to the page cache and
 * `flush()` fdatasyncs every file touched since, once per applied range, before the range's commit (the way
 * the ledger diffs are flushed, bug 380) — 4 serial fsyncs per block were most of a sync's wall time on a
 * busy disk (bug 384). `block`: fsync inside every `put` (the old behaviour). `0`: never (tests, scratch).
 */
export type BlockSyncPolicy = "batch" | "block" | "none";
export function blockSyncPolicy(): BlockSyncPolicy {
    const v = (process.env.GEROLAMO_BLOCK_FSYNC ?? "").trim().toLowerCase();
    if (v === "block") return "block";
    if (v === "0" || v === "none" || v === "off") return "none";
    return "batch";
}

export interface VolatileStoreOptions {
    blocksPerFile?: number;
    /** Default: `blockSyncPolicy()` (GEROLAMO_BLOCK_FSYNC). */
    syncPolicy?: BlockSyncPolicy;
    /** Never modify the directory (no torn-tail truncation, `put`/`gc` refused): for a running node's files. */
    readOnly?: boolean;
}

const FILE_RE = /^blocks-(\d+)\.dat$/;

export class VolatileStore {
    readonly dir: string;
    readonly blocksPerFile: number;
    readonly readOnly: boolean;
    private readonly byHash = new Map<string, VolatileBlock>();
    private readonly perFile = new Map<number, Set<string>>();
    private currentFile = 0;
    private currentCount = 0;
    readonly syncPolicy: BlockSyncPolicy;
    /** Files written since the last `flush()` (batched policy). */
    private readonly unsynced = new Set<number>();

    private constructor(dir: string, opts: VolatileStoreOptions) {
        this.dir = dir;
        this.blocksPerFile = opts.blocksPerFile ?? 1000;
        this.syncPolicy = opts.syncPolicy ?? blockSyncPolicy();
        this.readOnly = !!opts.readOnly;
    }

    static async open(dir: string, opts: VolatileStoreOptions = {}): Promise<VolatileStore> {
        if (!opts.readOnly) await mkdir(dir, { recursive: true });
        else if (!existsSync(dir)) return new VolatileStore(dir, opts);
        const store = new VolatileStore(dir, opts);
        await store.replay();
        return store;
    }

    get size(): number {
        return this.byHash.size;
    }

    private static key(hash: Uint8Array): string {
        return Buffer.from(hash).toString("hex");
    }

    /** Header hash of a disk-encoded block. Byron hashes the `[kind, header]` wrapper (kind 0 EBB, 1 regular). */
    static hashOf(bytes: Uint8Array, h = locateHeader(bytes)): Uint8Array {
        const header = bytes.subarray(h.headerOffset, h.headerOffset + h.headerSize);
        if (h.eraTag <= 1) {
            const wrapped = new Uint8Array(2 + header.length);
            wrapped[0] = 0x82;
            wrapped[1] = h.eraTag;
            wrapped.set(header, 2);
            return new Uint8Array(blake2b_256(wrapped));
        }
        return new Uint8Array(blake2b_256(header));
    }

    private async replay(): Promise<void> {
        const names = (await readdir(this.dir)).filter((n) => FILE_RE.test(n));
        const nos = names.map((n) => Number(FILE_RE.exec(n)![1])).sort((a, b) => a - b);
        for (const fileNo of nos) {
            const path = join(this.dir, `blocks-${fileNo}.dat`);
            const bytes = await Bun.file(path).bytes();
            let p = 0, count = 0, good = 0;
            while (p < bytes.length) {
                let len: number;
                try {
                    len = cborItemLength(bytes, p);
                } catch {
                    len = 0;
                }
                if (len <= 0 || p + len > bytes.length) break; // torn tail
                const blk = bytes.slice(p, p + len);
                let rec: VolatileBlock;
                try {
                    const h = locateHeader(blk);
                    rec = { hash: VolatileStore.hashOf(blk, h), prevHash: prevHashOf(blk, h), slot: slotOf(blk, h), bytes: blk, headerOffset: h.headerOffset, headerSize: h.headerSize, eraTag: h.eraTag, fileNo };
                } catch {
                    break; // not a block: a tail the OS zero-filled or cut after a power loss (writes are batched, bug 384)
                }
                this.remember(rec);
                p += len;
                good = p;
                count++;
            }
            if (good !== bytes.length && !this.readOnly) {
                const fh = await openFile(path, "r+");
                try {
                    await fh.truncate(good);
                } finally {
                    await fh.close();
                }
            }
            this.currentFile = fileNo;
            this.currentCount = count;
        }
        if (nos.length === 0) {
            this.currentFile = 0;
            this.currentCount = 0;
        }
    }

    private remember(b: VolatileBlock): void {
        const k = VolatileStore.key(b.hash);
        this.byHash.set(k, b);
        let set = this.perFile.get(b.fileNo);
        if (!set) this.perFile.set(b.fileNo, (set = new Set()));
        set.add(k);
    }

    has(hash: Uint8Array): boolean {
        return this.byHash.has(VolatileStore.key(hash));
    }

    get(hash: Uint8Array): VolatileBlock | undefined {
        return this.byHash.get(VolatileStore.key(hash));
    }

    /** All blocks at a slot (more than one on a fork). */
    atSlot(slot: number): VolatileBlock[] {
        const out: VolatileBlock[] = [];
        for (const b of this.byHash.values()) if (b.slot === slot) out.push(b);
        return out;
    }

    /** Every stored block, ascending by slot. */
    all(): VolatileBlock[] {
        return [...this.byHash.values()].sort((a, b) => a.slot - b.slot);
    }

    /** Store a block (idempotent by hash). `hash` may be given to skip recomputation. */
    async put(bytes: Uint8Array, hash?: Uint8Array): Promise<VolatileBlock> {
        if (this.readOnly) throw new Error("put: volatile store opened read-only");
        const h = locateHeader(bytes);
        const hh = hash ?? VolatileStore.hashOf(bytes, h);
        const existing = this.byHash.get(VolatileStore.key(hh));
        if (existing) return existing;
        if (this.currentCount >= this.blocksPerFile) {
            this.currentFile++;
            this.currentCount = 0;
        }
        const path = join(this.dir, `blocks-${this.currentFile}.dat`);
        const fh = await openFile(path, "a");
        try {
            await fh.write(bytes);
            if (this.syncPolicy === "block") await fh.sync();
        } finally {
            await fh.close();
        }
        if (this.syncPolicy === "batch") this.unsynced.add(this.currentFile);
        this.currentCount++;
        const b: VolatileBlock = { hash: hh, prevHash: prevHashOf(bytes, h), slot: slotOf(bytes, h), bytes, headerOffset: h.headerOffset, headerSize: h.headerSize, eraTag: h.eraTag, fileNo: this.currentFile };
        this.remember(b);
        return b;
    }

    /** Blocks written but not yet durable (batched policy): the count of files to sync. */
    pendingFiles(): number {
        return this.unsynced.size;
    }

    /**
     * Make every block written so far durable: fdatasync each file touched since the last flush (in
     * parallel). Called once per applied range before its commit, and before a promotion into the chunks.
     */
    async flush(): Promise<number> {
        if (!this.unsynced.size) return 0;
        const files = [...this.unsynced];
        this.unsynced.clear();
        await Promise.all(files.map(async (fileNo) => {
            let fh;
            try { fh = await openFile(join(this.dir, `blocks-${fileNo}.dat`), "r+"); }
            catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; this.unsynced.add(fileNo); throw err; } // collected meanwhile
            try { await fh.datasync(); }
            catch (err) { this.unsynced.add(fileNo); throw err; }
            finally { await fh.close(); }
        }));
        return files.length;
    }

    /**
     * Drop every file whose blocks are all at or below `immutableSlot` (they are in the chunk
     * store now, or on a dead fork below it). Returns the number of blocks removed.
     */
    async gc(immutableSlot: number): Promise<number> {
        if (this.readOnly) return 0;
        let removed = 0;
        for (const [fileNo, keys] of [...this.perFile.entries()]) {
            if (fileNo === this.currentFile && this.currentCount < this.blocksPerFile && keys.size > 0) {
                // the open file is only removable when it is also fully below the immutable slot and closed
            }
            let allBelow = true;
            for (const k of keys) if (this.byHash.get(k)!.slot > immutableSlot) { allBelow = false; break; }
            if (!allBelow) continue;
            if (fileNo === this.currentFile) {
                // roll to a fresh file so the current one can go
                this.currentFile++;
                this.currentCount = 0;
            }
            await rm(join(this.dir, `blocks-${fileNo}.dat`), { force: true });
            this.unsynced.delete(fileNo);
            for (const k of keys) this.byHash.delete(k);
            removed += keys.size;
            this.perFile.delete(fileNo);
        }
        return removed;
    }

    /** Bytes on disk (for stats). */
    async diskBytes(): Promise<number> {
        let total = 0;
        for (const fileNo of this.perFile.keys()) {
            const p = join(this.dir, `blocks-${fileNo}.dat`);
            if (existsSync(p)) total += (await stat(p)).size;
        }
        return total;
    }
}

/**
 * Slot of a disk-encoded block from its header. Shelley-era headers: `[[block_no, slot, …], sig]`;
 * Byron regular: `[protocolMagic, prevHash, bodyProof, [slotId = [epoch, slot], …], …]` where the
 * epoch/slot pair is Byron-relative (epoch · epochSlots + slot); EBB headers carry an epoch only.
 */
export function slotOf(bytes: Uint8Array, h = locateHeader(bytes), byronEpochSlots = 21600): number {
    const hdr = bytes.subarray(h.headerOffset, h.headerOffset + h.headerSize);
    if (h.eraTag >= 2) {
        // 0x82 [ 0x8f/0x8a body [ block_no, slot, ...
        let p = 1; // skip header array head (definite, ≤ 23 elements → 1 byte)
        p += headLen(hdr, p); // body array head
        const bn = uintAt(hdr, p); p += bn.len;
        return uintAt(hdr, p).value;
    }
    // Byron
    let p = headLen(hdr, 0); // header array head
    p += skipItem(hdr, p); // protocol magic
    p += skipItem(hdr, p); // prev hash
    p += skipItem(hdr, p); // body proof
    // consensus data: EBB [epoch, difficulty]; regular [slotId=[epoch, slot], pubkey, difficulty, sig]
    p += headLen(hdr, p); // consensus array head
    if (h.eraTag === 0) return uintAt(hdr, p).value * byronEpochSlots;
    p += headLen(hdr, p); // slotId array head
    const epoch = uintAt(hdr, p); p += epoch.len;
    const slot = uintAt(hdr, p);
    return epoch.value * byronEpochSlots + slot.value;
}

/** Block number from a Shelley-era header body `[block_no, slot, …]`; Byron blocks carry no number (null). */
export function blockNoOf(bytes: Uint8Array, h = locateHeader(bytes)): number | null {
    if (h.eraTag < 2) return null;
    const hdr = bytes.subarray(h.headerOffset, h.headerOffset + h.headerSize);
    let p = 1;
    p += headLen(hdr, p);
    return uintAt(hdr, p).value;
}

/** Previous header hash from the header: Shelley-era body `[block_no, slot, prev_hash | null, …]`, Byron `[magic, prev_hash, …]`. */
export function prevHashOf(bytes: Uint8Array, h = locateHeader(bytes)): Uint8Array | null {
    const hdr = bytes.subarray(h.headerOffset, h.headerOffset + h.headerSize);
    let p: number;
    if (h.eraTag >= 2) {
        p = 1;
        p += headLen(hdr, p); // body head
        p += skipItem(hdr, p); // block_no
        p += skipItem(hdr, p); // slot
    } else {
        p = headLen(hdr, 0);
        p += skipItem(hdr, p); // protocol magic
    }
    if (hdr[p] === 0xf6) return null;
    if (hdr[p]! >> 5 !== 2) throw new Error(`expected prev hash bytes at ${p}, got 0x${hdr[p]!.toString(16)}`);
    const len = hdr[p]! & 0x1f;
    const start = p + (len < 24 ? 1 : 2);
    const n = len < 24 ? len : hdr[p + 1]!;
    return hdr.slice(start, start + n);
}

function headLen(b: Uint8Array, p: number): number {
    const ai = b[p]! & 0x1f;
    return ai < 24 ? 1 : ai === 24 ? 2 : ai === 25 ? 3 : ai === 26 ? 5 : ai === 27 ? 9 : 1;
}

function uintAt(b: Uint8Array, p: number): { value: number; len: number } {
    if (b[p]! >> 5 !== 0) throw new Error(`expected uint at ${p}, got 0x${b[p]!.toString(16)}`);
    const ai = b[p]! & 0x1f;
    if (ai < 24) return { value: ai, len: 1 };
    const dv = new DataView(b.buffer, b.byteOffset + p + 1);
    if (ai === 24) return { value: dv.getUint8(0), len: 2 };
    if (ai === 25) return { value: dv.getUint16(0, false), len: 3 };
    if (ai === 26) return { value: dv.getUint32(0, false), len: 5 };
    return { value: Number(dv.getBigUint64(0, false)), len: 9 };
}

function skipItem(b: Uint8Array, p: number): number {
    return cborItemLength(b, p);
}
