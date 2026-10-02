/**
 * Raw CBOR writer for LocalStateQuery answers: exact control over every head (definite vs
 * indefinite, minimal integer width) without building an object tree, so a 3 MB answer (the vote
 * delegatee map) is written in one pass. Encodings follow cardano-ledger-binary:
 *   - maps / sequences: definite length up to 23 entries, indefinite beyond (`variableListLenEncoding`)
 *   - sets: tag 258 then the same list rule
 *   - integers: minimal width; above 2^64 a tag-2 bignum
 */
export class CborWriter {
    private buf: Uint8Array;
    private n = 0;
    constructor(initial = 1 << 16) { this.buf = new Uint8Array(initial); }

    private ensure(extra: number): void {
        if (this.n + extra <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < this.n + extra) cap *= 2;
        const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.n)); this.buf = nb;
    }
    private byte(b: number): void { this.ensure(1); this.buf[this.n++] = b; }
    private head(major: number, v: number | bigint): void {
        const m = major << 5;
        if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
            if (v < 24) return this.byte(m | v);
            if (v < 0x100) { this.ensure(2); this.buf[this.n++] = m | 24; this.buf[this.n++] = v; return; }
            if (v < 0x10000) { this.ensure(3); this.buf[this.n++] = m | 25; this.buf[this.n++] = v >> 8; this.buf[this.n++] = v & 0xff; return; }
            if (v < 0x100000000) { this.ensure(5); this.buf[this.n++] = m | 26; new DataView(this.buf.buffer).setUint32(this.n, v, false); this.n += 4; return; }
            v = BigInt(v);
        }
        const b = BigInt(v);
        if (b < 0n) throw new Error("negative head");
        if (b < 0x100000000n) return this.head(major, Number(b));
        if (b < 1n << 64n) { this.ensure(9); this.buf[this.n++] = m | 27; new DataView(this.buf.buffer).setBigUint64(this.n, b, false); this.n += 8; return; }
        throw new Error("head value above 2^64");
    }

    uint(v: number | bigint): this {
        const b = typeof v === "bigint" ? v : BigInt(v);
        if (b < 0n) { this.head(1, -1n - b); return this; }
        if (b >= 1n << 64n) { let h = b.toString(16); if (h.length % 2) h = "0" + h; this.tag(2).bytes(Uint8Array.from(Buffer.from(h, "hex"))); return this; }
        this.head(0, b < 0x100000000n ? Number(b) : b);
        return this;
    }
    /** Signed integer (major 0 or 1). */
    int(v: number | bigint): this { return this.uint(v); }
    bytes(b: Uint8Array): this { this.head(2, b.length); this.raw(b); return this; }
    hex(h: string): this { return this.bytes(Uint8Array.from(Buffer.from(h, "hex"))); }
    text(s: string): this { const b = new TextEncoder().encode(s); this.head(3, b.length); this.raw(b); return this; }
    array(len: number): this { this.head(4, len); return this; }
    arrayIndef(): this { this.byte(0x9f); return this; }
    map(len: number): this { this.head(5, len); return this; }
    mapIndef(): this { this.byte(0xbf); return this; }
    brk(): this { this.byte(0xff); return this; }
    tag(t: number): this { this.head(6, t); return this; }
    bool(v: boolean): this { this.byte(v ? 0xf5 : 0xf4); return this; }
    null(): this { this.byte(0xf6); return this; }
    raw(b: Uint8Array): this { this.ensure(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }

    /** cardano-ledger-binary list/map head: definite up to 23 entries, indefinite beyond; returns the closer. */
    listHead(len: number): () => void { if (len <= 23) { this.array(len); return () => {}; } this.arrayIndef(); return () => { this.brk(); }; }
    mapHead(len: number): () => void { if (len <= 23) { this.map(len); return () => {}; } this.mapIndef(); return () => { this.brk(); }; }
    /** A sequence written with `each` per element, using the variable-length rule. */
    list<T>(xs: readonly T[], each: (x: T) => void): this { const end = this.listHead(xs.length); for (const x of xs) each(x); end(); return this; }
    /** A map with entries in the given (already sorted) order. */
    mapOf<K, V>(entries: ReadonlyArray<readonly [K, V]>, key: (k: K) => void, val: (v: V) => void): this { const end = this.mapHead(entries.length); for (const [k, v] of entries) { key(k); val(v); } end(); return this; }
    /** A Conway set as `EncCBOR` writes it (`encodeSet`): tag 258 around the variable-length list rule. */
    set<T>(xs: readonly T[], each: (x: T) => void): this { this.tag(258); return this.list(xs, each); }
    /** A set as cardano-binary's `ToCBOR` writes it: tag 258 around a definite-length list at any size (GetStakePools: 727 ids). */
    setDefinite<T>(xs: readonly T[], each: (x: T) => void): this { this.tag(258).array(xs.length); for (const x of xs) each(x); return this; }
    /** Rational as tag 30 [num, den] (already reduced by the caller when the ledger reduces). */
    rational(num: bigint, den: bigint): this { this.tag(30).array(2).uint(num).uint(den); return this; }
    /** StrictMaybe: [] or [x]. */
    maybe<T>(x: T | null | undefined, each: (x: T) => void): this { if (x == null) return this.array(0); this.array(1); each(x); return this; }

    get length(): number { return this.n; }
    finish(): Uint8Array { return this.buf.slice(0, this.n); }
    /** The written bytes without a copy (the writer must not be used afterwards): for answers of hundreds of MB. */
    finishInPlace(): Uint8Array { return this.buf.subarray(0, this.n); }
}

export const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; };
/** Reduced rational (Haskell's `%`): 0 / d reduces to 0 / 1. */
export function reduced(n: bigint, d: bigint): [bigint, bigint] { if (d === 0n) return [n, d]; const g = n === 0n ? d : gcd(n, d); return [n / g, d / g]; }
export const hexBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
