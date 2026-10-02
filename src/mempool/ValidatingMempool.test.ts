import { describe, expect, test } from "bun:test";
import { Cbor, CborArray } from "@harmoniclabs/cbor";
import { addressBech32, baseAddressBytes, encodeSignedTx, encodeTxBody, generateKeyPair, keyHash, signTxBody, txId, type KeyPair } from "../pool/operator";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import type { EpochBodyParams } from "../consensus/epochParams";
import { ValidatingMempool, type MempoolLedgerView } from "./ValidatingMempool";
import { rejectMessageBytes } from "./applyTxErr";
import { parseMempoolTx } from "./mempoolTx";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const raw = {
    min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", key_deposit: "2000000", pool_deposit: "500000000",
    coins_per_utxo_size: "4310", collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "10",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000",
    min_fee_ref_script_cost_per_byte: 15,
};
const params: EpochBodyParams = { epoch: 1000, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, maxBlockSize: 90112, maxBlockHeaderSize: 1100, collateralPercent: 150, maxCollateralInputs: 3, maxValSize: 5000, protocolMajor: 10, raw };

/** An in-memory ledger: a UTxO map and a tip the test moves. */
class FakeLedger implements MempoolLedgerView {
    utxo = new Map<string, ResolvedUtxo>();
    tipSlot = 1000n;
    tipHash = "00".repeat(32);
    async tip() { return { slot: this.tipSlot, hash: this.tipHash }; }
    async state(slot: bigint) { return { slot, params, genesis: null, network: "testnet" as const }; }
    async resolve(refs: string[]) { const m = new Map<string, ResolvedUtxo>(); for (const r of refs) { const u = this.utxo.get(r); if (u) m.set(r, u); } return m; }
    async pools() { return new Set<string>(); }
    async rewardBalances() { return undefined; }
    async stake() { return null; }
    epochNetwork() { return "preview"; }
    /** Apply a "block": spend the transactions' inputs, add their outputs, move the tip. */
    applyBlock(txs: Uint8Array[]) {
        for (const bytes of txs) {
            const t = parseMempoolTx(bytes);
            for (const r of t.inputs) this.utxo.delete(r);
            (t.body.outputs as any[]).forEach((o, i) => this.utxo.set(`${t.txId}:${i}`, { ref: `${t.txId}:${i}`, address: o.address.toString(), value: new Map([["lovelace", BigInt(o.value.lovelaces)]]), referenceScriptHash: null, hasDatum: false }));
        }
        this.tipSlot += 20n;
        this.tipHash = hex(crypto.getRandomValues(new Uint8Array(32)));
    }
}

const key: KeyPair = generateKeyPair(new Uint8Array(32).fill(7));
const addrBytes = baseAddressBytes(0, keyHash(key.vkey), keyHash(key.vkey));
const addr = addressBech32(addrBytes);
const FEE = 200_000n;

function tx(inputs: Array<{ id: string; ix: number }>, outputs: bigint[], opts: { ttl?: bigint; sign?: boolean; fee?: bigint } = {}): Uint8Array {
    const body = encodeTxBody({ inputs: inputs.map((i) => ({ txHash: Uint8Array.from(Buffer.from(i.id, "hex")), index: i.ix })), outputs: outputs.map((l) => ({ address: addrBytes, lovelace: l })), fee: opts.fee ?? FEE, ttl: opts.ttl, certificates: [] });
    return encodeSignedTx(body, opts.sign === false ? [] : signTxBody(body, [key]));
}
const idOf = (bytes: Uint8Array) => parseMempoolTx(bytes).txId;

function setup() {
    const ledger = new FakeLedger();
    const genesisId = "11".repeat(32);
    ledger.utxo.set(`${genesisId}:0`, { ref: `${genesisId}:0`, address: addr, value: new Map([["lovelace", 100_000_000n]]), referenceScriptHash: null, hasDatum: false });
    ledger.utxo.set(`${genesisId}:1`, { ref: `${genesisId}:1`, address: addr, value: new Map([["lovelace", 50_000_000n]]), referenceScriptHash: null, hasDatum: false });
    const stored = new Map<string, Uint8Array>();
    const mp = new ValidatingMempool({ view: ledger, store: { append: async (h, t) => { stored.set(hex(h), t); }, drop: async (hs) => { for (const h of hs) stored.delete(hex(h)); } } });
    return { ledger, mp, genesisId, stored };
}

describe("ValidatingMempool", () => {
    test("admits a valid transaction keyed by its body hash, rejects the unsigned twin", async () => {
        const { mp, genesisId, stored } = setup();
        const t1 = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE]);
        const r = await mp.addTx(t1);
        expect(r.ok).toBe(true);
        const bodyBytes = (Cbor.parse(t1) as CborArray).array[0]!;
        expect(r.txId).toBe(hex(txId(Cbor.encode(bodyBytes).toBuffer())));
        expect([...stored.keys()]).toEqual([r.txId!]);
        const unsigned = await mp.addTx(tx([{ id: genesisId, ix: 1 }], [50_000_000n - FEE], { sign: false }));
        expect(unsigned.ok).toBe(false);
        if (!unsigned.ok) expect(hex(rejectMessageBytes(unsigned.failures))).toBe(`82028182068182018202d9010281581c${hex(keyHash(key.vkey))}`);
    });

    test("transactions chain in mempool order; a double spend is 'all inputs spent'", async () => {
        const { mp, genesisId } = setup();
        const t1 = tx([{ id: genesisId, ix: 0 }], [60_000_000n, 40_000_000n - FEE]);
        expect((await mp.addTx(t1)).ok).toBe(true);
        const t2 = tx([{ id: idOf(t1), ix: 0 }], [60_000_000n - FEE]); // spends t1's output
        expect((await mp.addTx(t2)).ok).toBe(true);
        const dbl = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE - 1000n], { fee: FEE + 1000n });
        const r = await mp.addTx(dbl);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons[0]).toContain("all inputs are spent");
        const again = await mp.addTx(t1); // resubmitting a queued transaction: its inputs are spent by itself
        expect(again.ok).toBe(false);
        expect(mp.ids()).toEqual([idOf(t1), idOf(t2)]);
    });

    test("a block including a transaction drops it and keeps its dependants; a rollback drops what no longer applies", async () => {
        const { mp, ledger, genesisId, stored } = setup();
        const t1 = tx([{ id: genesisId, ix: 0 }], [60_000_000n, 40_000_000n - FEE]);
        const t2 = tx([{ id: idOf(t1), ix: 0 }], [60_000_000n - FEE]);
        await mp.addTx(t1); await mp.addTx(t2);
        const before = structuredClone([...ledger.utxo]);
        ledger.applyBlock([t1]);
        await mp.sync();
        expect(mp.ids()).toEqual([idOf(t2)]);
        expect([...stored.keys()]).toEqual([idOf(t2)]);
        // roll the block back: t1 is not re-added (as cardano-node), so t2's input no longer exists
        ledger.utxo = new Map(before);
        ledger.tipSlot -= 20n; ledger.tipHash = "22".repeat(32);
        await mp.sync();
        expect(mp.ids()).toEqual([]);
        expect(mp.stats.droppedOnSync).toBe(2);
    });

    test("a transaction whose validity interval passes is dropped on the next tip", async () => {
        const { mp, ledger, genesisId } = setup();
        const t1 = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE], { ttl: ledger.tipSlot + 10n });
        expect((await mp.addTx(t1)).ok).toBe(true);
        ledger.tipSlot += 15n; ledger.tipHash = "33".repeat(32);
        await mp.sync();
        expect(mp.size).toBe(0);
    });

    test("the validity upper bound is exclusive (Allegra+): at slot = ttl the transaction is rejected", async () => {
        const { mp, ledger, genesisId } = setup();
        const atTtl = await mp.addTx(tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE], { ttl: ledger.tipSlot + 1n })); // validated at tip + 1
        expect(atTtl.ok).toBe(false);
        if (!atTtl.ok) expect(atTtl.reasons[0]).toContain("outside validity interval");
        expect((await mp.addTx(tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE], { ttl: ledger.tipSlot + 2n }))).ok).toBe(true);
    });

    test("forging snapshot re-applies at the forge slot and keeps mempool order", async () => {
        const { mp, ledger, genesisId } = setup();
        const t1 = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE], { ttl: ledger.tipSlot + 100n });
        const t2 = tx([{ id: genesisId, ix: 1 }], [50_000_000n - FEE]);
        await mp.addTx(t1); await mp.addTx(t2);
        expect((await mp.snapshotForBlock(ledger.tipSlot + 5n)).map((t) => hex(t.hash))).toEqual([idOf(t1), idOf(t2)]);
        expect((await mp.snapshotForBlock(ledger.tipSlot + 200n)).map((t) => hex(t.hash))).toEqual([idOf(t2)]); // t1 expired by then
        expect(mp.size).toBe(2); // a snapshot does not remove anything
    });

    test("measures: bytes are sizeTxF + 4 per transaction, capacity twice the block body", async () => {
        const { mp, genesisId } = setup();
        const t1 = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE]);
        await mp.addTx(t1);
        const m = mp.measures();
        expect(m.txCount).toBe(1);
        expect(m.bytes).toEqual({ size: t1.length - 1 + 4, capacity: 2 * (90112 - 1024) });
        const snap = await mp.snapshot();
        expect(snap.slot).toBe(1001n);
    });

    test("admission never blocks on a busy lock: concurrent submissions serialise", async () => {
        const { mp, genesisId } = setup();
        const a = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE]);
        const b = tx([{ id: genesisId, ix: 0 }], [100_000_000n - FEE - 5000n], { fee: FEE + 5000n }); // conflicts with a
        const [ra, rb] = await Promise.all([mp.addTx(a), mp.addTx(b)]);
        expect(ra.ok).toBe(true);
        expect(rb.ok).toBe(false);
    });
});
