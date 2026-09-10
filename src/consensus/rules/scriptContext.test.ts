import { describe, expect, test } from "bun:test";
import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { getTxIntervalData } from "@harmoniclabs/buildooor/dist/toOnChain/getTxIntervalData.js";

/**
 * Script-context details checked against the context aiken's uplc crate builds for the
 * same transaction (fixture preview-scriptcontext-167a49fe-0-0.aiken.hex; bug 67).
 */
const show = (d: any): string => {
    const n = d?.constructor?.name;
    if (n === "DataConstr") return `Constr ${d.constr}[${d.fields.map(show).join(", ")}]`;
    if (n === "DataB") return `B(${(d.bytes.toBuffer?.() ?? d.bytes).length})`;
    if (n === "DataI") return `I ${d.int}`;
    if (n === "DataList") return `List[${d.list.map(show).join(", ")}]`;
    return String(n);
};
const genesis = { systemStartPosixMs: 1666656000000, slotLengthMs: 1000, startSlotNo: 0 };

describe("script context: validity interval", () => {
    test("Conway: a finite lower bound is inclusive and a finite ttl is exclusive", () => {
        const d = getTxIntervalData(10n, 20n, genesis as any, false);
        expect(show(d)).toBe("Constr 0[Constr 0[Constr 1[I 1666656010000], Constr 1[]], Constr 0[Constr 1[I 1666656020000], Constr 0[]]]");
    });
    test("before protocol version 9 the ttl was translated as inclusive", () => {
        const d: any = getTxIntervalData(10n, 20n, genesis as any, true);
        expect(show(d.fields[1])).toBe("Constr 0[Constr 1[I 1666656020000], Constr 1[]]");
    });
    test("missing bounds are the closed infinities", () => {
        expect(show(getTxIntervalData(undefined, undefined, genesis as any, false))).toBe("Constr 0[Constr 0[Constr 0[], Constr 1[]], Constr 0[Constr 2[], Constr 1[]]]");
    });
});

describe("script context: addresses", () => {
    const base = "addr_test1qruhen60uwzpwnnr7gjs50z2v8u9zyfw6zunet4k42zrpr54mrlv55f93rs6j48wt29w90hlxt4rvpvshe55k5r9mpvqjv2wt4";
    test("a stake credential is StakingHash (Credential) in every Plutus version", () => {
        const a: any = Address.fromString(base);
        expect(show(a.toData("v1"))).toBe("Constr 0[Constr 0[B(28)], Constr 0[Constr 0[Constr 0[B(28)]]]]");
        expect(show(a.toData("v2"))).toBe("Constr 0[Constr 0[B(28)], Constr 0[Constr 0[Constr 0[B(28)]]]]");
        expect(show(a.toData("v3"))).toBe("Constr 0[Constr 0[B(28)], Constr 0[Constr 0[Constr 0[B(28)]]]]");
    });
});
