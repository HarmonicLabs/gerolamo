import { describe, expect, test } from "bun:test";
import { evaluateTxRules, type TxRuleParams } from "./txRules";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { Address, Credential, CredentialType, PubKeyHash, Value } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";

const KEY_A = "aa".repeat(28), KEY_B = "bb".repeat(28), TXH = "cd".repeat(32);
const addrOf = (keyHex: string) => Address.mainnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(keyHex)) })).toString();
const params: TxRuleParams = { minFeeA: 44n, minFeeB: 155381n, keyDeposit: 2_000_000n, poolDeposit: 500_000_000n, maxTxSize: 16384, minUtxoValue: 1_000_000n, coinsPerUtxoByte: null, coinsPerUtxoWord: null, minFeeRefScriptCostPerByte: null, priceMem: null, priceStep: null, network: "mainnet", collateralPercent: 150, maxCollateralInputs: 3, maxTxExMem: null, maxTxExSteps: null };
const utxo = (ref: string, address: string, lovelace: bigint): ResolvedUtxo => ({ ref, address, value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };
const out = (address: string, lovelace: bigint) => ({ address: Address.fromString(address), value: Value.lovelaces(lovelace) });

function run(overrides: Partial<Parameters<typeof evaluateTxRules>[0]> = {}, body: any = {}) {
    const resolved = new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)]]);
    return evaluateTxRules({
        era: 2,
        body: { inputs: [input(`${TXH}:0`)], outputs: [out(addrOf(KEY_B), 9_800_000n)], fee: 200_000n, ...body },
        witnessSet: {},
        slot: 1000n,
        resolved,
        provenKeys: new Set([KEY_A]),
        provenRoots: new Set(),
        isPoolRegistered: () => false,
        params,
        txSizeBytes: 300,
        ...overrides,
    });
}

describe("evaluateTxRules (Shelley)", () => {
    test("a well-formed signed transfer passes", () => {
        const r = run();
        expect(r.failures).toEqual([]);
    });
    test("value must be conserved", () => {
        expect(run({}, { fee: 100_000n }).failures.some((f) => f.startsWith("value not conserved"))).toBe(true);
    });
    test("fee below a·size + b fails; unknown size only reports", () => {
        expect(run({}, { fee: 1n, outputs: [out(addrOf(KEY_B), 9_999_999n)] }).failures.some((f) => f.startsWith("fee "))).toBe(true);
        const r = run({ txSizeBytes: null }, { fee: 1n, outputs: [out(addrOf(KEY_B), 9_999_999n)] });
        expect(r.failures.some((f) => f.startsWith("fee "))).toBe(false);
        expect(r.reports.some((f) => f.includes("fee not checked"))).toBe(true);
    });
    test("ttl and validity start are enforced against the block slot", () => {
        expect(run({}, { ttl: 999n }).failures.some((f) => f.startsWith("expired"))).toBe(true);
        expect(run({}, { validityIntervalStart: 1001n }).failures.some((f) => f.startsWith("not yet valid"))).toBe(true);
        expect(run({}, { ttl: 1000n, validityIntervalStart: 1000n }).failures).toEqual([]);
    });
    test("the spent input's key must have signed", () => {
        const r = run({ provenKeys: new Set([KEY_B]) });
        expect(r.failures.some((f) => f.startsWith("missing vkey witness"))).toBe(true);
    });
    test("missing inputs are reported and stop the balance check", () => {
        const r = run({ resolved: new Map() });
        expect(r.failures.some((f) => f.includes("not in the UTxO set"))).toBe(true);
        expect(r.failures.some((f) => f.startsWith("value not conserved"))).toBe(false);
    });
    test("outputs below the Shelley minimum fail", () => {
        const r = run({}, { outputs: [out(addrOf(KEY_B), 500_000n), out(addrOf(KEY_B), 9_300_000n)] });
        expect(r.failures.some((f) => f.includes("below min UTxO"))).toBe(true);
    });
    test("a stake key registration adds the deposit to the produced side", () => {
        const cert = { certType: 0, stakeCredential: new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(KEY_B)) }) };
        expect(run({}, { certs: [cert] }).failures.some((f) => f.startsWith("value not conserved"))).toBe(true);
        expect(run({}, { certs: [cert], outputs: [out(addrOf(KEY_B), 7_800_000n)] }).failures).toEqual([]);
    });
    test("a required native script must be provided and satisfied", () => {
        const POLICY = "ee".repeat(28);
        const mint = Value.singleAsset(POLICY, new Uint8Array([1]), 5n);
        const mintedOut = { address: Address.fromString(addrOf(KEY_B)), value: Value.add(Value.lovelaces(9_800_000n), Value.singleAsset(POLICY, new Uint8Array([1]), 5n)) };
        const noScript = run({}, { mint, outputs: [mintedOut] });
        expect(noScript.failures.some((f) => f.includes("required but not provided"))).toBe(true);
        const script = { hash: "ee".repeat(28), nativeScript: { type: "sig", keyHash: KEY_A } };
        const withScript = run({ witnessSet: { nativeScripts: [script] } }, { mint, outputs: [mintedOut] });
        expect(withScript.failures).toEqual([]);
        const unsatisfied = run({ witnessSet: { nativeScripts: [{ hash: "ee".repeat(28), nativeScript: { type: "sig", keyHash: KEY_B } }] } }, { mint, outputs: [mintedOut] });
        expect(unsatisfied.failures.some((f) => f.includes("not satisfied"))).toBe(true);
    });
});

describe("native reference scripts (Babbage)", () => {
    // preprod slot 15792765: a mint whose policy is a native `sig` script carried by a reference input
    const POLICY = "fd8e3f88482f62015d067c12da8a810990639524d4a375657bd55ab2";
    const SIGNER = "19842023fb0f59f40ca3452346c990f9d659b583ad2c4f3cf57dc970";
    const REF_CBOR = "82008200581c19842023fb0f59f40ca3452346c990f9d659b583ad2c4f3cf57dc970";
    test("a native reference script needs no redeemer and is evaluated as a timelock", () => {
        const refIn = `${"ef".repeat(32)}:0`;
        const resolved = new Map<string, ResolvedUtxo>([
            [`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)],
            [refIn, { ...utxo(refIn, addrOf(KEY_B), 2_000_000n), referenceScriptHash: POLICY, referenceScriptCbor: REF_CBOR }],
        ]);
        const body = { inputs: [input(`${TXH}:0`)], refInputs: [input(refIn)], outputs: [out(addrOf(KEY_B), 9_800_000n)], fee: 200_000n, mint: { map: [{ policy: { toString: () => POLICY }, assets: [] }] } };
        const scriptIssues = (keys: Set<string>) => run({ era: 6, resolved, provenKeys: keys, params: { ...params, minUtxoValue: null, coinsPerUtxoByte: 4310n } }, body).failures.filter((f) => /script|redeemer|collateral/i.test(f));
        expect(scriptIssues(new Set([KEY_A, SIGNER]))).toEqual([]);
        expect(scriptIssues(new Set([KEY_A]))).toEqual([`native script ${POLICY.slice(0, 12)}… not satisfied`]);
    });
});
