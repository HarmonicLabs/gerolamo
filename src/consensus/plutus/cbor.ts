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

export function parseCbor(b: Uint8Array): CNode {
    let p = 0;
    const arg = (ai: number): bigint | -1 => {
        if (ai < 24) return BigInt(ai);
        if (ai === 24) return BigInt(b[p++]!);
        if (ai === 25) { const v = (b[p]! << 8) | b[p + 1]!; p += 2; return BigInt(v); }
        if (ai === 26) { const v = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); p += 4; return BigInt(v); }
        if (ai === 27) { let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[p++]!); return v; }
        if (ai === 31) return -1;
        throw new Error(`cbor: additional info ${ai}`);
    };
    const item = (): CNode => {
        const s = p;
        const ib = b[p++];
        if (ib === undefined) throw new Error("cbor: out of input");
        const major = ib >> 5, ai = ib & 31;
        switch (major) {
            case 0: { const v = arg(ai); if (v === -1) throw new Error("cbor: indefinite uint"); return { t: "u", v, s, e: p }; }
            case 1: { const v = arg(ai); if (v === -1) throw new Error("cbor: indefinite nint"); return { t: "n", v: -1n - v, s, e: p }; }
            case 2: case 3: {
                const n = arg(ai);
                let bytes: Uint8Array;
                if (n !== -1) { bytes = b.subarray(p, p + Number(n)); p += Number(n); }
                else {
                    const parts: Uint8Array[] = [];
                    while (b[p] !== 0xff) { const c = item(); parts.push(c.t === "b" ? c.v : new TextEncoder().encode((c as any).v)); }
                    p++;
                    bytes = new Uint8Array(parts.reduce((x, y) => x + y.length, 0));
                    let o = 0; for (const x of parts) { bytes.set(x, o); o += x.length; }
                }
                return major === 2 ? { t: "b", v: bytes, s, e: p } : { t: "s", v: new TextDecoder().decode(bytes), s, e: p };
            }
            case 4: {
                const n = arg(ai), v: CNode[] = [];
                if (n === -1) { while (b[p] !== 0xff) v.push(item()); p++; } else for (let i = 0n; i < n; i++) v.push(item());
                return { t: "a", v, s, e: p };
            }
            case 5: {
                const n = arg(ai), v: Array<[CNode, CNode]> = [];
                if (n === -1) { while (b[p] !== 0xff) { const k = item(); v.push([k, item()]); } p++; } else for (let i = 0n; i < n; i++) { const k = item(); v.push([k, item()]); }
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
