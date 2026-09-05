#!/usr/bin/env bun
/**
 * Replay stored headers through the nonce evolver from a known epoch nonce and
 * compare every following epoch nonce with Koios.
 *   bun scripts/verify-nonces.ts --db <ledger.db> --network preprod --from 11 --to 31
 */
import { Database } from "bun:sqlite";
import { replayNonces, ticknEpochNonceHex, nonceFactsOf } from "../src/utils/nonceReplay";
import { prevHashToNonce } from "../src/utils/calcEpochNonce";
import { getFirstSlotOfEpoch } from "../src/utils/epochFromSlotCalculations";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const genesis = await Bun.file(`src/config/${net}/shelley-genesis.json`).json();
const db = new Database(args.db!, { readonly: true });
const from = Number(args.from), to = Number(args.to);
const koiosNonce = async (e: number) => (await (await fetch(`${base}/epoch_params?_epoch_no=${e}`, { headers: { accept: "application/json" } })).json())[0]?.nonce as string;
const eta0 = await koiosNonce(from);
const firstSlot = Number(getFirstSlotOfEpoch(from, genesis)), endSlot = Number(getFirstSlotOfEpoch(to + 1, genesis));
const rows = db.query("SELECT slot, block_data FROM blocks WHERE slot >= ? AND slot < ? ORDER BY slot").all(firstSlot, endSlot) as any[];
// ηh carried into epoch `from`: the label nonce lags one header, so TICKN mixes in the
// prevHash of the last block of the previous epoch (the second-to-last block's hash).
const lastPrev = db.query("SELECT slot, block_data FROM blocks WHERE slot < ? ORDER BY slot DESC LIMIT 1").get(firstSlot) as any;
const lastFacts = lastPrev ? nonceFactsOf({ slot: Number(lastPrev.slot), block_data: new Uint8Array(lastPrev.block_data) }) : null;
const etaHHex = lastFacts?.prevHash ? Buffer.from(prevHashToNonce(lastFacts.prevHash)).toString("hex") : null;
console.log(`replaying ${rows.length} blocks from epoch ${from} (η0 ${eta0.slice(0, 12)}…, ηh ${etaHHex ? etaHHex.slice(0, 12) + "…" : "none"}) to ${to}`);
const t0 = performance.now();
// ηv accumulates from the Shelley start and is never reset by a boundary, so a replay
// from a later epoch needs that epoch's start state (recorded by the node in
// epoch_nonces.start_*); without it only a replay from the Shelley start epoch is exact.
const startRow = db.query("SELECT start_evolving_hex, start_candidate_hex FROM epoch_nonces WHERE epoch = ?").get(from) as any;
const startState = startRow?.start_evolving_hex && startRow?.start_candidate_hex ? { etaVHex: String(startRow.start_evolving_hex), etaCHex: String(startRow.start_candidate_hex) } : null;
if (!startState) console.log(`no recorded start state for epoch ${from}: ηv = ηc = η0 (exact only from the Shelley start epoch)`);
const res = replayNonces(genesis, from, eta0, rows.map((r) => ({ slot: Number(r.slot), block_data: new Uint8Array(r.block_data) })), { etaHHex, ...(startState ?? {}) });
console.log(`replayed ${res.blocks} blocks in ${((performance.now() - t0) / 1000).toFixed(1)}s, ${res.ticks.length} boundaries`);
let ok = 0, bad = 0;
for (const t of res.ticks) {
    const e = Number((t as any).epoch ?? (t as any).newEpoch ?? NaN);
    const local = ticknEpochNonceHex(t);
    const k = await koiosNonce(e);
    const same = k && local.toLowerCase() === k.toLowerCase();
    if (same) ok++; else bad++;
    console.log(`epoch ${e}: local ${local.slice(0, 16)} koios ${String(k).slice(0, 16)} ${same ? "OK" : "DIFF"}`);
}
console.log({ ok, bad });
