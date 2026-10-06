#!/usr/bin/env bun
/**
 * Check an LMDB ledger store's per-epoch history against Koios, epoch by epoch (the acceptance
 * test of a store synced from genesis, bug 304). Opens the store READ-ONLY (safe beside a running
 * node) at the newest block it holds a complete state for, and compares:
 *
 *   pots      `pot_snap[e]` (reserves / treasury at the start of e)      ↔ /totals?_epoch_no=e
 *   nonce     `nonces[e]`                                                ↔ /epoch_params .nonce
 *   params    `epoch_params[e]` (the Koios-mapped fields)                ↔ /epoch_params
 *   stake     `snap_totals[e − 1]` (the "set" snapshot leading e)        ↔ /epoch_info .active_stake
 *   rewards   `reward_epochs[e].paid` + the per-pool reports (perf. e)    ↔ /epoch_info .total_rewards, /pool_history
 *   pools     `snap_pool[e − 1]`, `blocks_made[e]`                        ↔ /pool_history (active_stake, block_cnt); reward totals
 *             (pool_fees + deleg_rewards) as the informational "pool-rew" tally (db-sync counts what was paid)
 *   accounts  `reward_payouts[e]` for the --accounts N largest           ↔ POST /account_rewards (earned epoch e)
 *
 *   bun scripts/ledger-koios-check.ts <ledgerDir> --network preview --from 1 --to 30 [--pools 5] [--accounts 5] [--only pots,nonce,…]
 *
 * Koios: public tier, ~4 requests/s with backoff on 429; every list call is one epoch (no pagination
 * needed below 1000 rows). Exit 1 on any difference.
 *
 * `--bulk`: the same comparisons from whole-history fetches — /totals, /epoch_params, /epoch_info
 * once (paginated), /pool_history once per pool that is among the --pools largest in any epoch of
 * the range, /account_rewards once per 50 of the --accounts largest accounts — instead of 14
 * requests per epoch: the public tier's daily quota (≈ 5 000 requests) covers a few hundred epochs
 * per epoch-by-epoch run, a whole preview history in bulk. `KOIOS_API_KEY` (environment only) is sent
 * as a bearer token for a registered tier's larger quota.
 */
import { LedgerStore } from "../src/ledger/LedgerStore";
import { StakeReads } from "../src/ledger/stakeStore";
import { GovReads } from "../src/ledger/govStore";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { pin, type Pinned } from "../src/ledger/storeCompare";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!dir) { console.error("usage: bun scripts/ledger-koios-check.ts <ledgerDir> --network preview --from N --to M [--pools N] [--accounts N] [--only a,b]"); process.exit(2); }
const net = opt("network") ?? "preview";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const from = Number(opt("from") ?? 1), to = Number(opt("to") ?? from);
const nPools = Number(opt("pools") ?? 5), nAccounts = Number(opt("accounts") ?? 5);
const only = opt("only")?.split(",");
const want = (k: string) => !only || only.includes(k);

let last = 0;
async function koios(path: string, body?: unknown): Promise<any[]> {
    for (let attempt = 0; ; attempt++) {
        const wait = last + 260 - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        const auth: Record<string, string> = process.env.KOIOS_API_KEY ? { authorization: `Bearer ${process.env.KOIOS_API_KEY}` } : {}; // a registered tier's quota (env only, never logged)
        const res = await fetch(`${base}${path}`, body ? { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...auth }, body: JSON.stringify(body) } : { headers: { accept: "application/json", ...auth } });
        // 429 "Exceeded Tier Limit" is the rolling 24 h quota (bug 357): requests age out, so wait it out (≤ 90 min)
        if (res.status === 429 && attempt < 90 && /Tier Limit/.test(await res.clone().text().catch(() => ""))) { if (attempt % 10 === 0) console.error(`Koios quota exhausted; waiting (${path.slice(0, 60)})`); await new Promise((r) => setTimeout(r, 60_000)); continue; }
        if ((res.status === 429 || res.status >= 500) && attempt < 6) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
        if (!res.ok) throw new Error(`Koios ${path}: ${res.status} ${res.statusText}`);
        return (await res.json()) as any[];
    }
}
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
const mainnet = net === "mainnet";
const stakeAddr = (typed: string) => bech32(mainnet ? "stake" : "stake_test", Buffer.from((typed.length === 58 ? (mainnet ? "f1" : "f0") : (mainnet ? "e1" : "e0")) + typed.slice(-56), "hex"));
const PARAMS: Record<string, string> = {
    min_fee_a: "min_fee_a", min_fee_b: "min_fee_b", max_block_size: "max_block_size", max_tx_size: "max_tx_size", max_block_header_size: "max_bh_size",
    key_deposit: "key_deposit", pool_deposit: "pool_deposit", e_max: "max_epoch", n_opt: "optimal_pool_count", a0: "influence", rho: "monetary_expand_rate",
    tau: "treasury_growth_rate", decentralisation_param: "decentralisation", protocol_major_ver: "protocol_major", protocol_minor_ver: "protocol_minor",
    min_pool_cost: "min_pool_cost", coins_per_utxo_size: "coins_per_utxo_size", price_mem: "price_mem", price_step: "price_step",
    max_tx_ex_mem: "max_tx_ex_mem", max_tx_ex_steps: "max_tx_ex_steps", max_block_ex_mem: "max_block_ex_mem", max_block_ex_steps: "max_block_ex_steps",
    max_val_size: "max_val_size", collateral_percent: "collateral_percent", max_collateral_inputs: "max_collateral_inputs",
    gov_action_lifetime: "gov_action_lifetime", gov_action_deposit: "gov_action_deposit", drep_deposit: "drep_deposit", drep_activity: "drep_activity",
    committee_min_size: "committee_min_size", committee_max_term_length: "committee_max_term_length", min_fee_ref_script_cost_per_byte: "min_fee_ref_script_cost_per_byte",
};
const sameNum = (a: unknown, b: unknown) => { if (a == null || b == null) return a == b; const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x)) : String(a) === String(b); };

// Pinned: the newest block the store holds, its diffs, and one read transaction on the LMDB state
// they were loaded against (a running node promotes meanwhile; mixing would count counters twice).
let pinned: Pinned | null = null;
for (let attempt = 0; attempt < 10 && !pinned; attempt++) {
    const st0 = LedgerStore.open(dir, { readOnly: true });
    const held = st0.heldBlocks();
    const tip = held[held.length - 1];
    if (!tip) { console.error(`store ${dir} holds no block`); process.exit(2); }
    try { pinned = pin("store", dir, st0, tip.hash); } catch (err) { st0.close(); if ((err as Error).message !== "moved") throw err; }
}
if (!pinned) { console.error("could not pin the store (the node kept promoting); try again"); process.exit(2); }
const st = pinned.store;
const view = pinned.view.withTxn(pinned.txn);
const s = new StakeReads(view), g = new GovReads(view);
console.log(`store ${dir}: anchor ${pinned.anchorSlot ?? "origin"}, read at block ${pinned.at.hash.slice(0, 16)}… slot ${pinned.at.slot} (${pinned.depth} volatile); Koios ${base}, epochs ${from}..${to}`);
// ── --bulk: whole-history prefetch; `fetchOne` answers the per-epoch calls from it ──
const bulk = argv.includes("--bulk");
const pre = { totals: new Map<number, any>(), params: new Map<number, any>(), info: new Map<number, any>(), pool: new Map<string, any>(), rewards: new Map<string, any[]>() };
async function pages(path: string): Promise<any[]> {
    const out: any[] = [];
    for (let off = 0; ; off += 1000) { const r = await koios(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`); out.push(...r); if (r.length < 1000) return out; }
}
const topPools = (e: number) => [...s.snapshotPoolStake(e - 1)].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, nPools);
const topAccounts = (e: number) => [...s.rewardPayouts(e)].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, nAccounts);
if (bulk) {
    const t0 = performance.now();
    for (const r of await pages("/totals?order=epoch_no.asc")) pre.totals.set(Number(r.epoch_no), r);
    if (want("nonce") || want("params")) for (const r of await pages("/epoch_params?order=epoch_no.asc")) pre.params.set(Number(r.epoch_no), r);
    if (want("stake") || want("rewards")) for (const r of await pages("/epoch_info?_include_next_epoch=false&order=epoch_no.asc")) pre.info.set(Number(r.epoch_no), r);
    const pools = new Set<string>(), accounts = new Set<string>();
    for (let e = from; e <= to; e++) { if (want("pools")) for (const [p] of topPools(e)) pools.add(p); if (want("accounts")) for (const [c] of topAccounts(e)) accounts.add(stakeAddr(c)); }
    for (const p of pools) { const b = bech32("pool", Buffer.from(p, "hex")); for (const r of await pages(`/pool_history?_pool_bech32=${b}&order=epoch_no.asc`)) pre.pool.set(`${b}|${Number(r.epoch_no)}`, r); }
    const accs = [...accounts];
    for (let i = 0; i < accs.length; i += 50) for (const r of await koios("/account_rewards", { _stake_addresses: accs.slice(i, i + 50) })) pre.rewards.set(r.stake_address, r.rewards ?? []);
    console.log(`bulk: ${pre.totals.size} totals, ${pre.params.size} epoch params, ${pre.info.size} epoch infos, ${pools.size} pools (${pre.pool.size} pool-epochs), ${accounts.size} accounts in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
/** One Koios call of the per-epoch loop, from the prefetch when --bulk. */
async function fetchOne(path: string, body?: { _stake_addresses: string[]; _epoch_no: number }): Promise<any[]> {
    if (!bulk) return koios(path, body);
    const ep = Number(/_epoch_no=(\d+)/.exec(path)?.[1] ?? body?._epoch_no);
    if (path.startsWith("/totals")) return pre.totals.has(ep) ? [pre.totals.get(ep)] : [];
    if (path.startsWith("/epoch_params")) return pre.params.has(ep) ? [pre.params.get(ep)] : [];
    if (path.startsWith("/epoch_info")) return pre.info.has(ep) ? [pre.info.get(ep)] : [];
    if (path.startsWith("/pool_history")) { const b = /_pool_bech32=([a-z0-9]+)/.exec(path)![1]; const r = pre.pool.get(`${b}|${ep}`); return r ? [r] : []; }
    if (path === "/account_rewards") return body!._stake_addresses.map((a) => ({ stake_address: a, rewards: (pre.rewards.get(a) ?? []).filter((x: any) => Number(x.earned_epoch) === ep) }));
    return koios(path, body);
}

const tally = new Map<string, { ok: number; bad: number; skipped: number }>();
const count = (k: string, ok: boolean | null) => { const t = tally.get(k) ?? { ok: 0, bad: 0, skipped: 0 }; if (ok === null) t.skipped++; else if (ok) t.ok++; else t.bad++; tally.set(k, t); };
const report = (k: string, e: number, ok: boolean | null, msg: string) => { count(k, ok); if (ok === false || ok === null) console.log(`  ${ok === false ? "DIFF" : k === "pool-rew" ? "note" : "skip"} ${k.padEnd(8)} epoch ${e}: ${msg}`); };

for (let e = from; e <= to; e++) {
    const parts: string[] = [];
    if (want("pots")) {
        const ours = s.potSnapshot(e);
        const k = (await fetchOne(`/totals?_epoch_no=${e}`))[0];
        if (!ours || !k) report("pots", e, null, `ours ${ours ? "present" : "absent"}, Koios ${k ? "present" : "absent"}`);
        else { const ok = ours.reserves === BigInt(k.reserves) && ours.treasury === BigInt(k.treasury); report("pots", e, ok, `reserves ours ${ours.reserves} koios ${k.reserves} (Δ ${ours.reserves - BigInt(k.reserves)}), treasury ours ${ours.treasury} koios ${k.treasury} (Δ ${ours.treasury - BigInt(k.treasury)})`); if (ok) parts.push(`pots ok (treasury ${ours.treasury})`); }
    }
    let kp: any = null;
    if (want("nonce") || want("params")) kp = (await fetchOne(`/epoch_params?_epoch_no=${e}`))[0];
    if (want("nonce")) {
        const ours = g.nonce(e)?.nonceHex?.toLowerCase();
        if (!ours || !kp?.nonce) report("nonce", e, null, `ours ${ours ?? "absent"}, Koios ${kp?.nonce ?? "absent"}`);
        else { const ok = ours === String(kp.nonce).toLowerCase(); report("nonce", e, ok, `ours ${ours} koios ${kp.nonce}`); if (ok) parts.push("nonce ok"); }
    }
    if (want("params")) {
        const ours = g.epochParams(e)?.params as Record<string, unknown> | undefined;
        if (!ours || !kp) report("params", e, null, `ours ${ours ? "present" : "absent"}, Koios ${kp ? "present" : "absent"}`);
        else {
            const diffs = Object.entries(PARAMS).filter(([l, kk]) => kp[kk] != null && ours[l] != null && !sameNum(ours[l], kp[kk])).map(([l, kk]) => `${l} ours ${ours[l]} koios ${kp[kk]}`);
            report("params", e, diffs.length === 0, diffs.join("; "));
            if (!diffs.length) parts.push(`params ok (v${ours.protocol_major_ver}, d ${ours.decentralisation_param})`);
        }
    }
    let info: any = null;
    if (want("stake") || want("rewards")) info = (await fetchOne(`/epoch_info?_epoch_no=${e}&_include_next_epoch=false`))[0];
    if (want("stake")) {
        const ours = s.snapshotTotals(e - 1);
        if (!ours || info?.active_stake == null) report("stake", e, null, `ours ${ours ? ours.total : "absent"}, Koios ${info?.active_stake ?? "absent"}`);
        else { const ok = ours.total === BigInt(info.active_stake); report("stake", e, ok, `active stake ours ${ours.total} koios ${info.active_stake} (Δ ${ours.total - BigInt(info.active_stake)})`); if (ok) parts.push(`stake ok (${ours.pools} pools)`); }
    }
    if (want("rewards")) {
        const ours = s.rewardEpoch(e);
        if (!ours || info?.total_rewards == null) report("rewards", e, null, `ours ${ours ? ours.paid : "absent"}, Koios ${info?.total_rewards ?? "absent"}`);
        else {
            // db-sync's total_rewards also counts pool deposit refunds (reward type "refund") of the epoch: a
            // difference of whole pool deposits is that, not a reward difference (preview epoch 9: one 500 ADA refund)
            const delta = BigInt(info.total_rewards) - BigInt(String(ours.paid));
            const dep = BigInt(String(g.epochParams(e)?.params?.pool_deposit ?? 0));
            const refunds = delta > 0n && dep > 0n && delta % dep === 0n ? delta / dep : 0n;
            const ok = delta === 0n || refunds > 0n;
            report("rewards", e, ok, `rewards earned in ${e}: ours paid ${ours.paid} koios ${info.total_rewards}`);
            if (ok) parts.push(`rewards ok (${ours.paid}${refunds ? ` + ${refunds} pool deposit refund(s) in Koios' total` : ""})`);
        }
    }
    if (want("pools") && nPools > 0) {
        const stake = topPools(e);
        const blocks = s.blocksMade(e), rep = s.poolRewards(e);
        let ok = 0, bad = 0;
        for (const [pool, stk] of stake) {
            const h = (await fetchOne(`/pool_history?_pool_bech32=${bech32("pool", Buffer.from(pool, "hex"))}&_epoch_no=${e}`))[0];
            if (!h) { report("pools", e, null, `pool ${pool.slice(0, 12)}… no Koios history`); continue; }
            const r = rep.get(pool);
            const d: string[] = [];
            if (BigInt(h.active_stake ?? 0) !== stk) d.push(`active_stake ours ${stk} koios ${h.active_stake}`);
            if (blocks.size && Number(h.block_cnt ?? 0) !== (blocks.get(pool) ?? 0)) d.push(`block_cnt ours ${blocks.get(pool) ?? 0} koios ${h.block_cnt}`);
            // Reward totals are a separate, informational tally ("pool-rew"): db-sync splits a pool's rewards
            // as pool_fees (cost + margin) / deleg_rewards (owners included) and counts only what was paid,
            // where our report has the leader reward (owners' stake share included) and the members'
            // computed rewards, paid or not (a member deregistered by the payout forfeits to the treasury:
            // preview epoch 18, pool 3867a097…, 71 328 lovelace; epoch 11, pool 09e3491a…, 1 lovelace of
            // db-sync rounding — every paid account identical). The --accounts check is the exact one.
            if (r && h.pool_fees != null && h.deleg_rewards != null) {
                const ours = BigInt(String(r.operator)) + BigInt(String(r.members)), theirs = BigInt(h.pool_fees) + BigInt(h.deleg_rewards);
                if (ours === theirs) count("pool-rew", true);
                else report("pool-rew", e, null, `pool ${pool.slice(0, 12)}… computed ${ours} (leader ${r.operator} + members ${r.members}), db-sync paid ${theirs} (fees ${h.pool_fees} + delegators ${h.deleg_rewards}), Δ ${ours - theirs}`);
            }
            if (d.length) { bad++; report("pools", e, false, `pool ${pool.slice(0, 12)}…: ${d.join("; ")}`); } else { ok++; count("pools", true); }
        }
        if (stake.length) parts.push(`${ok}/${stake.length} pools ok`);
    }
    if (want("accounts") && nAccounts > 0) {
        const top = topAccounts(e);
        if (top.length) {
            const res = await fetchOne(`/account_rewards`, { _stake_addresses: top.map(([c]) => stakeAddr(c)), _epoch_no: e });
            const byAddr = new Map(res.map((r: any) => [r.stake_address, (r.rewards ?? []).filter((x: any) => Number(x.earned_epoch) === e && x.type !== "refund" && x.type !== "proposal_refund" && x.type !== "treasury" && x.type !== "reserves").reduce((t: bigint, x: any) => t + BigInt(x.amount), 0n)]));
            let ok = 0;
            for (const [c, amt] of top) { const k = byAddr.get(stakeAddr(c)); if (k === amt) { ok++; count("accounts", true); } else report("accounts", e, false, `${stakeAddr(c)} ours ${amt} koios ${k ?? "none"}`); }
            parts.push(`${ok}/${top.length} accounts ok`);
        }
    }
    console.log(`epoch ${e}: ${parts.join(", ") || "-"}`);
}
pinned.close();
let bad = 0;
for (const [k, t] of tally) { console.log(`${k.padEnd(9)} ok ${t.ok}, differ ${t.bad}, not comparable ${t.skipped}`); bad += t.bad; }
process.exit(bad ? 1 : 0);
