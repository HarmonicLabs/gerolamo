#!/usr/bin/env bun
/**
 * Compare the local per-epoch stake snapshot with Koios: total active stake per epoch
 * (`epoch_info.active_stake`) and, per pool, `pool_history.active_stake`.
 *   bun scripts/verify-stake.ts --db <ledger.db> --network preprod [--from 6 --to 40] [--pools 10]
 * Local `epoch_pool_stake.taken_at = t` is the distribution that leads epoch t + 1;
 * Koios `active_stake` for epoch e is the "set" snapshot, taken at the start of e − 1.
 */
import { Database } from "bun:sqlite";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const db = new Database(args.db!, { readonly: true });
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const H = { accept: "application/json" };
const totals = db.query("SELECT taken_at, total_active, pools FROM epoch_stake_totals ORDER BY taken_at").all() as any[];
const from = Number(args.from ?? 0), to = Number(args.to ?? 1e9), poolsToCheck = Number(args.pools ?? 8);
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32(hrp: string, data: Uint8Array): string {
    const polymod = (values: number[]) => { const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1; for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!; } return chk; };
    const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    const d: number[] = []; let acc = 0, bits = 0;
    for (const v of data) { acc = (acc << 8) | v; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
    if (bits) d.push((acc << (5 - bits)) & 31);
    const pm = polymod(exp.concat(d, [0, 0, 0, 0, 0, 0])) ^ 1;
    return hrp + "1" + d.map((x) => CHARSET[x]).join("") + [0, 1, 2, 3, 4, 5].map((i) => CHARSET[(pm >> (5 * (5 - i))) & 31]).join("");
}
let ok = 0, bad = 0;
// --delegators <pool hex> [--epoch e]: per-delegator comparison for one pool (Koios pool_delegators_history)
if (args.delegators) {
    const poolHex = String(args.delegators).toLowerCase();
    const takenAt = args.epoch ? Number(args.epoch) - 1 : Number((db.query("SELECT MAX(taken_at) m FROM epoch_stake_cred").get() as any).m);
    const ours = db.query("SELECT stake_key, stake FROM epoch_stake_cred WHERE taken_at = ? AND pool_id = ?").all(takenAt, poolHex) as any[];
    const k: any[] = await (await fetch(`${base}/pool_delegators_history?_pool_bech32=${bech32("pool", Buffer.from(poolHex, "hex"))}&_epoch_no=${takenAt + 1}`, { headers: H })).json();
    const decode = (addr: string) => { const d = [...addr.split("1", 2)[1]!.slice(0, -6)].map((c) => CHARSET.indexOf(c)); let acc = 0, bits = 0; const out: number[] = []; for (const v of d) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } } return Buffer.from(out).toString("hex").slice(2); };
    const ourMap = new Map(ours.map((r) => [r.stake_key, BigInt(r.stake)]));
    let same = 0, diff = 0, missing = 0, worst = 0;
    for (const x of k) { const o = ourMap.get(decode(x.stake_address)); const kv = BigInt(x.amount); if (o == null) { missing++; continue; } if (o === kv) same++; else { diff++; const rel = Math.abs(Number(o - kv)) / Number(kv); if (rel > worst) worst = rel; if (diff <= 5) console.log(`  ${x.stake_address.slice(0, 24)} koios ${kv} ours ${o} (${(rel * 100).toFixed(4)}%)`); } }
    console.log(`pool ${poolHex.slice(0, 12)} epoch ${takenAt + 1} (snapshot ${takenAt}): koios ${k.length} delegators, ours ${ours.length}; same ${same}, diff ${diff} (worst ${(worst * 100).toFixed(4)}%), missing ${missing}`);
    process.exit(0);
}
for (const t of totals) {
    const takenAt = Number(t.taken_at), leads = takenAt + 1;
    if (leads < from || leads > to) continue;
    const info: any = (await (await fetch(`${base}/epoch_info?_epoch_no=${leads}`, { headers: H })).json())[0];
    if (!info) { console.log(`epoch ${leads}: no Koios record`); continue; }
    const local = BigInt(t.total_active), koios = BigInt(info.active_stake ?? 0);
    const line = `epoch ${leads} (snapshot ${takenAt}): total local ${local} koios ${koios} ${local === koios ? "OK" : `DIFF ${local - koios}`}`;
    if (local === koios) ok++; else bad++;
    console.log(line);
    if (poolsToCheck > 0) {
        const pools = db.query("SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ? ORDER BY stake DESC LIMIT ?").all(takenAt, poolsToCheck) as any[];
        for (const p of pools) {
            const id = bech32("pool", Buffer.from(p.pool_id, "hex"));
            const hist: any[] = await (await fetch(`${base}/pool_history?_pool_bech32=${id}&_epoch_no=${leads}`, { headers: H })).json();
            const k = hist?.[0]?.active_stake;
            const same = k != null && BigInt(k) === BigInt(p.stake);
            if (!same) { bad++; console.log(`   pool ${p.pool_id.slice(0, 12)}… local ${p.stake} koios ${k ?? "n/a"} ${k == null ? "(no history)" : "DIFF"}`); }
        }
    }
}
console.log({ ok, bad });
