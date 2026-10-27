/**
 * Gerolamo node watchdog — run once a minute (systemd user timer, see scripts/watchdog/).
 *
 * For every node in the config file:
 *   - supervisor missing (reboot, crash)      → relaunch it with the node's exact command, alert
 *   - /metrics unreachable                    → alert after `unreachableAfterMin` minutes (startup grace)
 *   - sync halted                             → alert; after restartOnHaltMin (default 5, 0 = never) SIGTERM the
 *                                               node so its supervisor relaunches it (startup rolls the ledger
 *                                               store back to the newest block both stores hold), once per hour
 *   - tip behind the wall clock               → alert after `behindAlertSec` for 2 consecutive checks
 *   - producer leader slot missed / ghosted / stolen / invalid → alert once per slot
 *   - producer public relay address refusing connections (router forward target gone)
 *   - producer KES certificate: rotate soon (< 14 periods), rotate now (< 4), expired; counter off the chain's
 *   - recovery                                → "OK again" alert
 * Continuous verification against the cardano-node relay (lib/parityProbe.ts, `parity` config block):
 *   - N2C answers (the n2c-compare query set, one acquired block) differing in two consecutive runs
 *   - the producer's leader schedule differing from `cardano-cli … leadership-schedule --current`
 *   - a forged block the producer calls adopted/confirmed missing from the relay's chain, or ghosted/stolen but there
 *   The tick only reads parity-history.json and raises those; the checks run in scripts/parity-probe.ts, started
 *   detached (lock file) when one is due: every 30 min, after each epoch boundary, once per epoch and producer restart.
 * For every `processes` entry (e.g. the local cardano-node relay): not listening and not running →
 * relaunch it with its exact argv, alert; running but not listening past its startup grace → alert.
 * Alerts: desktop notification (notify-send), an optional push to an ntfy topic (phone), and a line in
 * the watchdog log. Each problem alerts when it appears, again every `repeatMin` minutes while it lasts.
 *
 * Usage: bun scripts/watchdog.ts <config.json>        (one pass; the timer provides the loop)
 *        bun scripts/watchdog.ts <config.json> --test (send a test alert through every channel)
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ParityConfig } from "./lib/parityProbe";

interface NodeSpec {
    name: string;              // label in alerts, e.g. "preview producer"
    network: "preview" | "preprod" | "mainnet";
    port: number;              // the node's --port (HTTP /metrics)
    dir: string;               // node directory (run-supervised.sh <datadir>)
    maxRssGb?: number;         // run-supervised.sh max_rss_gb (default 14)
    logName: string;           // run-supervised.sh logfile name
    flags?: string[];          // extra node flags passed through the supervisor (e.g. ["--no-ledger-sql-writes"]); the node reads no environment
    producer?: boolean;        // watch leader-slot outcomes
    relaunch?: boolean;        // relaunch the supervisor when it is missing (default true)
    restartOnHaltMin?: number; // SIGTERM the node after this long halted (default 5; 0 = never)
    restartOnStallMin?: number; // not catchingUp: SIGTERM after the tip is frozen this long while behind (default 30; 0 = never)
    catchingUp?: boolean;      // a node syncing history (e.g. from genesis): no "behind" alert; alert when its tip stops advancing instead
    stallMin?: number;         // catchingUp: tip unchanged this long → "stalled" alert (default 15)
    parity?: boolean;          // continuous verification against the relay (default true when it has an N2C socket)
    n2cSocketPath?: string;    // default: the node's <dir>/config.json n2cSocketPath
    vrfSkeyFile?: string;      // producer: default <dir>/config.json producer.vrfSkeyFile (a path for cardano-cli only)
}
/** A non-Gerolamo process to keep alive (e.g. the local cardano-node relay): judged by its listening TCP port. */
interface ProcessSpec {
    name: string;
    port: number;              // TCP port it listens on once up
    cwd: string;
    cmd: string[];             // argv
    logFile: string;           // stdout/stderr appended here
    startupGraceMin?: number;  // no "down" verdict this long after a relaunch (chunk validation, ledger replay); default 60
}
interface Config {
    repo: string;              // gerolamo checkout (run-supervised.sh lives in scripts/)
    stateFile: string;         // watchdog memory between passes
    logFile: string;
    ntfyUrl?: string;          // e.g. https://ntfy.sh/<secret-topic>
    behindAlertSec?: number;   // default 300
    unreachableAfterMin?: number; // default 10
    repeatMin?: number;        // default 30
    nodes: NodeSpec[];
    processes?: ProcessSpec[];
    parity?: ParityConfig;     // see lib/parityProbe.ts and watchdog/README.md; on by default
}
interface State { haltRestarts?: Record<string, number>; progress?: Record<string, { slot: number; at: number }>; problems: Record<string, { since: number; lastAlert: number; text: string }>; slotsSeen: Record<string, string>; strikes: Record<string, number>; launchedAt?: Record<string, number> }

const cfgPath = process.argv[2];
if (!cfgPath) { console.error("usage: bun scripts/watchdog.ts <config.json> [--test]"); process.exit(2); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
const behindAlert = cfg.behindAlertSec ?? 300, unreachableAfter = (cfg.unreachableAfterMin ?? 10) * 60_000, repeat = (cfg.repeatMin ?? 30) * 60_000;
const ntfy = cfg.ntfyUrl;
const now = Date.now();
mkdirSync(dirname(cfg.logFile), { recursive: true });
const log = (m: string) => appendFileSync(cfg.logFile, `[${new Date().toISOString()}] ${m}\n`);

function notify(title: string, body: string, urgent: boolean): void {
    log(`ALERT ${title}: ${body}`);
    try { spawnSync("notify-send", ["-a", "Gerolamo watchdog", "-u", urgent ? "critical" : "normal", title, body], { timeout: 5000 }); } catch { /* no desktop session */ }
    if (ntfy) {
        try { spawnSync("curl", ["-s", "-m", "10", "-H", `Title: ${title}`, "-H", `Priority: ${urgent ? "urgent" : "default"}`, "-d", body, ntfy], { timeout: 15000 }); } catch { /* offline */ }
    }
}

if (process.argv.includes("--test")) { notify("Gerolamo watchdog test", `Alerts reach you through this channel (${new Date().toISOString()}).`, false); process.exit(0); }

const state: State = existsSync(cfg.stateFile) ? JSON.parse(readFileSync(cfg.stateFile, "utf8")) : { problems: {}, slotsSeen: {}, strikes: {} };
state.strikes ??= {};
const seenNow = new Set<string>();

function problem(key: string, title: string, text: string, urgent = true): void {
    seenNow.add(key);
    const p = state.problems[key];
    if (!p) { state.problems[key] = { since: now, lastAlert: now, text }; notify(title, text, urgent); return; }
    if (now - p.lastAlert >= repeat) { p.lastAlert = now; p.text = text; notify(`${title} (still, since ${new Date(p.since).toISOString().slice(11, 16)} UTC)`, text, urgent); }
}

/** Wall-clock slot of each network (Shelley-era slot arithmetic; preprod and mainnet start after a Byron era of 20 s slots). */
function wallSlot(net: NodeSpec["network"]): number {
    const t = Math.floor(now / 1000);
    if (net === "preview") return t - 1666656000;
    if (net === "preprod") return 86400 + (t - 1655769600);
    return 4492800 + (t - 1596059091);
}

/** pids of a node's supervisor and node process (by cmdline: `start-gerolamo ... --port <port>`; GEROLAMO_PORT in the environment for a node started before 2026-10-26). */
function findProcs(n: NodeSpec): { supervisor: number | null; node: number | null } {
    let supervisor: number | null = null, node: number | null = null;
    for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        let cmd = "";
        try { cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" "); } catch { continue; }
        if (/^(\S*\/)?bash /.test(cmd) && cmd.includes("run-supervised.sh") && cmd.includes(` ${n.port} `) && cmd.includes(n.dir)) supervisor = Number(d);
        else if (cmd.startsWith("bun ") && cmd.includes("start-gerolamo")) {
            if (new RegExp(`--port ${n.port}( |$)`).test(cmd)) node = Number(d);
            else try { if (readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`GEROLAMO_PORT=${n.port}`)) node = Number(d); } catch { /* not ours */ }
        }
    }
    return { supervisor, node };
}

function relaunch(n: NodeSpec): void {
    const args = ["bash", "scripts/run-supervised.sh", n.network, String(n.port), n.dir, String(n.maxRssGb ?? 14), n.logName, ...(n.flags?.length ? ["--", ...n.flags] : [])];
    const child = spawn("setsid", args, { cwd: cfg.repo, detached: true, stdio: "ignore" });
    child.unref();
    log(`relaunched supervisor for ${n.name} (pid ${child.pid})`);
}

/** Minutes since the supervisor last launched the node (startup grace for /metrics). */
function minutesSinceLaunch(n: NodeSpec): number {
    try {
        const lines = readFileSync(join(n.dir, "logs", "supervisor.log"), "utf8").trim().split("\n").reverse();
        const l = lines.find((x) => x.includes("launching") || x.includes("adopting"));
        const m = l?.match(/\[supervisor (\S+)\]/);
        if (m) return (now - Date.parse(m[1]!)) / 60_000;
    } catch { /* no log */ }
    return Infinity;
}

async function metrics(port: number): Promise<any | null> {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(20_000) });
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

const metricsByNode: Record<string, any | null> = {};
for (const n of cfg.nodes) {
    const tag = n.name;
    metricsByNode[tag] = null;
    const procs = findProcs(n);
    if (!procs.supervisor) {
        if (n.relaunch !== false) {
            if (procs.node) log(`${tag}: supervisor missing but node pid ${procs.node} runs; the relaunched supervisor adopts it`);
            relaunch(n);
            notify(`${tag}: supervisor was down`, `Relaunched run-supervised.sh for :${n.port} (${n.dir}). Probable cause: reboot or the supervisor was killed.`, true);
        } else problem(`${tag}:supervisor`, `${tag}: supervisor not running`, `No run-supervised.sh for :${n.port}; relaunch is disabled for this node.`);
        continue; // give the relaunch a minute before judging the node
    }
    const m = await metrics(n.port);
    metricsByNode[tag] = m;
    if (!m) {
        const since = minutesSinceLaunch(n);
        if (since * 60_000 >= unreachableAfter) problem(`${tag}:unreachable`, `${tag}: not answering`, `/metrics on :${n.port} has not answered; last launch ${since === Infinity ? "unknown" : `${since.toFixed(0)} min ago`}. Node pid ${procs.node ?? "none"}.`);
        continue;
    }
    const halted = m.sync?.halted;
    if (halted) {
        problem(`${tag}:halted`, `${tag}: SYNC HALTED`, `At slot ${halted.slot}: ${String(halted.reason ?? "").slice(0, 300)}`);
        // A halted producer forges nothing (2026-09-29: 8 h 40 min halted on a fork-switch race, two leader slots
        // lost). The restart is the designed recovery; the supervisor relaunches the node.
        const after = (n.restartOnHaltMin ?? 5) * 60_000;
        const haltedFor = now - Number(halted.since ?? state.problems[`${tag}:halted`]?.since ?? now);
        const last = (state.haltRestarts ?? {})[tag] ?? 0;
        if (after > 0 && haltedFor >= after && now - last >= 3_600_000 && procs.node) {
            state.haltRestarts = { ...(state.haltRestarts ?? {}), [tag]: now };
            try { process.kill(procs.node, "SIGTERM"); } catch { /* gone already */ }
            log(`${tag}: halted ${Math.round(haltedFor / 60_000)} min; SIGTERM to node pid ${procs.node} (supervisor relaunches)`);
            notify(`${tag}: restarted after halt`, `Halted ${Math.round(haltedFor / 60_000)} min at slot ${halted.slot}: ${String(halted.reason ?? "").slice(0, 200)}. Node pid ${procs.node} got SIGTERM; the supervisor relaunches it.`, true);
            continue;
        }
    }
    const ls = m.ledgerStore;
    const behind = wallSlot(n.network) - Number(m.tipSlot ?? 0);
    const sk = `${tag}:behind`;
    if (n.catchingUp) {
        // 2026-10-04: node 3037 (preview from genesis) sat stalled for 20 h on a bad stored nonce and nothing said so.
        const tip = Number(m.tipSlot ?? 0), pg = (state.progress ??= {});
        const last = pg[tag];
        if (!last || tip > last.slot) pg[tag] = { slot: tip, at: now };
        else if (!halted && now - last.at >= (n.stallMin ?? 15) * 60_000) problem(`${tag}:stalled`, `${tag}: sync stalled`, `Tip slot ${tip} unchanged for ${Math.round((now - last.at) / 60_000)} min (${behind} s behind the wall clock).`, true);
    } else if (behind > behindAlert && !halted) {
        state.strikes[sk] = (state.strikes[sk] ?? 0) + 1;
        if (state.strikes[sk]! >= 2) problem(sk, `${tag}: ${Math.round(behind / 60)} min behind`, `Tip slot ${m.tipSlot}, ${behind} s behind the wall clock; ${m.sync?.blocksPerSec ?? 0} blocks/s, ${m.peers?.hot ?? 0} hot peers${ls ? `, ledger ${ls.mode} ${ls.volatileBlocks} diffs` : ""}.`, behind > 1800);
        // 2026-10-13 (bug 395): 3037 sat frozen at a tip for 5 h with a dead "hot" session and no halt; alerts only.
        // A frozen tip far behind the wall clock gets the same recovery as a halt: SIGTERM, the supervisor relaunches.
        const tip = Number(m.tipSlot ?? 0), pg = (state.progress ??= {});
        if (!pg[tag] || tip !== pg[tag]!.slot) pg[tag] = { slot: tip, at: now };
        const stallAfter = (n.restartOnStallMin ?? 30) * 60_000;
        const lastRestart = (state.haltRestarts ?? {})[tag] ?? 0;
        if (stallAfter > 0 && now - pg[tag]!.at >= stallAfter && now - lastRestart >= 3_600_000 && procs.node) {
            state.haltRestarts = { ...(state.haltRestarts ?? {}), [tag]: now };
            try { process.kill(procs.node, "SIGTERM"); } catch { /* gone already */ }
            log(`${tag}: tip ${tip} frozen ${Math.round((now - pg[tag]!.at) / 60_000)} min, ${behind} s behind; SIGTERM to node pid ${procs.node} (supervisor relaunches)`);
            notify(`${tag}: restarted after a frozen tip`, `Tip slot ${tip} unchanged for ${Math.round((now - pg[tag]!.at) / 60_000)} min, ${behind} s behind the wall clock, not halted. Node pid ${procs.node} got SIGTERM; the supervisor relaunches it.`, true);
            continue;
        }
    } else state.strikes[sk] = 0;
    const pr = m.inbound?.publicReachable;
    if (n.producer && pr && pr.ok === false) {
        problem(`${tag}:public`, `${tag}: public port unreachable`, `${pr.address} refuses connections from outside (${pr.error ?? "?"}): peers cannot pull our blocks except through a local relay. Usual cause: the machine the router forwards to lost that address (dock / USB Ethernet unplugged, DHCP change).`);
    }
    const kes = m.producer?.kes;
    if (n.producer && kes?.health && kes.health !== "ok") {
        const urgent = kes.health !== "rotate-soon";
        problem(`${tag}:kes`, `${tag}: KES ${kes.health === "rotate-soon" ? "rotate soon" : kes.health === "rotate-now" ? "ROTATE NOW" : kes.health === "expired" ? "EXPIRED" : "certificate not valid yet"}`,
            `${kes.remaining} of ${kes.maxEvolutions} KES periods left, certificate expires ${kes.expiresAt}. Rotate: bun scripts/pool-register.ts rotate-kes --dir <pool keys>, copy kes.skey/kes.vkey/node.cert to the producer, then send the node SIGHUP (kill -HUP <node pid>; pid ${procs.node ?? "?"}) — it reloads them without a restart and keeps the old pair if the new one fails its checks.`, urgent);
    }
    if (n.producer && kes?.counter && kes.counter !== "ok" && kes.counter !== "unknown") {
        problem(`${tag}:opcert`, `${tag}: operational certificate counter wrong`, `Disk counter ${m.producer.opcert?.counter} vs chain ${m.producer.opcert?.chainCounter} (${kes.counter}): headers need the chain's counter or one above; blocks will be rejected.`);
    }
    if (n.producer && Array.isArray(m.producer?.leaderSlots)) {
        for (const s of m.producer.leaderSlots as Array<{ slot: string; time: string; outcome: string; note?: string }>) {
            const prev = state.slotsSeen[`${tag}:${s.slot}`];
            if (prev === s.outcome) continue;
            state.slotsSeen[`${tag}:${s.slot}`] = s.outcome;
            if (["missed", "ghosted", "stolen", "invalid"].includes(s.outcome)) notify(`${tag}: leader slot ${s.outcome}`, `Slot ${s.slot} (${s.time}): ${s.note ?? ""}`, true);
            else if (s.outcome === "adopted" && prev === "upcoming") log(`${tag}: forged slot ${s.slot} (${s.time})`);
        }
    }
    log(`${tag}: tip ${m.tipSlot} behind ${behind}s${halted ? " HALTED" : ""}${ls ? ` ledger ${ls.mode} diffs ${ls.volatileBlocks}` : ""}`);
}

// ── other processes (local cardano-node relay …) ──
state.launchedAt ??= {};
const listening = (() => { try { return spawnSync("ss", ["-ltnH"], { encoding: "utf8", timeout: 5000 }).stdout ?? ""; } catch { return ""; } })();
function cmdRunning(ps: ProcessSpec): boolean {
    const needle = ps.cmd.join(" ");
    for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        try { if (readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ").trim() === needle) return true; } catch { /* gone */ }
    }
    return false;
}
for (const ps of cfg.processes ?? []) {
    const up = new RegExp(`:${ps.port}\\s`).test(listening);
    if (up) { log(`${ps.name}: listening on :${ps.port}`); continue; }
    if (cmdRunning(ps)) {
        const since = (now - (state.launchedAt[ps.name] ?? 0)) / 60_000;
        if (since >= (ps.startupGraceMin ?? 60)) problem(`${ps.name}:unreachable`, `${ps.name}: not listening`, `Process runs but :${ps.port} is not open ${since === Infinity ? "" : `${since.toFixed(0)} min after launch`}.`);
        else log(`${ps.name}: starting (${since.toFixed(0)} min since launch)`);
        continue;
    }
    const fd = openSync(ps.logFile, "a");
    const child = spawn("setsid", ps.cmd, { cwd: ps.cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    state.launchedAt[ps.name] = now;
    notify(`${ps.name}: was down`, `Relaunched (${ps.cmd[0]} …, pid ${child.pid}); log ${ps.logFile}.`, true);
}

// ── continuous verification (alerts from parity-history.json; the probe itself runs detached) ──
try {
    const { parityTick } = await import("./lib/parityProbe");
    const r = parityTick(cfg as any, cfgPath, metricsByNode, now, log);
    for (const a of r.alerts) problem(a.key, a.title, a.text, a.urgent);
} catch (e) {
    // an unreadable history must not read as "all clear": keep the parity problems open
    log(`parity: ${(e as Error).message}`);
    for (const k of Object.keys(state.problems)) if (/:(parity|parity-probe|schedule|schedule-check|forge-\d+)$/.test(k)) seenNow.add(k);
}

// problems that cleared
for (const [key, p] of Object.entries(state.problems)) {
    if (seenNow.has(key)) continue;
    delete state.problems[key];
    notify(`${key.split(":")[0]}: OK again`, `${key.split(":")[1]} cleared after ${Math.round((now - p.since) / 60_000)} min (was: ${p.text.slice(0, 160)})`, false);
}
// forget slot outcomes older than ~10 days of entries
const slotKeys = Object.keys(state.slotsSeen);
if (slotKeys.length > 400) for (const k of slotKeys.slice(0, slotKeys.length - 400)) delete state.slotsSeen[k];
writeFileSync(cfg.stateFile, JSON.stringify(state));
