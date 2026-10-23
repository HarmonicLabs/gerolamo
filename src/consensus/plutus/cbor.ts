/**
 * A small CBOR reader for transaction bodies and witness sets: a generic tree whose nodes keep
 * their byte range, so hashes (tx id, datum hashes, script hashes) are taken over the bytes as
 * carried. Tag 258 (Conway sets) is kept as a tag node; `arr()` looks through it.
 */
export type CNode =
    | { t: "u"; v: bigint; s: number; e: number }
    | { t: "n"; v: bigint; s: number; e: number }
    | { t: "b"; v: Uint8Array; s: number; e: number }
    | { t: "s"; v: string; s: number; e: number }
    | { t: "a"; v: CNode[]; s: number; e: number }
    | { t: "m"; v: Array<[CNode, CNode]>; s: number; e: number }
    | { t: "tag"; tag: number; v: CNode; s: number; e: number }
    | { t: "simple"; v: number | boolean | null | undefined; s: number; e: number };

/** Small unsigned values shared by the reader (map keys, small lengths): bigints compare by value. */
const SMALL: bigint[] = []; for (let n = 0; n < 256; n++) SMALL[n] = BigInt(n);
const utf8 = new TextDecoder();

export function parseCbor(b: Uint8Array): CNode {
    let p = 0;
    const len = b.length;
    /** The head's argument as a Number (lengths, tags, small ints); 2^53 and above come back as a bigint. −1: indefinite. */
    const arg = (ai: number): number | bigint => {
        if (ai < 24) return ai;
        if (ai === 24) { if (p + 1 > len) throw new Error("cbor: out of input"); return b[p++]!; }
        if (ai === 25) { if (p + 2 > len) throw new Error("cbor: out of input"); const v = (b[p]! << 8) | b[p + 1]!; p += 2; return v; }
        if (ai === 26) { if (p + 4 > len) throw new Error("cbor: out of input"); const v = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); p += 4; return v; }
        if (ai === 27) {
            if (p + 8 > len) throw new Error("cbor: out of input");
            const hi = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!);
            const lo = ((b[p + 4]! << 24) >>> 0) + ((b[p + 5]! << 16) | (b[p + 6]! << 8) | b[p + 7]!);
            p += 8;
            return hi < 0x200000 ? hi * 4294967296 + lo : (BigInt(hi) << 32n) | BigInt(lo);
        }
        if (ai === 31) return -1;
        throw new Error(`cbor: additional info ${ai}`);
    };
    const big = (v: number | bigint): bigint => (typeof v === "bigint" ? v : v < 256 ? SMALL[v]! : BigInt(v));
    const count = (v: number | bigint): number => { if (typeof v !== "number") throw new Error("cbor: out of input"); return v; };
    const atBreak = (): boolean => { if (p >= len) throw new Error("cbor: out of input"); if (b[p] !== 0xff) return false; p++; return true; };
    const item = (): CNode => {
        const s = p;
        if (p >= len) throw new Error("cbor: out of input");
        const ib = b[p++]!;
        const major = ib >> 5, ai = ib & 31;
        switch (major) {
            case 0: { const v = arg(ai); if (v === -1) throw new Error("cbor: indefinite uint"); return { t: "u", v: big(v), s, e: p }; }
            case 1: { const v = arg(ai); if (v === -1) throw new Error("cbor: indefinite nint"); return { t: "n", v: -1n - big(v), s, e: p }; }
            case 2: case 3: {
                const n = count(arg(ai));
                let bytes: Uint8Array;
                if (n !== -1) { if (p + n > len) throw new Error("cbor: out of input"); bytes = b.subarray(p, p + n); p += n; }
                else {
                    const parts: Uint8Array[] = [];
                    let total = 0;
                    while (!atBreak()) { const c = item(); const x = c.t === "b" ? c.v : new TextEncoder().encode((c as any).v); parts.push(x); total += x.length; }
                    bytes = new Uint8Array(total);
                    let o = 0; for (const x of parts) { bytes.set(x, o); o += x.length; }
                }
                return major === 2 ? { t: "b", v: bytes, s, e: p } : { t: "s", v: utf8.decode(bytes), s, e: p };
            }
            case 4: {
                const n = count(arg(ai)), v: CNode[] = [];
                if (n === -1) { while (!atBreak()) v.push(item()); } else for (let i = 0; i < n; i++) v.push(item());
                return { t: "a", v, s, e: p };
            }
            case 5: {
                const n = count(arg(ai)), v: Array<[CNode, CNode]> = [];
                if (n === -1) { while (!atBreak()) { const k = item(); v.push([k, item()]); } } else for (let i = 0; i < n; i++) { const k = item(); v.push([k, item()]); }
                return { t: "m", v, s, e: p };
            }
            case 6: { const tag = Number(arg(ai)); return { t: "tag", tag, v: item(), s, e: p }; }
            case 7: {
                if (ai === 20) return { t: "simple", v: false, s, e: p };
                if (ai === 21) return { t: "simple", v: true, s, e: p };
                if (ai === 22) return { t: "simple", v: null, s, e: p };
                if (ai === 23) return { t: "simple", v: undefined, s, e: p };
                if (ai === 24) { p++; return { t: "simple", v: b[p - 1]!, s, e: p }; }
                if (ai === 25) { p += 2; return { t: "simple", v: NaN, s, e: p }; }
                if (ai === 26) { p += 4; return { t: "simple", v: NaN, s, e: p }; }
                if (ai === 27) { p += 8; return { t: "simple", v: NaN, s, e: p }; }
                return { t: "simple", v: ai, s, e: p };
            }
        }
        throw new Error("cbor: unreachable");
    };
    return item();
}

/** Elements of an array, looking through tag 258 (and tolerating a missing field). */
export function arr(n: CNode | undefined): CNode[] {
    if (!n) return [];
    if (n.t === "tag") return arr(n.v);
    if (n.t === "a") return n.v;
    throw new Error(`cbor: expected array, got ${n.t}`);
}
export function map(n: CNode | undefined): Array<[CNode, CNode]> {
    if (!n) return [];
    if (n.t === "tag") return map(n.v);
    if (n.t === "m") return n.v;
    throw new Error(`cbor: expected map, got ${n.t}`);
}
export function uintOf(n: CNode | undefined): bigint {
    if (n?.t !== "u") throw new Error(`cbor: expected uint, got ${n?.t}`);
    return n.v;
}
export function intOf(n: CNode | undefined): bigint {
    if (n?.t === "u" || n?.t === "n") return n.v;
    throw new Error(`cbor: expected int, got ${n?.t}`);
}
export function bytesOf(n: CNode | undefined): Uint8Array {
    if (n?.t !== "b") throw new Error(`cbor: expected bytes, got ${n?.t}`);
    return n.v;
}
export function isNull(n: CNode | undefined): boolean { return !n || (n.t === "simple" && (n.v === null || n.v === undefined)); }
/** Field `k` of a map keyed by small unsigned integers. */
export function field(m: Array<[CNode, CNode]>, k: number): CNode | undefined {
    for (const [key, v] of m) if (key.t === "u" && key.v === BigInt(k)) return v;
    return undefined;
}
