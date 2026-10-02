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
    test("vote and propose redeemers match Plutus voters in the ledger's Map Voter order and guarded proposals (bug 277)", () => {
        // Map Voter: CommitteeVoter < DRepVoter < StakePoolVoter; ScriptHashObj < KeyHashObj; then the hash bytes
        const V = (kind: number, h: string) => ({ voter: { kind, hash: { toString: () => h } }, votes: [] });
        const PLUTUS_DREP = "c1".repeat(28), PLUTUS_CC = "f1".repeat(28), NATIVE_DREP = "a1".repeat(28), GUARD = "d1".repeat(28);
        const gov = { ...base, era: 7, plutusScripts: new Set([PLUTUS_DREP, PLUTUS_CC, GUARD]), nativeScripts: new Set([NATIVE_DREP]) };
        // wire order: SPO, DRep key, DRep script (native), DRep script (Plutus), CC script (Plutus)  →  ledger order: CC script, DRep scripts by hash (a1… native, c1… Plutus), DRep key, SPO
        const votingProcedures = { procedures: [V(4, "99".repeat(28)), V(2, "11".repeat(28)), V(3, NATIVE_DREP), V(3, PLUTUS_DREP), V(1, PLUTUS_CC)] };
        const proposalProcedures = [{ govAction: { policyHash: null } }, { govAction: { policyHash: { toString: () => GUARD } } }];
        const body = { inputs: [input(collIn)], collateralInputs: [input(collIn)], fee: 300_000n, scriptDataHash: "x", votingProcedures, proposalProcedures };
        const ok = evaluateAlonzoRules({ ...gov, body, witnessSet: { redeemers: [rd(4, 0), rd(4, 2), rd(5, 1)] } });
        expect([...ok.failures, ...ok.reports].filter((m) => m.includes("redeemer"))).toEqual([]);
        // the wire index of the Plutus DRep (3) is not its purpose index (2): rejected, as by the ledger
        const wire = evaluateAlonzoRules({ ...gov, body, witnessSet: { redeemers: [rd(4, 0), rd(4, 3), rd(5, 1)] } });
        expect(wire.failures).toEqual(expect.arrayContaining(["extra redeemer: vote index 3 needs no Plutus script", "missing redeemer: vote index 2"]));
        // a native-script voter needs no redeemer; an unguarded proposal takes none
        const extra = evaluateAlonzoRules({ ...gov, body, witnessSet: { redeemers: [rd(4, 0), rd(4, 1), rd(4, 2), rd(5, 0), rd(5, 1)] } });
        expect(extra.failures).toEqual(expect.arrayContaining(["extra redeemer: vote index 1 needs no Plutus script", "extra redeemer: propose index 0 needs no Plutus script"]));
        const missing = evaluateAlonzoRules({ ...gov, body, witnessSet: { redeemers: [rd(4, 2)] } });
        expect(missing.failures).toEqual(expect.arrayContaining(["missing redeemer: vote index 0", "missing redeemer: propose index 1"]));
    });
});
