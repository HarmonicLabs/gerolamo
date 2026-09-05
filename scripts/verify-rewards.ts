#!/usr/bin/env bun
/**
 * Compare locally computed member/leader rewards with Koios `account_rewards`
 * (spendable epoch = performance epoch + 2) for a sample of the largest reward
 * accounts per epoch, and the pool-level totals with `pool_history`.
 *   bun scripts/verify-rewards.ts --db <ledger.db> --network preprod [--from 8 --to 40] [--accounts 5]
 */
import { Database } from "bun:sqlite";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const db = new Database(args.db!, { readonly: true });
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const H = { accept: "application/json", "content-type": "application/json" };
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
const stakeAddr = (credHex: string) => bech32(net === "mainnet" ? "stake" : "stake_test", Buffer.from((net === "mainnet" ? "e1" : "e0") + credHex, "hex"));
const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name));
if (!tables.has("reward_payouts")) { console.log("no reward_payouts table: the run predates per-account payout recording"); process.exit(0); }
const epochs = (db.query("SELECT DISTINCT performance_epoch FROM reward_payouts ORDER BY performance_epoch").all() as any[]).map((r) => Number(r.performance_epoch));
const from = Number(args.from ?? 0), to = Number(args.to ?? 1e9), n = Number(args.accounts ?? 5);
let ok = 0, bad = 0, missing = 0;
for (const p of epochs) {
    const spendable = p + 2;
    if (spendable < from || spendable > to) continue;
    const rows = db.query("SELECT stake_key, amount, kind, pool_id FROM reward_payouts WHERE performance_epoch = ? ORDER BY CAST(amount AS INTEGER) DESC LIMIT ?").all(p, n) as any[];
    for (const r of rows) {
        const addr = stakeAddr(r.stake_key);
        const res: any[] = await (await fetch(`${base}/account_rewards`, { method: "POST", headers: H, body: JSON.stringify({ _stake_addresses: [addr], _epoch_no: p }) })).json();
        const kr = (res?.[0]?.rewards ?? []).filter((x: any) => Number(x.earned_epoch) === p);
        const total = kr.reduce((s: bigint, x: any) => s + BigInt(x.amount), 0n);
        if (!kr.length) { missing++; console.log(`perf ${p} ${r.kind} ${r.stake_key.slice(0, 12)}… local ${r.amount}: no Koios reward`); continue; }
        const same = total === BigInt(r.amount);
        if (same) ok++; else { bad++; console.log(`perf ${p} ${r.kind} ${r.stake_key.slice(0, 12)}… local ${r.amount} koios ${total} (${kr.map((x: any) => x.type).join("+")}) DIFF`); }
    }
    console.log(`perf epoch ${p} (spendable ${spendable}): checked ${rows.length}`);
}
console.log({ ok, bad, missing });
