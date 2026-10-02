/**
 * Validating-mempool latency: admits N signed, chained transactions against an in-memory ledger,
 * then re-applies them after a tip change, and reports per-transaction admission time, the
 * revalidation time, and the worst event-loop stall (a 1 ms timer measures how late it fires) —
 * the number that matters for the sync loop sharing the thread.
 *
 *   bun scripts/mempool-bench.ts [--n 200] [--workers 1]
 */
import { addressBech32, baseAddressBytes, encodeSignedTx, encodeTxBody, generateKeyPair, keyHash, signTxBody } from "../src/pool/operator";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";
import type { EpochBodyParams } from "../src/consensus/epochParams";
import { ValidationPool } from "../src/consensus/workers/ValidationPool";
import { ValidatingMempool, type MempoolLedgerView } from "../src/mempool/ValidatingMempool";
import { parseMempoolTx } from "../src/mempool/mempoolTx";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const N = Number(arg("n", "200")), WORKERS = Number(arg("workers", "1"));
const raw = { min_fee_a: "44", min_fee_b: "155381", max_tx_size: "16384", max_block_size: "90112", key_deposit: "2000000", pool_deposit: "500000000", coins_per_utxo_size: "4310", collateral_percent: "150", max_collateral_inputs: "3", max_val_size: "5000", protocol_major_ver: "10", price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "62000000", max_block_ex_steps: "20000000000", min_fee_ref_script_cost_per_byte: 15 };
const params: EpochBodyParams = { epoch: 1, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, maxBlockSize: 90112 * 100, maxBlockHeaderSize: 1100, collateralPercent: 150, maxCollateralInputs: 3, maxValSize: 5000, protocolMajor: 10, raw: { ...raw, max_block_size: String(90112 * 100) } };
const utxo = new Map<string, ResolvedUtxo>();
let tipSlot = 1000n, tipHash = "00".repeat(32);
const view: MempoolLedgerView = {
    tip: async () => ({ slot: tipSlot, hash: tipHash }),
    state: async (slot) => ({ slot, params, genesis: null, network: "testnet" }),
    resolve: async (refs) => { const m = new Map<string, ResolvedUtxo>(); for (const r of refs) { const u = utxo.get(r); if (u) m.set(r, u); } return m; },
    pools: async () => new Set(), rewardBalances: async () => undefined, stake: async () => null, epochNetwork: () => "preview",
};
const key = generateKeyPair(new Uint8Array(32).fill(9));
const addrBytes = baseAddressBytes(0, keyHash(key.vkey), keyHash(key.vkey));
const addr = addressBech32(addrBytes);
utxo.set(`${"11".repeat(32)}:0`, { ref: "", address: addr, value: new Map([["lovelace", 1_000_000_000_000n]]), referenceScriptHash: null, hasDatum: false });

// a chain: each transaction spends the previous one's change
const txs: Uint8Array[] = [];
let prev = { id: "11".repeat(32), ix: 0, lovelace: 1_000_000_000_000n };
const FEE = 200_000n;
for (let i = 0; i < N; i++) {
    const body = encodeTxBody({ inputs: [{ txHash: Uint8Array.from(Buffer.from(prev.id, "hex")), index: prev.ix }], outputs: [{ address: addrBytes, lovelace: 2_000_000n }, { address: addrBytes, lovelace: prev.lovelace - 2_000_000n - FEE }], fee: FEE, certificates: [] });
    const t = encodeSignedTx(body, signTxBody(body, [key]));
    txs.push(t);
    prev = { id: parseMempoolTx(t).txId, ix: 1, lovelace: prev.lovelace - 2_000_000n - FEE };
}

let maxLag = 0;
let last = performance.now();
const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 1); last = now; }, 1);
const pool = WORKERS > 0 ? new ValidationPool(WORKERS) : null;
const mp = new ValidatingMempool({ view, pool });
const lat: number[] = [];
await mp.addTx(txs.shift()!); // warm-up (worker start, JIT)
maxLag = 0; last = performance.now();
for (const t of txs) { const r = await mp.addTx(t); if (!r.ok) { console.error("rejected", r.reasons); process.exit(1); } lat.push(r.ms); }
const admitLag = maxLag;
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!.toFixed(2);
console.log(`admitted ${N - 1} chained txs after one warm-up (${WORKERS} worker): per tx p50 ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${q(1)} ms; worst event-loop stall ${admitLag.toFixed(1)} ms`);

// a new tip that changes nothing: the whole mempool is re-applied (signatures reused)
maxLag = 0; last = performance.now();
tipSlot += 20n; tipHash = "22".repeat(32);
const t0 = performance.now();
await mp.sync();
console.log(`revalidated ${mp.size} txs in ${(performance.now() - t0).toFixed(1)} ms (${((performance.now() - t0) / mp.size).toFixed(2)} ms/tx); worst event-loop stall ${maxLag.toFixed(1)} ms`);
clearInterval(timer);
pool?.close();
process.exit(0);
