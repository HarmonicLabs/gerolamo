#!/usr/bin/env bun
/**
 * Bring the Conway governance state of a ledger DB back in line with the chain after
 * bug 66 (UpdateCommittee actions never ratified because a committee vote was required;
 * governance-group parameter changes decoded as empty). Uses Koios as the reference for
 * which actions were enacted / dropped / expired and when, and the node's own recorded
 * proposal payloads for what they changed.
 *
 * Stop the node first (never two writers on one SQLite file).
 *   bun scripts/repair-governance.ts --db <ledger.db> --network preview --epoch <current epoch> [--port 3035] [--apply]
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Cbor, CborArray } from "@harmoniclabs/cbor";
import { paramChangesOfProposal } from "../src/consensus/governance/costModelUpdate";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]] : []).filter((x) => x.length));
const net = args.network ?? "preview";
const target = Number(args.epoch);
const apply = args.apply === "1";
if (!args.db || !Number.isFinite(target)) throw new Error("usage: --db <path> --epoch <current epoch> [--network preview] [--apply]");

// refuse to write while a node on this DB is running (a dry run only reads)
const port = args.port ?? (net === "preview" ? "3035" : net === "preprod" ? "3034" : "3033");
for (const pid of apply ? readdirSync("/proc").filter((d) => /^\d+$/.test(d)) : []) {
    try {
        // by cmdline (`start-gerolamo ... --port <port>`); GEROLAMO_PORT in the environment for a node started before 2026-10-26
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
        const byCmd = cmd.startsWith("bun ") && cmd.includes("start-gerolamo") && new RegExp(`--port ${port}( |$)`).test(cmd);
        const env = byCmd ? "" : readFileSync(`/proc/${pid}/environ`, "utf8");
        if (byCmd || env.includes(`\0GEROLAMO_PORT=${port}\0`) || env.startsWith(`GEROLAMO_PORT=${port}\0`)) throw new Error(`a node on port ${port} is running (pid ${pid}); stop it first`);
    } catch (e) { if (e instanceof Error && e.message.includes("running")) throw e; }
}

const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const H = { accept: "application/json" };
async function koiosAll(path: string): Promise<any[]> {
    const out: any[] = [];
    for (let off = 0; ; off += 500) {
        const r = await (await fetch(`${base}/${path}${path.includes("?") ? "&" : "?"}limit=500&offset=${off}`, { headers: H })).json() as any[];
        out.push(...r);
        if (r.length < 500) return out;
    }
}
const KIND: Record<string, string> = { ParameterChange: "ParameterChange", NewCommittee: "UpdateCommittee", NoConfidence: "NoConfidence", HardForkInitiation: "InitHardFork", NewConstitution: "NewConstitution", InfoAction: "Info", TreasuryWithdrawals: "TreasuryWithdrawals" };
const PURPOSE: Record<string, "pparams" | "committee" | "hardfork" | "constitution" | null> = { ParameterChange: "pparams", UpdateCommittee: "committee", NoConfidence: "committee", InitHardFork: "hardfork", NewConstitution: "constitution", Info: null, TreasuryWithdrawals: null };

const proposals = await koiosAll("proposal_list?order=proposed_epoch.asc");
const committeeInfo = (await (await fetch(`${base}/committee_info`, { headers: H })).json() as any[])[0];
console.log(`koios: ${proposals.length} proposals, committee of ${committeeInfo?.members?.length ?? 0} (current)`);

type Decision = { status: "enacted" | "dropped" | "expired"; epoch: number };
function decisionOf(p: any): Decision | null {
    const c: Array<[Decision["status"], number | null]> = [["enacted", p.enacted_epoch], ["dropped", p.dropped_epoch], ["expired", p.expired_epoch]];
    const d = c.filter(([, e]) => e != null).sort((a, b) => Number(a[1]) - Number(b[1]))[0];
    return d ? { status: d[0], epoch: Number(d[1]) } : null;
}
const byId = new Map<string, any>(proposals.map((p) => [`${String(p.proposal_tx_hash).toLowerCase()}:${Number(p.proposal_index)}`, p]));

const db = apply ? new Database(args.db) : new Database(args.db, { readonly: true });
const ours = db.query("SELECT action_id, kind, status, decided_epoch, deposit, return_account, payload, proposed_epoch FROM gov_proposals").all() as any[];
console.log(`local: ${ours.length} proposals`);

const statusUpdates: Array<{ id: string; status: string; epoch: number | null; refund: bigint; from: string }> = [];
const enactedRows: Array<{ epoch: number; id: string; kind: string; payload: any }> = [];
for (const o of ours) {
    const k = byId.get(o.action_id);
    if (!k) { console.log(`  ! ${o.action_id} unknown to koios`); continue; }
    const d = decisionOf(k);
    const want = d && d.epoch <= target ? d : { status: "active" as const, epoch: null };
    if (want.status !== o.status || (want.epoch ?? null) !== (o.decided_epoch ?? null)) {
        // deposits: refunded once, at the decision epoch. Moving active→decided refunds now;
        // decided→active takes an early refund back.
        const refund = o.status === "active" && want.status !== "active" ? BigInt(o.deposit) : o.status !== "active" && want.status === "active" ? -BigInt(o.deposit) : 0n;
        statusUpdates.push({ id: o.action_id, status: want.status, epoch: want.epoch, refund, from: `${o.status}@${o.decided_epoch ?? "-"}` });
    }
    if (want.status === "enacted") enactedRows.push({ epoch: want.epoch!, id: o.action_id, kind: o.kind, payload: JSON.parse(o.payload) });
}
enactedRows.sort((a, b) => a.epoch - b.epoch || a.id.localeCompare(b.id));
// parameter changes recorded before the byte-level decoder (bug 66) are empty: re-read them from the proposal's transaction
const payloadFixes: Array<{ id: string; payload: any }> = [];
for (const e of enactedRows) {
    if (e.kind !== "ParameterChange" || Object.keys(e.payload.changes ?? {}).length) continue;
    const [txHash, idx] = e.id.split(":");
    const [cb] = await (await fetch(`${base}/tx_cbor`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ _tx_hashes: [txHash] }) })).json() as any[];
    const tx = Cbor.parse(String(cb?.cbor ?? "")) as CborArray;
    const changes = paramChangesOfProposal(Cbor.encode(tx.array[0]!).toBuffer(), Number(idx));
    if (changes && Object.keys(changes).length) { e.payload = { ...e.payload, changes }; payloadFixes.push({ id: e.id, payload: e.payload }); console.log(`  re-decoded ${e.id.slice(0, 12)}… → ${JSON.stringify(changes)}`); }
}
console.log(`status changes: ${statusUpdates.length}; chain-enacted actions up to epoch ${target}: ${enactedRows.length}`);
for (const s of statusUpdates) console.log(`  ${s.id.slice(0, 12)}… ${s.from} → ${s.status}@${s.epoch ?? "-"}${s.refund ? ` refund ${s.refund}` : ""}`);
for (const e of enactedRows) console.log(`  enacted ${e.epoch} ${e.kind} ${e.id.slice(0, 12)}… ${JSON.stringify(e.payload).slice(0, 160)}`);

// previous-action pointers per purpose
const prev: Record<string, string | null> = { pparams: null, committee: null, hardfork: null, constitution: null };
let noConfidence = 0;
for (const e of enactedRows) { const p = PURPOSE[e.kind]; if (p) { prev[p] = e.id; if (p === "committee") noConfidence = e.kind === "NoConfidence" ? 1 : 0; } }
console.log("prev pointers:", prev, "no_confidence:", noConfidence);

// committee membership: genesis, then every enacted UpdateCommittee in order
const genesis = JSON.parse(readFileSync(`src/config/${net}/conway-genesis.json`, "utf8"));
const members = new Map<string, number>();
for (const [cred, exp] of Object.entries(genesis?.committee?.members ?? {})) members.set(String(cred).replace(/^(keyHash|scriptHash)-/, "").toLowerCase(), Number(exp));
let threshold = { num: Number(genesis?.committee?.threshold?.numerator ?? 2), den: Number(genesis?.committee?.threshold?.denominator ?? 3) };
for (const e of enactedRows) {
    if (e.kind !== "UpdateCommittee") continue;
    for (const c of e.payload.remove ?? []) members.delete(String(c));
    for (const a of e.payload.add ?? []) members.set(String(a.cred), Number(a.expires));
    threshold = { num: Number(e.payload.thresholdNum ?? 2), den: Number(e.payload.thresholdDen ?? 3) };
}
const existing = new Map<string, any>((db.query("SELECT cold_credential, hot_credential, resigned FROM gov_committee").all() as any[]).map((r) => [r.cold_credential, r]));
const koiosHot = new Map<string, string>((committeeInfo?.members ?? []).map((m: any) => [String(m.cc_cold_hex).toLowerCase(), String(m.cc_hot_hex).toLowerCase()]));
const overrides = new Map<string, string>(String(args.hot ?? "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
const finalCommittee = [...members].map(([cold, exp]) => ({ cold, exp, hot: overrides.get(cold) ?? existing.get(cold)?.hot_credential ?? koiosHot.get(cold) ?? null, resigned: existing.get(cold)?.resigned ?? 0 }));
console.log(`committee at epoch ${target} (threshold ${threshold.num}/${threshold.den}):`);
for (const m of finalCommittee) console.log(`  ${m.cold} expires ${m.exp} hot ${m.hot ?? "(unknown)"}${m.resigned ? " resigned" : ""}`);

// parameter changes to re-apply to epoch_params rows [enacted, target]
const paramFixes: Array<{ from: number; changes: Record<string, unknown> }> = enactedRows.filter((e) => e.kind === "ParameterChange").map((e) => ({ from: e.epoch, changes: e.payload.changes ?? {} }));
const epochRows = new Map<number, any>((db.query("SELECT epoch, params FROM epoch_params WHERE epoch <= ?").all(target) as any[]).map((r) => [Number(r.epoch), JSON.parse(r.params)]));
const touched = new Map<number, Record<string, unknown>>();
for (const f of paramFixes) {
    if (!Object.keys(f.changes).length) { console.log(`  ! enacted parameter change at ${f.from} has an empty payload (recorded before the decoder fix)`); continue; }
    for (const [ep, rec] of epochRows) {
        if (ep < f.from) continue;
        for (const [k, v] of Object.entries(f.changes)) {
            if (k === "cost_models") {
                const merged = { ...(rec.cost_models ?? {}), ...(v as any) };
                if (JSON.stringify(merged) !== JSON.stringify(rec.cost_models ?? {})) { rec.cost_models = merged; touched.set(ep, rec); }
                continue;
            }
            const cur = rec[k];
            const val = typeof cur === "number" ? Number(v) : typeof cur === "string" ? String(v) : v;
            if (JSON.stringify(cur) !== JSON.stringify(val)) { rec[k] = val; touched.set(ep, rec); }
        }
    }
}
console.log(`epoch_params rows to update: ${touched.size}${touched.size ? ` (${Math.min(...touched.keys())}…${Math.max(...touched.keys())})` : ""}`);
if (touched.has(target)) console.log("  target epoch now:", Object.fromEntries(paramFixes.flatMap((f) => Object.keys(f.changes)).filter((k) => k !== "cost_models").map((k) => [k, touched.get(target)![k]])));

if (!apply) { console.log("\ndry run; pass --apply to write"); process.exit(0); }
db.exec("BEGIN");
try {
    for (const s of statusUpdates) {
        db.query("UPDATE gov_proposals SET status = ?, decided_epoch = ? WHERE action_id = ?").run(s.status, s.epoch, s.id);
        if (s.refund !== 0n) {
            const o = ours.find((x) => x.action_id === s.id)!;
            const cred = Buffer.from(String(o.return_account), "hex");
            const has = db.query("SELECT amount FROM rewards WHERE stake_credentials = ?").get(cred) as any;
            if (has) db.query("UPDATE rewards SET amount = amount + ? WHERE stake_credentials = ?").run(s.refund.toString(), cred);
            else db.query("INSERT INTO rewards (stake_credentials, amount) VALUES (?, ?)").run(cred, s.refund.toString());
        }
    }
    for (const f of payloadFixes) db.query("UPDATE gov_proposals SET payload = ? WHERE action_id = ?").run(JSON.stringify(f.payload), f.id);
    for (const e of enactedRows) db.query("INSERT OR REPLACE INTO gov_enacted (epoch, action_id, kind, detail) VALUES (?, ?, ?, ?)").run(e.epoch, e.id, e.kind, JSON.stringify(e.payload));
    db.query("UPDATE gov_state SET prev_pparams = ?, prev_committee = ?, prev_hardfork = ?, prev_constitution = ?, no_confidence = ?, committee_threshold_num = ?, committee_threshold_den = ? WHERE id = 1")
        .run(prev.pparams, prev.committee, prev.hardfork, prev.constitution, noConfidence, threshold.num, threshold.den);
    db.exec("DELETE FROM gov_committee");
    for (const m of finalCommittee) db.query("INSERT INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (?, ?, ?, ?)").run(m.cold, m.exp, m.hot, m.resigned);
    for (const [ep, rec] of touched) db.query("UPDATE epoch_params SET params = ? WHERE epoch = ?").run(JSON.stringify(rec), ep);
    db.exec("COMMIT");
    console.log("\napplied");
} catch (e) {
    db.exec("ROLLBACK");
    throw e;
}
