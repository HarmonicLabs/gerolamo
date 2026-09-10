import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Machine } from "@harmoniclabs/plutus-machine";
import { toCostModelV1, toCostModelV2 } from "@harmoniclabs/cardano-costmodels-ts";
import { Application, Builtin, UPLCBuiltinTag, UPLCConst, UPLCDecoder } from "@harmoniclabs/uplc";
import { Cbor, CborBytes } from "@harmoniclabs/cbor";

/**
 * The evaluator's builtin cost models against the reference implementation (aiken's uplc
 * crate, which reproduces cardano-node's execution units on preview to the unit).
 * Bug 66/67 in PLAN_LEDGER_INTEGRITY.md C: the machine used the Plutus V3 division costs
 * for V1/V2 scripts (through the fake-V3 conversion), charged c02·y instead of c02·y² in the
 * V3 quadratic, and costed V3 multiplyInteger with added instead of multiplied sizes.
 */
const fixture = (name: string) => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8").trim();
const costModels = JSON.parse(fixture("preview-costmodels-736.json")) as Record<"PlutusV1" | "PlutusV2" | "PlutusV3", number[]>;
const machines = { v1: new Machine(costModels.PlutusV1 as any), v2: new Machine(costModels.PlutusV2 as any), v3: new Machine(costModels.PlutusV3 as any) };

describe("Plutus builtin costs vs the reference evaluator", () => {
    test("a real PlutusV2 redeemer (preview tx 8fffef38…, redeemer spend:0) spends exactly its declared budget", () => {
        const flat = (Cbor.parse(fixture("preview-plutusv2-program-8fffef38-0-0.hex")) as CborBytes).bytes;
        const program = UPLCDecoder.parse(flat, "flat");
        const { result, budgetSpent } = machines.v2.eval(program.body);
        expect(result?.constructor?.name).not.toBe("ErrorUPLC");
        expect(String(budgetSpent.cpu)).toBe("494407913");
        expect(String(budgetSpent.mem)).toBe("1621146");
    });
    const rows = JSON.parse(fixture("plutus-integer-builtin-reference.json")) as Array<{ lang: "v1" | "v2" | "v3"; builtin: string; x: string | number; y: string | number; sizes: number[]; cpu: number; mem: number }>;
    for (const r of rows) {
        test(`${r.lang} ${r.builtin} sizes ${r.sizes.join("x")} costs ${r.cpu}/${r.mem}`, () => {
            const term = new Application(new Application(new Builtin((UPLCBuiltinTag as any)[r.builtin]), UPLCConst.int(BigInt(r.x))), UPLCConst.int(BigInt(r.y)));
            const { budgetSpent } = machines[r.lang].eval(term);
            expect(Number(budgetSpent.cpu)).toBe(r.cpu);
            expect(Number(budgetSpent.mem)).toBe(r.mem);
        });
    }
});

describe("V1/V2 cost-model arrays longer than the V3 floor (preview epoch 1270+, bug 74)", () => {
    // Since epoch 1270 the V1/V2 lists carry 332 entries: `new Machine(array)` tests V3 first
    // (≥ 251 entries) and read them with V3 names. Naming the first 175 V2 entries ourselves
    // (what aiken's uplc crate maps) restores the historical order.
    const cm1413 = JSON.parse(fixture("preview-costmodels-1413.json")) as Record<"PlutusV1" | "PlutusV2" | "PlutusV3", number[]>;
    // ifThenElse sits after the bls12_381 block in V3 order (addInteger would not show the shift).
    const prog = new Application(new Application(new Application(new Builtin(UPLCBuiltinTag.ifThenElse), UPLCConst.bool(true)), UPLCConst.int(1)), UPLCConst.int(2));
    const budget = (m: Machine) => { const r = m.eval(prog); return { cpu: r.budgetSpent.cpu.toString(), mem: r.budgetSpent.mem.toString() }; };
    test("the 332-entry V2 array named as V2 costs like its first 175 entries, not like a V3 array", () => {
        expect(cm1413.PlutusV2.length).toBe(332);
        const named = budget(new Machine(toCostModelV2(cm1413.PlutusV2 as any) as any));
        const truncated = budget(new Machine(cm1413.PlutusV2.slice(0, 175) as any));
        const rawArray = budget(new Machine(cm1413.PlutusV2 as any));
        expect(named).toEqual(truncated);
        expect(rawArray).not.toEqual(truncated);
    });
    test("same for the 332-entry V1 array", () => {
        expect(cm1413.PlutusV1.length).toBe(332);
        expect(budget(new Machine(toCostModelV1(cm1413.PlutusV1 as any) as any))).toEqual(budget(new Machine(cm1413.PlutusV1.slice(0, 166) as any)));
    });
});
