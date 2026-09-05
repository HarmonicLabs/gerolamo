import { describe, expect, test } from "bun:test";
import { evaluateAlonzoRules } from "./alonzoRules";

const SCRIPT = "5d3bc621c161".padEnd(56, "0");
const cred = { type: 1, hash: { toString: () => SCRIPT } };
const params = { collateralPercent: 150, maxCollateralInputs: 3, maxTxExMem: null, maxTxExSteps: null };

describe("certificate redeemers", () => {
    test("script stake registration needs no redeemer; the delegation that follows does (preprod slot 11674001)", () => {
        const body = { inputs: [], certs: [{ certType: 0, stakeCredential: cred }, { certType: 2, stakeCredential: cred }], collateralInputs: [{ utxoRef: { id: "aa".repeat(32), index: 0 } }], fee: 200000n, scriptDataHash: "00".repeat(32) };
        const witnessSet = { redeemers: [{ tag: 2, index: 1, execUnits: { mem: 1n, steps: 1n } }], plutusV2Scripts: [{ hash: SCRIPT }] };
        const resolved = new Map([[`${"aa".repeat(32)}:0`, { ref: "", address: "addr_test1vrg8axv57lclxv7fwch7jyllz0xyjh32af3377grgegsn9gg67sky", value: new Map([["lovelace", 5_000_000n]]), referenceScriptHash: null, hasDatum: false }]]);
        const r = evaluateAlonzoRules({ era: 6, body, witnessSet, resolved: resolved as any, plutusScripts: new Set([SCRIPT]), nativeScripts: new Set(), params });
        expect(r.failures.filter((f) => f.includes("redeemer"))).toEqual([]);
        const missing = evaluateAlonzoRules({ era: 6, body, witnessSet: { ...witnessSet, redeemers: [] }, resolved: resolved as any, plutusScripts: new Set([SCRIPT]), nativeScripts: new Set(), params });
        expect(missing.failures).toContain("missing redeemer: cert index 1");
        expect(missing.failures.some((f) => f.includes("cert index 0"))).toBe(false);
    });
});
