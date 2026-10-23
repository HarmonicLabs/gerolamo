/**
 * Plutus `Data` for the evaluator (src/consensus/plutus/cek.ts): plain immutable objects with a
 * memoised `ExMemoryUsage`, structural equality, and the exact CBOR codec of plutus-core
 * (`PlutusCore.Data`): constructor tags 121–127 / 1280–1400 / 102, lists indefinite-length when
 * non-empty, maps definite, integers beyond 64 bits as tag-2/3 bignums, bytestrings (and bignum
 * magnitudes) above 64 bytes as indefinite 64-byte chunks.
 *
 * The @harmoniclabs/plutus-data classes are several copies (root, buildooor, ledger-ts) with
 * `defineProperties` constructors; converting once at the script-context boundary and
 * evaluating on these is both faster and independent of which copy built the context.
 */

export const enum DK { Constr = 0, Map = 1, List = 2, Int = 3, Bytes = 4 }

export class DConstr { readonly k = DK.Constr; s = -1; constructor(readonly tag: bigint, readonly fields: Data[]) {} }
export class DMap { readonly k = DK.Map; s = -1; constructor(readonly entries: DPair[]) {} }
export class DList { readonly k = DK.List; s = -1; constructor(readonly items: Data[]) {} }
export class DInt { readonly k = DK.Int; s = -1; constructor(readonly v: bigint) {} }
export class DBytes { readonly k = DK.Bytes; s = -1; constructor(readonly v: Uint8Array) {} }
export type Data = DConstr | DMap | DList | DInt | DBytes;
/** A (Data, Data) pair — also the element of `unMapData`'s list, so no copy is made there. */
export class DPair { constructor(readonly fst: any, readonly snd: any) {} }

const TWO63 = 1n << 63n;
/** `ExMemoryUsage Integer`: 1 for 0, else ⌊log2 |n|⌋ `quot` 64 + 1 (64-bit words). */
export function intSize(n: bigint): number {
    if (n < 0n) n = -n;
    if (n < TWO63) return 1;
    // bit length − 1 = ⌊log2 n⌋
    const bits = n.toString(16);
    const log2 = (bits.length - 1) * 4 + (31 - Math.clz32(parseInt(bits[0]!, 16)));
    return Math.floor(log2 / 64) + 1;
}
/** `ExMemoryUsage ByteString`: ((n − 1) `quot` 8) + 1 words; the empty string counts 1. */
export function bytesSize(b: Uint8Array): number {
    return b.length === 0 ? 1 : Math.floor((b.length - 1) / 8) + 1;
}

/** `ExMemoryUsage Data`: 4 per node plus the leaves' sizes (memoised: values are immutable). */
export function dataSize(d: Data): number {
    if (d.s >= 0) return d.s;
    let s = 4;
    switch (d.k) {
        case DK.Constr: for (const f of d.fields) s += dataSize(f); break;
        case DK.Map: for (const e of d.entries) s += dataSize(e.fst) + dataSize(e.snd); break;
        case DK.List: for (const x of d.items) s += dataSize(x); break;
        case DK.Int: s += intSize(d.v); break;
        case DK.Bytes: s += bytesSize(d.v); break;
    }
    d.s = s;
    return s;
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function dataEq(a: Data, b: Data): boolean {
    if (a === b) return true;
    if (a.k !== b.k) return false;
    switch (a.k) {
        case DK.Int: return a.v === (b as DInt).v;
        case DK.Bytes: return bytesEq(a.v, (b as DBytes).v);
        case DK.Constr: {
            const bb = b as DConstr;
            if (a.tag !== bb.tag || a.fields.length !== bb.fields.length) return false;
            for (let i = 0; i < a.fields.length; i++) if (!dataEq(a.fields[i]!, bb.fields[i]!)) return false;
            return true;
        }
        case DK.List: {
            const bb = b as DList;
            if (a.items.length !== bb.items.length) return false;
            for (let i = 0; i < a.items.length; i++) if (!dataEq(a.items[i]!, bb.items[i]!)) return false;
            return true;
        }
        case DK.Map: {
            const bb = b as DMap;
            if (a.entries.length !== bb.entries.length) return false;
            for (let i = 0; i < a.entries.length; i++) {
                if (!dataEq(a.entries[i]!.fst, bb.entries[i]!.fst) || !dataEq(a.entries[i]!.snd, bb.entries[i]!.snd)) return false;
            }
            return true;
        }
    }
}

// ── conversion from any @harmoniclabs/plutus-data copy (structural, no instanceof) ──

function bytesOf(b: any): Uint8Array {
    if (b instanceof Uint8Array) return b;
    if (b?._bytes instanceof Uint8Array) return b._bytes;
    if (typeof b?.toBuffer === "function") return b.toBuffer();
    return new Uint8Array(Buffer.from(String(b), "hex"));
}
export function fromLibData(d: any): Data {
    if (d instanceof DConstr || d instanceof DMap || d instanceof DList || d instanceof DInt || d instanceof DBytes) return d;
    if (d?.fields !== undefined) return new DConstr(BigInt(d.constr), (d.fields as any[]).map(fromLibData));
    if (d?.map !== undefined) return new DMap((d.map as any[]).map((e) => new DPair(fromLibData(e.fst), fromLibData(e.snd))));
    if (d?.list !== undefined) return new DList((d.list as any[]).map(fromLibData));
    if (d?.int !== undefined) return new DInt(BigInt(d.int));
    if (d?.bytes !== undefined) return new DBytes(bytesOf(d.bytes));
    throw new Error(`not Plutus data: ${d?.constructor?.name ?? typeof d}`);
}

// ── CBOR ──

class Writer {
    buf = new Uint8Array(256);
    n = 0;
    ensure(k: number) {
        if (this.n + k <= this.buf.length) return;
        let len = this.buf.length * 2;
        while (len < this.n + k) len *= 2;
        const nb = new Uint8Array(len); nb.set(this.buf.subarray(0, this.n)); this.buf = nb;
    }
    byte(b: number) { this.ensure(1); this.buf[this.n++] = b; }
    head(major: number, v: number | bigint) {
        const m = major << 5;
        const x = BigInt(v);
        if (x < 24n) return this.byte(m | Number(x));
        if (x < 256n) { this.ensure(2); this.buf[this.n++] = m | 24; this.buf[this.n++] = Number(x); return; }
        if (x < 65536n) { this.ensure(3); this.buf[this.n++] = m | 25; this.buf[this.n++] = Number(x >> 8n); this.buf[this.n++] = Number(x & 255n); return; }
        if (x < 4294967296n) { this.ensure(5); this.buf[this.n++] = m | 26; for (let s = 24n; s >= 0n; s -= 8n) this.buf[this.n++] = Number((x >> s) & 255n); return; }
        this.ensure(9); this.buf[this.n++] = m | 27; for (let s = 56n; s >= 0n; s -= 8n) this.buf[this.n++] = Number((x >> s) & 255n);
    }
    bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.n); this.n += b.length; }
    out() { return this.buf.slice(0, this.n); }
}
const TWO64 = 1n << 64n;
function chunked(w: Writer, b: Uint8Array) {
    if (b.length <= 64) { w.head(2, b.length); w.bytes(b); return; }
    w.byte(0x5f);
    for (let p = 0; p < b.length; p += 64) { const c = b.subarray(p, Math.min(b.length, p + 64)); w.head(2, c.length); w.bytes(c); }
    w.byte(0xff);
}
function bigBytes(n: bigint): Uint8Array {
    let h = n.toString(16);
    if (h.length % 2) h = "0" + h;
    return new Uint8Array(Buffer.from(h, "hex"));
}
function encList(w: Writer, xs: Data[]) {
    if (xs.length === 0) { w.byte(0x80); return; }
    w.byte(0x9f);
    for (const x of xs) enc(w, x);
    w.byte(0xff);
}
function enc(w: Writer, d: Data) {
    switch (d.k) {
        case DK.Constr: {
            const t = d.tag;
            if (t >= 0n && t < 7n) { w.head(6, Number(121n + t)); encList(w, d.fields); }
            else if (t >= 7n && t < 128n) { w.head(6, Number(1280n + t - 7n)); encList(w, d.fields); }
            else { w.head(6, 102); w.byte(0x82); w.head(0, t); encList(w, d.fields); }
            return;
        }
        case DK.Map: w.head(5, d.entries.length); for (const e of d.entries) { enc(w, e.fst); enc(w, e.snd); } return;
        case DK.List: encList(w, d.items); return;
        case DK.Int: {
            const n = d.v;
            if (n >= 0n) { if (n < TWO64) w.head(0, n); else { w.head(6, 2); chunked(w, bigBytes(n)); } }
            else { const m = -1n - n; if (m < TWO64) w.head(1, m); else { w.head(6, 3); chunked(w, bigBytes(m)); } }
            return;
        }
        case DK.Bytes: chunked(w, d.v); return;
    }
}
export function encodeData(d: Data): Uint8Array { const w = new Writer(); enc(w, d); return w.out(); }

/** Small bigints shared by the decoder (constructor tags, small integers): bigints compare by value, so sharing is invisible. */
const SMALL_BIG: bigint[] = []; for (let n = 0; n < 256; n++) SMALL_BIG[n] = BigInt(n);
const SMALL_NEG: bigint[] = []; for (let n = 0; n < 256; n++) SMALL_NEG[n] = -1n - BigInt(n);
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const OUT_OF_INPUT = "cbor: out of input";

/** A CBOR cursor over one Data item; reading past the end throws (a truncated item is never read as zeros). */
class DataReader {
    p = 0;
    readonly len: number;
    constructor(readonly b: Uint8Array) { this.len = b.length; }
    /** The argument of a head byte: a Number up to 2^53, a bigint beyond, −1 for indefinite length. */
    arg(ai: number): number | bigint {
        if (ai < 24) return ai;
        const b = this.b, p = this.p;
        if (ai === 24) { if (p + 1 > this.len) throw new Error(OUT_OF_INPUT); this.p = p + 1; return b[p]!; }
        if (ai === 25) { if (p + 2 > this.len) throw new Error(OUT_OF_INPUT); this.p = p + 2; return (b[p]! << 8) | b[p + 1]!; }
        if (ai === 26) { if (p + 4 > this.len) throw new Error(OUT_OF_INPUT); this.p = p + 4; return ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); }
        if (ai === 27) {
            if (p + 8 > this.len) throw new Error(OUT_OF_INPUT);
            this.p = p + 8;
            const hi = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!);
            const lo = ((b[p + 4]! << 24) >>> 0) + ((b[p + 5]! << 16) | (b[p + 6]! << 8) | b[p + 7]!);
            if (hi < 0x200000) return hi * 4294967296 + lo; // < 2^53
            const v = (BigInt(hi) << 32n) | BigInt(lo);
            return v <= MAX_SAFE_BIG ? Number(v) : v;
        }
        if (ai === 31) return -1;
        throw new Error(`cbor: bad additional info ${ai}`);
    }
    /** A definite length as a Number (a bigint length is beyond any input). */
    length(ai: number): number {
        const n = this.arg(ai);
        if (typeof n !== "number") throw new Error(OUT_OF_INPUT);
        return n;
    }
    head(): number {
        if (this.p >= this.len) throw new Error(OUT_OF_INPUT);
        return this.b[this.p++]!;
    }
    /** `true` and consumed when the next byte is the break (0xff). */
    atBreak(): boolean {
        if (this.p >= this.len) throw new Error(OUT_OF_INPUT);
        if (this.b[this.p] !== 0xff) return false;
        this.p++;
        return true;
    }
    /** Bytes after a major-2 head: a fresh copy (TypedArray slice copies, a `Buffer#slice` would be a view). */
    bytesItem(ai: number): Uint8Array {
        const n = this.length(ai);
        if (n !== -1) {
            const p = this.p;
            if (p + n > this.len) throw new Error(OUT_OF_INPUT);
            this.p = p + n;
            return Uint8Array.prototype.slice.call(this.b, p, p + n);
        }
        // indefinite: definite chunks up to the break; measure, then copy once
        const start = this.p;
        let total = 0;
        while (!this.atBreak()) {
            const ib = this.head();
            if (ib >> 5 !== 2) throw new Error("cbor: bad bytes chunk");
            const len = this.length(ib & 31);
            if (len === -1 || this.p + len > this.len) throw new Error(OUT_OF_INPUT);
            total += len; this.p += len;
        }
        const out = new Uint8Array(total);
        let p = start, o = 0;
        for (;;) {
            const ib = this.b[p++]!;
            if (ib === 0xff) break;
            const ai2 = ib & 31;
            let len: number;
            if (ai2 < 24) len = ai2;
            else if (ai2 === 24) len = this.b[p++]!;
            else if (ai2 === 25) { len = (this.b[p]! << 8) | this.b[p + 1]!; p += 2; }
            else if (ai2 === 26) { len = ((this.b[p]! << 24) >>> 0) + ((this.b[p + 1]! << 16) | (this.b[p + 2]! << 8) | this.b[p + 3]!); p += 4; }
            else { const save = this.p; this.p = p; len = this.length(ai2); p = this.p; this.p = save; }
            out.set(this.b.subarray(p, p + len), o); o += len; p += len;
        }
        return out;
    }
    items(ai: number): Data[] {
        const n = this.length(ai), out: Data[] = [];
        if (n === -1) { while (!this.atBreak()) out.push(this.item()); }
        else for (let i = 0; i < n; i++) out.push(this.item());
        return out;
    }
    constrFields(): Data[] {
        const ib = this.head();
        if (ib >> 5 !== 4) throw new Error("cbor: constr fields not a list");
        return this.items(ib & 31);
    }
    item(): Data {
        const ib = this.head();
        const major = ib >> 5, ai = ib & 31;
        switch (major) {
            case 0: { const n = this.arg(ai); return new DInt(typeof n === "number" ? (n < 256 ? SMALL_BIG[n]! : BigInt(n)) : n); }
            case 1: { const n = this.arg(ai); return new DInt(typeof n === "number" ? (n < 256 ? SMALL_NEG[n]! : -1n - BigInt(n)) : -1n - n); }
            case 2: return new DBytes(this.bytesItem(ai));
            case 4: return new DList(this.items(ai));
            case 5: {
                const n = this.length(ai), out: DPair[] = [];
                if (n === -1) { while (!this.atBreak()) { const k = this.item(); out.push(new DPair(k, this.item())); } }
                else for (let i = 0; i < n; i++) { const k = this.item(); out.push(new DPair(k, this.item())); }
                return new DMap(out);
            }
            case 6: {
                const t = this.arg(ai);
                if (t >= 121 && t <= 127) return new DConstr(SMALL_BIG[(t as number) - 121]!, this.constrFields());
                if (t >= 1280 && t <= 1400) return new DConstr(SMALL_BIG[(t as number) - 1280 + 7]!, this.constrFields());
                if (t === 102) {
                    if (this.head() !== 0x82) throw new Error("cbor: tag 102 not a pair");
                    const ib3 = this.head(); if (ib3 >> 5 !== 0) throw new Error("cbor: tag 102 alternative");
                    const a = this.arg(ib3 & 31);
                    const alt = typeof a === "number" ? (a < 256 ? SMALL_BIG[a]! : BigInt(a)) : a;
                    return new DConstr(alt, this.constrFields());
                }
                if (t === 2 || t === 3) {
                    const ib2 = this.head(); if (ib2 >> 5 !== 2) throw new Error("cbor: bignum not bytes");
                    const mag = this.bytesItem(ib2 & 31);
                    let v = 0n;
                    for (let i = 0; i < mag.length; i++) v = (v << 8n) | BigInt(mag[i]!);
                    return new DInt(t === 2 ? v : -1n - v);
                }
                throw new Error(`cbor: unexpected tag ${t} in Data`);
            }
        }
        throw new Error(`cbor: unexpected major type ${major} in Data`);
    }
}

/**
 * Decode Plutus Data from CBOR (tolerant of definite/indefinite forms, as the ledger decoder).
 * Bytestrings are always fresh copies: `Buffer#slice` is a view, and a value sharing memory with
 * the block would let any mutation reach the transaction bytes (seen with a delegated builtin).
 */
export function decodeData(b: Uint8Array): Data {
    const r = new DataReader(b);
    const d = r.item();
    if (r.p !== b.length) throw new Error("cbor: trailing bytes after Data");
    return d;
}
