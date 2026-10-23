import { describe, expect, test } from "bun:test";
import { Address, Credential, CredentialType, PubKeyHash, Value } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { evaluateTxRules, type TxRuleParams } from "./txRules";
import { applyOverlay, evaluateShelleyBlockWithInputs, type BlockRuleInputs } from "./blockRulesPure";
import type { ResolvedUtxo } from "./resolvedUtxo";

// Bugs 272/273: withdrawal amounts and `current_treasury_value` are strict when the balances come from
// an exact ledger store, reported (with the reason) otherwise; a block's later transactions see the
// accounts its earlier ones drained.
const KEY_A = "aa".repeat(28), KEY_B = "bb".repeat(28), TXH = "cd".repeat(32), TXH2 = "ce".repeat(32);
const addrOf = (keyHex: string) => Address.mainnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(keyHex)) })).toString();
const params: TxRuleParams = { minFeeA: 44n, minFeeB: 155381n, keyDeposit: 2_000_000n, poolDeposit: 500_000_000n, maxTxSize: 16384, minUtxoValue: 1_000_000n, coinsPerUtxoByte: null, coinsPerUtxoWord: null, minFeeRefScriptCostPerByte: null, priceMem: null, priceStep: null, network: "mainnet", collateralPercent: 150, maxCollateralInputs: 3, maxTxExMem: null, maxTxExSteps: null };
const utxo = (ref: string, address: string, lovelace: bigint): ResolvedUtxo => ({ ref, address, value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };
const out = (address: string, lovelace: bigint) => ({ address: Address.fromString(address), value: Value.lovelaces(lovelace) });
const wd = (keyHex: string, amount: bigint) => ({ withdrawals: { map: [{ rewardAccount: { type: "stakeKey", credentials: { toString: () => keyHex } }, amount }] } });
const EXACT = { exact: true, why: "" }, INEXACT = { exact: false, why: "ledger store mode sqlite" };

function run(overrides: Partial<Parameters<typeof evaluateTxRules>[0]>, body: any) {
    return evaluateTxRules({
        era: 2, body: { inputs: [input(`${TXH}:0`)], fee: 200_000n, ...body }, witnessSet: {}, slot: 1000n,
        resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)]]),
        provenKeys: new Set([KEY_A, KEY_B]), provenRoots: new Set(), isPoolRegistered: () => false, params, txSizeBytes: 300, ...overrides,
    });
}

describe("withdrawal amount (bug 272)", () => {
    const body = { outputs: [out(addrOf(KEY_B), 14_800_000n)], ...wd(KEY_B, 5_000_000n) };
    test("the whole balance passes", () => {
        expect(run({ rewardBalances: new Map([[KEY_B, 5_000_000n]]), exactness: EXACT }, body).failures).toEqual([]);
    });
    test("an exact store rejects a withdrawal that is not the balance", () => {
        const r = run({ rewardBalances: new Map([[KEY_B, 5_000_001n]]), exactness: EXACT }, body);
        expect(r.failures.some((f) => f.startsWith("WithdrawalsNotInRewardsDELEGS: withdrawal 5000000 ≠ reward balance 5000001"))).toBe(true);
    });
    test("balances not proven exact: reported with the reason", () => {
        const r = run({ rewardBalances: new Map([[KEY_B, 5_000_001n]]), exactness: INEXACT }, body);
        expect(r.failures).toEqual([]);
        expect(r.reports.some((m) => m.includes("≠ reward balance 5000001") && m.includes("(report-only: ledger store mode sqlite)"))).toBe(true);
        const noFlag = run({ rewardBalances: new Map([[KEY_B, 1n]]) }, body);
        expect(noFlag.failures).toEqual([]);
    });
    test("Conway PV 11 names it ConwayIncompleteWithdrawals", () => {
        const r = run({ era: 7, params: { ...params, protocolMajor: 11, minUtxoValue: null, coinsPerUtxoByte: 4310n }, rewardBalances: new Map([[KEY_B, 4n]]), exactness: EXACT }, body);
        expect(r.failures.some((f) => f.startsWith("ConwayIncompleteWithdrawals"))).toBe(true);
    });
});

describe("current_treasury_value (bug 273)", () => {
    const body = { outputs: [out(addrOf(KEY_B), 9_800_000n)], currentTreasuryValue: 7n };
    const conway = { era: 7, params: { ...params, protocolMajor: 10, minUtxoValue: null, coinsPerUtxoByte: 4310n } };
    test("strict on an exact store, reported otherwise", () => {
        expect(run({ ...conway, treasury: 7n, exactness: EXACT }, body).failures.filter((f) => f.includes("Treasury"))).toEqual([]);
        expect(run({ ...conway, treasury: 8n, exactness: EXACT }, body).failures.some((f) => f.startsWith("ConwayTreasuryValueMismatch"))).toBe(true);
        const r = run({ ...conway, treasury: 8n, exactness: INEXACT }, body);
        expect(r.failures.filter((f) => f.includes("Treasury"))).toEqual([]);
        expect(r.reports.some((m) => m.includes("ConwayTreasuryValueMismatch") && m.includes("report-only: ledger store mode sqlite"))).toBe(true);
    });
});

describe("withdrawals inside one block (bug 272)", () => {
    // two transactions of one block withdraw from the same account: the second sees it drained
    const tx = (h: string, inRef: string, amount: bigint) => ({ hash: { toString: () => h }, inputs: [input(inRef)], outputs: [out(addrOf(KEY_A), 9_800_000n + amount)], fee: 200_000n, ...wd(KEY_B, amount) });
    const block = (second: bigint): any => ({ era: 2, block: { header: { body: { slot: 1000 } }, transactionBodies: [tx(TXH2, `${TXH}:0`, 5_000_000n), tx(TXH, `${TXH}:1`, second)], transactionWitnessSets: [{}, {}], invalidTransactions: [] } });
    const inputs = (): BlockRuleInputs => ({
        resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)], [`${TXH}:1`, utxo(`${TXH}:1`, addrOf(KEY_A), 10_000_000n)]]),
        pools: new Set(), rewardBalances: new Map([[KEY_B, 5_000_000n]]), exactness: EXACT,
    });
    const ctx = { config: { network: "mainnet" }, pool: null, params: null, genesis: { protocolParams: {} }, slot: 1000n, preVerified: [], phase: "rules" as const };
    const wdFailures = (o: { failures: string[] }) => o.failures.filter((f) => f.includes("reward balance"));
    test("the second withdrawal must take 0", async () => {
        expect(wdFailures(await evaluateShelleyBlockWithInputs(block(0n), ctx as any, inputs()))).toEqual([]);
        const twice = wdFailures(await evaluateShelleyBlockWithInputs(block(5_000_000n), ctx as any, inputs()));
        expect(twice.length).toBe(1);
        expect(twice[0]).toContain("tx[1]: WithdrawalsNotInRewardsDELEGS: withdrawal 5000000 ≠ reward balance 0");
    });
    test("the caller's balances are not modified; exactness survives the overlays", async () => {
        const i = inputs();
        await evaluateShelleyBlockWithInputs(block(0n), ctx as any, i);
        expect(i.rewardBalances!.get(KEY_B)).toBe(5_000_000n);
        const next = applyOverlay(i, { created: new Map(), spent: new Set(), poolsRegistered: new Set(), withdrawnCreds: new Set([KEY_B]) });
        expect(next.exactness).toEqual(EXACT);
        expect(next.rewardBalances!.get(KEY_B)).toBe(0n);
    });
});

describe("transactions marked invalid still pass UTXO / UTXOW (bug 534)", () => {
    // a phase-2-invalid transaction: cardano-ledger runs the whole UTXOW / UTXO rule for it and skips only
    // LEDGER's withdrawal / treasury checks, CERTS and GOV; Gerolamo checked only its collateral
    const tx = (lovelaceOut: bigint, withdrawal: bigint) => ({ hash: { toString: () => TXH2 }, inputs: [input(`${TXH}:0`)], outputs: [out(addrOf(KEY_A), lovelaceOut)], fee: 200_000n, ...wd(KEY_B, withdrawal) });
    const block = (body: any): any => ({ era: 2, block: { header: { body: { slot: 1000 } }, transactionBodies: [body], transactionWitnessSets: [{}], invalidTransactions: [0] } });
    const inputs = (): BlockRuleInputs => ({
        resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)]]),
        pools: new Set(), rewardBalances: new Map([[KEY_B, 5_000_000n]]), exactness: EXACT,
    });
    const ctx = { config: { network: "mainnet" }, pool: null, params: null, genesis: { protocolParams: {} }, slot: 1000n, preVerified: [], phase: "rules" as const };
    test("an invalid transaction that does not conserve value is rejected", async () => {
        const r = await evaluateShelleyBlockWithInputs(block(tx(99_000_000n, 5_000_000n)), ctx as any, inputs());
        expect(r.failures.some((f) => f.startsWith("tx[0]: value not conserved"))).toBe(true);
    });
    test("its withdrawal amount is not checked (CERTS is skipped for it)", async () => {
        // conserved with a 1 ADA withdrawal, but the reward balance is 5 ADA: a CERTS failure for a valid transaction only
        const r = await evaluateShelleyBlockWithInputs(block(tx(10_800_000n, 1_000_000n)), ctx as any, inputs());
        expect(r.failures.filter((f) => f.includes("reward balance"))).toEqual([]);
        expect(r.failures.some((f) => f.startsWith("tx[0]: value not conserved"))).toBe(false);
    });
});

describe("block execution units count invalid transactions (bug 535)", () => {
    // cardano-ledger Alonzo BBODY validateExUnits: foldMap getTotalExUnits over every transaction of the block
    const body = { hash: { toString: () => TXH2 }, inputs: [input(`${TXH}:0`)], outputs: [out(addrOf(KEY_A), 9_800_000n)], fee: 200_000n };
    const block: any = { era: 2, block: { header: { body: { slot: 1000 } }, transactionBodies: [body], transactionWitnessSets: [{ redeemers: [{ tag: 0, index: 0, execUnits: { mem: 200n, steps: 50n } }] }], invalidTransactions: [0] } };
    const inputs = (): BlockRuleInputs => ({ resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)]]), pools: new Set(), rewardBalances: new Map() });
    const ctx = (mem: number) => ({ config: { network: "mainnet" }, pool: null, params: { raw: { max_block_ex_mem: mem, max_block_ex_steps: 1_000 } }, genesis: { protocolParams: {} }, slot: 1000n, preVerified: [], phase: "rules" as const });
    test("an invalid transaction's redeemers count toward maxBlockExUnits", async () => {
        const over = await evaluateShelleyBlockWithInputs(block, ctx(100) as any, inputs());
        expect(over.failures.some((f) => f.startsWith("block execution memory 200 > max 100"))).toBe(true);
        const under = await evaluateShelleyBlockWithInputs(block, ctx(1_000) as any, inputs());
        expect(under.failures.some((f) => f.startsWith("block execution"))).toBe(false);
    });
});
