/**
 * Minimal CBOR walking over raw bytes (no object tree): positions of array items and map
 * entries, unsigned/signed integers, byte and text strings, exact item slices. Used by the
 * explorer projection (worker thread) and the Blockfrost-compatible API to read blocks and
 * transactions without a full ledger decode, and to keep the original bytes for hashing.
 * Pure: imports nothing that touches the database.
 */
import { cborItemLength } from "../../storage/chunkFormat";

export interface CborHead { major: number; value: number; big: bigint; len: number; indef: boolean }

export function head(b: Uint8Array, p: number): CborHead {
    const ib = b[p];
    if (ib === undefined) throw new Error(`cbor: read past end at ${p}`);
    const major = ib >> 5, info = ib & 31;
    if (info < 24) return { major, value: info, big: BigInt(info), len: 1, indef: false };
    if (info === 24) return { major, value: b[p + 1]!, big: BigInt(b[p + 1]!), len: 2, indef: false };
    if (info === 25) { const v = (b[p + 1]! << 8) | b[p + 2]!; return { major, value: v, big: BigInt(v), len: 3, indef: false }; }
    const dv = new DataView(b.buffer, b.byteOffset + p + 1);
    if (info === 26) { const v = dv.getUint32(0, false); return { major, value: v, big: BigInt(v), len: 5, indef: false }; }
    if (info === 27) { const v = dv.getBigUint64(0, false); return { major, value: Number(v), big: v, len: 9, indef: false }; }
    if (info === 31) return { major, value: -1, big: -1n, len: 1, indef: true };
    throw new Error(`cbor: reserved additional info ${info}`);
}

export const itemLength = cborItemLength;
export const itemEnd = (b: Uint8Array, p: number): number => p + cborItemLength(b, p);
export const slice = (b: Uint8Array, p: number): Uint8Array => b.subarray(p, p + cborItemLength(b, p));

/** Skip any tags (e.g. 258 sets, 24 embedded CBOR) in front of an item. */
export function untag(b: Uint8Array, p: number): number {
    while ((b[p]! >> 5) === 6) p += head(b, p).len;
    return p;
}

export function tagOf(b: Uint8Array, p: number): bigint | null {
    const h = head(b, p);
    return h.major === 6 ? h.big : null;
}

export function isArray(b: Uint8Array, p: number): boolean { return (b[untag(b, p)]! >> 5) === 4; }
export function isMap(b: Uint8Array, p: number): boolean { return (b[untag(b, p)]! >> 5) === 5; }
export const isNull = (b: Uint8Array, p: number): boolean => b[p] === 0xf6 || b[p] === 0xf7;

/** Item positions of the array at p (tags skipped, definite or indefinite). */
export function items(b: Uint8Array, p: number): number[] {
    p = untag(b, p);
    const h = head(b, p);
    if (h.major !== 4) throw new Error(`cbor: expected array at ${p}, major ${h.major}`);
    const out: number[] = [];
    let q = p + h.len;
    if (h.indef) { while (b[q] !== 0xff) { out.push(q); q += cborItemLength(b, q); } return out; }
    for (let i = 0; i < h.value; i++) { out.push(q); q += cborItemLength(b, q); }
    return out;
}

/** [key position, value position] pairs of the map at p. */
export function entries(b: Uint8Array, p: number): Array<[number, number]> {
    p = untag(b, p);
    const h = head(b, p);
    if (h.major !== 5) throw new Error(`cbor: expected map at ${p}, major ${h.major}`);
    const out: Array<[number, number]> = [];
    let q = p + h.len;
    for (let i = 0; h.indef ? b[q] !== 0xff : i < h.value; i++) { const k = q; q += cborItemLength(b, q); out.push([k, q]); q += cborItemLength(b, q); }
    return out;
}

/** Items of an array or the keys of a map (a CDDL `set` may be either in some eras). */
export function setItems(b: Uint8Array, p: number): number[] {
    return isMap(b, p) ? entries(b, p).map(([k]) => k) : items(b, p);
}

/** Unsigned or negative integer (bignum tags 2/3 included). */
export function intAt(b: Uint8Array, p: number): bigint {
    const h = head(b, p);
    if (h.major === 0) return h.big;
    if (h.major === 1) return -1n - h.big;
    if (h.major === 6 && (h.big === 2n || h.big === 3n)) {
        const bytes = bytesAt(b, p + h.len);
        let v = 0n;
        for (const x of bytes) v = (v << 8n) | BigInt(x);
        return h.big === 2n ? v : -1n - v;
    }
    throw new Error(`cbor: expected integer at ${p}, major ${h.major}`);
}
export const uintAt = intAt;
export const numAt = (b: Uint8Array, p: number): number => Number(intAt(b, p));

/** Contents of a byte string (indefinite chunks concatenated). */
export function bytesAt(b: Uint8Array, p: number): Uint8Array {
    p = untag(b, p);
    const h = head(b, p);
    if (h.major !== 2) throw new Error(`cbor: expected bytes at ${p}, major ${h.major}`);
    if (!h.indef) return b.subarray(p + h.len, p + h.len + h.value);
    const parts: Uint8Array[] = [];
    let q = p + 1;
    while (b[q] !== 0xff) { parts.push(bytesAt(b, q)); q += cborItemLength(b, q); }
    let n = 0; for (const x of parts) n += x.length;
    const out = new Uint8Array(n); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
}

export function textAt(b: Uint8Array, p: number): string {
    p = untag(b, p);
    const h = head(b, p);
    if (h.major !== 3) throw new Error(`cbor: expected text at ${p}, major ${h.major}`);
    if (!h.indef) return new TextDecoder().decode(b.subarray(p + h.len, p + h.len + h.value));
    let s = ""; let q = p + 1;
    while (b[q] !== 0xff) { s += textAt(b, q); q += cborItemLength(b, q); }
    return s;
}

export const hex = (u: Uint8Array): string => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("hex");
export const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

/** Map value for an unsigned integer key, or null. */
export function mapGet(b: Uint8Array, p: number, key: number): number | null {
    for (const [k, v] of entries(b, p)) if ((b[k]! >> 5) === 0 && numAt(b, k) === key) return v;
    return null;
}

/** A rational `#6.30([num, den])` (or a bare [num, den]) as numbers. */
export function rationalAt(b: Uint8Array, p: number): { num: bigint; den: bigint } {
    const f = items(b, p);
    return { num: intAt(b, f[0]!), den: intAt(b, f[1]!) };
}

/** CBOR head bytes for a major type and length (definite). */
export function encodeHead(major: number, n: number | bigint): Uint8Array {
    const v = BigInt(n);
    const m = major << 5;
    if (v < 24n) return Uint8Array.of(m | Number(v));
    if (v < 0x100n) return Uint8Array.of(m | 24, Number(v));
    if (v < 0x10000n) return Uint8Array.of(m | 25, Number(v >> 8n), Number(v & 0xffn));
    if (v < 0x100000000n) { const o = new Uint8Array(5); o[0] = m | 26; new DataView(o.buffer).setUint32(1, Number(v), false); return o; }
    const o = new Uint8Array(9); o[0] = m | 27; new DataView(o.buffer).setBigUint64(1, v, false); return o;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    let n = 0; for (const x of parts) n += x.length;
    const out = new Uint8Array(n); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
}
