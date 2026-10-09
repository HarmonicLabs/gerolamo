import { describe, expect, test } from "bun:test";
import { Address, Credential, CredentialType, PubKeyHash, Value } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { evaluateShelleyBlockWithInputs, shelleyBlockOverlay, shelleyBlockReads, type BlockRuleInputs } from "../rules/blockRulesPure";
import type { ResolvedUtxo } from "../rules/resolvedUtxo";

/** Era-8 blocks through the block rules (bugs 427..429): sub-transactions, overlay, BBODY checks. */
const KEY_A = "aa".repeat(28), KEY_B = "bb".repeat(28), TXH = "cd".repeat(32), TOP = "ce".repeat(32), SUBH = "ef".repeat(32), TX2 = "f0".repeat(32);
const addrOf = (keyHex: string) => Address.mainnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(keyHex)) })).toString();
const utxo = (ref: string, address: string, lovelace: bigint): ResolvedUtxo => ({ ref, address, value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false });
const input = (ref: string) => { const [id, idx] = ref.split(":"); return { utxoRef: { id, index: Number(idx) } }; };
const out = (address: string, lovelace: bigint) => ({ address: Address.fromString(address), value: Value.lovelaces(lovelace) });
const h = (x: string) => ({ toString: () => x });

const sub = { body: { hash: h(SUBH), inputs: [input(`${TXH}:1`)], outputs: [out(addrOf(KEY_B), 3_000_000n)] }, witnessSet: {} };
const top = { hash: h(TOP), inputs: [input(`${TXH}:0`)], outputs: [out(addrOf(KEY_B), 9_800_000n)], fee: 200_000n, subTransactions: [sub] };
const spendSubOutput = { hash: h(TX2), inputs: [input(`${SUBH}:0`)], outputs: [out(addrOf(KEY_A), 2_800_000n)], fee: 200_000n };
const header = (major: number) => ({ body: { slot: 1000, protocolVersion: { major }, leiosCertified: false } });
const block = (txs: any[], extra: any = {}): any => ({ era: 8, block: { header: header(12), transactionBodies: txs, transactionWitnessSets: txs.map(() => ({})), invalidTransactions: [], transactions: txs, leiosCertificate: null, perasCertificate: null, ...extra } });
const inputs = (): BlockRuleInputs => ({
    resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, addrOf(KEY_A), 10_000_000n)], [`${TXH}:1`, utxo(`${TXH}:1`, addrOf(KEY_A), 3_000_000n)]]),
    pools: new Set(), rewardBalances: new Map(), exactness: { exact: true, why: "" },
});
const ctx = (major = 12) => ({ config: { network: "mainnet" }, pool: null, params: { raw: { protocol_major_ver: major } }, genesis: { protocolParams: {} }, slot: 1000n, preVerified: null, phase: "rules" as const });

describe("Dijkstra blocks in the block rules", () => {
    test("reads include the sub-transaction inputs", () => {
        expect([...shelleyBlockReads(block([top])).refs].sort()).toEqual([`${TXH}:0`, `${TXH}:1`]);
    });
    test("a sub-transaction needs its own vkey witness; a later transaction may spend its output", async () => {
        const r = await evaluateShelleyBlockWithInputs(block([top, spendSubOutput]), ctx() as any, inputs());
        expect(r.failures.some((f) => f.startsWith("tx[0].sub[0]: missing vkey witness"))).toBe(true);
        expect(r.failures.some((f) => f.startsWith("tx[0]: missing vkey witness"))).toBe(true);
        expect(r.failures.some((f) => f.includes("not in the UTxO set"))).toBe(false); // tx[1] spends SUBH:0
        expect(r.failures.some((f) => f.startsWith("tx[0]: value not conserved"))).toBe(false); // batch value
        expect(r.reports.some((m) => m.includes("SUBLEDGER"))).toBe(true);
    });
    test("the overlay for the next block: sub-transaction effects first", () => {
        const o = shelleyBlockOverlay(block([top]));
        expect([...o.spent].sort()).toEqual([`${TXH}:0`, `${TXH}:1`]);
        expect(o.created.has(`${SUBH}:0`)).toBe(true);
        expect(o.created.has(`${TOP}:0`)).toBe(true);
    });
    test("BBODY: a Peras certificate fails the block; an empty block still gets HeaderProtVerTooLow", async () => {
        const peras = await evaluateShelleyBlockWithInputs(block([top], { perasCertificate: new Uint8Array([1]) }), ctx() as any, inputs());
        expect(peras.failures.some((f) => f.startsWith("PerasCertValidationFailed"))).toBe(true);
        const low = await evaluateShelleyBlockWithInputs({ era: 8, block: { header: header(12), transactionBodies: [], transactionWitnessSets: [], invalidTransactions: [] } } as any, ctx(13) as any, inputs());
        expect(low.failures.some((f) => f.startsWith("HeaderProtVerTooLow"))).toBe(true);
        const ok = await evaluateShelleyBlockWithInputs({ era: 8, block: { header: header(12), transactionBodies: [], transactionWitnessSets: [], invalidTransactions: [] } } as any, ctx(12) as any, inputs());
        expect(ok.failures).toEqual([]);
    });
    test("Conway blocks are untouched: no Dijkstra rule runs for era 7", async () => {
        const conway = { era: 7, block: { header: { body: { slot: 1000, protocolVersion: { major: 9 } } }, transactionBodies: [], transactionWitnessSets: [], invalidTransactions: [], perasCertificate: new Uint8Array([1]) } };
        expect((await evaluateShelleyBlockWithInputs(conway as any, ctx(10) as any, inputs())).failures).toEqual([]);
    });
});
