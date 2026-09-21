/**
 * Browser-side chunk writer: verified blocks go into cardano-node-format chunk files
 * (`NNNNN.chunk|primary|secondary`, see src/storage/chunkFormat.ts) through a `FileSink`
 * (OPFS in the page, memory in tests). A light client syncing from the tip starts mid-chunk:
 * the primary index is filled with repeated 0 offsets up to the first stored slot, which is a
 * valid index for a chunk whose earlier slots are empty. The open chunk is kept in memory and
 * its three files rewritten on every append (≤ 1 MB each); finished chunks are written once.
 */
import {
    SECONDARY_ENTRY_SIZE,
    chunkFileName,
    crc32,
    chunkNoOf,
    encodePrimary,
    encodeSecondaryEntry,
    locateHeader,
    primaryOffsetCount,
    relativeSlot,
} from "../../../src/storage/chunkFormat";

export interface FileSink {
    write(name: string, bytes: Uint8Array): Promise<void>;
    read(name: string): Promise<Uint8Array | null>;
    list(): Promise<string[]>;
    remove?(name: string): Promise<void>;
}

export interface ChunkWriterState {
    chunkNo: number;
    offsets: number[];
    entries: Uint8Array[]; // encoded secondary entries
    chunkBytes: Uint8Array[];
    bytes: number;
    lastSlot: number;
}

export class ChunkWriter {
    private open: ChunkWriterState | null = null;
    private stored = 0;
    private storedBytes = 0;
    private chunksDone = 0;

    constructor(private readonly sink: FileSink, readonly chunkSlots: number) {}

    get stats() { return { blocks: this.stored, bytes: this.storedBytes, chunks: this.chunksDone + (this.open ? 1 : 0), openChunk: this.open?.chunkNo ?? null }; }

    /** Resume: find the highest chunk on the sink and reload it as the open chunk. */
    async resume(): Promise<{ lastSlot: number; chunkNo: number } | null> {
        const names = await this.sink.list();
        const nos = names.filter((n) => /^\d{5}\.chunk$/.test(n)).map((n) => Number(n.slice(0, 5))).sort((a, b) => a - b);
        if (!nos.length) return null;
        this.chunksDone = nos.length - 1;
        const chunkNo = nos[nos.length - 1]!;
        const [chunk, pri, sec] = await Promise.all([this.sink.read(chunkFileName(chunkNo, "chunk")), this.sink.read(chunkFileName(chunkNo, "primary")), this.sink.read(chunkFileName(chunkNo, "secondary"))]);
        if (!chunk || !pri || !sec) return null;
        const offsets: number[] = []; const dv = new DataView(pri.buffer, pri.byteOffset);
        for (let i = 1; i + 4 <= pri.length; i += 4) offsets.push(dv.getUint32(i, false));
        const entries: Uint8Array[] = []; for (let o = 0; o + SECONDARY_ENTRY_SIZE <= sec.length; o += SECONDARY_ENTRY_SIZE) entries.push(sec.slice(o, o + SECONDARY_ENTRY_SIZE));
        const lastEntry = entries[entries.length - 1];
        const lastSlot = lastEntry ? Number(new DataView(lastEntry.buffer, lastEntry.byteOffset).getBigUint64(48, false)) : -1;
        this.open = { chunkNo, offsets, entries, chunkBytes: [chunk], bytes: chunk.length, lastSlot };
        return lastSlot >= 0 ? { lastSlot, chunkNo } : null;
    }

    /** Append a verified block (`[era, block]` bytes, header hash). Slots must increase. */
    async append(slot: number, hash: Uint8Array, bytes: Uint8Array): Promise<void> {
        const chunkNo = chunkNoOf(slot, this.chunkSlots);
        if (this.open && chunkNo < this.open.chunkNo) throw new Error(`append: slot ${slot} is below the open chunk ${this.open.chunkNo}`);
        if (this.open && slot <= this.open.lastSlot) return; // duplicate (rollback re-stream)
        if (this.open && chunkNo > this.open.chunkNo) await this.finalise();
        if (!this.open) this.open = { chunkNo, offsets: [0], entries: [], chunkBytes: [], bytes: 0, lastSlot: -1 };
        const o = this.open;
        const rel = relativeSlot(slot, chunkNo, this.chunkSlots);
        const h = locateHeader(bytes);
        const secEnd = o.entries.length * SECONDARY_ENTRY_SIZE;
        o.entries.push(encodeSecondaryEntry({ blockOffset: o.bytes, headerOffset: h.headerOffset, headerSize: h.headerSize, crc: crc32(bytes), headerHash: hash, slotOrEbb: slot }));
        while (o.offsets.length < rel + 1) o.offsets.push(secEnd);
        o.offsets.push(secEnd + SECONDARY_ENTRY_SIZE);
        o.chunkBytes.push(bytes);
        o.bytes += bytes.length;
        o.lastSlot = slot;
        this.stored++; this.storedBytes += bytes.length;
        await this.flush();
    }

    private async flush(): Promise<void> {
        const o = this.open!;
        await this.sink.write(chunkFileName(o.chunkNo, "chunk"), concatAll(o.chunkBytes));
        await this.sink.write(chunkFileName(o.chunkNo, "secondary"), concatAll(o.entries));
        await this.sink.write(chunkFileName(o.chunkNo, "primary"), encodePrimary(o.offsets));
    }

    /** Pad the open chunk's primary to its full length (the chunk is complete). */
    private async finalise(): Promise<void> {
        const o = this.open!;
        const want = primaryOffsetCount(this.chunkSlots);
        const last = o.offsets[o.offsets.length - 1]!;
        while (o.offsets.length < want) o.offsets.push(last);
        await this.flush();
        this.chunksDone++;
        this.open = null;
    }
}

function concatAll(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

/** In-memory sink (tests, probes). */
export class MemorySink implements FileSink {
    readonly files = new Map<string, Uint8Array>();
    async write(name: string, bytes: Uint8Array) { this.files.set(name, bytes.slice()); }
    async read(name: string) { return this.files.get(name) ?? null; }
    async list() { return [...this.files.keys()]; }
    async remove(name: string) { this.files.delete(name); }
}
