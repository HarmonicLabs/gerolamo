/**
 * Compare a node's SQLite ledger tables with its LMDB ledger store (docs/PLAN_LMDB_LEDGER.md §5, §7).
 * Both are opened read-only beside a running node; the LMDB state is the anchor plus the persisted
 * diffs up to the store's selected tip (db/gerolamo/selected-tip.hex).
 *
 * Usage: bun scripts/ledger-compare.ts <nodeDir> [--utxo-sample N] [--all-utxo]
 * Exit code 1 when any table differs. A node applying a block while this runs can show a handful
 * of transient differences: rerun when the tips agree.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerStore } from "../src/ledger/LedgerStore";
import { StakeReads } from "../src/ledger/stakeStore";
import { GovReads, keyAction } from "../src/ledger/govStore";
import { UtxoReads } from "../src/ledger/utxoStore";

const args = process.argv.slice(2);
const nodeDir = args.find((a) => !a.startsWith("--"));
if (!nodeDir) { console.error("usage: bun scripts/ledger-compare.ts <nodeDir> [--utxo-sample N] [--all-utxo]"); process.exit(2); }
const allUtxo = args.includes("--all-utxo");
const sampleN = Number(args[args.indexOf("--utxo-sample") + 1] || 200000);
const cfg = JSON.parse(readFileSync(join(nodeDir, "config.json"), "utf8"));
const dbPath = String(cfg.dbPath ?? join(nodeDir, "preview.db"));
const ledgerDir = String(cfg.ledgerDir ?? join(nodeDir, "ledger"));
const tipFile = join(nodeDir, "db", "gerolamo", "selected-tip.hex");

const sq = new Database(dbPath, { readonly: true });
// One read transaction: every SQLite table is seen as of the same moment (WAL snapshot), and the
// LMDB view is pinned to the newest block SQLite has applied (the ledger journal's newest block),
// so diffs of a range still in flight are left out.
sq.exec("BEGIN");
// the first read starts the snapshot; the store (and its diff files) is opened afterwards, so every
// block the snapshot holds has its diff on disk already (diffs are written before the SQLite commit)
const journalTip = (sq.query("SELECT lower(hex(block_hash)) AS h FROM ledger_journal ORDER BY id DESC LIMIT 1").get() as { h?: string } | null)?.h ?? null;
const st = LedgerStore.open(ledgerDir, { readOnly: true });
const anchor = st.anchor();
const tipHex = journalTip ?? (existsSync(tipFile) ? readFileSync(tipFile, "utf8").trim() : null);
if (tipHex) st.selectTip(Uint8Array.from(Buffer.from(tipHex, "hex")));
console.log(`ledger ${ledgerDir}: anchor slot ${anchor?.slot ?? "-"}, ${st.loadedDiffs} persisted diff(s), compared at ${journalTip ? "SQLite's newest applied block" : "the store's selected tip"} ${tipHex?.slice(0, 16) ?? "-"}, reaches anchor: ${tipHex ? st.chainReachesAnchor(Uint8Array.from(Buffer.from(tipHex, "hex"))) : "-"}`);
const ur = new UtxoReads(st), sr = new StakeReads(st);
let failed = 0;
const report = (table: string, a: number, b: number, diffs: string[]) => {
    const ok = diffs.length === 0 && a === b;
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "DIFF"} ${table.padEnd(22)} sqlite ${String(a).padStart(9)}  lmdb ${String(b).padStart(9)}${diffs.length ? `  ${diffs.length} difference(s): ${diffs.slice(0, 4).join(" | ")}` : ""}`);
};
const typed = (hashHex: unknown, type: unknown) => `${Number(type) === 1 ? "01" : ""}${String(hashHex).toLowerCase()}`;
const cmpMaps = <V>(table: string, a: Map<string, V>, b: Map<string, V>, eq: (x: V, y: V) => boolean = (x, y) => JSON.stringify(x) === JSON.stringify(y), show: (k: string, x?: V, y?: V) => string = (k, x, y) => `${k.slice(0, 20)}: ${JSON.stringify(x)?.slice(0, 60)} vs ${JSON.stringify(y)?.slice(0, 60)}`) => {
    const diffs: string[] = [];
    for (const [k, v] of a) { const w = b.get(k); if (w === undefined || !eq(v, w)) diffs.push(show(k, v, w)); }
    for (const k of b.keys()) if (!a.has(k)) diffs.push(show(k, undefined, b.get(k)));
    report(table, a.size, b.size, diffs);
};
const rows = (q: string): any[] => { try { return sq.query(q).values() as any[]; } catch { return []; } };

// ---- UTxO
{
    const n = (sq.query("SELECT COUNT(*) AS n FROM utxo").get() as any).n as number;
    const diffs: string[] = [];
    let checked = 0;
    // CAST: bun:sqlite returns INTEGER as a JS number and loses precision above 2^53 (the preview faucet output holds 2.27e16 lovelace)
    const q = sq.query(allUtxo ? "SELECT utxo_ref, tx_out, CAST(lovelace AS TEXT) AS lovelace, stake_key, address, reference_script_hash FROM utxo" : `SELECT utxo_ref, tx_out, CAST(lovelace AS TEXT) AS lovelace, stake_key, address, reference_script_hash FROM utxo ORDER BY random() LIMIT ${sampleN}`);
    for (const r of q.iterate() as Iterable<any>) {
        checked++;
        const b = ur.get(String(r.utxo_ref));
        if (!b) { if (diffs.length < 50) diffs.push(`${String(r.utxo_ref).slice(0, 20)}: in SQLite only`); continue; }
        if (b.tx_out !== String(r.tx_out) || String(b.lovelace ?? "") !== String(r.lovelace ?? "") || (b.stake_key ?? null) !== (r.stake_key ?? null) || (b.address ?? null) !== (r.address ?? null) || (b.reference_script_hash ?? null) !== (r.reference_script_hash ?? null)) { if (diffs.length < 50) diffs.push(`${String(r.utxo_ref).slice(0, 20)}: row differs`); }
    }
    report(`utxo (${allUtxo ? "all" : checked + " sampled"})`, n, ur.count(), diffs);
    // stake balances: SQLite stake_balance vs LMDB counters (full)
    const sb = new Map<string, string>(); for (const r of rows("SELECT stake_key, CAST(lovelace AS TEXT) FROM stake_balance WHERE lovelace <> 0")) sb.set(String(r[0]), String(r[1]));
    const lb = new Map<string, string>(); for (const [k, v] of st.range("stake_bal", new Uint8Array(0))) lb.set(Buffer.from(k).toString("hex"), new DataView(v.buffer, v.byteOffset).getBigUint64(0, false).toString());
    cmpMaps("stake_balance", sb, lb);
}
// ---- stake group
cmpMaps("stake", new Map(rows("SELECT hex(stake_credentials), cred_type FROM stake").map((r) => [typed(r[0], r[1]), 1])), new Map([...sr.registeredStakeKeys()].map((k) => [k, 1])));
cmpMaps("delegations", new Map(rows("SELECT hex(stake_credentials), cred_type, lower(hex(pool_key_hash)) FROM delegations ORDER BY id").map((r) => [typed(r[0], r[1]), String(r[2])])), new Map(sr.allDelegations()));
cmpMaps("rewards", new Map(rows("SELECT lower(hex(stake_credentials)), amount FROM rewards WHERE amount <> 0").map((r) => [String(r[0]), String(r[1])])), new Map([...sr.rewardBalances()].map(([k, v]) => [k, v.toString()])));
cmpMaps("stake_pointers", new Map(rows("SELECT slot, tx_ix, cert_ix, stake_key FROM stake_pointers").map((r) => [`${r[0]}/${r[1]}/${r[2]}`, String(r[3])])), new Map([...st.range("pointer", new Uint8Array(0))].map(([k, v]) => { const dv = new DataView(k.buffer, k.byteOffset); return [`${dv.getBigUint64(0, false)}/${dv.getUint32(8, false)}/${dv.getUint32(12, false)}`, Buffer.from(v).toString("hex")]; })));
cmpMaps("pool_params", new Map(rows("SELECT pool_id, vrf_key_hash, registered_slot, retiring_epoch, params_json FROM pool_params").map((r) => [String(r[0]), { vrf: String(r[1]), registeredSlot: Number(r[2]), retiringEpoch: r[3] == null ? null : Number(r[3]), params: r[4] == null ? null : JSON.parse(String(r[4])) }])), sr.pools() as Map<string, any>);
cmpMaps("pool_params_pending", new Map(rows("SELECT pool_id, vrf_key_hash, registered_slot, params_json FROM pool_params_pending").map((r) => [String(r[0]), { vrf: String(r[1]), registeredSlot: Number(r[2]), params: r[3] == null ? null : JSON.parse(String(r[3])) }])), sr.pendingPools() as Map<string, any>);
cmpMaps("opcert_counters", new Map(rows("SELECT pool_id, counter, slot FROM opcert_counters").map((r) => [String(r[0]), { counter: Number(r[1]), slot: Number(r[2]) }])), new Map([...st.range("opcert", new Uint8Array(0))].map(([k]) => { const id = Buffer.from(k).toString("hex"); return [id, sr.opcert(id)!]; })));
// report history below the store's retention window (GEROLAMO_LEDGER_KEEP_EPOCHS, default 30) is not in LMDB
const keepEpochs = Number(process.env.GEROLAMO_LEDGER_KEEP_EPOCHS) >= 4 ? Number(process.env.GEROLAMO_LEDGER_KEEP_EPOCHS) : 30;
const curEpoch = Number((sq.query("SELECT MAX(taken_at) m FROM epoch_stake_totals").get() as any)?.m ?? 0);
const minEpoch = curEpoch - keepEpochs;
console.log(`history tables compared from epoch ${minEpoch} (retention ${keepEpochs} epochs)`);
{
    const a = new Map<string, number>(); for (const r of rows(`SELECT epoch, pool_id, blocks FROM blocks_made_by_epoch WHERE epoch >= ${minEpoch}`)) a.set(`${r[0]}/${r[1]}`, Number(r[2]));
    const b = new Map<string, number>(); for (const [k, v] of st.range("blocks_made", new Uint8Array(0))) b.set(`${new DataView(k.buffer, k.byteOffset).getUint32(0, false)}/${Buffer.from(k.subarray(4)).toString("hex")}`, Number(new DataView(v.buffer, v.byteOffset).getBigUint64(0, false)));
    cmpMaps("blocks_made_by_epoch", a, b);
}
cmpMaps("genesis_delegs", new Map(rows("SELECT genesis_key_hash, effective_slot, delegate_hash, vrf_key_hash FROM genesis_delegs").map((r) => [`${r[0]}/${r[1]}`, { delegate: String(r[2]), vrf: String(r[3]) }])), new Map([...st.range("gdeleg", new Uint8Array(0))].map(([k, v]) => [`${Buffer.from(k.subarray(0, 28)).toString("hex")}/${new DataView(k.buffer, k.byteOffset).getBigUint64(28, false)}`, JSON.parse(new TextDecoder().decode(v))])));
cmpMaps("mir_pending", new Map(rows("SELECT id, recorded_epoch, source, stake_key, amount FROM mir_pending ORDER BY id").map((r, i) => [String(i), { epoch: Number(r[1]), source: Number(r[2]), stakeKey: r[3] == null ? null : String(r[3]), amount: String(r[4]) }])), new Map(sr.pendingMir(1e9).map((m, i) => [String(i), { epoch: m.recordedEpoch, source: m.source, stakeKey: m.stakeKey, amount: m.amount.toString() }])));
{
    const r = rows("SELECT reserves, treasury, fee_pot, donation_pot, initialized_epoch FROM reward_pots WHERE id = 1")[0];
    const a = r ? { reserves: String(r[0]), treasury: String(r[1]), feePot: String(r[2]), donationPot: String(r[3] ?? 0), initializedEpoch: Number(r[4]) } : null;
    const p = sr.pots();
    const b = p ? { reserves: p.reserves.toString(), treasury: p.treasury.toString(), feePot: p.feePot.toString(), donationPot: p.donationPot.toString(), initializedEpoch: p.initializedEpoch } : null;
    report("reward_pots", a ? 1 : 0, b ? 1 : 0, JSON.stringify(a) === JSON.stringify(b) ? [] : [`sqlite ${JSON.stringify(a)} lmdb ${JSON.stringify(b)}`]);
}
cmpMaps("epoch_stake_totals", new Map(rows("SELECT taken_at, total_active, pools FROM epoch_stake_totals").map((r) => [String(r[0]), { total: String(r[1]), pools: Number(r[2]) }])), new Map(sr.snapshotEpochs().map((e) => { const t = sr.snapshotTotals(e)!; return [String(e), { total: t.total.toString(), pools: t.pools }]; })));
{
    const a = new Map<string, string>(); for (const r of rows(`SELECT taken_at, pool_id, stake FROM epoch_pool_stake WHERE taken_at >= ${minEpoch}`)) a.set(`${r[0]}/${r[1]}`, String(r[2]));
    const b = new Map<string, string>(); for (const e of sr.snapshotEpochs()) for (const [id, v] of sr.snapshotPoolStake(e)) b.set(`${e}/${id}`, v.toString());
    cmpMaps("epoch_pool_stake", a, b);
    const ac = new Map<string, string>(); for (const r of rows("SELECT taken_at, stake_key, pool_id, stake FROM epoch_stake_cred")) ac.set(`${r[0]}/${r[1]}`, `${r[2]}:${r[3]}`);
    const bc = new Map<string, string>(); for (const e of sr.snapshotEpochs()) for (const [c, v] of sr.snapshotCredentials(e)) bc.set(`${e}/${c}`, `${v.pool}:${v.stake}`);
    cmpMaps("epoch_stake_cred", ac, bc);
    const ap = new Map<string, any>(); for (const r of rows("SELECT taken_at, pool_id, vrf_key_hash, params_json FROM epoch_pool_params")) ap.set(`${r[0]}/${r[1]}`, { vrf: String(r[2]), params: r[3] == null ? null : JSON.parse(String(r[3])) });
    const bp = new Map<string, any>(); for (const e of sr.snapshotEpochs()) for (const [id, v] of sr.snapshotPoolParams(e)) bp.set(`${e}/${id}`, v);
    cmpMaps("epoch_pool_params", ap, bp);
}
{
    const a = new Map<string, string>(); for (const r of rows("SELECT pay_at, stake_key, amount FROM pending_rewards")) a.set(`${r[0]}/${r[1]}`, String(r[2]));
    const b = new Map<string, string>(); for (const [k, v] of st.range("pending_rew", new Uint8Array(0))) b.set(`${new DataView(k.buffer, k.byteOffset).getUint32(0, false)}/${Buffer.from(k.subarray(4)).toString("hex")}`, new DataView(v.buffer, v.byteOffset).getBigUint64(0, false).toString());
    cmpMaps("pending_rewards", a, b);
}
cmpMaps("reward_epochs", new Map(rows("SELECT performance_epoch, reward_pot, treasury_delta, paid, unclaimed, pools, accounts FROM reward_epochs").map((r) => [String(r[0]), { rewardPot: String(r[1]), treasuryDelta: String(r[2]), paid: String(r[3]), unclaimed: String(r[4]), pools: Number(r[5]), accounts: Number(r[6]) }])), new Map([...st.range("reward_epochs", new Uint8Array(0))].map(([k]) => { const e = new DataView(k.buffer, k.byteOffset).getUint32(0, false); return [String(e), sr.rewardEpoch(e)!]; })));
{
    const a = new Map<string, string>(); for (const r of rows(`SELECT performance_epoch, stake_key, amount FROM reward_payouts WHERE performance_epoch >= ${minEpoch}`)) a.set(`${r[0]}/${r[1]}`, String(r[2]));
    const b = new Map<string, string>(); for (const [k, v] of st.range("reward_payouts", new Uint8Array(0))) b.set(`${new DataView(k.buffer, k.byteOffset).getUint32(0, false)}/${Buffer.from(k.subarray(4)).toString("hex")}`, new DataView(v.buffer, v.byteOffset).getBigUint64(0, false).toString());
    cmpMaps("reward_payouts", a, b);
    const ap = new Map<string, any>(); for (const r of rows(`SELECT performance_epoch, pool_id, max_pool, pool_reward, operator, members, owner_stake, stake, blocks FROM reward_pool_epochs WHERE performance_epoch >= ${minEpoch}`)) ap.set(`${r[0]}/${r[1]}`, { maxPool: String(r[2]), poolReward: String(r[3]), operator: String(r[4]), members: String(r[5]), ownerStake: String(r[6]), stake: String(r[7]), blocks: Number(r[8]) });
    const bp = new Map<string, any>(); for (const [k, v] of st.range("reward_pool_epochs", new Uint8Array(0))) bp.set(`${new DataView(k.buffer, k.byteOffset).getUint32(0, false)}/${Buffer.from(k.subarray(4)).toString("hex")}`, JSON.parse(new TextDecoder().decode(v)));
    cmpMaps("reward_pool_epochs", ap, bp);
}
cmpMaps("pot_snapshots", new Map(rows("SELECT epoch, reserves, treasury, fees_collected FROM pot_snapshots").map((r) => [String(r[0]), { reserves: String(r[1]), treasury: String(r[2]), feesCollected: String(r[3]) }])), new Map([...st.range("pot_snap", new Uint8Array(0))].map(([k]) => { const e = new DataView(k.buffer, k.byteOffset).getUint32(0, false); const p = sr.potSnapshot(e)!; return [String(e), { reserves: p.reserves.toString(), treasury: p.treasury.toString(), feesCollected: p.feesCollected.toString() }]; })));
cmpMaps("pool_relays", new Map(rows("SELECT pool_id, relays_json FROM pool_relays").map((r) => [String(r[0]), JSON.parse(String(r[1]))])), new Map([...st.range("pool_relays", new Uint8Array(0))].map(([k, v]) => [Buffer.from(k).toString("hex"), JSON.parse(new TextDecoder().decode(v)).relays])));

// ---- governance / parameters / nonces
{
    const gr = new GovReads(st);
    const strv = (v: unknown) => (v == null ? null : String(v));
    cmpMaps("gov_dreps", new Map(rows("SELECT credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch FROM gov_dreps").map((r) => [String(r[0]), { isScript: Number(r[1] ?? 0), deposit: String(r[2]), registeredSlot: Number(r[3]), lastActiveEpoch: Number(r[4]), expiryEpoch: r[5] == null ? null : Number(r[5]) }])), gr.dreps() as Map<string, any>);
    cmpMaps("gov_drep_delegations", new Map(rows("SELECT stake_key, drep_type, drep_hash FROM gov_drep_delegations").map((r) => [String(r[0]), { type: Number(r[1]), hash: strv(r[2]) }])), gr.drepDelegations() as Map<string, any>);
    cmpMaps("gov_committee", new Map(rows("SELECT cold_credential, expires_epoch, hot_credential, resigned FROM gov_committee").map((r) => [String(r[0]), { expiresEpoch: Number(r[1]), hot: strv(r[2]), resigned: Number(r[3] ?? 0) }])), gr.committee() as Map<string, any>);
    cmpMaps("gov_committee_auth", new Map(rows("SELECT cold_credential, hot_credential, resigned FROM gov_committee_auth").map((r) => [String(r[0]), { hot: strv(r[1]), resigned: Number(r[2] ?? 0) }])), gr.committeeAuths() as Map<string, any>);
    const gs = rows("SELECT committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, prev_pparams, prev_hardfork, prev_committee, prev_constitution, seeded_epoch, dormant_epochs, pending FROM gov_state WHERE id = 1")[0];
    const a = gs ? { thrNum: Number(gs[0]), thrDen: Number(gs[1]), constitutionHash: strv(gs[2]), constitutionScript: strv(gs[3]), noConfidence: Number(gs[4] ?? 0), prevPP: strv(gs[5]), prevHF: strv(gs[6]), prevCC: strv(gs[7]), prevCons: strv(gs[8]), seededEpoch: Number(gs[9]), dormantEpochs: Number(gs[10] ?? 0), pending: strv(gs[11]) } : null;
    report("gov_state", a ? 1 : 0, gr.state() ? 1 : 0, JSON.stringify(a) === JSON.stringify(gr.state()) ? [] : [`sqlite ${JSON.stringify(a)?.slice(0, 200)} lmdb ${JSON.stringify(gr.state())?.slice(0, 200)}`]);
    cmpMaps("gov_proposals", new Map(rows("SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status, decided_epoch FROM gov_proposals").map((r) => [String(r[0]), { actionId: String(r[0]), seq: Number(r[1]), kind: String(r[2]), prevActionId: strv(r[3]), deposit: String(r[4]), returnAccount: String(r[5]), payload: String(r[6]), proposedEpoch: Number(r[7]), expiresEpoch: Number(r[8]), status: String(r[9] ?? "active"), decidedEpoch: r[10] == null ? null : Number(r[10]) }])), new Map(gr.proposals().map((p) => [p.actionId, p])) as Map<string, any>);
    const av = new Map<string, any>(); for (const r of rows("SELECT action_id, voter_kind, voter_hash, vote, slot FROM gov_votes")) av.set(`${r[0]}/${r[1]}/${r[2]}`, { vote: Number(r[3]), slot: Number(r[4]) });
    const bv = new Map<string, any>(); for (const p of gr.proposals()) for (const v of gr.votes(p.actionId)) bv.set(`${v.actionId}/${v.voterKind}/${v.voterHash}`, { vote: v.vote, slot: v.slot });
    cmpMaps("gov_votes", av, bv);
    const ae = new Map<string, any>(); for (const r of rows("SELECT epoch, action_id, kind, detail FROM gov_enacted")) ae.set(`${r[0]}/${r[1]}`, { kind: String(r[2]), detail: strv(r[3]) });
    const be = new Map<string, any>(); for (const [k, v] of st.range("gov_enacted", new Uint8Array(0))) { const e = new DataView(k.buffer, k.byteOffset).getUint32(0, false); be.set(`${e}/${keyAction(k.subarray(4))}`, JSON.parse(new TextDecoder().decode(v))); }
    cmpMaps("gov_enacted", ae, be);
    const ads = new Map<string, string>(); for (const r of rows(`SELECT taken_at, drep_type, drep_hash, stake FROM epoch_drep_stake WHERE taken_at >= ${minEpoch}`)) ads.set(`${r[0]}/${r[1]}/${r[2] ?? ""}`, String(r[3]));
    const bds = new Map<string, string>(); for (const [k, v] of st.range("drep_stake", new Uint8Array(0))) bds.set(`${new DataView(k.buffer, k.byteOffset).getUint32(0, false)}/${k[4]}/${Buffer.from(k.subarray(5)).toString("hex")}`, new DataView(v.buffer, v.byteOffset).getBigUint64(0, false).toString());
    cmpMaps("epoch_drep_stake", ads, bds);
    cmpMaps("epoch_params", new Map(rows("SELECT epoch, params, source FROM epoch_params").map((r) => [String(r[0]), { params: JSON.parse(String(r[1])), source: strv(r[2]) }])), new Map(gr.epochParamEpochs().map((e) => [String(e), gr.epochParams(e)])) as Map<string, any>, undefined, (k, x, y) => `${k}: ${x ? "sqlite" : "-"} vs ${y ? "lmdb" : "-"}${x && y ? " content differs" : ""}`);
    const app = new Map<string, any>(); for (const r of rows("SELECT epoch, genesis_key, changes_json, slot FROM pparam_proposals")) app.set(`${r[0]}/${r[1]}`, { changes: String(r[2]), slot: Number(r[3]) });
    const bpp = new Map<string, any>(); for (const [k, v] of st.range("pparam_props", new Uint8Array(0))) bpp.set(`${new DataView(k.buffer, k.byteOffset).getUint32(0, false)}/${Buffer.from(k.subarray(4)).toString("hex")}`, JSON.parse(new TextDecoder().decode(v)));
    cmpMaps("pparam_proposals", app, bpp);
    cmpMaps("epoch_nonces", new Map(rows("SELECT epoch, nonce_hex, source, evolving_hex, candidate_hex, start_evolving_hex, start_candidate_hex, start_slot, start_lab_hex FROM epoch_nonces").map((r) => [String(r[0]), { nonceHex: String(r[1]), source: String(r[2] ?? "external"), evolvingHex: strv(r[3]), candidateHex: strv(r[4]), startEvolvingHex: strv(r[5]), startCandidateHex: strv(r[6]), startSlot: r[7] == null ? null : Number(r[7]), startLabHex: strv(r[8]) }])), new Map(gr.nonceEpochs().map((e) => [String(e), gr.nonce(e)])) as Map<string, any>);
}

st.close(); sq.exec("COMMIT"); sq.close();
console.log(failed ? `${failed} table(s) differ` : "all tables match");
process.exit(failed ? 1 : 0);
