#!/usr/bin/env bun
/**
 * Diff the node's Blockfrost-compatible API with the public Blockfrost API on the same network.
 * Picks sample ids from the node itself (the block a few deep, its transactions, their addresses,
 * stake keys, assets, pools, DReps, proposals), requests each path from both, and reports field
 * differences. Read-only on both sides; paced to stay under Blockfrost's free-tier rate.
 *
 *   bun scripts/blockfrost-compare.ts --blockfrost-project-id-file <path> --node http://127.0.0.1:3035 [--network preview]
 *        [--depth 20] [--paths extra.txt] [--json report.json] [--max 200]
 *
 * Fields Blockfrost leaves to off-chain sources (pool / token registry metadata, DRep metadata) and
 * moving values (confirmations, server_time, live stake) are listed but not counted as mismatches.
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]] : []).filter((x) => x.length));
const project = args["blockfrost-project-id-file"] ? readFileSync(String(args["blockfrost-project-id-file"]), "utf8").trim() : "";
if (!project) throw new Error("pass --blockfrost-project-id-file <path> (a file holding a project id for the node's network)");
const network = String(args.network ?? "preview");
const node = String(args.node ?? "http://127.0.0.1:3035").replace(/\/$/, "") + "/api/v0";
const bf = `https://cardano-${network}.blockfrost.io/api/v0`;
const depth = Number(args.depth ?? 20), max = Number(args.max ?? 200);
/** Moving values and off-chain fields: listed, not counted. */
const VOLATILE = new Set(["confirmations", "server_time", "live_stake", "live_size", "live_saturation", "live_delegators", "live_pledge", "next_block", "controlled_amount", "withdrawable_amount", "rewards_sum", "blocks_epoch", "ticker", "name", "description", "homepage", "decimals", "logo", "onchain_metadata_extra"]);
let offChainMetadata = false; // set per path: `metadata` of /assets and /pools is the token / pool registry

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(20_000) });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
}
const ours = (p: string) => fetchJson(node, p);
let lastBf = 0;
async function theirs(p: string) {
    const wait = lastBf + 120 - Date.now(); // ≤ ~8 requests per second
    if (wait > 0) await sleep(wait);
    lastBf = Date.now();
    return fetchJson(bf, p, { project_id: project! });
}

function diff(a: unknown, b: unknown, at: string, out: Array<{ at: string; ours: unknown; theirs: unknown; volatile: boolean }>): void {
    const key = at.split(".").pop()!.replace(/\[\d+\]$/, "");
    if (offChainMetadata && key === "metadata") { if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ at, ours: a, theirs: b, volatile: true }); return; }
    if (a === b) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
        if (Array.isArray(a) !== Array.isArray(b)) { out.push({ at, ours: a, theirs: b, volatile: VOLATILE.has(key) }); return; }
        if (Array.isArray(a)) {
            const bb = b as unknown[];
            if (a.length !== bb.length) out.push({ at: `${at}.length`, ours: a.length, theirs: bb.length, volatile: VOLATILE.has(key) });
            for (let i = 0; i < Math.min(a.length, bb.length); i++) diff(a[i], bb[i], `${at}[${i}]`, out);
            return;
        }
        const ka = Object.keys(a as object), kb = Object.keys(b as object);
        for (const k of new Set([...ka, ...kb])) {
            if (!(k in (b as object))) continue; // a Gerolamo extension field
            if (!(k in (a as object))) { out.push({ at: `${at}.${k}`, ours: undefined, theirs: (b as any)[k], volatile: VOLATILE.has(k) }); continue; }
            diff((a as any)[k], (b as any)[k], `${at}.${k}`, out);
        }
        return;
    }
    out.push({ at, ours: a, theirs: b, volatile: VOLATILE.has(key) });
}

// ---- sample ids from the node
const tip = (await ours("/blocks/latest")).body as any;
const block = (await ours(`/blocks/${tip.height - depth}`)).body as any;
const txs = ((await ours(`/blocks/${block.hash}/txs`)).body as string[]).slice(0, 5);
const paths = new Set<string>(["/", "/genesis", "/network/eras", `/epochs/${block.epoch}`, `/epochs/${block.epoch}/parameters`, `/blocks/${block.hash}`, `/blocks/${block.hash}/txs`, `/blocks/${block.hash}/addresses`, `/blocks/${block.height}/next?count=3`, `/blocks/${block.height}/previous?count=3`, `/blocks/slot/${block.slot}`, "/pools?count=20", "/pools/retiring", "/governance/proposals?count=10", "/governance/dreps?count=10", "/metadata/txs/labels?count=20", "/assets?count=10"]);
const stakeAddrs = new Set<string>(), addrs = new Set<string>(), units = new Set<string>(), pools = new Set<string>();
for (const h of txs) {
    for (const s of ["", "/utxos", "/metadata", "/redeemers", "/delegations", "/withdrawals", "/stakes", "/pool_updates", "/mirs", "/cbor"]) paths.add(`/txs/${h}${s}`);
    const u = (await ours(`/txs/${h}/utxos`)).body as any;
    for (const o of [...(u?.outputs ?? []), ...(u?.inputs ?? [])]) {
        if (o.address) addrs.add(o.address);
        for (const a of o.amount ?? []) if (a.unit !== "lovelace") units.add(a.unit);
    }
}
for (const a of [...addrs].slice(0, 5)) {
    for (const s of ["", "/total", "/utxos?count=10", "/transactions?count=10", "/txs?count=10"]) paths.add(`/addresses/${a}${s}`);
    const st = ((await ours(`/addresses/${a}`)).body as any)?.stake_address;
    if (st) stakeAddrs.add(st);
}
for (const s of [...stakeAddrs].slice(0, 3)) {
    for (const x of ["", "/registrations", "/delegations", "/withdrawals", "/history?count=10", "/addresses?count=10"]) paths.add(`/accounts/${s}${x}`);
    const p = ((await ours(`/accounts/${s}`)).body as any)?.pool_id;
    if (p) pools.add(p);
}
for (const u of [...units].slice(0, 5)) for (const x of ["", "/history", "/addresses?count=10"]) paths.add(`/assets/${u}${x}`);
for (const p of [...pools].slice(0, 3)) for (const x of ["", "/relays", "/metadata", "/updates", "/blocks?count=10&order=desc"]) paths.add(`/pools/${p}${x}`);
if (args.paths) for (const l of readFileSync(String(args.paths), "utf8").split("\n")) if (l.trim()) paths.add(l.trim());

// ---- compare
const report: Array<{ path: string; ours: number; theirs: number; mismatches: number; volatile: number; details: unknown[] }> = [];
let n = 0;
for (const p of paths) {
    if (n++ >= max) break;
    const [a, b] = await Promise.all([ours(p), theirs(p)]);
    offChainMetadata = p.startsWith("/assets/") || p.startsWith("/pools");
    const d: Array<{ at: string; ours: unknown; theirs: unknown; volatile: boolean }> = [];
    if (a.status === 200 && b.status === 200) diff(a.body, b.body, "$", d);
    const mism = d.filter((x) => !x.volatile).length + (a.status !== b.status ? 1 : 0);
    report.push({ path: p, ours: a.status, theirs: b.status, mismatches: mism, volatile: d.filter((x) => x.volatile).length, details: d.slice(0, 20) });
    console.log(`${mism === 0 ? "ok  " : "DIFF"} ${a.status}/${b.status} ${p}${mism ? `  ${d.filter((x) => !x.volatile).slice(0, 3).map((x) => `${x.at}: ${JSON.stringify(x.ours)?.slice(0, 40)} ≠ ${JSON.stringify(x.theirs)?.slice(0, 40)}`).join("; ")}` : ""}`);
}
const ok = report.filter((r) => r.mismatches === 0).length;
console.log(`\n${ok}/${report.length} paths identical (volatile fields excluded)`);
if (args.json) writeFileSync(String(args.json), JSON.stringify(report, null, 2));
