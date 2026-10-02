/**
 * Empty the SQLite ledger tables of a node that runs the LMDB ledger with SQLite writes off
 * (docs/PLAN_LMDB_LEDGER.md §9 step 4) and VACUUM the file, keeping the schema (a stray read then
 * sees an empty table instead of an error) and the static tables (schema_migrations, genesis_utxo).
 * Marks the database so the node refuses any mode but lmdb afterwards.
 *
 * Guards: the node's config says ledgerStore "lmdb" and its watchdog entry carries
 * GEROLAMO_LEDGER_SQL_WRITES=0; the node answers /metrics in lmdb mode, at the tip, not halted.
 * The tool stops the node's supervisor and node (and holds the watchdog off), works, then relaunches.
 *   bun scripts/ledger-sqlite-drop.ts --port 3036 --dir <nodeDir> [--watchdog-config <path>] [--yes]
 */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const port = Number(arg("port")), dir = arg("dir")!, wdPath = arg("watchdog-config", "/media/bakon/data/cardano/watchdog/config.json")!;
if (!port || !dir) { console.error("usage: bun scripts/ledger-sqlite-drop.ts --port <p> --dir <nodeDir> [--yes]"); process.exit(2); }
const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const wd = JSON.parse(readFileSync(wdPath, "utf8"));
const node = wd.nodes.find((n: any) => n.port === port);
const fail = (m: string) => { console.error(`refused: ${m}`); process.exit(1); };
if (cfg.ledgerStore !== "lmdb") fail(`config ledgerStore is ${cfg.ledgerStore}`);
if (node?.env?.GEROLAMO_LEDGER_SQL_WRITES !== "0") fail("the watchdog entry does not set GEROLAMO_LEDGER_SQL_WRITES=0");
const m = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch(() => null) as any;
if (!m || m.ledgerStore?.mode !== "lmdb" || m.sync?.halted) fail("node not answering in lmdb mode, or halted");
const next = ((m.producer?.leaderSlots ?? []) as any[]).filter((s) => s.outcome === "upcoming").map((s) => Date.parse(s.time)).sort()[0];
if (next && next - Date.now() < 45 * 60_000) fail(`leader slot at ${new Date(next).toISOString()} within 45 min`);
const dbPath = join(dir, `${node.network}.db`);
const TABLES = ["utxo", "utxo_deltas", "stake_balance", "stake", "delegations", "rewards", "stake_pointers", "pool_params", "pool_params_pending", "pool_relays", "pool_distr",
    "opcert_counters", "blocks_made_by_epoch", "genesis_delegs", "mir_pending", "reward_pots", "pot_snapshots", "epoch_stake_cred", "epoch_pool_stake", "epoch_stake_totals",
    "epoch_pool_params", "pending_rewards", "reward_epochs", "reward_payouts", "reward_pool_epochs", "gov_dreps", "gov_drep_delegations", "gov_committee", "gov_committee_auth",
    "gov_state", "gov_proposals", "gov_votes", "gov_enacted", "epoch_drep_stake", "epoch_params", "pparam_proposals", "epoch_nonces", "ledger_journal", "chain_account_state"];
const before = statSync(dbPath).size;
console.log(`${dbPath}: ${(before / 1e9).toFixed(2)} GB; emptying ${TABLES.length} ledger tables${process.argv.includes("--yes") ? "" : " (dry run: pass --yes)"}`);
if (!process.argv.includes("--yes")) process.exit(0);

const procs = () => { let sup: number | null = null, nd: number | null = null; for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue; try { const c = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" "); if (c.startsWith("bash ") && c.includes("run-supervised.sh") && c.includes(` ${port} `)) sup = Number(d); else if (c.startsWith("bun ") && c.includes("start-gerolamo") && readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`GEROLAMO_PORT=${port}`)) nd = Number(d); } catch { /* gone */ } } return { sup, nd }; };
node.relaunch = false; writeFileSync(wdPath, JSON.stringify(wd, null, 1)); // hold the watchdog off
try {
    const p = procs();
    if (p.sup) process.kill(p.sup, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (p.nd) process.kill(p.nd, "SIGTERM");
    for (let i = 0; i < 90 && procs().nd; i++) await new Promise((r) => setTimeout(r, 1000));
    if (procs().nd) throw new Error("node did not stop");
    const db = new Database(dbPath);
    const t0 = performance.now();
    const have = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => r.name));
    for (const t of TABLES) if (have.has(t)) db.exec(`DELETE FROM "${t}"`);
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.exec("INSERT OR REPLACE INTO schema_migrations (name) VALUES ('ledger_sqlite_dropped')");
    db.exec("VACUUM");
    db.close();
    console.log(`emptied and vacuumed in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${(before / 1e9).toFixed(2)} GB → ${(statSync(dbPath).size / 1e9).toFixed(2)} GB`);
} finally {
    delete node.relaunch; writeFileSync(wdPath, JSON.stringify(wd, null, 1));
    const child = spawn("setsid", ["bash", "scripts/run-supervised.sh", node.network, String(port), dir, String(node.maxRssGb ?? 14), node.logName], { cwd: wd.repo, env: { ...process.env, PLUTUS_TRACE: "0", ...node.env }, detached: true, stdio: "ignore" });
    child.unref();
    console.log(`supervisor relaunched (pid ${child.pid})`);
    spawnSync("true");
}
