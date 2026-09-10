import { describe, expect, test } from "bun:test";
import { Address, Credential, CredentialType, PubKeyHash, ValidatorHash } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { requiredWitnesses } from "./requiredSigners";
import type { ResolvedUtxo } from "./resolvedUtxo";

const K1 = "11".repeat(28), K2 = "22".repeat(28), S1 = "33".repeat(28), POOL = "44".repeat(28), OWNER = "55".repeat(28);
const keyAddr = (k: string) => Address.mainnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(k)) })).toString();
const scriptAddr = (s: string) => Address.mainnet(new Credential({ type: CredentialType.Script, hash: new ValidatorHash(fromHex(s)) })).toString();
const utxo = (ref: string, address: string): ResolvedUtxo => ({ ref, address, value: new Map(), referenceScriptHash: null, hasDatum: false });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };
const H = "ab".repeat(32);

describe("requiredWitnesses", () => {
    test("spent key inputs, script inputs, bootstrap inputs", () => {
        const resolved = new Map([
            [`${H}:0`, utxo(`${H}:0`, keyAddr(K1))],
            [`${H}:1`, utxo(`${H}:1`, scriptAddr(S1))],
            [`${H}:2`, utxo(`${H}:2`, "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi")],
        ]);
        const r = requiredWitnesses({ inputs: [input(`${H}:0`), input(`${H}:1`), input(`${H}:2`)] }, resolved);
        expect([...r.keyHashes]).toEqual([K1]);
        expect([...r.scriptHashes]).toEqual([S1]);
        expect(r.bootstrapRoots.size).toBe(1);
        expect(r.problems).toEqual([]);
    });
    test("collateral inputs need key witnesses only, never a script (preview 78658821)", () => {
        const resolved = new Map([
            [`${H}:0`, utxo(`${H}:0`, keyAddr(K1))],
            [`${H}:1`, utxo(`${H}:1`, scriptAddr(S1))],
            [`${H}:2`, utxo(`${H}:2`, keyAddr(K2))],
        ]);
        const r = requiredWitnesses({ inputs: [input(`${H}:0`)], collateralInputs: [input(`${H}:1`), input(`${H}:2`)] }, resolved);
        expect([...r.keyHashes].sort()).toEqual([K1, K2]);
        expect([...r.scriptHashes]).toEqual([]);
    });
    test("certificates, withdrawals, required signers, mint policies", () => {
        const stakeKey = new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(K2)) });
        const body = {
            inputs: [],
            certs: [
                { certType: 0, stakeCredential: stakeKey }, // registration: no witness
                { certType: 2, stakeCredential: stakeKey, poolKeyHash: POOL }, // delegation: stake key
                { certType: 3, poolParams: { operator: POOL, owners: [OWNER] } },
                { certType: 4, poolHash: POOL },
            ],
            withdrawals: { map: [{ rewardAccount: { type: "stakeKey", credentials: fromHex(K1) }, amount: 1n }] },
            requiredSigners: [S1],
            mint: { map: [{ policy: "66".repeat(28), assets: [] }] },
        };
        const r = requiredWitnesses(body, new Map());
        expect(r.keyHashes.has(K2)).toBe(true);
        expect(r.keyHashes.has(POOL)).toBe(true);
        expect(r.keyHashes.has(OWNER)).toBe(true);
        expect(r.keyHashes.has(S1)).toBe(true);
        expect(r.scriptHashes.has("66".repeat(28))).toBe(true);
    });
});
