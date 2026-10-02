import { describe, expect, test } from "bun:test";
import { evaluateByronTxRules } from "./byronTxRules";
import type { ResolvedUtxo } from "./resolvedUtxo";

const TXH = "ab".repeat(32);
const utxo = (ref: string, lovelace: bigint): ResolvedUtxo => ({ ref, address: "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi", value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };

describe("evaluateByronTxRules", () => {
    const base = {
        txHashHex: TXH,
        inputs: [input(`${TXH}:0`)],
        outputs: [{ amount: 9_000_000n }],
        resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, 10_000_000n)]]),
        witnesses: { items: [{ publicKey: new Uint8Array(32), signature: new Uint8Array(64), message: new Uint8Array(1) }], roots: [{ root: "x", inputRef: `${TXH}:0` }], types: [0], problems: [] },
        witnessOk: [true],
        feePolicy: { summand: 155381_000_000_000n, multiplier: 43946_000_000n },
        txSizeBytes: 200,
    };
    test("invalid witness signature fails; mismatched root fails", () => {
        const r = evaluateByronTxRules({ ...base, witnessOk: [false] });
        expect(r.failures.some((f) => f.includes("witness signature invalid"))).toBe(true);
        // the root of the fixture address is not "x"
        expect(evaluateByronTxRules(base).failures.some((f) => f.includes("does not match the address root"))).toBe(true);
    });
    test("inputs must cover outputs; a fee below the policy minimum is a failure", () => {
        const r = evaluateByronTxRules({ ...base, outputs: [{ amount: 11_000_000n }] });
        expect(r.failures.some((f) => f.startsWith("value not conserved"))).toBe(true);
        const cheap = evaluateByronTxRules({ ...base, outputs: [{ amount: 9_999_999n }] });
        expect(cheap.failures.some((f) => f.includes("fee"))).toBe(true);
    });
    test("redemption transactions are exempt from the fee policy", () => {
        const r = evaluateByronTxRules({ ...base, outputs: [{ amount: 10_000_000n }], witnessTypes: [2] });
        expect(r.reports).toEqual([]);
    });
    test("witness / input count mismatch is a failure", () => {
        const r = evaluateByronTxRules({ ...base, witnesses: { items: [], roots: [], types: [], problems: ["1 witnesses for 2 inputs"] }, witnessOk: [] });
        expect(r.failures).toContain("1 witnesses for 2 inputs");
    });
});

describe("validateTxAux with the adopted parameters (size limit and fee on the ATxAux bytes)", () => {
    const base = {
        txHashHex: TXH,
        inputs: [input(`${TXH}:0`)],
        outputs: [{ amount: 9_830_000n }],
        resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, 10_000_000n)]]),
        witnesses: { items: [], roots: [], types: [], problems: [] },
        witnessOk: [],
        feePolicy: { summand: 155381_000_000_000n, multiplier: 43946_000_000n },
        txSizeBytes: 200,
    };
    // fee 170 000: covers 155 381 + 43.946·200 = 164 171 (witness-less), not 155 381 + ⌈43.946·400⌉ = 172 960 (with witnesses)
    test("the fee basis is the whole [tx, witnesses] encoding when it is known", () => {
        expect(evaluateByronTxRules(base).failures).toEqual([]);
        const r = evaluateByronTxRules({ ...base, txAuxSizeBytes: 400 });
        expect(r.failures).toEqual(["fee 170000 below policy minimum 172960 (a + b·size, ATxAux size 400)"]);
        // a + ⌈b·size⌉: 155 381 + ⌈43.946 · 333⌉ = 155 381 + ⌈14 634.018⌉ = 170 016
        expect(evaluateByronTxRules({ ...base, txAuxSizeBytes: 333, outputs: [{ amount: 10_000_000n - 170_016n }] }).failures).toEqual([]);
        expect(evaluateByronTxRules({ ...base, txAuxSizeBytes: 333, outputs: [{ amount: 10_000_000n - 170_015n }] }).failures.length).toBe(1);
    });
    test("size ≤ ppMaxTxSize of the adopted parameters", () => {
        expect(evaluateByronTxRules({ ...base, txAuxSizeBytes: 300, maxTxSize: 300n }).failures).toEqual([]);
        expect(evaluateByronTxRules({ ...base, txAuxSizeBytes: 301, maxTxSize: 300n, outputs: [{ amount: 9_000_000n }] }).failures).toEqual(["TxValidationTxTooLarge 301 > maxTxSize 300"]);
        // without the on-chain bytes the size is not checked
        expect(evaluateByronTxRules({ ...base, maxTxSize: 10n }).failures).toEqual([]);
    });
});
