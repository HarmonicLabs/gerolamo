/**
 * CBOR shape normalization of the cardano-cbor-dataset corpus
 * (github.com/etorreborre/cardano-cbor-dataset, branch `etorreborre/feat/normalization`,
 * README "Normalization specification" and `app/Normalize.hs`).
 *
 * A re-encoding is compared with the corpus `expected/<name>.cbor` only after this rewrite, for
 * every rule whose bytes are not hashed. It rewrites the container form and nothing else:
 *
 *   indefinite array / map          → definite, same items in the same order
 *   chunked byte / text string      → one definite string, chunks concatenated
 *   non-minimal integer / length /
 *   tag head                        → the minimal head
 *   bignum (#6.2 / #6.3) below 2^64 → the native uint / nint
 *   larger bignum                   → kept, leading zero bytes of the magnitude dropped
 *   rational #6.30([n, d]), d > 0   → reduced: n / gcd, d / gcd (README table, "rational";
 *                                     cardano-ledger stores a Ratio and re-encodes it reduced)
 *
 * Map key order, duplicate keys, other tags and float widths survive untouched. The input must be
 * exactly one well-formed CBOR item: trailing bytes, truncation, a stray break, a reserved
 * additional-info value or a chunk of the wrong type throw, as `normalizeBytes` does in Haskell.
 *
 * Written against the raw bytes rather than @harmoniclabs/cbor: the library's parser drops the
 * float width and the head width, which the normalization must keep or minimise on purpose.
 */

class Out {
    private buf = new Uint8Array(256);
    len = 0;
    private ensure(n: number): void {
        if (this.len + n <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < this.len + n) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    byte(b: number): void { this.ensure(1); this.buf[this.len++] = b; }
    bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
    /** Minimal head for `major` with argument `n` (0 ≤ n < 2^64). */
    head(major: number, n: bigint): void {
        const m = major << 5;
        if (n < 24n) this.byte(m | Number(n));
        else if (n < 0x100n) { this.byte(m | 24); this.byte(Number(n)); }
        else if (n < 0x10000n) { this.byte(m | 25); this.byte(Number(n >> 8n)); this.byte(Number(n & 0xffn)); }
        else if (n < 0x100000000n) { this.byte(m | 26); for (let s = 24n; s >= 0n; s -= 8n) this.byte(Number((n >> s) & 0xffn)); }
        else { this.byte(m | 27); for (let s = 56n; s >= 0n; s -= 8n) this.byte(Number((n >> s) & 0xffn)); }
    }
    result(): Uint8Array { return this.buf.slice(0, this.len); }
}

const TWO_64 = 1n << 64n;

interface Head { major: number; info: number; arg: bigint; next: number }

function readHead(b: Uint8Array, p: number): Head {
    if (p >= b.length) throw new Error(`truncated CBOR at offset ${p}`);
    const ib = b[p]!;
    const major = ib >> 5, info = ib & 31;
    if (info < 24) return { major, info, arg: BigInt(info), next: p + 1 };
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width > 0) {
        if (p + 1 + width > b.length) throw new Error(`truncated CBOR head at offset ${p}`);
        let v = 0n;
        for (let i = 1; i <= width; i++) v = (v << 8n) | BigInt(b[p + i]!);
        return { major, info, arg: v, next: p + 1 + width };
    }
    if (info === 31) return { major, info, arg: -1n, next: p + 1 };
    throw new Error(`reserved additional information ${info} at offset ${p}`);
}

function stringBytes(b: Uint8Array, p: number, major: number): { data: Uint8Array; next: number } {
    const h = readHead(b, p);
    if (h.major !== major) throw new Error(`string chunk of major type ${h.major} inside major type ${major} at offset ${p}`);
    if (h.info === 31) throw new Error(`nested indefinite string at offset ${p}`);
    const end = h.next + Number(h.arg);
    if (h.arg > BigInt(b.length) || end > b.length) throw new Error(`truncated string at offset ${p}`);
    return { data: b.subarray(h.next, end), next: end };
}

/** A definite or chunked string of `major` at `p`, chunks concatenated. */
function readString(b: Uint8Array, p: number, h: Head): { data: Uint8Array; next: number } {
    if (h.info !== 31) return stringBytes(b, p, h.major);
    const parts: Uint8Array[] = [];
    let q = h.next;
    for (;;) {
        if (q >= b.length) throw new Error("unterminated indefinite string");
        if (b[q] === 0xff) { q++; break; }
        const c = stringBytes(b, q, h.major);
        parts.push(c.data);
        q = c.next;
    }
    let n = 0;
    for (const x of parts) n += x.length;
    const data = new Uint8Array(n);
    let i = 0;
    for (const x of parts) { data.set(x, i); i += x.length; }
    return { data, next: q };
}

function magnitude(bytes: Uint8Array): bigint {
    let v = 0n;
    for (const x of bytes) v = (v << 8n) | BigInt(x);
    return v;
}

const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };

/**
 * The already-normalized payload of a `#6.30` tag, reduced when it is `[n, d]` with integer n and
 * d > 0; anything else is returned as it is.
 */
function reduceRational(n: Uint8Array): Uint8Array {
    if (n[0] !== 0x82) return n;
    const ints: bigint[] = [];
    let q = 1;
    for (let i = 0; i < 2; i++) {
        const h = readHead(n, q);
        if (h.major === 0) ints.push(h.arg);
        else if (h.major === 1) ints.push(-1n - h.arg);
        else return n;
        q = h.next;
    }
    if (q !== n.length) return n;
    const [num, den] = ints as [bigint, bigint];
    if (den <= 0n) return n;
    const g = gcd(num < 0n ? -num : num, den);
    if (g <= 1n) return n;
    const out = new Out();
    out.byte(0x82);
    const rn = num / g;
    if (rn >= 0n) out.head(0, rn); else out.head(1, -1n - rn);
    out.head(0, den / g);
    return out.result();
}

function writeItem(b: Uint8Array, p: number, out: Out, depth: number): number {
    if (depth > 10_000) throw new Error("CBOR nesting too deep");
    const h = readHead(b, p);
    switch (h.major) {
        case 0: case 1:
            if (h.info === 31) throw new Error(`indefinite integer at offset ${p}`);
            out.head(h.major, h.arg);
            return h.next;
        case 2: case 3: {
            const s = readString(b, p, h);
            out.head(h.major, BigInt(s.data.length));
            out.bytes(s.data);
            return s.next;
        }
        case 4: case 5: {
            const perEntry = h.major === 5 ? 2 : 1;
            const tmp = new Out();
            let q = h.next, count = 0n;
            if (h.info === 31) {
                for (;;) {
                    if (q >= b.length) throw new Error("unterminated indefinite container");
                    if (b[q] === 0xff) { q++; break; }
                    for (let k = 0; k < perEntry; k++) q = writeItem(b, q, tmp, depth + 1);
                    count++;
                }
            } else {
                if (h.arg > BigInt(b.length)) throw new Error(`container length ${h.arg} exceeds the input at offset ${p}`);
                for (let i = 0n; i < h.arg; i++) for (let k = 0; k < perEntry; k++) q = writeItem(b, q, tmp, depth + 1);
                count = h.arg;
            }
            out.head(h.major, count);
            out.bytes(tmp.result());
            return q;
        }
        case 6: {
            if (h.info === 31) throw new Error(`indefinite tag at offset ${p}`);
            if (h.arg === 2n || h.arg === 3n) {
                const inner = readHead(b, h.next);
                if (inner.major === 2) {
                    const s = readString(b, h.next, inner);
                    const m = magnitude(s.data);
                    if (m < TWO_64) out.head(h.arg === 2n ? 0 : 1, m);
                    else {
                        let z = 0;
                        while (z < s.data.length && s.data[z] === 0) z++;
                        const mag = s.data.subarray(z);
                        out.head(6, h.arg);
                        out.head(2, BigInt(mag.length));
                        out.bytes(mag);
                    }
                    return s.next;
                }
            }
            if (h.arg === 30n) {
                const tmp = new Out();
                const next = writeItem(b, h.next, tmp, depth + 1);
                out.head(6, 30n);
                out.bytes(reduceRational(tmp.result()));
                return next;
            }
            out.head(6, h.arg);
            return writeItem(b, h.next, out, depth + 1);
        }
        default: {
            if (h.info === 31) throw new Error(`unexpected break at offset ${p}`);
            if (h.info === 25 || h.info === 26 || h.info === 27) {
                // floats keep their width and bits
                out.bytes(b.subarray(p, h.next));
                return h.next;
            }
            if (h.info === 24 && h.arg < 32n) throw new Error(`non-canonical simple value ${h.arg} at offset ${p}`);
            out.head(7, h.arg);
            return h.next;
        }
    }
}

/** Normalize one encoded item; throws on malformed CBOR or trailing bytes. */
export function normalizeCbor(bytes: Uint8Array): Uint8Array {
    const out = new Out();
    const end = writeItem(bytes, 0, out, 0);
    if (end !== bytes.length) throw new Error(`${bytes.length - end} trailing bytes after the top-level item`);
    return out.result();
}

/** Offset just past the first CBOR item of `bytes` (throws when it is not well-formed). */
export function cborItemEnd(bytes: Uint8Array, p = 0): number {
    return writeItem(bytes, p, new Out(), 0);
}
