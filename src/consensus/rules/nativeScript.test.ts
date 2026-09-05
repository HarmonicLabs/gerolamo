import { describe, expect, test } from "bun:test";
import { evalNativeScript } from "./nativeScript";

const A = "aa".repeat(28), B = "bb".repeat(28), C = "cc".repeat(28);
const sig = (keyHash: string) => ({ type: "sig", keyHash } as any);

describe("evalNativeScript", () => {
    const signers = new Set([A, B]);
    test("sig / all / any / atLeast", () => {
        expect(evalNativeScript(sig(A), { signers })).toBe(true);
        expect(evalNativeScript(sig(C), { signers })).toBe(false);
        expect(evalNativeScript({ type: "all", scripts: [sig(A), sig(B)] } as any, { signers })).toBe(true);
        expect(evalNativeScript({ type: "all", scripts: [sig(A), sig(C)] } as any, { signers })).toBe(false);
        expect(evalNativeScript({ type: "any", scripts: [sig(C), sig(B)] } as any, { signers })).toBe(true);
        expect(evalNativeScript({ type: "atLeast", required: 2, scripts: [sig(A), sig(B), sig(C)] } as any, { signers })).toBe(true);
        expect(evalNativeScript({ type: "atLeast", required: 3, scripts: [sig(A), sig(B), sig(C)] } as any, { signers })).toBe(false);
    });
    test("timelocks need the matching validity bound", () => {
        const before = { type: "before", slot: 100 } as any;
        const after = { type: "after", slot: 50 } as any;
        expect(evalNativeScript(before, { signers, validTo: 100n })).toBe(true);
        expect(evalNativeScript(before, { signers, validTo: 101n })).toBe(false);
        expect(evalNativeScript(before, { signers })).toBe(false);
        expect(evalNativeScript(after, { signers, validFrom: 50n })).toBe(true);
        expect(evalNativeScript(after, { signers, validFrom: 49n })).toBe(false);
        expect(evalNativeScript(after, { signers })).toBe(false);
    });
});

import { Script, ScriptType } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { nativeScriptTreeOf } from "./nativeScript";

describe("nativeScriptTreeOf", () => {
    // preprod slot 10662793, tx 1: all [before 15688803, sig 1f3af8…] wrapped in a ledger-ts Script
    const bytes = fromHex("82018282051a00ef64638200581c1f3af84024d2b2df54ab84c2a1ba55df164611d24602c1d92edfb619");
    test("unwraps a ledger-ts Script (nativeScript is a method) and the timelock evaluates", () => {
        const wrapped = new Script(ScriptType.NativeScript, bytes);
        const tree = nativeScriptTreeOf(wrapped)!;
        expect(tree.type).toBe("all");
        const signers = new Set(["1f3af84024d2b2df54ab84c2a1ba55df164611d24602c1d92edfb619"]);
        expect(evalNativeScript(tree, { signers, validTo: 15688803n })).toBe(true);
        expect(evalNativeScript(tree, { signers, validTo: 15688804n })).toBe(false);
        expect(evalNativeScript(tree, { signers: new Set(), validTo: 15688803n })).toBe(false);
    });
    test("passes a bare tree through", () => {
        expect(nativeScriptTreeOf({ type: "sig", keyHash: "aa" })!.type).toBe("sig");
        expect(nativeScriptTreeOf(null)).toBeNull();
    });
});
