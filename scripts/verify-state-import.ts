/**
 * Compare a database filled by `gerolamo import-state` (+ `import-utxo`) with a reference ledger
 * database (a genesis replay) table by table. The reference is normally at a later tip, so the
 * in-flight tables (rewards, fee pot, blocks made in the current epoch, live proposals) may
 * legitimately differ by what happened after the snapshot slot; the boundary-frozen tables
 * (stake snapshots, pool parameters at the snapshots, pots, parameters, nonces, DRep stake) must
 * match exactly.
 *
 *   bun scripts/verify-state-import.ts --imported <db> --reference <db> [--epoch E]
 */
import { Database } from "bun:sqlite";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
const imp = new Database(args.get("imported")!, { readonly: true });
const ref = new Database(args.get("reference")!, { readonly: true });
const E = Number(args.get("epoch") ?? imp.query("SELECT initialized_epoch FROM reward_pots WHERE id = 1").get()?.["initialized_epoch"]);
const S = Number(imp.query("SELECT start_slot FROM epoch_nonces WHERE epoch = ?").get(E)?.["start_slot"] ?? 0);
console.log(`verify-state-import: epoch ${E}, snapshot slot ${S}`);

type Row = Record<string, unknown>;
const q = (db: Database, sql: string, ...p: unknown[]) => db.query(sql).all(...(p as any)) as Row[];
const norm = (v: unknown): string => v == null ? "∅" : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : typeof v === "bigint" ? String(v) : String(v);

interface CompareOpts { name: string; sql: string; key: string[]; params?: unknown[]; exact: boolean; ignore?: string[]; examples?: number }
function compare(o: CompareOpts): void {
    const key = (r: Row) => o.key.map((k) => norm(r[k])).join("|");
    const cols = (r: Row) => Object.keys(r).filter((c) => !o.key.includes(c) && !(o.ignore ?? []).includes(c));
    const a = new Map(q(imp, o.sql, ...(o.params ?? [])).map((r) => [key(r), r]));
    const b = new Map(q(ref, o.sql, ...(o.params ?? [])).map((r) => [key(r), r]));
    let same = 0, diff = 0, onlyA = 0, onlyB = 0; const ex: string[] = [];
    for (const [k, ra] of a) {
        const rb = b.get(k);
        if (!rb) { onlyA++; if (ex.length < (o.examples ?? 3)) ex.push(`only imported: ${k}`); continue; }
        const d = cols(ra).filter((c) => norm(ra[c]) !== norm(rb[c]));
        if (d.length) { diff++; if (ex.length < (o.examples ?? 3)) ex.push(`${k}: ${d.map((c) => `${c} ${norm(ra[c])} vs ${norm(rb[c])}`).join(", ")}`); } else same++;
    }
    for (const k of b.keys()) if (!a.has(k)) { onlyB++; if (ex.length < (o.examples ?? 3)) ex.push(`only reference: ${k}`); }
    const ok = diff === 0 && onlyA === 0 && onlyB === 0;
    console.log(`${ok ? "OK  " : o.exact ? "FAIL" : "diff"} ${o.name}: ${same} same, ${diff} differ, ${onlyA} only imported, ${onlyB} only reference`);
    for (const e of ex) console.log(`       ${e}`);
}

/** Pool parameter JSON with the margin as a decimal, so 0/1 and 0/1000000 compare equal. */
const POOL_JSON = "json_extract(params_json, '$.pledge') AS pledge, json_extract(params_json, '$.cost') AS cost, CAST(json_extract(params_json, '$.marginNum') AS REAL) / CAST(json_extract(params_json, '$.marginDen') AS REAL) AS margin, json_extract(params_json, '$.rewardAccount') AS reward_account, json_extract(params_json, '$.owners') AS owners";
const typedStake = "CASE WHEN cred_type = 1 THEN '01' ELSE '' END || lower(hex(stake_credentials)) AS k";
compare({ name: "rewards (in-flight: withdrawals/credits after S may differ)", sql: "SELECT lower(hex(stake_credentials)) AS k, amount FROM rewards WHERE amount <> 0", key: ["k"], exact: false });
compare({ name: "stake registrations", sql: `SELECT ${typedStake} FROM stake`, key: ["k"], exact: false });
compare({ name: "delegations", sql: `SELECT ${typedStake}, lower(hex(pool_key_hash)) AS pool FROM delegations`, key: ["k"], exact: false });
compare({ name: "gov_drep_delegations", sql: "SELECT stake_key, drep_type, COALESCE(drep_hash, '') AS drep_hash FROM gov_drep_delegations", key: ["stake_key"], exact: false });
compare({ name: "pool_params (margin reduced)", sql: `SELECT pool_id, vrf_key_hash, retiring_epoch, ${POOL_JSON} FROM pool_params`, key: ["pool_id"], exact: false });
for (const t of [E - 2, E - 1, E]) {
    compare({ name: `epoch_stake_cred ${t} (reference keeps zero-stake delegators)`, sql: "SELECT stake_key, pool_id, stake FROM epoch_stake_cred WHERE taken_at = ? AND stake <> 0", key: ["stake_key"], params: [t], exact: true });
    compare({ name: `epoch_pool_stake ${t}`, sql: "SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ?", key: ["pool_id"], params: [t], exact: true });
    compare({ name: `epoch_stake_totals ${t}`, sql: "SELECT taken_at, total_active, pools FROM epoch_stake_totals WHERE taken_at = ?", key: ["taken_at"], params: [t], exact: true });
    compare({ name: `epoch_pool_params ${t} (margin reduced; owners as registered — a pool re-registered since keeps the node's delegated-owner subset)`, sql: `SELECT pool_id, vrf_key_hash, ${POOL_JSON} FROM epoch_pool_params WHERE taken_at = ?`, key: ["pool_id"], params: [t], exact: true });
}
compare({ name: `blocks_made_by_epoch ${E - 1}`, sql: "SELECT pool_id, blocks FROM blocks_made_by_epoch WHERE epoch = ?", key: ["pool_id"], params: [E - 1], exact: true });
compare({ name: `blocks_made_by_epoch ${E} (reference counts blocks after S too)`, sql: "SELECT pool_id, blocks FROM blocks_made_by_epoch WHERE epoch = ?", key: ["pool_id"], params: [E], exact: false });
compare({ name: "opcert_counters (reference: pools that issued after S may differ)", sql: "SELECT pool_id, counter FROM opcert_counters", key: ["pool_id"], exact: false });
compare({ name: "reward_pots reserves/treasury", sql: "SELECT id, reserves, treasury FROM reward_pots", key: ["id"], exact: true });
compare({ name: "reward_pots fee/donation pot (reference accumulates after S)", sql: "SELECT id, fee_pot, donation_pot FROM reward_pots", key: ["id"], exact: false });
compare({ name: `pot_snapshots ${E}`, sql: "SELECT epoch, reserves, treasury, fees_collected FROM pot_snapshots WHERE epoch = ?", key: ["epoch"], params: [E], exact: true });
for (const e of [E - 1, E]) {
    const a = q(imp, "SELECT params FROM epoch_params WHERE epoch = ?", e)[0], b = q(ref, "SELECT params FROM epoch_params WHERE epoch = ?", e)[0];
    if (!a || !b) { console.log(`FAIL epoch_params ${e}: ${a ? "" : "missing in imported "}${b ? "" : "missing in reference"}`); continue; }
    const pa = JSON.parse(String(a.params)), pb = JSON.parse(String(b.params));
    const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    const d = [...keys].filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]));
    console.log(`${d.length ? "FAIL" : "OK  "} epoch_params ${e}: ${keys.size} keys, ${d.length} differ${d.length ? ` (${d.slice(0, 6).join(", ")})` : ""}`);
}
compare({ name: `epoch_nonces ${E} (epoch nonce, candidate)`, sql: "SELECT epoch, nonce_hex, candidate_hex FROM epoch_nonces WHERE epoch = ?", key: ["epoch"], params: [E], exact: true });
compare({ name: `epoch_nonces ${E - 1} (epoch nonce)`, sql: "SELECT epoch, nonce_hex FROM epoch_nonces WHERE epoch = ?", key: ["epoch"], params: [E - 1], exact: true });
compare({ name: "gov_dreps (deposit, type)", sql: "SELECT credential, is_script, deposit FROM gov_dreps", key: ["credential"], exact: true });
{
    // Expiry: the import carries the ledger's stored value; a reference from before bug 102 derives it from last_active + the current drep_activity.
    const hasExpiry = (db: Database) => q(db, "PRAGMA table_info(gov_dreps)").some((r) => r.name === "expiry_epoch");
    const expiries = (db: Database) => { const act = Number(q(db, "SELECT json_extract(params, '$.drep_activity') AS a FROM epoch_params WHERE epoch = ?", E)[0]?.a ?? 20); return new Map(q(db, hasExpiry(db) ? "SELECT credential, COALESCE(expiry_epoch, last_active_epoch + ?) AS e FROM gov_dreps" : "SELECT credential, last_active_epoch + ? AS e FROM gov_dreps", act).map((r) => [String(r.credential), Number(r.e)])); };
    const a = expiries(imp), b = expiries(ref); const dist = new Map<number, number>(); for (const [k, e] of a) { const d = e - (b.get(k) ?? NaN); dist.set(d, (dist.get(d) ?? 0) + 1); }
    console.log(`diff gov_dreps expiry − reference (bug 102: DReps last active under another drep_activity keep theirs): ${[...dist].sort((x, y) => y[1] - x[1]).map(([d, n]) => `${d >= 0 ? "+" : ""}${d}: ${n}`).join(", ")}`);
}
compare({ name: "gov_committee", sql: "SELECT cold_credential, expires_epoch, hot_credential, resigned FROM gov_committee", key: ["cold_credential"], exact: true });
compare({ name: "gov_committee_auth (the node keeps members' authorisations only; the replay keeps every cold key's)", sql: "SELECT cold_credential, hot_credential, resigned FROM gov_committee_auth", key: ["cold_credential"], exact: false });
compare({ name: "gov_state", sql: "SELECT id, committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, prev_pparams, prev_hardfork, prev_committee, prev_constitution, dormant_epochs, pending FROM gov_state", key: ["id"], exact: true });
compare({ name: "gov_proposals live at S (reference: proposals after S, decisions after S)", sql: `SELECT action_id, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status FROM gov_proposals WHERE status IN ('active', 'ratified') AND proposed_epoch <= ${E}`, key: ["action_id"], exact: false });
compare({ name: "gov_votes on live proposals (reference: votes after S)", sql: `SELECT v.action_id, v.voter_kind, v.voter_hash, v.vote FROM gov_votes v JOIN gov_proposals p ON p.action_id = v.action_id WHERE p.status IN ('active', 'ratified')`, key: ["action_id", "voter_kind", "voter_hash"], exact: false });
compare({ name: `epoch_drep_stake ${E} (reference: bug 101 delegations; zero rows omitted)`, sql: "SELECT drep_type, drep_hash, stake FROM epoch_drep_stake WHERE taken_at = ? AND CAST(stake AS INTEGER) <> 0", key: ["drep_type", "drep_hash"], params: [E], exact: false });
compare({ name: "genesis_delegs", sql: "SELECT genesis_key_hash, delegate_hash, vrf_key_hash FROM genesis_delegs", key: ["genesis_key_hash"], exact: true });
compare({ name: "schema_migrations", sql: "SELECT name FROM schema_migrations", key: ["name"], exact: false });
const sb = (db: Database) => q(db, "SELECT COUNT(*) AS n, COALESCE(SUM(lovelace), 0) AS s FROM stake_balance WHERE lovelace > 0")[0]!;
const a = sb(imp), b = sb(ref); console.log(`${norm(a.n) === norm(b.n) ? "OK  " : "diff"} stake_balance: imported ${a.n} keys ${a.s} lovelace, reference ${b.n} keys ${b.s} lovelace (reference at its tip)`);
