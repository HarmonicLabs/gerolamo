/**
 * cardano-node's ImmutableDB on-disk format (ouroboros-consensus
 * `Storage/ImmutableDB/Impl/Index/{Primary,Secondary}.hs`), verified byte for byte against the
 * preview Mithril snapshot on 2026-09-14 (docs/PLAN_CHUNK_STORE.md):
 *
 * - `NNNNN.chunk`: the blocks of chunk N in slot order, each in the node's disk encoding (the
 *   block-fetch wire envelope `[eraTag, block]`, era tags 0 Byron EBB … 7 Conway), concatenated.
 * - `NNNNN.secondary`: one 56-byte big-endian entry per block:
 *   blockOffset u64 | headerOffset u16 | headerSize u16 | crc32 u32 | headerHash 32 | slotOrEbb u64.
 * - `NNNNN.primary`: version byte 1, then (chunkSlots + 2) u32 secondary offsets: relative slot 0
 *   is reserved for a Byron EBB, a regular block at absolute slot s sits at relative slot
 *   s − chunkStart + 1, an empty slot repeats the previous offset, the last offset is the size
 *   of the secondary file.
 *
 * A chunk covers 10·k slots (4 320 on preview/preprod, 21 600 on mainnet) in every era.
 */

export const SECONDARY_ENTRY_SIZE = 56;
export const PRIMARY_VERSION = 1;
export const HASH_SIZE = 32;

export interface SecondaryEntry {
    /** Offset of the block's first byte in the chunk file. */
    blockOffset: number;
    /** Offset of the header inside the block bytes (3 for every hard-fork-combinator block). */
    headerOffset: number;
    headerSize: number;
    /** CRC-32 (IEEE, as `Bun.hash.crc32`) of the block bytes. */
    crc: number;
    headerHash: Uint8Array;
    /** Slot number for a regular block, epoch number for a Byron EBB. */
    slotOrEbb: number;
    isEbb: boolean;
}

/** Slots per chunk from the security parameter (`10 · k`). */
export function chunkSlotsFor(k: number): number {
    return 10 * k;
}

export function chunkFileName(chunkNo: number, ext: "chunk" | "primary" | "secondary"): string {
    return `${chunkNo.toString().padStart(5, "0")}.${ext}`;
}

/** Number of secondary offsets a finalised primary file holds: EBB slot + chunkSlots slots + end marker. */
export function primaryOffsetCount(chunkSlots: number): number {
    return chunkSlots + 2;
}

export function primaryFileSize(chunkSlots: number): number {
    return 1 + 4 * primaryOffsetCount(chunkSlots);
}

/** Relative slot (index into the primary offsets) of a regular block. */
export function relativeSlot(slot: number, chunkNo: number, chunkSlots: number): number {
    return slot - chunkNo * chunkSlots + 1;
}

export function chunkNoOf(slot: number, chunkSlots: number): number {
    return Math.floor(slot / chunkSlots);
}

export function decodeSecondaryEntry(sec: Uint8Array, index: number, isEbb = false): SecondaryEntry {
    const o = index * SECONDARY_ENTRY_SIZE;
    if (o + SECONDARY_ENTRY_SIZE > sec.length) throw new RangeError(`secondary entry ${index} past end (${sec.length} bytes)`);
    const dv = new DataView(sec.buffer, sec.byteOffset + o, SECONDARY_ENTRY_SIZE);
    return {
        blockOffset: Number(dv.getBigUint64(0, false)),
        headerOffset: dv.getUint16(8, false),
        headerSize: dv.getUint16(10, false),
        crc: dv.getUint32(12, false),
        headerHash: sec.slice(o + 16, o + 48),
        slotOrEbb: Number(dv.getBigUint64(48, false)),
        isEbb,
    };
}

export function encodeSecondaryEntry(e: Omit<SecondaryEntry, "isEbb">): Uint8Array {
    if (e.headerHash.length !== HASH_SIZE) throw new RangeError(`header hash must be ${HASH_SIZE} bytes`);
    const out = new Uint8Array(SECONDARY_ENTRY_SIZE);
    const dv = new DataView(out.buffer);
    dv.setBigUint64(0, BigInt(e.blockOffset), false);
    dv.setUint16(8, e.headerOffset, false);
    dv.setUint16(10, e.headerSize, false);
    dv.setUint32(12, e.crc >>> 0, false);
    out.set(e.headerHash, 16);
    dv.setBigUint64(48, BigInt(e.slotOrEbb), false);
    return out;
}

/** The u32 offsets of a primary file (version byte checked). */
export function decodePrimary(pri: Uint8Array): number[] {
    if (pri.length < 1 || pri[0] !== PRIMARY_VERSION) throw new Error(`primary index version ${pri[0]} (expected ${PRIMARY_VERSION})`);
    if ((pri.length - 1) % 4 !== 0) throw new Error(`primary index size ${pri.length} is not 1 + 4n`);
    const n = (pri.length - 1) / 4;
    const dv = new DataView(pri.buffer, pri.byteOffset + 1, n * 4);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, false);
    return out;
}

export function encodePrimary(offsets: number[]): Uint8Array {
    const out = new Uint8Array(1 + 4 * offsets.length);
    out[0] = PRIMARY_VERSION;
    const dv = new DataView(out.buffer, 1);
    offsets.forEach((x, i) => dv.setUint32(i * 4, x, false));
    return out;
}

/**
 * Relative slots that hold a block, in order, from the primary offsets: slot i is filled when
 * offsets[i + 1] > offsets[i]. The k-th filled slot corresponds to secondary entry k.
 */
export function filledRelativeSlots(offsets: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < offsets.length; i++) if (offsets[i + 1]! > offsets[i]!) out.push(i);
    return out;
}

declare const Bun: { hash?: { crc32?: (b: Uint8Array) => number } } | undefined;
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
/** CRC-32 (IEEE): Bun's native routine when running under Bun, the table otherwise (browser build). */
export function crc32(bytes: Uint8Array): number {
    if (typeof Bun !== "undefined" && Bun?.hash?.crc32) return Bun.hash.crc32(bytes) >>> 0;
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Where the header sits in a disk-encoded block: after the 2-element envelope `[eraTag, block]`
 * and the block array's own head byte the header array starts. Returns offset and encoded size
 * (the header is a definite-length CBOR array; its size is found by skipping it).
 */
export function locateHeader(block: Uint8Array): { headerOffset: number; headerSize: number; eraTag: number } {
    if (block[0] !== 0x82) throw new Error(`disk block must start with a 2-element array, got 0x${block[0]?.toString(16)}`);
    const eraTag = block[1]!;
    if (eraTag > 23) throw new Error(`unexpected era tag byte 0x${eraTag.toString(16)}`);
    // Every era, Byron included (verified on preprod chunk 0: EBB `[0, [hdr, body, extra]]`, regular
    // `[1, [hdr, body, extra]]`): the header is the first element of the inner block array.
    let p = 2;
    const blockHead = block[p]!;
    if ((blockHead & 0xe0) !== 0x80) throw new Error(`block is not a CBOR array (0x${blockHead.toString(16)})`);
    p += cborHeadLength(block, p);
    const headerSize = cborItemLength(block, p);
    return { headerOffset: p, headerSize, eraTag };
}

/** Length in bytes of the head (initial byte + argument) of the CBOR item at p. */
function cborHeadLength(b: Uint8Array, p: number): number {
    const ai = b[p]! & 0x1f;
    if (ai < 24) return 1;
    if (ai === 24) return 2;
    if (ai === 25) return 3;
    if (ai === 26) return 5;
    if (ai === 27) return 9;
    if (ai === 31) return 1; // indefinite
    throw new Error(`reserved CBOR additional info ${ai} at ${p}`);
}

/** Argument value of the CBOR head at p (lengths / counts); undefined for indefinite. */
function cborArg(b: Uint8Array, p: number): number | undefined {
    const ai = b[p]! & 0x1f;
    if (ai < 24) return ai;
    const dv = new DataView(b.buffer, b.byteOffset + p + 1);
    if (ai === 24) return dv.getUint8(0);
    if (ai === 25) return dv.getUint16(0, false);
    if (ai === 26) return dv.getUint32(0, false);
    if (ai === 27) return Number(dv.getBigUint64(0, false));
    return undefined;
}

/** Encoded length of the whole CBOR item at p (skips nested items; handles indefinite forms). */
export function cborItemLength(b: Uint8Array, p: number): number {
    const start = p;
    const stack: number[] = [1]; // items still to consume per nesting level
    while (stack.length) {
        if (stack[stack.length - 1] === 0) { stack.pop(); continue; }
        const major = b[p]! >> 5;
        const ai = b[p]! & 0x1f;
        const head = cborHeadLength(b, p);
        const arg = cborArg(b, p);
        if (b[p] === 0xff) { // break of an indefinite container
            p += 1;
            stack.pop();
            continue;
        }
        stack[stack.length - 1]!--;
        switch (major) {
            case 0: case 1: case 7: p += head; break;
            case 2: case 3:
                if (arg === undefined) { p += head; stack.push(Infinity); } else p += head + arg;
                break;
            case 4:
                p += head; stack.push(arg === undefined ? Infinity : arg); break;
            case 5:
                p += head; stack.push(arg === undefined ? Infinity : arg * 2); break;
            case 6:
                p += head; stack.push(1); break;
            default: throw new Error(`bad CBOR major ${major}`);
        }
        void ai;
    }
    return p - start;
}
