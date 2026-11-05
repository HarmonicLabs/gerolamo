import { describe, expect, test } from "bun:test";
import { Cbor, CborArray } from "@harmoniclabs/cbor";
import { Address, Credential, CredentialType, DijkstraTx, DijkstraTxBody, DijkstraTxOut, DijkstraTxWitnessSet, DijkstraUTxO, PubKeyHash, Value } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { readFileSync } from "node:fs";
import { evaluateDijkstraMempoolPhase1 } from "./conwayMempoolRules";
import { checkDijkstraGuarding } from "../consensus/rules/dijkstraRules";
import type { MempoolLedgerState, MempoolLookups, WitnessVerdict } from "./conwayMempoolRules";
import { ValidatingMempool, type MempoolLedgerView } from "./ValidatingMempool";
import { mempoolToBlockTransactionBytes, parseMempoolTx } from "./mempoolTx";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import type { EpochBodyParams } from "../consensus/epochParams";
import { assembleBody, splitTx } from "../pool/bodyAssembly";
import { EMPTY_BODY, dijkstraBlockBodyFromSegments } from "../pool/forge";
import { TxContext } from "../consensus/plutus/context";
import { DList } from "../consensus/plutus/data";
import { generateKeyPair, keyHash } from "../pool/operator";

const FIX = (n: string) => new URL(`../consensus/__fixtures__/dijkstra/${n}`, import.meta.url).pathname;
const golden = fromHex(readFileSync(FIX("cardano_ledger_golden_tx.hex"), "utf8").replace(/\s+/g, ""));
const KEY_A = "aa".repeat(28), TXH = "cd".repeat(32);
const addrOf = (keyHex: string) => Address.testnet(new Credential({ type: CredentialType.KeyHash, hash: new PubKeyHash(fromHex(keyHex)) })).toString();
const paramRaw = {
    min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", key_deposit: "2000000", pool_deposit: "500000000",
    collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "12",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000",
    max_ref_script_size_per_tx: "204800", ref_script_cost_stride: "25600", ref_script_cost_multiplier: "6/5",
};
const params: EpochBodyParams = { epoch: 1000, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, maxBlockSize: 90112, maxBlockHeaderSize: 1100, collateralPercent: 150, maxCollateralInputs: 3, maxValSize: 5000, protocolMajor: 12, raw: paramRaw };
const state: MempoolLedgerState = { slot: 1001n, era: 8, params, genesis: null, network: "testnet" };
const utxo = (ref: string, lovelace: bigint): ResolvedUtxo => ({ ref, address: addrOf(KEY_A), value: new Map([["lovelace", lovelace]]), referenceScriptHash: null, hasDatum: false });
const look = (): MempoolLookups => ({ resolved: new Map([[`${TXH}:0`, utxo(`${TXH}:0`, 10_000_000n)]]), pools: new Set(), stake: null });
const wits: WitnessVerdict = { provenKeys: new Set([KEY_A]), provenRoots: new Set(), allKeyHashes: new Set([KEY_A]), invalidVkeys: [] };
const input = (ref: string) => { const [id, index] = ref.split(":"); return { utxoRef: { id, index: Number(index) } }; };
const txOf = (body: any, size = 600) => ({ era: 8, body, witnessSet: {}, auxBytes: null, subTransactions: (body?.subTransactions ?? []), size, inputs: ((body?.inputs ?? []) as any[]).map((i) => utxoRefOf(i)).filter((r): r is string => !!r), collateral: [], refInputs: [] });
const utxoRefOf = (i: any): string | null => { const id = i?.utxoRef?.id, index = i?.utxoRef?.index; return id == null || index == null ? null : `${String(id).toLowerCase()}:${Number(index)}` };
const out = (lovelace: bigint) => ({ address: Address.fromString(addrOf(KEY_A)), value: Value.lovelaces(lovelace) });

class FakeLedger implements MempoolLedgerView {
    utxo = new Map<string, ResolvedUtxo>();
    async tip() { return { slot: 1000n, hash: "00".repeat(32) }; }
    async state(slot: bigint) { return { slot, era: 8, params: { ...params, protocolMajor: 12 }, genesis: null, network: "testnet" as const }; }
    async resolve(refs: string[]) { const m = new Map<string, ResolvedUtxo>(); for (const r of refs) { const u = this.utxo.get(r); if (u) m.set(r, u); } return m; }
    async pools() { return new Set<string>(); }
    async rewardBalances() { return undefined; }
    async stake() { return null; }
    epochNetwork() { return "preview"; }
}

describe("Dijkstra mempool (bug 432)", () => {
    test("the golden Dijkstra mempool transaction parses with hashTx and a block form", () => {
        const tx = DijkstraTx.fromCbor(golden);
        const parsed = parseMempoolTx(golden, 8);
        expect(parsed.era).toBe(8);
        expect(parsed.txId).toBe(toHex(tx.hashTx()));
        expect(parsed.subTransactions.length).toBeGreaterThan(0);
        expect(parsed.inputs.length).toBe(1);
        expect(parsed.blockBytes[0]).toBe(0x84);
        expect(parsed.blockBytes[parsed.blockBytes.length - 1]).toBe(0xf5);
        const block = Cbor.parse(parsed.blockBytes) as CborArray;
        expect(block.array.length).toBe(4);
        expect((block.array[3] as any).simple).toBe(true);
    });
    test("the block form is byte-identical to the hashTx input and survives splitTx (era 8)", () => {
        const parsed = parseMempoolTx(golden, 8);
        const blockBytes = mempoolToBlockTransactionBytes(golden);
        expect(toHex(blockBytes)).toBe(toHex(parsed.blockBytes));
        expect(toHex(new Uint8Array(blake2b_256(blockBytes)))).toBe(parsed.txId);
        const parts = splitTx(parsed.blockTxIdBytes, blockBytes, 8);
        expect(parts.isValid).toBe(true);
        const asm = assembleBody([parts], 1_000_000);
        const body = dijkstraBlockBodyFromSegments(asm.segments);
        expect(body[0]).toBe(0x83);
        const parsedBody = Cbor.parse(body) as CborArray;
        expect(((parsedBody.array[0] as CborArray).array.length)).toBe(1);
    });
    test("the era-8 rules accept a conserved transaction and reject a sub-transaction input outside the UTxO", () => {
        const body = { inputs: [input(`${TXH}:0`)], outputs: [out(9_800_000n)], fee: 200_000n };
        const ok = evaluateDijkstraMempoolPhase1(txOf(body) as any, state, look(), wits);
        expect(ok.failures).toEqual([]);
        expect(ok.runsPlutus).toBe(false);
        const withSub = { ...body, subTransactions: [{ body: { inputs: [input(`${TXH}:9`)], outputs: [out(50_000_000n)] } }] };
        const bad = evaluateDijkstraMempoolPhase1(txOf(withSub) as any, state, look(), wits);
        expect(bad.failures.length).toBeGreaterThan(0);
        expect(bad.reasons.some((r) => r.startsWith("sub-transactions spend 1 input(s)"))).toBe(true);
    });
    test("empty body segments still make a Dijkstra [txs, leios, peras] body", () => {
        expect(toHex(dijkstraBlockBodyFromSegments(EMPTY_BODY))).toBe("8380f6f6");
    });
    test("a wallet-signed Dijkstra transaction passes the validating mempool (era 8)", async () => {
        const seed = new Uint8Array(32).fill(9);
        const addrA = addrOf(toHex(keyHash(generateKeyPair(seed).vkey)));
        const inputOut = new DijkstraTxOut({ address: Address.fromString(addrA), value: Value.lovelaces(10_000_000n) });
        const body = new DijkstraTxBody({
            inputs: [new DijkstraUTxO({ utxoRef: { id: TXH, index: 0 }, resolved: inputOut })],
            outputs: [new DijkstraTxOut({ address: Address.fromString(addrA), value: Value.lovelaces(9_800_000n) })],
            fee: 200_000n,
        });
        const tx = new DijkstraTx({ body, witnesses: new DijkstraTxWitnessSet({ vkeyWitnesses: [] }) });
        tx.signWith(seed);
        const bytes = tx.toCborBytes();
        const ledger = new FakeLedger();
        ledger.utxo.set(`${TXH}:0`, { ref: `${TXH}:0`, address: addrA, value: new Map([["lovelace", 10_000_000n]]), referenceScriptHash: null, hasDatum: false });
        const mp = new ValidatingMempool({ view: ledger });
        // the fake view's protocolMajor drives the era; patch it to 12 for the Dijkstra form.
        const r = await mp.addTx(bytes);
        expect(r.ok).toBe(true);
    });
    test("the Plutus V4 TxInfo lists the top-level Dijkstra fields (bug 435, top level)", () => {
        const seed = new Uint8Array(32).fill(10);
        const addrA = addrOf(toHex(keyHash(generateKeyPair(seed).vkey)));
        const inputOut = new DijkstraTxOut({ address: Address.fromString(addrA), value: Value.lovelaces(10_000_000n) });
        const body = new DijkstraTxBody({
            inputs: [new DijkstraUTxO({ utxoRef: { id: TXH, index: 0 }, resolved: inputOut })],
            outputs: [new DijkstraTxOut({ address: Address.fromString(addrA), value: Value.lovelaces(9_800_000n) })],
            fee: 200_000n,
        });
        const tx = new DijkstraTx({ body, witnesses: new DijkstraTxWitnessSet({ vkeyWitnesses: [] }) });
        const ctx = new TxContext({
            era: 8, pv: 12, bodyBytes: body.toCborBytes(), witnessSetBytes: tx.witnesses.toCborBytes(),
            resolved: new Map([[`${TXH}:0`, { ref: `${TXH}:0`, address: addrA, value: new Map([["lovelace", 10_000_000n]]), referenceScriptHash: null, hasDatum: false }]]),
            slotToPosixMs: () => 0n,
        });
        const info = ctx.txInfo(4);
        expect(info).toBeInstanceOf(DList);
        expect((info as DList).items.length).toBe(19);
    });
    test("guarding redeemers point at script guards and script guards need a redeemer (bug 428)", () => {
        const sink = { failures: [] as string[], reports: [] as string[] };
        const guards = [{ type: 1, hash: fromHex("11".repeat(28)) }, { type: 0, hash: fromHex("22".repeat(28)) }];
        checkDijkstraGuarding(sink as any, { body: { guards }, redeemers: [{ tag: 6, index: 0, data: undefined }], providedScripts: new Map() });
        expect(sink.failures.some((f) => f.startsWith("MissingScriptWitnesses"))).toBe(true);
        sink.failures.length = 0;
        checkDijkstraGuarding(sink as any, { body: { guards }, redeemers: [], providedScripts: new Map() });
        expect(sink.failures.some((f) => f.startsWith("MissingGuardingRedeemer"))).toBe(true);
        sink.failures.length = 0;
        checkDijkstraGuarding(sink as any, { body: { guards }, redeemers: [{ tag: 6, index: 1 }], providedScripts: new Map() });
        expect(sink.failures.some((f) => f.startsWith("ScriptHashNotFoundForPurpose"))).toBe(true);
    });
});
