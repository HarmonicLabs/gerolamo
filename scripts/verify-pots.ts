#!/usr/bin/env bun
/**
 * Compare the local reward accounting with Koios per-epoch totals:
 *   treasury / reserves now, and the treasury delta per boundary
 *   (local `reward_epochs.performance_epoch` p is applied at the boundary into p + 2).
 *
 *   bun scripts/verify-pots.ts --db <ledger.db> --network preprod [--from 5 --to 40]
 */
import { Database } from "bun:sqlite";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const db = new Database(args.db!, { readonly: true });
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
// Koios returns at most 1000 rows per call; ask per epoch for the range we compare.
const lo = Number(args.from ?? 0), hi = Number(args.to ?? 0);
const totals: any[] = [];
for (let e = Math.max(0, lo - 1); e <= hi; e++) {
    const rows: any[] = await (await fetch(`${base}/totals?_epoch_no=${e}`, { headers: { accept: "application/json" } })).json();
    if (Array.isArray(rows)) totals.push(...rows);
}
const byEpoch = new Map<number, any>(totals.map((t) => [Number(t.epoch_no), t]));
const local = db.query("SELECT performance_epoch, treasury_delta, reward_pot, paid, unclaimed FROM reward_epochs ORDER BY performance_epoch").all() as any[];
const pots = db.query("SELECT reserves, treasury, fee_pot, initialized_epoch FROM reward_pots WHERE id = 1").get() as any;
const from = Number(args.from ?? (local[0]?.performance_epoch ?? 0) + 2), to = Number(args.to ?? (local.at(-1)?.performance_epoch ?? 0) + 2);
// Two views per boundary: the reward update's treasury cut (reward_epochs.treasury_delta) and the
// actual pot movements between the boundary snapshots (pot_snapshots), both against Koios totals.
// Deposits forfeited to the treasury, donations and refunds show only in the actual column.
const snaps = new Map<number, { reserves: bigint; treasury: bigint }>((db.query("SELECT epoch, reserves, treasury FROM pot_snapshots").all() as any[]).map((r) => [Number(r.epoch), { reserves: BigInt(r.reserves), treasury: BigInt(r.treasury) }]));
const ppmOf = (l: bigint, k: bigint) => (k === 0n ? (l === 0n ? 0 : 1e6) : Number(((l - k) * 1_000_000n) / k));
console.log("epoch  Δtreasury(rewards)  Δtreasury(koios)  ppm | Δtreasury(actual) ppm | Δreserves(actual) Δreserves(koios) diff(ADA)");
let worst = 0;
for (const r of local) {
    const e = Number(r.performance_epoch) + 2;
    if (e < from || e > to) continue;
    const k = byEpoch.get(e), kp = byEpoch.get(e - 1);
    if (!k || !kp) continue;
    const kd = BigInt(k.treasury) - BigInt(kp.treasury);
    const ld = BigInt(r.treasury_delta);
    const ppm = ppmOf(ld, kd);
    worst = Math.max(worst, Math.abs(ppm));
    const s1 = snaps.get(e), s0 = snaps.get(e - 1);
    let actual = "";
    if (s1 && s0) {
        const lt = s1.treasury - s0.treasury, lr = s1.reserves - s0.reserves, kr = BigInt(k.reserves) - BigInt(kp.reserves);
        actual = ` | ${String(lt).padStart(16)} ${String(ppmOf(lt, kd)).padStart(6)} | ${String(lr).padStart(17)} ${String(kr).padStart(17)} ${(Number(lr - kr) / 1e6).toFixed(0).padStart(8)}`;
    }
    console.log(String(e).padStart(5), String(ld).padStart(18), String(kd).padStart(18), String(ppm).padStart(6) + actual);
}
const tipEpoch = Number(args.at ?? to);
const k = byEpoch.get(tipEpoch);
// Absolute pots at `tipEpoch`: the snapshot recorded at that boundary (the live reward_pots
// row is the current epoch's, which is later than `to` while the node keeps syncing).
const snapAt = db.query("SELECT reserves, treasury FROM pot_snapshots WHERE epoch = ?").get(tipEpoch) as any;
const at = snapAt ?? pots;
if (k && at) {
    console.log(`\npots at epoch ${tipEpoch}${snapAt ? "" : " (live pots; no snapshot for that epoch)"}: reserves local ${at.reserves} koios ${k.reserves} (diff ${BigInt(at.reserves) - BigInt(k.reserves)})`);
    console.log(`                     treasury local ${at.treasury} koios ${k.treasury} (diff ${BigInt(at.treasury) - BigInt(k.treasury)})`);
    if (pots) console.log(`pots initialised at epoch ${pots.initialized_epoch}; worst Δtreasury deviation ${worst} ppm`);
}
