import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bls12_381_G1_compress } from "@harmoniclabs/crypto";
import { evaluate, type EvalResult } from "./cek";
import { costTable } from "./costs";
import { FlatError, TK, builtinsAvailable, constTypeSize, decodeProgram, type Term } from "./flat";
import { VValue, valueFromList } from "./multiasset";
import { encodeProgramFlat, parseProgram } from "./uplcText";
import { ConstT, T, VCon } from "./values";

/**
 * Plutus batch 6 and the other van Rossem (protocol 11) evaluator changes of plutus-core 1.63.0.0
 * (cardano-node 11.0.1) that the conformance suite (conformance.test.ts) does not reach: the
 * flat decoder's Value constants and protocol-11 bounds, the `ensurable` argument bounds of
 * semantics variants D/E, and the budgets of a V3 script using the new builtins (cross-checked
 * with aiken's uplc 1.1.24). Cost models: preview's at protocol 11 (the conformance fixture's).
 */
const fx = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(new URL("../__fixtures__/plutus-conformance-1.63.json.gz", import.meta.url))))) as {
    costModels: { PlutusV1: number[]; PlutusV2: number[]; PlutusV3: number[] };
};
const MODELS = { 1: fx.costModels.PlutusV1, 2: fx.costModels.PlutusV2, 3: fx.costModels.PlutusV3 } as const;
const UNLIMITED = { cpu: Number.MAX_SAFE_INTEGER, mem: Number.MAX_SAFE_INTEGER };

function run(src: string, lang: 1 | 2 | 3 = 3, pv = 11, budget = UNLIMITED): EvalResult {
    const p = parseProgram(src.includes("(program") ? src : `(program 1.1.0 ${src})`);
    return evaluate(p.term, costTable(lang, MODELS[lang], pv), budget, { pv });
}
const ok = (r: EvalResult) => { if (!r.ok) throw new Error(`evaluation failed: ${r.error}`); return (r.result as VCon).v; };
const fails = (r: EvalResult) => { expect(r.ok).toBe(false); expect(r.error?.startsWith("evaluator limit")).toBe(false); };
const hex = (n: number, b = "ab") => "#" + b.repeat(n);
const big = (e: bigint) => (1n << e).toString();

describe("builtin availability (plutus-ledger-api 1.63 builtinsIntroducedIn)", () => {
    test("batch 6 (tags 87–100) in every language from protocol 11 only; no tag 101", () => {
        for (const lang of [1, 2, 3] as const) {
            for (let t = 87; t <= 100; t++) { expect(builtinsAvailable(lang, 11).has(t)).toBe(true); expect(builtinsAvailable(lang, 10).has(t)).toBe(false); }
            expect(builtinsAvailable(lang, 11).has(101)).toBe(false);
        }
    });
    test("a script using insertCoin decodes at protocol 11, not at 10", () => {
        const b = encodeProgramFlat(parseProgram("(program 1.0.0 (builtin insertCoin))"));
        expect(decodeProgram(b, 3, 11).term).toEqual({ k: TK.Builtin, fn: 94 });
        expect(() => decodeProgram(b, 3, 10)).toThrow(FlatError);
        expect(() => decodeProgram(b, 1, 10)).toThrow(FlatError);
        expect(decodeProgram(b, 1, 11).term.k).toBe(TK.Builtin);
    });
});

describe("flat decoding (plutus-core 1.63 Flat instances, maxBoundsByPV)", () => {
    const roundTrip = (src: string, lang: 1 | 2 | 3 = 3, pv = 11) => decodeProgram(encodeProgramFlat(parseProgram(src)), lang, pv);
    /** A hand-assembled flat program `(program 1.0.0 (con <tags> <value>))`: bits with absolute positions (bytestring fillers). */
    class Bits {
        b: number[] = [];
        put(v: number | bigint, w: number) { for (let i = w - 1; i >= 0; i--) this.b.push(Number((BigInt(v) >> BigInt(i)) & 1n)); return this; }
        bytes(x: number[]) { do this.b.push(0); while (this.b.length % 8 !== 0); this.b[this.b.length - 1] = 1; if (x.length) { this.put(x.length, 8); for (const y of x) this.put(y, 8); } return this.put(0, 8); }
        integer(q: bigint) { let n = q >= 0n ? q << 1n : ((-q - 1n) << 1n) | 1n; do { const ch = n & 127n; n >>= 7n; this.put(n > 0n ? ch | 128n : ch, 8); } while (n > 0n); return this; }
        static program(tags: number[], value: (w: Bits) => void): Uint8Array {
            const w = new Bits().put(1, 8).put(0, 8).put(0, 8).put(4, 4);
            for (const t of tags) w.put(1, 1).put(t, 4);
            w.put(0, 1); value(w);
            do w.b.push(0); while (w.b.length % 8 !== 0); w.b[w.b.length - 1] = 1;
            const out = new Uint8Array(w.b.length / 8); w.b.forEach((x, i) => { out[i >> 3]! |= x << (7 - (i & 7)); });
            return out;
        }
    }
    const rawConst = (tags: number[], bits: number[]) => Bits.program(tags, (w) => { w.b.push(...bits); });

    test("Value constants: canonical ones decode (any language, any version)", () => {
        const t = roundTrip("(program 1.0.0 (con value [(#, [(#, 1)]), (#aa, [(#01, -170141183460469231731687303715884105728), (#02, 170141183460469231731687303715884105727)])]))", 1, 11).term as Extract<Term, { k: TK.Const }>;
        const v = t.v.v as VValue;
        expect(t.v.type).toBe(T.value);
        expect([v.total, v.maxInner, v.neg, v.entries.length]).toEqual([3, 2, 1, 2]);
    });
    test("Value constants: non-canonical, oversized or out-of-bounds ones do not decode (buildValueWith)", () => {
        type E = Array<[number[], Array<[number[], bigint]>]>;
        const dec = (entries: E) => decodeProgram(Bits.program([13], (w) => {
            for (const [c, ts] of entries) { w.put(1, 1).bytes(c); for (const [k, q] of ts) w.put(1, 1).bytes(k).integer(q); w.put(0, 1); }
            w.put(0, 1);
        }), 3, 11).term as any;
        expect(dec([[[0xaa], [[[1], 5n]]]]).v.v.total).toBe(1);
        expect(() => dec([[[0xbb], [[[1], 5n]]], [[0xaa], [[[1], 5n]]]])).toThrow(/currency symbols not strictly ascending/);
        expect(() => dec([[[0xaa], [[[1], 5n]]], [[0xaa], [[[2], 5n]]]])).toThrow(/currency symbols not strictly ascending/);
        expect(() => dec([[[0xaa], [[[2], 5n], [[1], 5n]]]])).toThrow(/token names not strictly ascending/);
        expect(() => dec([[[0xaa], [[[1], 0n]]]])).toThrow(/zero quantity/);
        expect(() => dec([[[0xaa], []]])).toThrow(/empty inner map/);
        expect(() => dec([[new Array(33).fill(1), [[[1], 5n]]]])).toThrow(/invalid Value key/);
        expect(() => dec([[[0xaa], [[new Array(33).fill(1), 5n]]]])).toThrow(/invalid Value key/);
        expect(() => dec([[[0xaa], [[[1], 1n << 127n]]]])).toThrow(/128-bit/);
        expect(() => dec([[[0xaa], [[[1], -(1n << 127n) - 1n]]]])).toThrow(/128-bit/);
        expect(dec([[new Array(32).fill(1), [[new Array(32).fill(2), -(1n << 127n)]]]]).v.v.neg).toBe(1);
    });
    test("BLS12-381 constant types decode; their values do not (an empty list of points is a constant)", () => {
        expect((decodeProgram(rawConst([7, 5, 9], [0]), 3, 11).term as any).v.type).toBe(ConstT.list(T.g1));
        expect((decodeProgram(rawConst([7, 12, 10], [0]), 3, 11).term as any).v.type).toBe(ConstT.array(T.g2));
        expect(() => decodeProgram(rawConst([7, 5, 9], [1]), 3, 11)).toThrow(/BLS12-381 values cannot be flat-decoded/);
        expect(() => decodeProgram(rawConst([9], []), 3, 11)).toThrow(FlatError);
    });
    test("arrays are not gated on the Plutus Core version", () => {
        expect((roundTrip("(program 1.0.0 (con (array integer) [1, 2]))", 1, 11).term as any).v.type).toBe(ConstT.array(T.int));
    });
    test("from protocol 11 a constant's type has size at most 32 (defaultUniSize)", () => {
        const nest = (n: number) => (n === 0 ? "integer" : `(list ${nest(n - 1)})`);
        expect(constTypeSize(ConstT.pair(T.int, ConstT.list(T.data)))).toBe(7); // (1 + 1 + 1) + (1 + 1 + 1) + 1
        const ok15 = `(program 1.0.0 (con ${nest(15)} []))`, bad16 = `(program 1.0.0 (con ${nest(16)} []))`; // sizes 31, 33
        expect(roundTrip(ok15).term.k).toBe(TK.Const);
        expect(() => roundTrip(bad16)).toThrow(/type size 33/);
        expect(roundTrip(bad16, 3, 10).term.k).toBe(TK.Const);
        // pair (list^7 integer) (list^7 integer): 15 + 15 + 3 = 33
        expect(() => roundTrip(`(program 1.0.0 (con (pair ${nest(7)} ${nest(7)}) ([], [])))`)).toThrow(/type size 33/);
        expect(roundTrip(`(program 1.0.0 (con (pair ${nest(7)} ${nest(6)}) ([], [])))`).term.k).toBe(TK.Const);
    });
    test("from protocol 11 a constr has at most 1024 fields", () => {
        const c = (n: number) => `(program 1.1.0 (constr 0 ${"(con unit ()) ".repeat(n)}))`;
        expect((roundTrip(c(1024)).term as any).fields.length).toBe(1024);
        expect(() => roundTrip(c(1025))).toThrow(/1025 fields/);
        expect((roundTrip(c(1025), 3, 10).term as any).fields.length).toBe(1025);
    });
    test("a constr tag up to 2^64 − 1 decodes exactly", () => {
        expect((roundTrip("(program 1.1.0 (constr 18446744073709551615))").term as any).tag).toBe(18446744073709551615n);
    });
});

describe("variants D/E argument bounds (plutus-core 1.63 `ensurable`, PlutusCore.Default.Universe.Cardano)", () => {
    const MAXI = (1n << 262143n) - 1n, MINI = -(1n << 262143n);
    test("integer arithmetic takes CIntegers from protocol 11 (V3 E, V1/V2 D); the results are unbounded", () => {
        expect(ok(run(`[(builtin addInteger) (con integer ${MAXI}) (con integer 1)]`))).toBe(MAXI + 1n);
        fails(run(`[(builtin addInteger) (con integer ${MAXI + 1n}) (con integer 0)]`));
        fails(run(`[(builtin multiplyInteger) (con integer 1) (con integer ${MINI - 1n})]`));
        expect(ok(run(`[(builtin subtractInteger) (con integer ${MINI}) (con integer 0)]`))).toBe(MINI);
        fails(run(`[(builtin lessThanInteger) (con integer ${MAXI + 1n}) (con integer 0)]`));
        fails(run(`[(builtin divideInteger) (con integer ${MAXI + 1n}) (con integer 2)]`, 1, 11));
        fails(run(`[(builtin modInteger) (con integer ${MAXI + 1n}) (con integer 2)]`, 2, 11));
        // equalsInteger is not bounded; before protocol 11 nothing is
        expect(ok(run(`[(builtin equalsInteger) (con integer ${MAXI + 1n}) (con integer ${MAXI + 1n})]`))).toBe(true);
        expect(ok(run(`[(builtin addInteger) (con integer ${MAXI + 1n}) (con integer 0)]`, 3, 10))).toBe(MAXI + 1n);
        expect(ok(run(`[(builtin addInteger) (con integer ${MAXI + 1n}) (con integer 0)]`, 1, 10))).toBe(MAXI + 1n);
    });
    test("bytestring and hash builtins take CByteStrings (≤ 65536 bytes) from protocol 11", () => {
        const at = hex(65536), over = hex(65537);
        expect(ok(run(`[(builtin lengthOfByteString) [(builtin appendByteString) (con bytestring ${at}) (con bytestring ${at})]]`))).toBe(131072n);
        fails(run(`[(builtin appendByteString) (con bytestring ${over}) (con bytestring #)]`));
        for (const h of ["sha2_256", "sha3_256", "blake2b_256", "keccak_256", "blake2b_224", "ripemd_160", "complementByteString", "countSetBits", "findFirstSetBit"]) {
            expect(run(`[(builtin ${h}) (con bytestring ${at})]`).ok).toBe(true);
            fails(run(`[(builtin ${h}) (con bytestring ${over})]`));
            expect(run(`[(builtin ${h}) (con bytestring ${over})]`, 3, 10).ok).toBe(true);
        }
        fails(run(`[(builtin equalsByteString) (con bytestring #) (con bytestring ${over})]`));
        fails(run(`[(builtin indexByteString) (con bytestring ${over}) (con integer 0)]`));
        fails(run(`[(builtin sliceByteString) (con integer 0) (con integer 1) (con bytestring ${over})]`));
        fails(run(`[(builtin consByteString) (con integer 1) (con bytestring ${over})]`));
        fails(run(`[(builtin decodeUtf8) (con bytestring ${hex(65537, "61")})]`));
        fails(run(`[(builtin byteStringToInteger) (con bool True) (con bytestring ${over})]`));
        fails(run(`[(builtin andByteString) (con bool False) (con bytestring ${over}) (con bytestring #)]`));
        fails(run(`[(builtin readBit) (con bytestring ${over}) (con integer 0)]`));
        fails(run(`[(builtin bls12_381_G1_hashToGroup) (con bytestring ${over}) (con bytestring #01)]`));
        // not bounded: lengthOfByteString, bData, the ECDSA message, shift/rotate's bytestring
        expect(ok(run(`[(builtin lengthOfByteString) (con bytestring ${over})]`))).toBe(65537n);
        expect(run(`[(builtin shiftByteString) (con bytestring ${over}) (con integer 1)]`).ok).toBe(true);
        expect(run(`[(builtin bData) (con bytestring ${over})]`).ok).toBe(true);
        // V1/V2 (variant D) too
        fails(run(`[(builtin sha2_256) (con bytestring ${over})]`, 1, 11));
    });
    test("the signature builtins bound only the message", () => {
        const pk = hex(32, "00"), sig = hex(64, "00");
        fails(run(`[(builtin verifyEd25519Signature) (con bytestring ${pk}) (con bytestring ${hex(65537)}) (con bytestring ${sig})]`));
        expect(ok(run(`[(builtin verifyEd25519Signature) (con bytestring ${pk}) (con bytestring ${hex(65536)}) (con bytestring ${sig})]`))).toBe(false);
    });
    test("constrData's tag is a Word64, shift/rotate amounts an Int, writeBits' input ≤ 4096 bytes", () => {
        expect(run(`[(builtin constrData) (con integer 18446744073709551615) (con (list data) [])]`).ok).toBe(true);
        fails(run(`[(builtin constrData) (con integer 18446744073709551616) (con (list data) [])]`));
        fails(run(`[(builtin constrData) (con integer -1) (con (list data) [])]`));
        expect(run(`[(builtin constrData) (con integer -1) (con (list data) [])]`, 3, 10).ok).toBe(true);
        fails(run(`[(builtin rotateByteString) (con bytestring #ff) (con integer 9223372036854775808)]`));
        expect(ok(run(`[(builtin shiftByteString) (con bytestring #ff) (con integer 9223372036854775808)]`, 3, 10))).toEqual(new Uint8Array([0]));
        fails(run(`[(builtin writeBits) (con bytestring ${hex(4097, "00")}) (con (list integer) []) (con bool True)]`));
        expect(run(`[(builtin writeBits) (con bytestring ${hex(4096, "00")}) (con (list integer) [0]) (con bool True)]`).ok).toBe(true);
        expect(run(`[(builtin writeBits) (con bytestring ${hex(4097, "00")}) (con (list integer) [0]) (con bool True)]`, 3, 10).ok).toBe(true);
    });
    test("BLS12-381 scalarMul takes scalars within 4096 bits from protocol 11", () => {
        const g = "(con bls12_381_G1_element 0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb)";
        expect(run(`[(builtin bls12_381_G1_scalarMul) (con integer -${big(4095n)}) ${g}]`).ok).toBe(true);
        fails(run(`[(builtin bls12_381_G1_scalarMul) (con integer ${big(4095n)}) ${g}]`));
        expect(run(`[(builtin bls12_381_G1_scalarMul) (con integer ${big(4095n)}) ${g}]`, 3, 10).ok).toBe(true);
    });
    test("expModInteger's bounds are [−2^8191, 2^8191 − 1] (PlutusCore.Crypto.ExpMod)", () => {
        const b = -(1n << 8191n);
        expect(ok(run(`[(builtin expModInteger) (con integer ${b}) (con integer 1) (con integer 7)]`))).toBe(((b % 7n) + 7n) % 7n);
        fails(run(`[(builtin expModInteger) (con integer ${b - 1n}) (con integer 1) (con integer 7)]`));
        fails(run(`[(builtin expModInteger) (con integer 2) (con integer ${-b}) (con integer 7)]`));
    });
});

describe("costing", () => {
    test("listToArray is costed on the list's length (ExMemoryUsage [a] has no element measure)", () => {
        const empty = run(`[(force (builtin listToArray)) (con (list integer) [])]`);
        const one = run(`[(force (builtin listToArray)) (con (list integer) [${big(640n)}])]`); // a 11-word integer
        const two = run(`[(force (builtin listToArray)) (con (list data) [B ${hex(800)}, I 1])]`);
        // linear_in_x: cpu 1000 + 24838·len, mem 7 + 1·len
        expect([one.cpu - empty.cpu, one.mem - empty.mem]).toEqual([24838, 1]);
        expect([two.cpu - empty.cpu, two.mem - empty.mem]).toEqual([2 * 24838, 2]);
    });
    test("multi-scalar multiplication is costed on the scalar list's length", () => {
        const r = (n: number) => run(`[(builtin bls12_381_G1_multiScalarMul) (con (list integer) [${Array(n).fill(3).join(", ")}]) (con (list bls12_381_G1_element) [])]`);
        expect(r(3).cpu - r(1).cpu).toBe(2 * 25087669);
        expect(r(3).mem).toBe(r(1).mem);
    });
});

describe("multi-scalar multiplication (BLS12_381.G1/G2.multiScalarMul)", () => {
    const P = "0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
    test("Σ sᵢ·Pᵢ over the zipped lists; the empty sum is the identity", () => {
        const id = ok(run(`[(builtin bls12_381_G1_multiScalarMul) (con (list integer) []) (con (list bls12_381_G1_element) [${P}])]`));
        expect(Buffer.from(bls12_381_G1_compress(id)).toString("hex")).toBe("c0" + "00".repeat(47));
        expect(ok(run(`[(builtin bls12_381_G1_equal)
            [(builtin bls12_381_G1_multiScalarMul) (con (list integer) [2, 3, 99]) (con (list bls12_381_G1_element) [${P}, ${P}])]
            [(builtin bls12_381_G1_scalarMul) (con integer 5) (con bls12_381_G1_element ${P})]]`))).toBe(true);
    });
    test("every scalar is bounds-checked, also those beyond the points", () => {
        fails(run(`[(builtin bls12_381_G1_multiScalarMul) (con (list integer) [1, ${big(4095n)}]) (con (list bls12_381_G1_element) [${P}])]`));
        expect(run(`[(builtin bls12_381_G1_multiScalarMul) (con (list integer) [1, -${big(4095n)}]) (con (list bls12_381_G1_element) [${P}])]`).ok).toBe(true);
    });
});

describe("Value builtins (PlutusCore.Value): results and errors beyond the conformance suite", () => {
    const v = (s: string) => `(con value ${s})`;
    test("insertCoin with amount 0 deletes without checking the keys; otherwise keys ≤ 32 bytes and 128-bit amounts", () => {
        expect((ok(run(`[(builtin insertCoin) (con bytestring ${hex(33)}) (con bytestring #) (con integer 0) ${v("[(#aa, [(#bb, 1)])]")}]`)) as VValue).total).toBe(1);
        expect((ok(run(`[(builtin insertCoin) (con bytestring #aa) (con bytestring #bb) (con integer 0) ${v("[(#aa, [(#bb, 1)])]")}]`)) as VValue).total).toBe(0);
        fails(run(`[(builtin insertCoin) (con bytestring ${hex(33)}) (con bytestring #) (con integer 1) ${v("[]")}]`));
        fails(run(`[(builtin insertCoin) (con bytestring #) (con bytestring #) (con integer ${big(127n)}) ${v("[]")}]`));
        expect((ok(run(`[(builtin insertCoin) (con bytestring #) (con bytestring #) (con integer -${big(127n)}) ${v("[]")}]`)) as VValue).neg).toBe(1);
    });
    test("lookupCoin of a missing entry (or an over-long key) is 0", () => {
        expect(ok(run(`[(builtin lookupCoin) (con bytestring ${hex(40)}) (con bytestring #bb) ${v("[(#aa, [(#bb, 7)])]")}]`))).toBe(0n);
        expect(ok(run(`[(builtin lookupCoin) (con bytestring #aa) (con bytestring #bb) ${v("[(#aa, [(#bb, 7)])]")}]`))).toBe(7n);
    });
    test("unionValue drops cancelled entries and fails beyond 128 bits", () => {
        expect((ok(run(`[(builtin unionValue) ${v("[(#aa, [(#bb, 7)])]")} ${v("[(#aa, [(#bb, -7)])]")}]`)) as VValue).entries).toEqual([]);
        fails(run(`[(builtin unionValue) ${v(`[(#aa, [(#bb, ${(1n << 127n) - 1n})])]`)} ${v("[(#aa, [(#bb, 1)])]")}]`));
    });
    test("valueContains fails on negative amounts in either value", () => {
        fails(run(`[(builtin valueContains) ${v("[(#aa, [(#bb, -1)])]")} ${v("[]")}]`));
        fails(run(`[(builtin valueContains) ${v("[]")} ${v("[(#aa, [(#bb, -1)])]")}]`));
        expect(ok(run(`[(builtin valueContains) ${v("[(#aa, [(#bb, 2)]), (#cc, [(#01, 1)])]")} ${v("[(#aa, [(#bb, 2)])]")}]`))).toBe(true);
        expect(ok(run(`[(builtin valueContains) ${v("[(#aa, [(#bb, 1)]), (#cc, [(#01, 1)])]")} ${v("[(#aa, [(#bb, 2)])]")}]`))).toBe(false);
    });
    test("valueData fails above 40000 entries; unValueData is strict", () => {
        const many = (n: number) => new VCon(T.value, valueFromList([[new Uint8Array([1]), Array.from({ length: n }, (_, i) => [new Uint8Array([i >> 16, (i >> 8) & 255, i & 255]), 1n] as const)]]));
        const vd = (n: number) => evaluate({ k: TK.Apply, f: { k: TK.Builtin, fn: 98 }, a: { k: TK.Const, v: many(n) } }, costTable(3, MODELS[3], 11), UNLIMITED, { pv: 11 });
        expect(vd(40000).ok).toBe(true);
        fails(vd(40001));
        const uvd = (d: string) => run(`[(builtin unValueData) (con data ${d})]`);
        expect((ok(uvd("(Map [(B #aa, Map [(B #01, I 1), (B #02, I -1)])])")) as VValue).total).toBe(2);
        fails(uvd("(Map [(B #aa, Map [(B #02, I 1), (B #01, I 1)])])"));
        fails(uvd("(Map [(B #aa, Map [(B #01, I 0)])])"));
        fails(uvd("(Map [(B #aa, Map [])])"));
        fails(uvd("(Map [(B #aa, List [])])"));
        fails(uvd("(List [])"));
        fails(uvd(`(Map [(B #aa, Map [(B #01, I ${big(127n)})])])`));
        expect(ok(uvd("(Map [])"))).toBeInstanceOf(VValue);
    });
    test("scaleValue by 0 is empty; by a negative factor flips the signs; overflow fails", () => {
        expect((ok(run(`[(builtin scaleValue) (con integer 0) ${v("[(#aa, [(#bb, 7)])]")}]`)) as VValue).total).toBe(0);
        const r = ok(run(`[(builtin scaleValue) (con integer -3) ${v("[(#aa, [(#bb, 7), (#cc, -1)])]")}]`)) as VValue;
        expect([r.neg, r.entries[0]![1][0]![1], r.entries[0]![1][1]![1]]).toEqual([1, -21n, 3n]);
        fails(run(`[(builtin scaleValue) (con integer ${big(100n)}) ${v(`[(#aa, [(#bb, ${big(30n)})])]`)}]`));
    });
    test("case on a Value, an array or Data is not supported (caseBuiltin)", () => {
        fails(run(`(case (con value []) (con unit ()))`));
        fails(run(`(case (con (array integer) [1]) (con unit ()))`));
        fails(run(`(case (con data (I 1)) (con unit ()))`));
    });
});

describe("a Plutus V3 script using the new builtins, as the ledger evaluates it", () => {
    // Accepts iff the redeemer, as a Value (unValueData), contains #aa.#bb ≥ 5 after insertCoin #aa #bb 5, and
    // Σ [2, 3]·[P, P] = 5·P (P uncompressed from bytes: points have no flat encoding). Flat-encoded and decoded as
    // phase 2 does (decodeProgram, V3, protocol 11), applied to a ScriptContext-shaped Constr 0 [info, redeemer, info].
    const P = "#97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
    const src = `(program 1.1.0 (lam ctx
        [ (lam v [ (lam p
            (case [(builtin valueContains)
                     [(builtin insertCoin) (con bytestring #aa) (con bytestring #bb) (con integer 5) v]
                     (con value [(#aa, [(#bb, 5)])])]
               (error)
               (case [(builtin bls12_381_G1_equal)
                        [(builtin bls12_381_G1_multiScalarMul) (con (list integer) [2, 3])
                           [(force (builtin mkCons)) p [(force (builtin mkCons)) p (con (list bls12_381_G1_element) [])]]]
                        [(builtin bls12_381_G1_scalarMul) (con integer 5) p]]
                  (error) (con unit ()))))
            [(builtin bls12_381_G1_uncompress) (con bytestring ${P})] ])
          [(builtin unValueData) [(force (builtin headList)) [(force (builtin tailList)) [(force (force (builtin sndPair))) [(builtin unConstrData) ctx]]]]] ]))`;
    const script = encodeProgramFlat(parseProgram(src));
    const term = decodeProgram(script, 3, 11).term;
    const withCtx = (redeemer: string): Term => ({ k: TK.Apply, f: term, a: parseProgram(`(program 1.0.0 (con data (Constr 0 [List [], ${redeemer}, Constr 1 []])))`).term });
    const costs = costTable(3, MODELS[3], 11);
    test("only decodes from protocol 11", () => { expect(() => decodeProgram(script, 3, 10)).toThrow(FlatError); });
    test("accepts within its declared units; a unit less is a budget failure", () => {
        const r = evaluate(withCtx("Map [(B #cc, Map [(B #01, I 1)])]"), costs, UNLIMITED, { pv: 11 });
        expect(r.ok).toBe(true);
        expect((r.result as VCon).type).toBe(T.unit);
        expect([r.cpu, r.mem]).toEqual(V3_SCRIPT_UNITS);
        expect(evaluate(withCtx("Map [(B #cc, Map [(B #01, I 1)])]"), costs, { cpu: r.cpu, mem: r.mem }, { pv: 11 }).ok).toBe(true);
        expect(evaluate(withCtx("Map [(B #cc, Map [(B #01, I 1)])]"), costs, { cpu: r.cpu - 1, mem: r.mem }, { pv: 11 }).budgetExceeded).toBe(true);
        expect(evaluate(withCtx("Map [(B #cc, Map [(B #01, I 1)])]"), costs, { cpu: r.cpu, mem: r.mem - 1 }, { pv: 11 }).budgetExceeded).toBe(true);
    });
    test("rejects a redeemer that is not a canonical value", () => {
        expect(evaluate(withCtx("Map []"), costs, UNLIMITED, { pv: 11 }).ok).toBe(true);
        expect(evaluate(withCtx("List []"), costs, UNLIMITED, { pv: 11 }).ok).toBe(false);
        expect(evaluate(withCtx("Map [(B #cc, Map [(B #01, I 0)])]"), costs, UNLIMITED, { pv: 11 }).ok).toBe(false);
    });
});
/** aiken's uplc 1.1.24 on the same flat script and context, preview protocol-11 V3 cost model. */
const V3_SCRIPT_UNITS = [504870098, 6891];
