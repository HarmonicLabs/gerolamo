import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { programUnavailable, runConformanceCase, runTextVector } from "./conformance";
import { costTable } from "./costs";
import { UplcParseError, parseProgram } from "./uplcText";
import { TK } from "./flat";
import { VCon } from "./values";
import type { VValue } from "./multiasset";

/**
 * Textual vectors run under a ledger language and protocol version (docs/parity/ndc-uplc.md,
 * bugs 550–553; pragma's uplc-conformance corpus).
 */
const fx = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(new URL("../__fixtures__/plutus-conformance-1.63.json.gz", import.meta.url))))) as {
    costModels: { PlutusV1: number[]; PlutusV2: number[]; PlutusV3: number[] };
};
const run = (src: string, lang: 1 | 2 | 3, pv: number) =>
    runTextVector(src, costTable(lang, lang === 1 ? fx.costModels.PlutusV1 : lang === 2 ? fx.costModels.PlutusV2 : fx.costModels.PlutusV3, pv), { lang, pv });

describe("bug 550: any Plutus Core version parses; bug 553: an unavailable one is the ledger's decode error", () => {
    test("any version parses (plutus' parser), constr / case still need 1.1.0 or later", () => {
        expect(parseProgram("(program 2.0.0 (con unit ()))").version).toEqual([2, 0, 0]);
        expect(parseProgram("(program 1.0.1 (con unit ()))").version).toEqual([1, 0, 1]);
        expect(() => parseProgram("(program 1.0.0 (constr 0))")).toThrow();
        expect(parseProgram("(program 2.0.0 (constr 0))").term.k).toBe(TK.Constr);
    });
    test("an unknown version is a decode error for every language (PlutusCoreLanguageNotAvailableError)", () => {
        for (const lang of [1, 2, 3] as const) for (const pv of [10, 11]) expect(run("(program 2.0.0 (con unit ()))", lang, pv).outcome).toBe("parse error");
        expect(run("(program 1.0.1 (con unit ()))", 3, 11).outcome).toBe("parse error");
        expect(run("(program 1.0.1 (con unit ()))", 3, 11).detail).toContain("not available");
    });
    test("1.1.0: V3 always, V1 / V2 from protocol 11; 1.2.0 from protocol 12", () => {
        expect(run("(program 1.1.0 (con unit ()))", 1, 10).outcome).toBe("parse error");
        expect(run("(program 1.1.0 (con unit ()))", 2, 10).outcome).toBe("parse error");
        expect(run("(program 1.1.0 (con unit ()))", 1, 11).outcome).toBe("success");
        expect(run("(program 1.1.0 (con unit ()))", 3, 10).outcome).toBe("success");
        expect(run("(program 1.2.0 (con unit ()))", 3, 11).outcome).toBe("parse error");
    });
    test("builtins outside the language's set at the protocol version are a decode error too (the flat decoder's checkBuiltin)", () => {
        const ser = "(program 1.0.0 [(builtin serialiseData) (con data (I 1))])";
        expect(run(ser, 1, 10).outcome).toBe("parse error"); // batch 2 reaches V1 at protocol 11
        expect(run(ser, 1, 11).outcome).toBe("success");
        expect(run(ser, 2, 10).outcome).toBe("success");
        const p = parseProgram(ser);
        expect(programUnavailable(p.version, p.term, 1, 10)).toContain("serialiseData");
        expect(programUnavailable(p.version, p.term, 3, 10)).toBeNull();
    });
    test("a free variable stays an evaluation failure (mkTermToEvaluate's scope check is not a decode error)", () => {
        expect(run("(program 1.0.0 x)", 3, 11).outcome).toBe("evaluation failure");
    });
    test("runConformanceCase applies the same classification (V3 at protocol 11 by default)", () => {
        const r = runConformanceCase("(program 2.0.0 (con unit ()))", "parse/decode error", "parse/decode error", fx.costModels.PlutusV3);
        expect(r.resultOk).toBe(true);
        expect(r.budgetOk).toBe(true);
        expect(runConformanceCase("(program 2.0.0 (con unit ()))", "evaluation failure", "evaluation failure", fx.costModels.PlutusV3).resultOk).toBe(false);
    });
});

describe("bug 551: verifySignature, the old name of verifyEd25519Signature", () => {
    test("parses to flat tag 21 and verifies", () => {
        const src = "(program 1.0.0 [[[(builtin verifySignature) (con bytestring #d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a)] (con bytestring #)] (con bytestring #e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b)])";
        const p = parseProgram(src);
        expect(JSON.stringify(p.term)).toContain("\"fn\":21");
        const r = run(src, 3, 10);
        expect(r.outcome).toBe("success");
        expect(JSON.stringify(r.term)).toContain("true");
    });
});

describe("bug 552: a value literal must be canonical (plutus-core conValue / Value.buildValueWith)", () => {
    const value = (body: string) => (parseProgram(`(program 1.0.0 (con value ${body}))`).term as { k: TK.Const; v: VCon }).v.v as VValue;
    const rejects = (body: string, why: string) => {
        try { parseProgram(`(program 1.0.0 (con value ${body}))`); }
        catch (e) { expect(e).toBeInstanceOf(UplcParseError); expect((e as Error).message).toContain(why); return; }
        throw new Error(`${body}: parsed, expected a parse error (${why})`);
    };
    test("canonical literals parse, with the cached sizes", () => {
        expect(value("[]").total).toBe(0);
        const v = value("[(#, [(#, 123), (#bb, 50000)]), (#ffff, [(#aa, -10), (#bb, 20)])]");
        expect([v.total, v.maxInner, v.neg]).toEqual([4, 2, 1]);
        // 32-byte keys and the 128-bit bounds are fine
        const k32 = "#" + "aa".repeat(32);
        expect(value(`[(${k32}, [(#, 123), (#00, 456)])]`).total).toBe(2);
        expect(value(`[(#, [(#1234, 456), (${k32}, 123)])]`).maxInner).toBe(2);
        expect(value("[(#, [(#, 170141183460469231731687303715884105727)])]").total).toBe(1);
        expect(value("[(#, [(#, -170141183460469231731687303715884105728)])]").neg).toBe(1);
    });
    test("anything not canonical is a parse error, never normalised", () => {
        rejects("[(#88, [(#aa, 1)]), (#123456, [(#bb, 1)])]", "currency symbols not strictly ascending");
        rejects("[(#1234, [(#00, 1)]), (#1234, [(#02, 1)])]", "currency symbols not strictly ascending"); // duplicates
        rejects("[(#, [(#9999, 5), (#123456, 100)])]", "token names not strictly ascending");
        rejects("[(#, [(#, 123), (#, 456)])]", "token names not strictly ascending"); // duplicates
        rejects("[(#, [])]", "empty inner map");
        rejects("[(#, [(#, 0), (#aa, 1)])]", "zero quantity");
        rejects("[(#, [(#, 170141183460469231731687303715884105728)])]", "Quantity out of bounds");
        rejects("[(#, [(#, -170141183460469231731687303715884105729)])]", "Quantity out of bounds");
        rejects(`[(#${"aa".repeat(33)}, [(#11, 123)])]`, "longer than 32 bytes");
        rejects(`[(#, [(#${"aa".repeat(33)}, 123)])]`, "longer than 32 bytes");
        rejects("[(\"CURRENCY\", [(\"TOKEN\", 123)])]", "expected #");
    });
    test("plutus 1.63's parser normalised instead (valueLiterals: \"normalise\"); bounds and key lengths were parse errors there too", () => {
        const legacy = (body: string) => (parseProgram(`(program 1.0.0 (con value ${body}))`, { valueLiterals: "normalise" }).term as { k: TK.Const; v: VCon }).v.v as VValue;
        const v = legacy("[(#, [(#, 123), (#, 456)])]"); // duplicates summed
        expect([v.total, Number(v.entries[0]![1][0]![1])]).toEqual([1, 579]);
        expect(legacy("[(#, [])]").total).toBe(0); // empty inner list dropped
        expect(legacy("[(#, [(#, 0), (#aa, 1)])]").total).toBe(1); // zero dropped
        expect(legacy("[(#ffff, [(#bb, 1), (#aa, 2)]), (#aa, [(#aa, 3)])]").entries.map(([c]) => Buffer.from(c).toString("hex"))).toEqual(["aa", "ffff"]); // sorted
        for (const body of ["[(#, [(#, 170141183460469231731687303715884105728)])]", `[(#${"aa".repeat(33)}, [(#11, 123)])]`]) {
            expect(() => parseProgram(`(program 1.0.0 (con value ${body}))`, { valueLiterals: "normalise" })).toThrow(UplcParseError);
        }
    });
});
