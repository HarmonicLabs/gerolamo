import { describe, expect, test } from "bun:test";
import { FlatError, TK, applyData, compileTerm, decodeProgram, type Term } from "./flat";
import { DBytes, DConstr, DInt, DList, DMap, DPair, dataEq, decodeData, encodeData, type Data } from "./data";
import { parseCbor } from "./cbor";
import { encodeProgramFlat, parseProgram, termEq } from "./uplcText";
import { ConstT, LArr, T, VArray, VCon, VPair } from "./values";

/**
 * The flat decoder's bit cursor (flat.ts): fixed-width reads through a 32-bit accumulator, the
 * 16-bit peek dispatch of term headers, iterative (stack-based) term decoding, bytestring blocks,
 * naturals up to and beyond 2^53, the filler, and the end of the input, plus the Data / CBOR
 * readers it leans on (data.ts, cbor.ts). Truncated input is always a rejection, never a hang.
 */
const flat = (src: string) => encodeProgramFlat(parseProgram(src));
const decode = (src: string, lang: 1 | 2 | 3 = 3, pv = 11) => decodeProgram(flat(src), lang, pv);
const constOf = (src: string, lang: 1 | 2 | 3 = 3, pv = 11): VCon => (decode(`(program 1.1.0 ${src})`, lang, pv).term as Extract<Term, { k: TK.Const }>).v;
const roundTrips = (src: string, lang: 1 | 2 | 3 = 3, pv = 11) => expect(termEq(decode(src, lang, pv).term, parseProgram(src).term)).toBe(true);

/** Hand-assembled bits (most significant first), with byte-aligned bytestring blocks. */
class Bits {
    b: number[] = [];
    put(v: number | bigint, w: number) { for (let i = w - 1; i >= 0; i--) this.b.push(Number((BigInt(v) >> BigInt(i)) & 1n)); return this; }
    filler() { do this.b.push(0); while (this.b.length % 8 !== 0); this.b[this.b.length - 1] = 1; return this; }
    /** `blocks`: explicit block contents (a zero-length block ends the string). */
    blocks(blocks: number[][]) { this.filler(); for (const x of blocks) { this.put(x.length, 8); for (const y of x) this.put(y, 8); } return this.put(0, 8); }
    natural(n: bigint) { do { const ch = n & 127n; n >>= 7n; this.put(n > 0n ? ch | 128n : ch, 8); } while (n > 0n); return this; }
    version() { return this.put(1, 8).put(0, 8).put(0, 8); }
    out(): Uint8Array { const o = new Uint8Array(Math.ceil(this.b.length / 8)); this.b.forEach((x, i) => { o[i >> 3]! |= x << (7 - (i & 7)); }); return o; }
    /** `(program 1.0.0 <term bits>)` with the final filler. */
    program(term: (w: Bits) => void): Uint8Array { this.version(); term(this); return this.filler().out(); }
}
const CON = 4, UNIT_TAGS = (w: Bits) => w.put(1, 1).put(3, 4).put(0, 1);

describe("term headers and the iterative term decoder", () => {
    test("every node kind, nested, round-trips", () => {
        roundTrips("(program 1.1.0 (lam x (lam y [[(builtin addInteger) x] [(force (delay y)) (con integer 7)]])))");
        roundTrips("(program 1.1.0 (case (constr 1 (con unit ()) (con bool True) (error)) (lam a a) (lam b (lam c c)) (constr 0)))");
        roundTrips("(program 1.1.0 (constr 0))");
        roundTrips("(program 1.1.0 [(constr 2 (constr 1 (constr 0)) (con integer -1)) (case (con unit ()))])");
    });
    test("de Bruijn indexes: one byte, several bytes, index 0 only with deserialiseOnly", () => {
        const varTerm = (i: bigint) => new Bits().program((w) => { w.put(TK.Var, 4).natural(i); });
        for (const i of [1n, 127n, 128n, 255n, 16383n, 16384n, 2n ** 31n, 2n ** 49n - 1n]) {
            expect(decodeProgram(varTerm(i), 3, 11, { deserialiseOnly: true }).term).toEqual({ k: TK.Var, i: Number(i) });
        }
        expect(() => decodeProgram(varTerm(2n ** 56n), 3, 11, { deserialiseOnly: true })).toThrow(/natural too large/);
        expect(() => decodeProgram(varTerm(0n), 3, 11)).toThrow(/de Bruijn index 0/);
        expect(decodeProgram(varTerm(0n), 3, 11, { deserialiseOnly: true }).term).toEqual({ k: TK.Var, i: 0 });
    });
    test("builtin tags: 7 bits after the 4-bit header, gated by language and protocol", () => {
        const b = (fn: number) => new Bits().program((w) => { w.put(TK.Builtin, 4).put(fn, 7); });
        expect(decodeProgram(b(0), 1, 5).term).toEqual({ k: TK.Builtin, fn: 0 });
        expect(decodeProgram(b(86), 3, 10).term).toEqual({ k: TK.Builtin, fn: 86 });
        expect(() => decodeProgram(b(87), 3, 10)).toThrow(/builtin 87 not available/);
        expect(() => decodeProgram(b(51), 1, 10)).toThrow(/builtin 51 not available/);
        expect(() => decodeProgram(b(127), 3, 12)).toThrow(FlatError);
        expect(() => decodeProgram(new Bits().program((w) => { w.put(10, 4); }), 3, 11)).toThrow(/unknown term tag 10/);
    });
    test("a 200 000-deep term decodes (no recursion in the decoder) and 1 000 constr fields in a row", () => {
        const deep = new Bits().program((w) => { for (let i = 0; i < 200_000; i++) w.put(i % 2 ? TK.Delay : TK.Force, 4); w.put(CON, 4); UNIT_TAGS(w); });
        let t: Term = decodeProgram(deep, 3, 11).term, depth = 0;
        while (t.k === TK.Delay || t.k === TK.Force) { t = t.b; depth++; }
        expect(depth).toBe(200_000);
        expect(t).toEqual({ k: TK.Const, v: new VCon(T.unit, null) });
        const wide = new Bits().put(1, 8).put(1, 8).put(0, 8);
        wide.put(TK.Constr, 4).natural(5n);
        for (let i = 0; i < 1000; i++) { wide.put(1, 1).put(CON, 4); UNIT_TAGS(wide); }
        wide.put(0, 1);
        const c = decodeProgram(wide.filler().out(), 3, 11).term as Extract<Term, { k: TK.Constr }>;
        expect([c.tag, c.fields.length]).toEqual([5, 1000]);
    });
    test("constr and case read the list continuation bit after each child", () => {
        // (program 1.1.0 (case (constr 0 x1 … xf) b1 … bb)) with Var children
        const mk = (fields: number, branches: number) => {
            const w = new Bits().put(1, 8).put(1, 8).put(0, 8);
            w.put(TK.Case, 4).put(TK.Constr, 4).natural(0n);
            for (let i = 0; i < fields; i++) w.put(1, 1).put(TK.Var, 4).natural(BigInt(i + 1));
            w.put(0, 1);
            for (let i = 0; i < branches; i++) w.put(1, 1).put(TK.Var, 4).natural(BigInt(i + 1));
            w.put(0, 1);
            return w.filler().out();
        };
        for (const [f, b] of [[0, 0], [2, 0], [0, 2], [3, 3]] as const) {
            const t = decodeProgram(mk(f, b), 3, 11).term as Extract<Term, { k: TK.Case }>;
            expect([(t.s as any).fields.length, t.bs.length]).toEqual([f, b]);
        }
    });
});

describe("constants", () => {
    test("integers: zigzag, one byte and beyond 2^53, both signs", () => {
        for (const n of [0n, 1n, -1n, 63n, -64n, 64n, -65n, 127n, -128n, 128n, 2n ** 32n, -(2n ** 32n), 2n ** 49n - 1n, 2n ** 49n, 2n ** 53n, -(2n ** 53n) - 1n, 2n ** 64n, -(2n ** 64n), 2n ** 200n + 1n, -(2n ** 200n)]) {
            const c = constOf(`(con integer ${n})`);
            expect(c.type).toBe(T.int);
            expect(c.v).toBe(n);
        }
    });
    test("bytestrings: empty, one block, several blocks, always a copy", () => {
        for (const len of [0, 1, 254, 255, 256, 300, 510, 511, 1000]) {
            const hex = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 255)).toString("hex");
            const c = constOf(`(con bytestring #${hex})`);
            expect(c.type).toBe(T.bytes);
            expect(Buffer.from(c.v as Uint8Array).toString("hex")).toBe(hex);
        }
        const bytes = flat("(program 1.0.0 (con bytestring #0102))");
        const asBuffer = Buffer.from(bytes);
        const v = (decodeProgram(asBuffer, 3, 11).term as any).v.v as Uint8Array;
        v[0] = 0xff;
        expect(asBuffer.includes(Buffer.from([0x01, 0x02]))).toBe(true);
        // hand-made blocks: two blocks of 2, and a zero-length block ends the string
        const two = new Bits().program((w) => { w.put(CON, 4).put(1, 1).put(1, 4).put(0, 1).blocks([[1, 2], [3, 4]]); });
        expect(Array.from((decodeProgram(two, 3, 11).term as any).v.v)).toEqual([1, 2, 3, 4]);
    });
    test("strings: ASCII fast path, UTF-8, long, and invalid UTF-8 rejected", () => {
        expect(constOf('(con string "hello")').v).toBe("hello");
        expect(constOf('(con string "")').v).toBe("");
        const long = "x".repeat(300);
        expect(constOf(`(con string "${long}")`).v).toBe(long);
        const utf8 = new Bits().program((w) => { w.put(CON, 4).put(1, 1).put(2, 4).put(0, 1).blocks([[0x68, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]]); });
        expect((decodeProgram(utf8, 3, 11).term as any).v.v).toBe("hé€😀");
        const bad = new Bits().program((w) => { w.put(CON, 4).put(1, 1).put(2, 4).put(0, 1).blocks([[0x68, 0xff]]); });
        expect(() => decodeProgram(bad, 3, 11)).toThrow(/invalid utf-8/);
        const badLong = new Bits().program((w) => { w.put(CON, 4).put(1, 1).put(2, 4).put(0, 1).blocks([Array.from({ length: 100 }, () => 0x61).concat([0xc3])]); });
        expect(() => decodeProgram(badLong, 3, 11)).toThrow(/invalid utf-8/);
    });
    test("unit, bool and compound types", () => {
        expect(constOf("(con unit ())")).toEqual(new VCon(T.unit, null));
        expect(constOf("(con bool True)").v).toBe(true);
        expect(constOf("(con bool False)").v).toBe(false);
        const l = constOf("(con (list integer) [1, 2, 3])");
        expect(l.type).toBe(ConstT.list(T.int));
        expect((l.v as LArr).arr).toEqual([1n, 2n, 3n]);
        const ll = constOf("(con (list (list bool)) [[True], [], [False, True]])");
        expect(ll.type).toBe(ConstT.list(ConstT.list(T.bool)));
        const p = constOf("(con (pair integer (list bytestring)) (5, [#aa, #]))");
        expect(p.type).toBe(ConstT.pair(T.int, ConstT.list(T.bytes)));
        expect((p.v as VPair).fst).toBe(5n);
        const a = constOf("(con (array integer) [7, 8])", 3, 11);
        expect(a.type).toBe(ConstT.array(T.int));
        expect((a.v as VArray).arr).toEqual([7n, 8n]);
        const d = constOf("(con data (Constr 1 [I 2, B #03, List [I -4], Map [(I 5, B #06)]]))");
        expect(d.type).toBe(T.data);
        expect(dataEq(d.v as Data, new DConstr(1n, [new DInt(2n), new DBytes(new Uint8Array([3])), new DList([new DInt(-4n)]), new DMap([new DPair(new DInt(5n), new DBytes(new Uint8Array([6])))])]))).toBe(true);
    });
    test("type lists: empty, bare application tags, trailing tags, bad applications are rejected", () => {
        const withTags = (tags: number[], value: (w: Bits) => void = () => {}) => new Bits().program((w) => { w.put(CON, 4); for (const t of tags) w.put(1, 1).put(t, 4); w.put(0, 1); value(w); });
        expect(() => decodeProgram(withTags([]), 3, 11)).toThrow(FlatError);
        expect(() => decodeProgram(withTags([5]), 3, 11)).toThrow(/unsupported constant type tag 5/);
        expect(() => decodeProgram(withTags([7]), 3, 11)).toThrow(/unsupported type application/);
        expect(() => decodeProgram(withTags([7, 5]), 3, 11)).toThrow(FlatError);
        expect(() => decodeProgram(withTags([7, 6, 0, 0]), 3, 11)).toThrow(/unsupported type application 6/);
        expect(() => decodeProgram(withTags([7, 7, 5, 0, 0]), 3, 11)).toThrow(/bad type application/);
        expect(() => decodeProgram(withTags([3, 3]), 3, 11)).toThrow(/trailing type tags/);
        expect(() => decodeProgram(withTags([14]), 3, 11)).toThrow(/unsupported constant type tag 14/);
        expect(decodeProgram(withTags([7, 5, 3], (w) => w.put(0, 1)), 3, 11).term.k).toBe(TK.Const);
    });
});

describe("fillers, the end of the input and malformed input", () => {
    test("a filler is any run of zero bits then a one, ending on a byte boundary", () => {
        // (con bytestring #01) with a 2-byte filler before the blocks: 0x00 0x01
        const w = new Bits().version().put(CON, 4).put(1, 1).put(1, 4).put(0, 1);
        while (w.b.length % 8 !== 0) w.b.push(0);
        w.put(0, 8).put(1, 8).put(1, 8).put(1, 8).put(0, 8);
        expect(Array.from((decodeProgram(w.filler().out(), 3, 11).term as any).v.v)).toEqual([1]);
        // a one bit before the boundary is a misaligned filler
        const bad = new Bits().version().put(CON, 4).put(1, 1).put(1, 4).put(0, 1);
        bad.put(1, 1); while (bad.b.length % 8 !== 0) bad.b.push(0);
        bad.put(1, 8).put(1, 8).put(0, 8);
        expect(() => decodeProgram(bad.filler().out(), 3, 11)).toThrow(/misaligned filler/);
    });
    test("trailing bytes and a missing final filler are rejected", () => {
        const ok = flat("(program 1.0.0 (con unit ()))");
        const padded = new Uint8Array(ok.length + 1); padded.set(ok);
        expect(() => decodeProgram(padded, 3, 11)).toThrow(/trailing bytes/);
        expect(() => decodeProgram(ok.subarray(0, ok.length - 1), 3, 11)).toThrow(FlatError);
    });
    test("every truncation of a program is a FlatError, never a hang", () => {
        const srcs = [
            "(program 1.1.0 (lam x [[(builtin addInteger) (con integer 123456789012345)] (con (list bytestring) [#aabbcc, #])]))",
            '(program 1.1.0 (case (constr 3 (con string "abc") (con data (List [I 1, B #0102]))) (delay (error))))',
            `(program 1.0.0 (con bytestring #${"ab".repeat(600)}))`,
        ];
        for (const src of srcs) {
            const b = flat(src);
            for (let cut = 0; cut < b.length; cut++) expect(() => decodeProgram(b.subarray(0, cut), 3, 11)).toThrow(FlatError);
        }
    });
    test("bit flips either decode or fail with a FlatError", () => {
        const b = flat('(program 1.1.0 [(lam x (constr 1 x (con integer 99))) (con data (Map [(I 1, List [B #ff])]))])');
        for (let k = 0; k < b.length * 8; k++) {
            const c = b.slice(); c[k >> 3]! ^= 1 << (7 - (k & 7));
            try { decodeProgram(c, 3, 11); } catch (e) { expect(e).toBeInstanceOf(FlatError); }
        }
    });
    test("protocol-version gates are unchanged", () => {
        expect(() => decode("(program 1.1.0 (constr 0))", 1, 10)).toThrow(/1\.1\.0 not available/);
        expect(() => decode("(program 2.0.0 (con unit ()))", 3, 11)).toThrow(/unsupported Plutus Core version/);
        expect(decodeProgram(flat("(program 2.0.0 (con unit ()))"), 3, 11, { deserialiseOnly: true }).version).toEqual([2, 0, 0]);
        expect(() => decodeProgram(flat("(program 1.0.0 (constr 0))"), 3, 11, { deserialiseOnly: true })).toThrow(/constr needs/);
    });
});

describe("Data and CBOR readers", () => {
    const sample: Data = new DConstr(130n, [new DInt(2n ** 70n), new DInt(-(2n ** 70n)), new DBytes(new Uint8Array(100).fill(7)), new DList([]), new DMap([new DPair(new DInt(0n), new DList([new DInt(255n), new DInt(-256n)]))]), new DConstr(0n, [])]);
    test("round trip, shared small bigints compare by value, constr 102 and bignums", () => {
        const enc = encodeData(sample);
        const dec = decodeData(enc);
        expect(dataEq(dec, sample)).toBe(true);
        expect(Buffer.from(encodeData(dec)).toString("hex")).toBe(Buffer.from(enc).toString("hex"));
        expect((dec as DConstr).tag).toBe(130n);
        // tag 102 with an alternative beyond 2^53 and 64-bit heads
        const big = decodeData(Buffer.from("d866821b00ffffffffffffff80", "hex"));
        expect((big as DConstr).tag).toBe(0x00ffffffffffffffn);
        expect((decodeData(Buffer.from("1bffffffffffffffff", "hex")) as DInt).v).toBe(2n ** 64n - 1n);
        expect((decodeData(Buffer.from("3bffffffffffffffff", "hex")) as DInt).v).toBe(-(2n ** 64n));
        // indefinite-length bytes in chunks, definite inner lengths of every width
        const chunks = decodeData(Buffer.from("5f41aa5801bb590001cc5a00000001ddff", "hex")) as DBytes;
        expect(Array.from(chunks.v)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });
    test("every truncation of a Data item throws (definite and indefinite forms)", () => {
        for (const enc of [encodeData(sample), Buffer.from("9f0102ff", "hex"), Buffer.from("5f41aa41bbff", "hex"), Buffer.from("bf0102ff", "hex"), Buffer.from("d87a9f01ff", "hex")]) {
            for (let cut = 0; cut < enc.length; cut++) expect(() => decodeData(enc.subarray(0, cut))).toThrow(/out of input|trailing|cbor/);
        }
        expect(() => decodeData(Buffer.from("9b0000001000000000", "hex"))).toThrow(/out of input/); // 2^36 items
        expect(() => decodeData(Buffer.from("0100", "hex"))).toThrow(/trailing bytes/);
        expect(() => decodeData(Buffer.from("f5", "hex"))).toThrow(/major type 7/);
    });
    test("the generic CBOR reader rejects truncated input instead of returning a short node", () => {
        expect(() => parseCbor(Buffer.from("invalid"))).toThrow(/out of input/);
        expect(() => parseCbor(Buffer.from("5f41aa", "hex"))).toThrow(/out of input/);
        expect(() => parseCbor(Buffer.from("820102", "hex").subarray(0, 2))).toThrow(/out of input/);
        const n = parseCbor(Buffer.from("83011b00200000000000003a00000100", "hex"));
        expect(n.t).toBe("a");
        if (n.t === "a") { expect(n.v.map((x) => (x as any).v)).toEqual([1n, 2n ** 53n, -257n]); expect(n.e).toBe(16); }
        const long = parseCbor(Buffer.from("5f41aa41bbff", "hex"));
        if (long.t === "b") expect(Array.from(long.v)).toEqual([0xaa, 0xbb]); else throw new Error(long.t);
    });
});

describe("the typed-array program (Code)", () => {
    const J = (t: unknown) => JSON.stringify(t, (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Array.from(v) : v));
    test("object term → compileTerm → materialise is the identity, and matches the flat decoder's arrays", () => {
        for (const src of ["(program 1.1.0 (lam x (lam y [[(builtin addInteger) x] [(force (delay y)) (con integer 7)]])))", "(program 1.1.0 (case (constr 0 (con unit ()) (con bool True) (error)) (lam a a) (lam b (lam c c)) (constr 0)))", "(program 1.1.0 [(constr 2 (constr 1 (constr 0)) (con integer -1)) (case (con unit ()))])", "(program 1.1.0 (constr 0))"]) {
            const parsed = parseProgram(src);
            const compiled = compileTerm(parsed.term, parsed.version);
            expect(termEq(compiled.term, parsed.term)).toBe(true);
            const decoded = decodeProgram(flat(src), 3, 11);
            expect(J(decoded.term)).toBe(J(compiled.term));
            expect(decoded.code.n).toBe(compiled.code.n);
            // apply's function is the next node; its operand, the argument, follows the function's subtree
            const c = decoded.code;
            for (let t = 0; t < c.n; t++) if (c.K[t] === TK.Apply) expect(c.A[t]).toBeGreaterThan(t + 1);
        }
    });
    test("a program with more nodes than the initial estimate decodes (the arrays grow)", () => {
        // 20 000 nested forces are 4 bits each: two nodes per byte, well above the one-per-byte estimate
        const b = new Bits().program((w) => { for (let i = 0; i < 20_000; i++) w.put(TK.Force, 4); w.put(CON, 4); UNIT_TAGS(w); });
        const p = decodeProgram(b, 3, 11);
        expect(p.code.n).toBe(20_001);
        expect(p.code.K.length).toBeGreaterThanOrEqual(20_001);
        let t: Term = p.term, depth = 0;
        while (t.k === TK.Force) { t = t.b; depth++; }
        expect(depth).toBe(20_000);
    });
    test("applyData wraps a shared program in applications without touching it", () => {
        const p = decodeProgram(flat("(program 1.0.0 (lam d (lam r d)))"), 1, 10);
        const n0 = p.code.n;
        const applied = applyData(p, [new DInt(1n), new DBytes(new Uint8Array([2]))]);
        expect(p.code.n).toBe(n0);
        expect(applied.code.n).toBe(n0 + 4);
        expect(termEq(applied.term, parseProgram("(program 1.0.0 [[(lam d (lam r d)) (con data (I 1))] (con data (B #02))])").term)).toBe(true);
        expect(termEq(p.term, parseProgram("(program 1.0.0 (lam d (lam r d)))").term)).toBe(true);
    });
    test("variables with indexes of 2^31 and more keep their value in the object term", () => {
        const varTerm = (i: bigint) => new Bits().program((w) => { w.put(TK.Var, 4).natural(i); });
        for (const i of [2n ** 31n, 2n ** 40n + 5n]) {
            const p = decodeProgram(varTerm(i), 3, 11, { deserialiseOnly: true });
            expect(p.term).toEqual({ k: TK.Var, i: Number(i) });
            expect(p.code.A[0]).toBeLessThan(0);
        }
    });
});
