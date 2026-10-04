/**
 * Guarded ledger-store cut-over for a running node (docs/PLAN_LMDB_LEDGER.md §9), meant to be run
 * unattended from a one-shot timer. Two stages:
 *
 *   lmdb        config ledgerStore dual → lmdb, restart the node (the supervisor relaunches it; the
 *               LMDB diffs reload, nothing is reseeded).
 *               Guards: node at the tip and not halted, mode is dual with 0 dual-run differences,
 *               no leader slot within --slot-margin-min (default 60).
 *   sql-off     GEROLAMO_LEDGER_SQL_WRITES=0: the watchdog config gets the variable (so any later
 *               relaunch keeps it), then the supervisor is stopped and relaunched with it.
 *               Guards: as above, plus mode lmdb for at least --min-hours (default 24) without a
 *               halt, and the ledger store not broken.
 *
 * Every refusal or action is appended to the watchdog log and sent as a desktop notification.
 * Usage: bun scripts/producer-cutover.ts <lmdb|sql-off> --port 3035 --dir <nodeDir> --watchdog-config <path>
 */
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const stage = process.argv[2];
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const port = Number(arg("port", "3035"));
const dir = arg("dir")!;
const wdPath = arg("watchdog-config", "/media/bakon/data/cardano/watchdog/config.json")!;
const margin = Number(arg("slot-margin-min", "60")) * 60_000;
const minHours = Number(arg("min-hours", "24"));
if (!["lmdb", "sql-off"].includes(stage ?? "") || !dir) { console.error("usage: bun scripts/producer-cutover.ts <lmdb|sql-off> --port <p> --dir <nodeDir>"); process.exit(2); }
const wd = JSON.parse(readFileSync(wdPath, "utf8"));
const say = (m: string, urgent = false) => {
    const line = `[${new Date().toISOString()}] CUTOVER ${stage} :${port}: ${m}`;
    console.log(line);
    try { appendFileSync(wd.logFile, line + "\n"); } catch { /* no log */ }
    try { spawnSync("notify-send", ["-a", "Gerolamo cut-over", "-u", urgent ? "critical" : "normal", `cut-over ${stage}`, m], { timeout: 5000 }); } catch { /* headless */ }
};
const refuse = (why: string) => { say(`REFUSED: ${why}`, true); process.exit(1); };

const m = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch(() => null) as any;
if (!m) refuse("node not answering /metrics");
if (m.sync?.halted) refuse(`node halted: ${m.sync.halted.reason}`);
const behind = Math.floor(Date.now() / 1000) - 1666656000 - Number(m.tipSlot);
if (behind > 300) refuse(`node ${behind} s behind the tip`);
const upcoming = ((m.producer?.leaderSlots ?? []) as Array<{ time: string; outcome: string }>).filter((s) => s.outcome === "upcoming").map((s) => Date.parse(s.time)).filter((t) => t > Date.now() - 60_000);
const nextSlot = upcoming.length ? Math.min(...upcoming) : null;
if (nextSlot != null && nextSlot - Date.now() < margin) refuse(`leader slot at ${new Date(nextSlot).toISOString()} is within ${margin / 60_000} min`);
const ls = m.ledgerStore;
const cfgPath = join(dir, "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

function nodePid(): number | null {
    for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        try {
            const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ");
            if (cmd.startsWith("bun ") && cmd.includes("start-gerolamo") && readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`GEROLAMO_PORT=${port}`)) return Number(d);
        } catch { /* gone */ }
    }
    return null;
}
function supervisorPid(): number | null {
    for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        try { const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" "); if (/^(\S*\/)?bash /.test(cmd) && cmd.includes("run-supervised.sh") && cmd.includes(` ${port} `) && cmd.includes(dir)) return Number(d); } catch { /* gone */ }
    }
    return null;
}

if (stage === "lmdb") {
    if (cfg.ledgerStore === "lmdb") { say("already lmdb; nothing to do"); process.exit(0); }
    if (ls?.mode !== "dual") refuse(`ledger mode is ${ls?.mode}, expected dual`);
    if ((ls.dual?.differences ?? 1) !== 0) refuse(`dual run shows ${ls.dual?.differences} difference(s)`);
    cfg.ledgerStore = "lmdb";
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
    const pid = nodePid();
    if (pid) process.kill(pid, "SIGTERM");
    say(`config ledgerStore → lmdb; node pid ${pid ?? "none"} restarted by its supervisor (dual run was clean: ${ls.dual.checked} keys over ${ls.dual.blocks} blocks); next leader slot ${nextSlot ? new Date(nextSlot).toISOString() : "none known"}`);
    process.exit(0);
}

// sql-off
const node = wd.nodes.find((n: any) => n.port === port);
if (!node) refuse(`no watchdog entry for port ${port}`);
if (node.env?.GEROLAMO_LEDGER_SQL_WRITES === "0") { say("already off; nothing to do"); process.exit(0); }
if (ls?.mode !== "lmdb") refuse(`ledger mode is ${ls?.mode}, expected lmdb`);
// time on lmdb: the config change is logged by stage 1; require the node's uptime or the stage-1 log line to be old enough
const logLines = readFileSync(wd.logFile, "utf8").split("\n").filter((l) => l.includes(`CUTOVER lmdb :${port}: config ledgerStore → lmdb`));
const since = logLines.length ? Date.parse(logLines[logLines.length - 1]!.slice(1, 25)) : NaN;
if (!Number.isFinite(since)) refuse("no record of the lmdb cut-over in the watchdog log");
// The clean window runs from the later of the lmdb cut-over and the node's last (re)launch: a halt that a
// restart recovered from (2026-09-29) must not block the stage for ever, but the node must then prove
// another --min-hours clean.
let launched = NaN;
try {
    const l = readFileSync(join(dir, "logs", "supervisor.log"), "utf8").trim().split("\n").reverse().find((x) => x.includes("launching") || x.includes("adopting"));
    launched = Date.parse(l?.match(/\[supervisor (\S+)\]/)?.[1] ?? "");
} catch { /* no supervisor log */ }
const cleanSince = Math.max(since, Number.isFinite(launched) ? launched : 0);
const hours = (Date.now() - cleanSince) / 3_600_000;
if (hours < minHours) refuse(`only ${hours.toFixed(1)} h clean since ${new Date(cleanSince).toISOString()} (lmdb cut-over or last relaunch; need ${minHours})`);
const halts = readFileSync(join(dir, "logs", node.logName), "utf8").split("\n").filter((l) => /SYNC HALTED|ledger store unusable|LEDGER STORE DIVERGENCE/.test(l) && Date.parse(l.match(/\w{3}, \d{2} \w{3} \d{4} [\d:]{8} GMT/)?.[0] ?? "") >= cleanSince);
if (halts.length) refuse(`${halts.length} halt/store error line(s) in the clean window, e.g. ${halts[0]!.slice(0, 160)}`);
node.env = { ...(node.env ?? {}), GEROLAMO_LEDGER_SQL_WRITES: "0" };
writeFileSync(wdPath, JSON.stringify(wd, null, 1));
const sup = supervisorPid();
if (sup) process.kill(sup, "SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
const pid = nodePid();
if (pid) process.kill(pid, "SIGTERM");
for (let i = 0; i < 60; i++) { const ss = spawnSync("ss", ["-ltnH"], { encoding: "utf8" }).stdout ?? ""; if (!new RegExp(`:${port}\\s`).test(ss)) break; await new Promise((r) => setTimeout(r, 1000)); }
const child = spawn("setsid", ["bash", "scripts/run-supervised.sh", node.network, String(port), dir, String(node.maxRssGb ?? 14), node.logName], { cwd: wd.repo, env: { ...process.env, PLUTUS_TRACE: "0", ...node.env }, detached: true, stdio: "ignore" });
child.unref();
say(`GEROLAMO_LEDGER_SQL_WRITES=0: watchdog config updated, supervisor relaunched (pid ${child.pid}) after ${hours.toFixed(1)} h clean on lmdb`);
