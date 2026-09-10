import { describe, expect, test } from "bun:test";
import { evaluateAlonzoRules } from "./alonzoRules";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { Address, Credential, CredentialType, PubKeyHash, ValidatorHash } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";

const KEY = "aa".repeat(28), SCRIPT = "bb".repeat(28), TXH = "cd".repeat(32);
const keyAddr = Address.mainnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(KEY)) })).toString();
const scriptAddr = Address.mainnet(new Credential({ type: CredentialType.Script, hash: new ValidatorHash(fromHex(SCRIPT)) })).toString();
const utxo = (ref: string, address: string, lovelace: bigint, extra: Partial<ResolvedUtxo> = {}): ResolvedUtxo => ({ ref, address, value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false, ...extra });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };
const params = { collateralPercent: 150, maxCollateralInputs: 3, maxTxExMem: 14_000_000n, maxTxExSteps: 10_000_000_000n };
const rd = (tag: number, index: number, mem = 1000n, steps = 1000n) => ({ tag, index, data: null, execUnits: { mem, cpu: steps } });

describe("evaluateAlonzoRules", () => {
    const scriptIn = `${TXH}:0`, collIn = `${TXH}:1`;
    const resolved = new Map([
        [scriptIn, utxo(scriptIn, scriptAddr, 5_000_000n, { inlineDatumCbor: "d87980", hasDatum: true })],
        [collIn, utxo(collIn, keyAddr, 5_000_000n)],
    ]);
    const base = { era: 6, resolved, plutusScripts: new Set([SCRIPT]), nativeScripts: new Set<string>(), params };
    test("a spend from a Plutus address needs exactly one spend redeemer, a datum and collateral", () => {
        const ok = evaluateAlonzoRules({ ...base, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [rd(0, 0)] } });
        expect(ok.failures).toEqual([]);
        const missing = evaluateAlonzoRules({ ...base, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [] } });
        expect(missing.failures.some((f) => f.startsWith("missing redeemer: spend index 0"))).toBe(true);
        const extra = evaluateAlonzoRules({ ...base, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [rd(0, 0), rd(1, 0)] } });
        expect(extra.failures.some((f) => f.startsWith("extra redeemer: mint"))).toBe(true);
    });
    test("datum must be present for a hash-datum script input", () => {
        const r2 = new Map(resolved);
        r2.set(scriptIn, utxo(scriptIn, scriptAddr, 5_000_000n, { datumHash: "ee".repeat(32), hasDatum: true }));
        const r = evaluateAlonzoRules({ ...base, resolved: r2, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [rd(0, 0)], datums: [] } });
        expect(r.failures.some((f) => f.includes("not in the witness set"))).toBe(true);
    });
    test("a datum-less script output: spendable by PlutusV3 (CIP-69), rejected for V2, reported when the version is unknown", () => {
        const r3 = new Map(resolved);
        r3.set(scriptIn, utxo(scriptIn, scriptAddr, 5_000_000n, { hasDatum: false }));
        const body = { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" };
        const v3 = evaluateAlonzoRules({ ...base, era: 7, resolved: r3, plutusLanguages: new Map([[SCRIPT, 3 as const]]), body, witnessSet: { redeemers: [rd(0, 0)] } });
        expect(v3.failures).toEqual([]);
        const v2 = evaluateAlonzoRules({ ...base, era: 7, resolved: r3, plutusLanguages: new Map([[SCRIPT, 2 as const]]), body, witnessSet: { redeemers: [rd(0, 0)] } });
        expect(v2.failures.some((f) => f.includes("PlutusV2 script but carries no datum"))).toBe(true);
        const unknown = evaluateAlonzoRules({ ...base, era: 7, resolved: r3, body, witnessSet: { redeemers: [rd(0, 0)] } });
        expect(unknown.failures).toEqual([]);
        expect(unknown.reports.some((f) => f.includes("unknown version"))).toBe(true);
    });
    test("collateral: script address rejected, short collateral rejected, ex units capped", () => {
        const r2 = new Map(resolved);
        r2.set(collIn, utxo(collIn, scriptAddr, 5_000_000n));
        const bad = evaluateAlonzoRules({ ...base, resolved: r2, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [rd(0, 0)] } });
        expect(bad.failures.some((f) => f.includes("is a script address"))).toBe(true);
        const short = evaluateAlonzoRules({ ...base, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 4_000_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [rd(0, 0)] } });
        expect(short.failures.some((f) => f.includes("< required"))).toBe(true);
        const heavy = evaluateAlonzoRules({ ...base, body: { inputs: [input(scriptIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x" }, witnessSet: { redeemers: [rd(0, 0, 20_000_000n)] } });
        expect(heavy.failures.some((f) => f.includes("execution memory"))).toBe(true);
    });
});
