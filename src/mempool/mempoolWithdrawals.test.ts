/**
 * Bug 404: the mempool reads reward balances by the typed key and, on an exact store, enforces the
 * withdrawal amount; a withdrawal by an earlier mempool transaction drains the account for later ones.
 */
import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborUInt } from "@harmoniclabs/cbor";
import { addressBech32, baseAddressBytes, encodeSignedTx, encodeTxBody, generateKeyPair, keyHash, signTxBody, type KeyPair } from "../pool/operator";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import type { EpochBodyParams } from "../consensus/epochParams";
import type { GovLedgerView } from "../consensus/governance/govRules";
import { credKey } from "../consensus/certificateRules";
import { ValidatingMempool, type MempoolLedgerView } from "./ValidatingMempool";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const raw = {
    min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", key_deposit: "2000000", pool_deposit: "500000000",
    coins_per_utxo_size: "4310", collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "10",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000",
    min_fee_ref_script_cost_per_byte: 15, gov_action_deposit: "100000000000", drep_deposit: "500000000",
};
const params: EpochBodyParams = { epoch: 1000, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, maxBlockSize: 90112, maxBlockHeaderSize: 1100, collateralPercent: 150, maxCollateralInputs: 3, maxValSize: 5000, protocolMajor: 10, raw };

const key: KeyPair = generateKeyPair(new Uint8Array(32).fill(9));
const stake = hex(keyHash(key.vkey));
const addrBytes = baseAddressBytes(0, keyHash(key.vkey), keyHash(key.vkey));
const addr = addressBech32(addrBytes);
const FEE = 200_000n;
const REWARD = 5_000_000n;
const src = "22".repeat(32);

/** An exact store holding one registered key account (delegated to always-abstain) with `REWARD`. */
function ledger(asked: string[]): MempoolLedgerView {
    const utxo = new Map<string, ResolvedUtxo>([0, 1].map((i) => [`${src}:${i}`, { ref: `${src}:${i}`, address: addr, value: new Map([["lovelace", 50_000_000n]]), referenceScriptHash: null, hasDatum: false }]));
    const gov: Partial<GovLedgerView> = { accountRegistered: (c) => c === stake, accountDRep: (c) => (c === stake ? { kind: "abstain" } : null), accountBalance: (c) => (c === stake ? REWARD : null), accountDeposit: () => null, drepRegistered: () => null, poolRegistered: () => null, poolVrf: () => null, registeredVrfs: () => null, treasury: () => null, balancesExact: () => ({ exact: true, why: "" }) };
    return {
        tip: async () => ({ slot: 1000n, hash: "00".repeat(32) }),
        state: async (slot) => ({ slot, params, genesis: null, network: "testnet" }),
        resolve: async (refs) => new Map(refs.filter((r) => utxo.has(r)).map((r) => [r, utxo.get(r)!])),
        pools: async () => new Set(),
        rewardBalances: async (creds) => { asked.push(...creds); return new Map(creds.map((c) => [c, c === stake ? REWARD : 0n])); },
        stake: async (creds) => ({ registered: new Set(creds.filter((c) => c.hex === stake && c.type === 0).map((c) => credKey(c.type, c.hex))), delegated: new Map() }),
        epochNetwork: () => "preview",
        exactness: () => ({ exact: true, why: "" }),
        govLedgerView: async () => gov as GovLedgerView,
    };
}

/** Spend `src:ix` and withdraw `amount` from the key's reward account. */
function withdrawTx(ix: number, amount: bigint): Uint8Array {
    const body = Cbor.parse(encodeTxBody({ inputs: [{ txHash: Uint8Array.from(Buffer.from(src, "hex")), index: ix }], outputs: [{ address: addrBytes, lovelace: 50_000_000n + amount - FEE }], fee: FEE, certificates: [] })) as CborMap;
    body.map.push({ k: new CborUInt(5), v: new CborMap([{ k: new CborBytes(Uint8Array.of(0xe0, ...keyHash(key.vkey))), v: new CborUInt(amount) }]) });
    const bytes = Cbor.encode(body).toBuffer();
    return encodeSignedTx(bytes, signTxBody(bytes, [key]));
}

describe("mempool withdrawals (bug 404)", () => {
    test("the whole balance is admitted; a wrong amount is rejected on an exact store; the balance is read by the typed key", async () => {
        const asked: string[] = [];
        const mp = new ValidatingMempool({ view: ledger(asked) });
        const wrong = await mp.addTx(withdrawTx(0, REWARD - 1n));
        expect(wrong.ok).toBe(false);
        if (!wrong.ok) expect(wrong.reasons.join(" ")).toContain("WithdrawalsNotInRewardsCERTS");
        expect((await mp.addTx(withdrawTx(0, REWARD))).ok).toBe(true);
        expect(asked.every((c) => c === stake)).toBe(true);
    });

    test("after a queued transaction drained the account, a second withdrawal must take 0", async () => {
        const mp = new ValidatingMempool({ view: ledger([]) });
        expect((await mp.addTx(withdrawTx(0, REWARD))).ok).toBe(true);
        const again = await mp.addTx(withdrawTx(1, REWARD));
        expect(again.ok).toBe(false);
        expect((await mp.addTx(withdrawTx(1, 0n))).ok).toBe(true);
    });
});
