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

/**
 * Decode Plutus Data from CBOR (tolerant of definite/indefinite forms, as the ledger decoder).
 * Bytestrings are always fresh copies: `Buffer#slice` is a view, and a value sharing memory with
 * the block would let any mutation reach the transaction bytes (seen with a delegated builtin).
 */
export function decodeData(b: Uint8Array): Data {
    let p = 0;
    const arg = (ai: number): number | bigint => {
        if (ai < 24) return ai;
        if (ai === 24) return b[p++]!;
        if (ai === 25) { const v = (b[p]! << 8) | b[p + 1]!; p += 2; return v; }
        if (ai === 26) { const v = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); p += 4; return v; }
        if (ai === 27) { let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[p++]!); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
        if (ai === 31) return -1;
        throw new Error(`cbor: bad additional info ${ai}`);
    };
    const bytesItem = (ai: number): Uint8Array => {
        const n = arg(ai);
        if (n !== -1) { const len = Number(n); const out = Uint8Array.prototype.slice.call(b, p, p + len); p += len; return out; }
        const parts: Uint8Array[] = [];
        while (b[p] !== 0xff) {
            const ib = b[p++]!;
            if (ib >> 5 !== 2) throw new Error("cbor: bad bytes chunk");
            const len = Number(arg(ib & 31)); parts.push(b.subarray(p, p + len)); p += len;
        }
        p++;
        const total = parts.reduce((s, x) => s + x.length, 0), out = new Uint8Array(total);
        let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
        return out;
    };
    const items = (ai: number): Data[] => {
        const n = arg(ai), out: Data[] = [];
        if (n === -1) { while (b[p] !== 0xff) out.push(item()); p++; } else for (let i = 0; i < Number(n); i++) out.push(item());
        return out;
    };
    const item = (): Data => {
        const ib = b[p++]!;
        const major = ib >> 5, ai = ib & 31;
        switch (major) {
            case 0: return new DInt(BigInt(arg(ai)));
            case 1: return new DInt(-1n - BigInt(arg(ai)));
            case 2: return new DBytes(bytesItem(ai));
            case 4: return new DList(items(ai));
            case 5: {
                const n = arg(ai), out: DPair[] = [];
                if (n === -1) { while (b[p] !== 0xff) { const k = item(); out.push(new DPair(k, item())); } p++; }
                else for (let i = 0; i < Number(n); i++) { const k = item(); out.push(new DPair(k, item())); }
                return new DMap(out);
            }
            case 6: {
                const t = Number(arg(ai));
                if (t >= 121 && t <= 127) { const ib2 = b[p++]!; if (ib2 >> 5 !== 4) throw new Error("cbor: constr fields not a list"); return new DConstr(BigInt(t - 121), items(ib2 & 31)); }
                if (t >= 1280 && t <= 1400) { const ib2 = b[p++]!; if (ib2 >> 5 !== 4) throw new Error("cbor: constr fields not a list"); return new DConstr(BigInt(t - 1280 + 7), items(ib2 & 31)); }
                if (t === 102) {
                    const ib2 = b[p++]!;
                    if (ib2 !== 0x82) throw new Error("cbor: tag 102 not a pair");
                    const ib3 = b[p++]!; if (ib3 >> 5 !== 0) throw new Error("cbor: tag 102 alternative");
                    const alt = BigInt(arg(ib3 & 31));
                    const ib4 = b[p++]!; if (ib4 >> 5 !== 4) throw new Error("cbor: tag 102 fields");
                    return new DConstr(alt, items(ib4 & 31));
                }
                if (t === 2 || t === 3) {
                    const ib2 = b[p++]!; if (ib2 >> 5 !== 2) throw new Error("cbor: bignum not bytes");
                    const mag = bytesItem(ib2 & 31);
                    let v = 0n; for (const x of mag) v = (v << 8n) | BigInt(x);
                    return new DInt(t === 2 ? v : -1n - v);
                }
                throw new Error(`cbor: unexpected tag ${t} in Data`);
            }
        }
        throw new Error(`cbor: unexpected major type ${major} in Data`);
    };
    const d = item();
    if (p !== b.length) throw new Error("cbor: trailing bytes after Data");
    return d;
}
