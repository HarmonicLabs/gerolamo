#!/usr/bin/env bun
/**
 * Repair the retained stake snapshots, the reward-account balances and the pots from Koios
 * at the tip (VALIDATION_STATUS.md bug 72).
 *
 * Why: reward balances count as stake. Balances that were over-credited by bugs fixed long
 * ago (script-account withdrawals, pots aligned at 1050 without the balances) keep inflating
 * every later snapshot: the snapshot total (active stake) drives the apparent performance
 * β = n·activeStake/(N·σ) of every pool, so every reward comes out ≈ +0.13 % and the excess
 * compounds (≈ 440 ADA/epoch leaking from the reserves on preview). The formula itself is
 * exact with the chain's inputs (checked for an operator and a member reward, epoch 1391).
 *
 * What it does (dry run by default, `--apply` writes; run --apply with the node stopped):
 *   1. For each retained snapshot `taken_at = t` (the last three) rewrite `epoch_stake_cred`
 *      from Koios `pool_delegators_history` at epoch t + 1 (the distribution that leads t + 1),
 *      add pools Koios has and we lack, drop delegators the chain does not count, then
 *      recompute `epoch_pool_stake` and `epoch_stake_totals`; compare with `epoch_info`.
 *   2. Reward balances: for accounts in the newest snapshot the excess is
 *      ours_stake − koios_stake (UTxO agrees, so the whole difference is the balance) and is
 *      invariant under withdrawals since the boundary, so balance −= excess. Accounts with a
 *      balance outside the snapshot are set from `account_info.rewards_available`
 *      (0 when the account is not registered). A random sample of corrected accounts is
 *      cross-checked against `account_info`.
 *   3. Pots: `reward_pots` and `pot_snapshots[E]` take Koios `totals` for the current epoch.
 *
 *   bun scripts/repair-reward-balances.ts --db <ledger.db> --network preview --cache <dir> [--apply] [--sample 300] [--concurrency 2]
 *       [--snapshots 1410,1411] [--no-pots] [--blockfrost https://blockfrost-preprod.onchainapps.io [--blockfrost-key <project_id>]]
 *   --blockfrost takes the snapshots (`/epochs/{e}/stakes/{pool}`), accounts (`/accounts/{addr}`), pool
 *   list and epoch totals from a Blockfrost-compatible API instead of Koios (whose public tier allows
 *   only a few thousand requests a day); the pots still come from Koios `totals` unless --no-pots.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : []).filter((x) => x.length));
const apply = args.apply === "1";
const net = args.network ?? "preview";
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const stakeHrp = net === "mainnet" ? "stake" : "stake_test";
const stakeHeaderKey = net === "mainnet" ? 0xe1 : 0xe0;
const cacheDir = args.cache ?? join(process.cwd(), ".repair-cache");
const sampleN = Number(args.sample ?? 300);
const concurrency = Number(args.concurrency ?? 2);
const bfBase = args.blockfrost ? String(args.blockfrost).replace(/\/$/, "") : null;
// Official Blockfrost needs a project id (header `project_id`); the onchainapps mirrors do not.
const bfProjectId = (args["blockfrost-key"] ?? process.env.BLOCKFROST_PROJECT_ID ?? "").trim();
mkdirSync(cacheDir, { recursive: true });
const db = apply ? new Database(args.db!) : new Database(args.db!, { readonly: true });
db.exec("PRAGMA busy_timeout = 10000");

// ---------- bech32 ----------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number { const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1; for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!; } return chk; }
function bech32(hrp: string, data: Uint8Array): string {
    const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    const d: number[] = []; let acc = 0, bits = 0;
    for (const v of data) { acc = (acc << 8) | v; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
    if (bits) d.push((acc << (5 - bits)) & 31);
    const pm = polymod(exp.concat(d, [0, 0, 0, 0, 0, 0])) ^ 1;
    return hrp + "1" + d.map((x) => CHARSET[x]).join("") + [0, 1, 2, 3, 4, 5].map((i) => CHARSET[(pm >> (5 * (5 - i))) & 31]).join("");
}
function bech32Data(addr: string): Uint8Array {
    const d = [...addr.slice(addr.lastIndexOf("1") + 1, -6)].map((c) => CHARSET.indexOf(c));
    let acc = 0, bits = 0; const out: number[] = [];
    for (const v of d) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
    return Uint8Array.from(out);
}
/** Koios stake address → our typed key: bare hash for key credentials, 01‖hash for scripts. */
function typedKeyOf(stakeAddress: string): string {
    const raw = bech32Data(stakeAddress);
    const hash = Buffer.from(raw.subarray(1)).toString("hex");
    return (raw[0]! & 0x10) ? "01" + hash : hash;
}
function stakeAddressOf(typedKey: string): string {
    const script = typedKey.length === 58;
    const hash = script ? typedKey.slice(2) : typedKey;
    const header = script ? (stakeHeaderKey | 0x10) : stakeHeaderKey;
    return bech32(stakeHrp, Buffer.concat([Buffer.from([header]), Buffer.from(hash, "hex")]));
}
const poolBech32 = (hex: string) => bech32("pool", Buffer.from(hex, "hex"));

// ---------- Koios with cache, retry, concurrency ----------
let inflight = 0; const waiters: Array<() => void> = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
    if (inflight >= concurrency) await new Promise<void>((r) => waiters.push(r));
    inflight++;
    try { return await f(); } finally { inflight--; waiters.shift()?.(); }
}
async function fetchCached(url: string, key: string, body?: unknown, notFoundValue?: unknown, headers: Record<string, string> = {}): Promise<any> {
    const file = join(cacheDir, key + ".json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    return slot(async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                const res = await fetch(url, body ? { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...headers }, body: JSON.stringify(body) } : { headers: { accept: "application/json", ...headers } });
                if (res.status === 404 && notFoundValue !== undefined) { writeFileSync(file, JSON.stringify(notFoundValue)); return notFoundValue; }
                if (res.status === 429 || res.status >= 500) {
                    // Koios free tier: a 429 means the per-window quota is spent; wait it out (Retry-After when given).
                    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
                    throw Object.assign(new Error(`HTTP ${res.status}`), { waitMs: res.status === 429 ? Math.max(10_000, retryAfter * 1000) : 0 });
                }
                if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
                const json = await res.json();
                writeFileSync(file, JSON.stringify(json));
                return json;
            } catch (err: any) {
                if (err?.fatal || attempt >= 12) throw err;
                await Bun.sleep(Math.max(err?.waitMs ?? 0, 500 * 2 ** Math.min(attempt, 6)));
            }
        }
    });
}
const koios = (path: string, body?: unknown, cacheKey?: string) => fetchCached(`${base}/${path}`, cacheKey ?? path.replace(/[^A-Za-z0-9_.=&-]/g, "_"), body);
/** Blockfrost-compatible GET (404 → `notFound`). */
const bf = (path: string, notFound?: unknown) => fetchCached(`${bfBase}${path}`, "bf_" + path.replace(/[^A-Za-z0-9_.=&-]/g, "_"), undefined, notFound, bfProjectId ? { project_id: bfProjectId } : {});
/**
 * All delegators of a pool in the snapshot that leads `epoch`. Pages of 1000; beyond the first
 * page the rows must be ordered explicitly — without `order=` Koios pages overlap and skip rows
 * (the 69 985-delegator preview pool came back with 15 416 duplicates and as many rows missing).
 */
async function delegatorsHistory(poolHex: string, epoch: number): Promise<Array<{ stake_address: string; amount: string }>> {
    if (bfBase) {
        const out: Array<{ stake_address: string; amount: string }> = [];
        for (let page = 1; ; page++) {
            const rows: any[] = await bf(`/epochs/${epoch}/stakes/${poolBech32(poolHex)}?page=${page}&count=100`, []);
            out.push(...rows);
            if (rows.length < 100) break;
        }
        return out;
    }
    const base = `pool_delegators_history?_pool_bech32=${poolBech32(poolHex)}&_epoch_no=${epoch}`;
    const first: any[] = await koios(`${base}&limit=1000&offset=0`);
    if (first.length < 1000) return first;
    const out: Array<{ stake_address: string; amount: string }> = [];
    for (let offset = 0; ; offset += 1000) {
        const page: any[] = await koios(`${base}&order=stake_address.asc&limit=1000&offset=${offset}`);
        out.push(...page);
        if (page.length < 1000) break;
    }
    return out;
}
async function accountInfo(keys: string[]): Promise<Map<string, { status: string; rewardsAvailable: bigint; utxo: bigint }>> {
    const res = new Map<string, { status: string; rewardsAvailable: bigint; utxo: bigint }>();
    if (bfBase) {
        await Promise.all(keys.map(async (k) => {
            const a: any = await bf(`/accounts/${stakeAddressOf(k)}`, null);
            if (!a) { res.set(k, { status: "unknown", rewardsAvailable: 0n, utxo: 0n }); return; }
            const rewards = BigInt(a.withdrawable_amount ?? 0);
            res.set(k, { status: a.registered === false || a.active === false ? "not registered" : "registered", rewardsAvailable: rewards, utxo: BigInt(a.controlled_amount ?? 0) - rewards });
        }));
        return res;
    }
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));
    await Promise.all(chunks.map(async (chunk) => {
        const addrs = chunk.map(stakeAddressOf);
        const rows: any[] = await koios("account_info", { _stake_addresses: addrs }, "account_info_" + Bun.hash(addrs.join(",")).toString(16));
        const byAddr = new Map(rows.map((r) => [r.stake_address, r]));
        for (let i = 0; i < chunk.length; i++) {
            const r = byAddr.get(addrs[i]!);
            res.set(chunk[i]!, r ? { status: String(r.status), rewardsAvailable: BigInt(r.rewards_available ?? 0), utxo: BigInt(r.utxo ?? 0) } : { status: "unknown", rewardsAvailable: 0n, utxo: 0n });
        }
    }));
    return res;
}

// ---------- 1. snapshots ----------
let ctx: any = null;
try { ctx = db.query("SELECT block_hash, journaling FROM apply_ctx WHERE id = 1").get(); } catch { /* older database without the journal context table */ }
if (apply && ctx?.block_hash != null) { console.error(`apply_ctx.block_hash is set (${Buffer.from(ctx.block_hash).toString("hex")}) — the node is running or stopped mid-block; refusing to write.`); process.exit(2); }
const retained = (db.query("SELECT taken_at FROM epoch_stake_totals ORDER BY taken_at DESC LIMIT 3").all() as any[]).map((r) => Number(r.taken_at)).sort();
const newest = retained[retained.length - 1]!;
// --snapshots 1410,1411 restricts the snapshot phase (e.g. while Koios' quota is spent); the balance
// phase needs the newest retained snapshot and is skipped unless it is included.
const takenAts = args.snapshots ? String(args.snapshots).split(",").map(Number).filter((t) => retained.includes(t)).sort() : retained;
let doBalances = takenAts.includes(newest);
console.log(`retained snapshots: ${retained.join(", ")} (newest ${newest}, leads epoch ${newest + 1}); repairing ${takenAts.join(", ")}${doBalances ? "" : " — balances skipped (newest snapshot not included)"}`);
const koiosPools = new Set<string>();
if (bfBase) {
    for (let page = 1; ; page++) { const ids: string[] = await bf(`/pools?page=${page}&count=100`, []); for (const id of ids) koiosPools.add(Buffer.from(bech32Data(id)).toString("hex")); if (ids.length < 100) break; }
    console.log(`Blockfrost /pools: ${koiosPools.size} registered pools`);
} else {
    const poolList: any[] = [];
    for (let offset = 0; ; offset += 1000) { const page: any[] = await koios(`pool_list?limit=1000&offset=${offset}`); poolList.push(...page); if (page.length < 1000) break; }
    for (const p of poolList) if (p.pool_status !== "retired") koiosPools.add(Buffer.from(bech32Data(p.pool_id_bech32)).toString("hex"));
    console.log(`Koios pool_list: ${poolList.length} pools, ${koiosPools.size} not retired`);
}

type SnapRow = { stake_key: string; pool_id: string; stake: bigint };
type SnapPlan = { takenAt: number; koios: Map<string, { pool: string; stake: bigint }>; ours: Map<string, SnapRow>; updates: number; inserts: number; deletes: number; pools: number; total: bigint; koiosTotal: bigint | null };
const plans: SnapPlan[] = [];
for (const t of takenAts) {
    const leads = t + 1;
    const ours = new Map<string, SnapRow>();
    for (const r of db.query("SELECT stake_key, pool_id, stake FROM epoch_stake_cred WHERE taken_at = ?").all(t) as any[]) ours.set(r.stake_key, { stake_key: r.stake_key, pool_id: r.pool_id, stake: BigInt(r.stake) });
    const ourPools = new Set((db.query("SELECT pool_id FROM epoch_pool_stake WHERE taken_at = ?").all(t) as any[]).map((r) => String(r.pool_id)));
    const poolsToFetch = new Set<string>([...ourPools, ...koiosPools]);
    const koiosMap = new Map<string, { pool: string; stake: bigint }>();
    const incomplete = new Set<string>(); // pools whose Koios listing repeated rows: never delete their delegators on its say-so
    let fetched = 0, added = 0;
    await Promise.all([...poolsToFetch].map(async (poolHex) => {
        const rows = await delegatorsHistory(poolHex, leads);
        fetched++;
        if (rows.length && !ourPools.has(poolHex)) added++;
        const seen = new Set<string>();
        for (const r of rows) { const key = typedKeyOf(r.stake_address); seen.add(key); koiosMap.set(key, { pool: poolHex, stake: BigInt(r.amount) }); }
        if (seen.size !== rows.length) { incomplete.add(poolHex); console.log(`\n  pool ${poolHex.slice(0, 12)}…: Koios returned ${rows.length} rows but ${seen.size} distinct accounts — listing incomplete, no deletes for it`); }
        if (fetched % 100 === 0) process.stderr.write(`\r  snapshot ${t}: ${fetched}/${poolsToFetch.size} pools`);
    }));
    process.stderr.write("\n");
    if (koiosMap.size === 0) {
        // The source has no distribution for this epoch yet (Blockfrost publishes epoch e + 1
        // later than Koios): leave the snapshot alone rather than plan 80 000 deletes.
        console.log(`snapshot ${t} (leads ${leads}): no distribution available from the source yet — skipped`);
        continue;
    }
    let updates = 0, inserts = 0, deletes = 0, total = 0n;
    const pools = new Set<string>();
    for (const [k, v] of koiosMap) { total += v.stake; pools.add(v.pool); const o = ours.get(k); if (!o) inserts++; else if (o.stake !== v.stake || o.pool_id !== v.pool) updates++; }
    for (const [k, o] of ours) if (!koiosMap.has(k)) { if (incomplete.has(o.pool_id)) { koiosMap.set(k, { pool: o.pool_id, stake: o.stake }); total += o.stake; } else deletes++; }
    const info: any = bfBase ? await bf(`/epochs/${leads}`, null) : (await koios(`epoch_info?_epoch_no=${leads}`))[0];
    const koiosTotal = info?.active_stake != null ? BigInt(info.active_stake) : null;
    const ourTotal = BigInt(String((db.query("SELECT total_active FROM epoch_stake_totals WHERE taken_at = ?").get(t) as any)?.total_active ?? 0));
    console.log(`snapshot ${t} (leads ${leads}): ours ${ours.size} delegators / ${ourPools.size} pools, total ${ourTotal}; koios ${koiosMap.size} delegators / ${pools.size} pools (${added} pools we lacked), total ${total}${koiosTotal != null ? ` (epoch_info ${koiosTotal}${koiosTotal === total ? " = sum OK" : ` ≠ sum by ${total - koiosTotal}`})` : " (epoch_info n/a)"}; plan: ${updates} updates, ${inserts} inserts, ${deletes} deletes`);
    plans.push({ takenAt: t, koios: koiosMap, ours, updates, inserts, deletes, pools: pools.size, total, koiosTotal });
}

// ---------- 2. reward balances ----------
// The excess is measured at the newest retained snapshot: without it (source not ready) the balances wait.
if (doBalances && (plans.length === 0 || plans[plans.length - 1]!.takenAt !== newest)) { doBalances = false; console.log(`balances: skipped — snapshot ${newest} is not available from the source yet`); }
const newBalance = new Map<string, bigint>();
const balances = new Map<string, bigint>();
let sumBefore = 0n, sumAfter = 0n;
if (doBalances) {
const newestPlan = plans[plans.length - 1]!;
for (const r of db.query("SELECT lower(hex(stake_credentials)) AS k, amount FROM rewards").all() as any[]) balances.set(r.k, BigInt(r.amount));
const reasons = { snapshot: 0, snapshotUnchanged: 0, clamped: 0, accountInfo: 0, unregistered: 0 };
const clampedList: Array<[string, bigint]> = [];
const needInfo: string[] = [];
for (const [k, kv] of newestPlan.koios) {
    const o = newestPlan.ours.get(k);
    if (!o) { needInfo.push(k); continue; } // not in our snapshot: no UTxO reference, ask Koios directly
    const excess = o.stake - kv.stake;
    const cur = balances.get(k) ?? 0n;
    if (excess === 0n) { reasons.snapshotUnchanged++; continue; }
    let next = cur - excess;
    if (next < 0n) { clampedList.push([k, next]); next = 0n; reasons.clamped++; }
    newBalance.set(k, next); reasons.snapshot++;
}
for (const k of newestPlan.ours.keys()) if (!newestPlan.koios.has(k)) needInfo.push(k); // we count it, the chain does not
for (const [k, v] of balances) if (v !== 0n && !newestPlan.koios.has(k) && !newestPlan.ours.has(k)) needInfo.push(k);
const uniqueNeed = [...new Set(needInfo)];
console.log(`balances: ${balances.size} rows; ${reasons.snapshot} corrected from the snapshot excess (${reasons.clamped} clamped at 0), ${reasons.snapshotUnchanged} already exact; ${uniqueNeed.length} accounts need account_info`);
const infos = await accountInfo(uniqueNeed);
for (const k of uniqueNeed) {
    const i = infos.get(k)!;
    const cur = balances.get(k) ?? 0n;
    const next = i.status === "registered" ? i.rewardsAvailable : 0n;
    if (i.status !== "registered") reasons.unregistered++;
    if (next !== cur) { newBalance.set(k, next); reasons.accountInfo++; }
}
console.log(`account_info: ${reasons.accountInfo} balances changed (${reasons.unregistered} accounts not registered on chain)`);
if (clampedList.length) console.log(`clamped (would be negative): ${clampedList.slice(0, 10).map(([k, v]) => `${k.slice(0, 12)}… ${v}`).join(", ")}${clampedList.length > 10 ? " …" : ""}`);
// cross-check a sample of snapshot-corrected accounts against account_info
const corrected = [...newBalance.keys()].filter((k) => newestPlan.ours.has(k) && newestPlan.koios.has(k));
const sample = corrected.sort(() => Math.random() - 0.5).slice(0, sampleN);
const sampleInfo = await accountInfo(sample);
let sameN = 0; const mism: string[] = [];
for (const k of sample) { const exp = newBalance.get(k)!; const got = sampleInfo.get(k)!.rewardsAvailable; if (exp === got) sameN++; else mism.push(`${k.slice(0, 12)}… ours→${exp} koios ${got} (Δ ${exp - got})`); }
console.log(`sample check of ${sample.length} corrected accounts vs account_info: ${sameN} exact, ${mism.length} differ${mism.length ? "\n  " + mism.slice(0, 10).join("\n  ") : ""}`);
for (const [k, v] of balances) { sumBefore += v; sumAfter += newBalance.has(k) ? newBalance.get(k)! : v; }
for (const [k, v] of newBalance) if (!balances.has(k)) sumAfter += v;
} else console.log("balances: skipped (run again with the newest snapshot once Koios is reachable)");

// ---------- 3. pots ----------
// Pots: Koios `totals` for the epoch (Blockfrost keeps no pot history); when Koios is out of
// quota and --blockfrost is set, `/network` gives the *current* reserves/treasury, which equal
// the epoch-start values unless a treasury donation/withdrawal happened since the boundary.
let totals: any = null;
if (args["no-pots"] !== "1") {
    try { totals = (await koios(`totals?_epoch_no=${newest}`))[0]; }
    catch (err) {
        if (!bfBase) throw err;
        const net: any = await bf("/network", null);
        if (!net?.supply) throw err;
        totals = { reserves: net.supply.reserves, treasury: net.supply.treasury, reward: null };
        console.log(`Koios totals unavailable (${(err as Error).message}); using Blockfrost /network current reserves/treasury for epoch ${newest} — valid only if no treasury movement happened since the boundary`);
    }
}
const pots = db.query("SELECT reserves, treasury, fee_pot FROM reward_pots WHERE id = 1").get() as any;
const snap = db.query("SELECT reserves, treasury FROM pot_snapshots WHERE epoch = ?").get(newest) as any;
if (totals) console.log(`pots epoch ${newest}: reserves ${pots.reserves} → ${totals.reserves} (Δ ${BigInt(totals.reserves) - BigInt(pots.reserves)}), treasury ${pots.treasury} → ${totals.treasury} (Δ ${BigInt(totals.treasury) - BigInt(pots.treasury)}); snapshot row ${snap ? `${snap.reserves}/${snap.treasury}` : "missing"}`);
else console.log(`pots epoch ${newest}: left as they are (reserves ${pots.reserves}, treasury ${pots.treasury})`);
if (doBalances) console.log(`reward balances total: ${sumBefore} → ${sumAfter}${totals?.reward != null ? ` (Koios totals.reward ${totals.reward}, Δ after ${sumAfter - BigInt(totals.reward)})` : ""}`);

if (!apply) { console.log("dry run — pass --apply (with the node stopped) to write"); process.exit(0); }

// ---------- write ----------
db.exec("BEGIN");
try {
    const del = db.prepare("DELETE FROM epoch_stake_cred WHERE taken_at = ? AND stake_key = ?");
    const up = db.prepare("INSERT OR REPLACE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (?, ?, ?, ?)");
    for (const p of plans) {
        for (const k of p.ours.keys()) if (!p.koios.has(k)) del.run(p.takenAt, k);
        for (const [k, v] of p.koios) { const o = p.ours.get(k); if (!o || o.stake !== v.stake || o.pool_id !== v.pool) up.run(p.takenAt, k, v.pool, v.stake.toString()); }
        db.run("DELETE FROM epoch_pool_stake WHERE taken_at = ?", [p.takenAt]);
        db.run("INSERT INTO epoch_pool_stake (taken_at, pool_id, stake) SELECT ?, pool_id, SUM(stake) FROM epoch_stake_cred WHERE taken_at = ? GROUP BY pool_id", [p.takenAt, p.takenAt]);
        db.run("INSERT OR REPLACE INTO epoch_stake_totals (taken_at, total_active, pools) SELECT ?, COALESCE(SUM(stake), 0), COUNT(*) FROM epoch_pool_stake WHERE taken_at = ?", [p.takenAt, p.takenAt]);
        const t = db.query("SELECT total_active, pools FROM epoch_stake_totals WHERE taken_at = ?").get(p.takenAt) as any;
        console.log(`wrote snapshot ${p.takenAt}: total ${t.total_active} (${t.pools} pools)${p.koiosTotal != null ? (BigInt(t.total_active) === p.koiosTotal ? " = Koios" : ` ≠ Koios ${p.koiosTotal}`) : ""}`);
    }
    const setBal = db.prepare("UPDATE rewards SET amount = ? WHERE stake_credentials = ?");
    const insBal = db.prepare("INSERT INTO rewards (stake_credentials, amount) VALUES (?, ?)");
    let updated = 0, inserted = 0;
    for (const [k, v] of newBalance) {
        const blob = Buffer.from(k, "hex");
        const r = setBal.run(v.toString(), blob);
        if (r.changes === 0) { if (v !== 0n) { insBal.run(blob, v.toString()); inserted++; } } else updated++;
    }
    console.log(`wrote balances: ${updated} updated, ${inserted} inserted`);
    if (!totals) console.log("pots: left unchanged (--no-pots)");
    else {
        db.run("UPDATE reward_pots SET reserves = ?, treasury = ? WHERE id = 1", [String(totals.reserves), String(totals.treasury)]);
        db.run("UPDATE pot_snapshots SET reserves = ?, treasury = ? WHERE epoch = ?", [String(totals.reserves), String(totals.treasury), newest]);
    }
    db.exec("COMMIT");
    console.log("committed");
} catch (err) {
    db.exec("ROLLBACK");
    throw err;
}
