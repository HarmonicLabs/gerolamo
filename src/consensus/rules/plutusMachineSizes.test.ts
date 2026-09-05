import { describe, expect, test } from "bun:test";
import { Machine } from "@harmoniclabs/plutus-machine";
import { Application, Builtin, UPLCConst, UPLCBuiltinTag } from "@harmoniclabs/uplc";
import { defaultV2Costs } from "@harmoniclabs/cardano-costmodels-ts";
import { ByteString } from "@harmoniclabs/bytestring";

// The ledger measures bytestrings in 8-byte words (((n − 1) quot 8) + 1) and
// integers in 64-bit words (integerLog2 quot 64 + 1); plutus-machine measured
// both in bytes, which pushed ~28% of real Babbage transactions over their
// declared CPU budget. The vendored patch fixes the measures; this pins them.
const machine = new Machine(defaultV2Costs as any);
const cpu = (term: any) => BigInt(machine.eval(term).budgetSpent.cpu);
const eqBs = (n: number) => new Application(new Application(new Builtin(UPLCBuiltinTag.equalsByteString), UPLCConst.byteString(new ByteString(new Uint8Array(n).fill(1)))), UPLCConst.byteString(new ByteString(new Uint8Array(n).fill(1))));
const eqInt = (v: bigint) => new Application(new Application(new Builtin(UPLCBuiltinTag.equalsInteger), UPLCConst.int(v)), UPLCConst.int(v));

describe("plutus-machine size measures", () => {
    test("equalsByteString: 32 bytes are 4 words, 8 bytes 1 word (slope 62)", () => {
        expect(cpu(eqBs(32)) - cpu(eqBs(8))).toBe(62n * 3n);
        expect(cpu(eqBs(9)) - cpu(eqBs(8))).toBe(62n); // 9 bytes → 2 words
        expect(cpu(eqBs(1))).toBe(cpu(eqBs(8)));
    });
    test("equalsInteger: values below 2^64 are one word (slope 421)", () => {
        expect(cpu(eqInt(255n))).toBe(cpu(eqInt(1n)));
        expect(cpu(eqInt(1n << 64n)) - cpu(eqInt(1n))).toBe(421n);
    });
    test("maxStepCpu refuses one oversized builtin step before it runs; a heavy step checks the deadline at once", () => {
        const m = new Machine(defaultV2Costs as any);
        const big = (1n << 100_000n) + 1n; // ~1 563 words: multiplyInteger costs ~ 1 M cpu
        const mul = new Application(new Application(new Builtin(UPLCBuiltinTag.multiplyInteger), UPLCConst.int(big)), UPLCConst.int(big));
        (m as any).maxBudget = { mem: 1n << 62n, cpu: 1n << 62n, maxStepCpu: 500_000n };
        let err: any = null;
        try { m.eval(mul); } catch (e) { err = e; }
        expect(err?.timedOut).toBe(true);
        expect(err?.stepTooLarge).toBe(true);
        (m as any).maxBudget = { mem: 1n << 62n, cpu: 1n << 62n, deadlineMs: Date.now() - 1 };
        err = null;
        try { m.eval(mul); } catch (e) { err = e; }
        expect(err?.timedOut).toBe(true);
        expect(err?.stepTooLarge).toBeUndefined();
        (m as any).maxBudget = { mem: 1n << 62n, cpu: 1n << 62n, maxStepCpu: 1n << 40n, deadlineMs: Date.now() + 600_000 };
        expect(BigInt(m.eval(mul).budgetSpent.cpu) > 500_000n).toBe(true);
    }, 60_000);
});
