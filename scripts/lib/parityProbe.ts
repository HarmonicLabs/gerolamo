/**
 * Continuous verification of the Gerolamo nodes against the local cardano-node relay, for the
 * watchdog (scripts/watchdog.ts). Three checks:
 *   parity   — the n2c-compare query set (lib/n2cCompare.ts) on a node's N2C socket and the relay's,
 *              both acquired at one block; every `intervalMin` and, after each epoch boundary,
 *              again until one run has acquired a block of the new epoch.
 *   schedule — the producer's leader slots for the current epoch against
 *              `cardano-cli conway query leadership-schedule --current` on the relay socket (the key
 *              is passed to cardano-cli as a path; nothing here opens it); once per epoch and again
 *              after each producer restart. Every tick then compares the producer's live schedule
 *              with that answer, so a schedule recomputed mid-epoch is checked before its slots.
 *   forge    — each forged block whose outcome the producer has settled (adopted/confirmed vs
 *              ghosted/stolen) against the relay's chain: ChainSync FindIntersect at our block.
 * The watchdog tick (parityTick) never talks to a node: it reads the history file, raises problems
 * from it, and spawns scripts/parity-probe.ts detached when a check is due. The probe does the
 * network work under a lock file and replaces the history file atomically.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Cbor, CborArray, CborBytes, CborUInt } from "@harmoniclabs/cbor";
import { openLsq, type LsqClient } from "./lsq";
import { openN2c } from "./n2c";
import { DEFAULT_OWNER_CRED, DEFAULT_POOL, U, acquireShared, buildQuerySet, compareQueries, currentEra, ledger, type QueryResult } from "./n2cCompare";
import { epochForSlot, firstSlotOfEpoch, slotToUnixTime } from "../../src/utils/epochFromSlotCalculations";
import { slotAt } from "../../src/pool/slotClock";

export type Net = "preview" | "preprod" | "mainnet";
export const MAGIC: Record<Net, number> = { preview: 2, preprod: 1, mainnet: 764824073 };

/** The watchdog `parity` block; every key optional. */
export interface ParityConfig {
    enabled?: boolean;            // default true: every node with an N2C socket and a relay of its network
    intervalMin?: number;         // parity run cadence per node (30)
    boundaryDelayMin?: number;    // first post-boundary run this long after the epoch starts (3)
    boundaryWindowMin?: number;   // …retried every retryMin until a run acquired a block of the new epoch, this long (30)
    retryMin?: number;            // minimum gap between parity attempts on a node (3)
    huge?: boolean;               // add GetUTxOWhole, DebugEpochState, DebugNewEpochState (hundreds of MB): false
    extra?: boolean;              // add DebugLedgerConfig, GetNonMyopicMemberRewards(set), GetRewardInfoPools (61 → 64; needs the pool-ranking seed, bug 262): false
    skip?: string[];              // query-name substrings left out
    pools?: string[];             // pool ids for the pool queries (default: the producers' pool ids)
    ownerCred?: string;           // stake key hash for the account and UTxO queries (default: our pool's reward account)
    quietSec?: number;            // no queries on a producer this close to its next leader slot (180)
    maxLagSec?: number;           // no parity run while the node's tip is further behind the wall clock (600): the "behind" alert covers it
    historyRuns?: number;         // runs kept per node (48)
    detailRuns?: number;          // newest runs that keep every query's result, older keep only the differences (4)
    maxRuntimeMin?: number;       // the probe exits after this long whatever it is doing (15)
    leaderSchedule?: boolean;     // the schedule check on producer nodes (true)
    scheduleRetryMin?: number;    // after a failed schedule check (15)
    postForge?: boolean;          // the forge check on producer nodes (true)
    forgeSettleSec?: number;      // judge a forged block once the relay's tip is this far past it (900)
    forgeWindowHours?: number;    // re-check forged blocks this recent (36)
    cardanoCli?: string;          // default: cardano-cli next to the relay's cardano-node binary
    relays?: Partial<Record<Net, RelaySpec>>; // default: the `processes` entry of that network with --socket-path
    historyFile?: string; lockFile?: string; logFile?: string; // default: next to the watchdog state file
}
export interface RelaySpec { socket?: string; cardanoCli?: string; shelleyGenesis?: string }
export interface ParityNodeSpec { name: string; network: Net; port: number; dir: string; producer?: boolean; parity?: boolean; n2cSocketPath?: string; vrfSkeyFile?: string }
export interface ParityHostConfig { stateFile: string; logFile: string; nodes: ParityNodeSpec[]; processes?: Array<{ name: string; cwd: string; cmd: string[] }>; parity?: ParityConfig }

export const PARITY_DEFAULTS = {
    intervalMin: 30, boundaryDelayMin: 3, boundaryWindowMin: 30, retryMin: 3, quietSec: 180, maxLagSec: 600, historyRuns: 48, detailRuns: 4,
    maxRuntimeMin: 15, scheduleRetryMin: 15, forgeSettleSec: 900, forgeWindowHours: 36,
};
type Opts = typeof PARITY_DEFAULTS & ParityConfig;
const opts = (pc: ParityConfig = {}): Opts => ({ ...PARITY_DEFAULTS, ...Object.fromEntries(Object.entries(pc).filter(([, v]) => v != null)) }) as Opts;

export interface ParityTarget {
    name: string; network: Net; port: number; producer: boolean;
    socket: string; magic: number;
    relay: { socket: string; cardanoCli: string };
    vrfSkeyFile: string | null; // a path only: handed to cardano-cli, never opened here
}

/** Subset of a node's /metrics the checks read. */
export interface NodeMetrics {
    tipSlot?: number | string; uptimeSec?: number;
    producer?: {
        poolId?: string; scheduledEpochs?: number[]; nextLeaderSlot?: string | null;
        leaderSlots?: Array<{ slot: string; time?: string; epoch: number; outcome: string; hash: string | null }>;
    };
}

// ---------------------------------------------------------------------------------------- history
export interface StoredResult { name: string; same: boolean; ours: number; ref: number; firstDiff?: number; err?: string }
export interface ParityRun {
    at: number; ms: number;
    point: string | null; pointSlot: number | null; epoch: number | null; shared: boolean;
    total: number; same: number;
    diffs: StoredResult[];          // the differing (or failed) queries, kept for every run
    results?: StoredResult[];       // every query, newest `detailRuns` runs only
    error?: string;                 // the run did not complete (connection, acquire)
}
export interface ScheduleCheck {
    at: number; epoch: number; producerStartedAt: number; ms?: number;
    ref: number[] | null;           // cardano-cli's slots (null: no successful answer for this epoch yet)
    ours: number[];                 // the producer's slots at check time
    error?: string; failures: number;
}
export interface ForgeCheck { at: number; slot: number; hash: string; outcome: string; relayTip: number; onRelay: boolean; verdict: "agree" | "disagree" | "pending" }
export interface NodeHistory { runs: ParityRun[]; lastAttempt?: number; schedule?: ScheduleCheck; forge?: Record<string, ForgeCheck> }
export interface ParityHistory { version: 1; updatedAt: number; nodes: Record<string, NodeHistory> }

/** The history; empty when there is none yet. Throws on an unreadable file (the tick then keeps its problems). */
export function readHistory(path: string): ParityHistory {
    if (!existsSync(path)) return { version: 1, updatedAt: 0, nodes: {} };
    const h = JSON.parse(readFileSync(path, "utf8")) as ParityHistory;
    if (h?.version !== 1 || typeof h.nodes !== "object") throw new Error(`${path}: not a parity history`);
    return h;
}
/** Replace the file atomically: the watchdog tick may read it at any moment. */
export function writeHistory(path: string, h: ParityHistory): void {
    h.updatedAt = Date.now();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(h));
    renameSync(tmp, path);
}
export function recordRun(nh: NodeHistory, run: ParityRun, pc: ParityConfig = {}): void {
    const o = opts(pc);
    nh.runs.push(run);
    while (nh.runs.length > o.historyRuns) nh.runs.shift();
    nh.runs.forEach((r, i) => { if (i < nh.runs.length - o.detailRuns) delete r.results; });
}

export function parityPaths(cfg: ParityHostConfig): { history: string; lock: string; log: string } {
    const d = dirname(cfg.stateFile), p = cfg.parity ?? {};
    return { history: p.historyFile ?? join(d, "parity-history.json"), lock: p.lockFile ?? join(d, "parity.lock"), log: p.logFile ?? join(d, "parity.log") };
}

// ------------------------------------------------------------------------------- targets, relays
function processFor(cfg: ParityHostConfig, net: Net) {
    return (cfg.processes ?? []).find((p) => p.cmd.includes("--socket-path") && `${p.name} ${p.cmd.join(" ")}`.includes(net));
}
function processArg(p: { cwd: string; cmd: string[] } | undefined, flag: string): string | undefined {
    if (!p) return undefined;
    const i = p.cmd.indexOf(flag);
    return i >= 0 && p.cmd[i + 1] ? resolve(p.cwd, p.cmd[i + 1]!) : undefined;
}
/** The relay of a network: `parity.relays[net]`, else the `processes` entry for that network (its --socket-path, its cardano-cli). */
export function resolveRelay(cfg: ParityHostConfig, net: Net): { socket: string; cardanoCli: string } | null {
    const ex = cfg.parity?.relays?.[net] ?? {}, ps = processFor(cfg, net);
    const socket = ex.socket ?? processArg(ps, "--socket-path");
    if (!socket) return null;
    const cardanoCli = ex.cardanoCli ?? cfg.parity?.cardanoCli ?? (ps ? join(dirname(resolve(ps.cwd, ps.cmd[0]!)), "cardano-cli") : "cardano-cli");
    return { socket, cardanoCli };
}
/** The Shelley genesis cardano-cli needs: `parity.relays[net].shelleyGenesis`, else the relay's own (its --config's ShelleyGenesisFile). */
export function shelleyGenesisOf(cfg: ParityHostConfig, net: Net): string | null {
    const ex = cfg.parity?.relays?.[net]?.shelleyGenesis;
    if (ex) return ex;
    const c = processArg(processFor(cfg, net), "--config");
    if (!c) return null;
    try { const f = JSON.parse(readFileSync(c, "utf8")).ShelleyGenesisFile; return f ? resolve(dirname(c), f) : null; } catch { return null; }
}
/** Nodes to verify: an N2C socket (the spec's n2cSocketPath, else the node's config.json) and a relay of the same network. */
export function resolveTargets(cfg: ParityHostConfig): ParityTarget[] {
    if (cfg.parity?.enabled === false) return [];
    const out: ParityTarget[] = [];
    for (const n of cfg.nodes) {
        if (n.parity === false) continue;
        let nodeCfg: any = {};
        try { nodeCfg = JSON.parse(readFileSync(join(n.dir, "config.json"), "utf8")); } catch { /* no config: the spec must name the socket */ }
        const sock = n.n2cSocketPath ?? nodeCfg.n2cSocketPath;
        const relay = resolveRelay(cfg, n.network);
        if (!sock || !relay || !(n.network in MAGIC)) continue;
        const vrf = n.producer ? (n.vrfSkeyFile ?? nodeCfg.producer?.vrfSkeyFile ?? null) : null;
        out.push({ name: n.name, network: n.network, port: n.port, producer: !!n.producer, socket: resolve(n.dir, sock), magic: MAGIC[n.network], relay, vrfSkeyFile: vrf ? resolve(n.dir, vrf) : null });
    }
    return out;
}

// --------------------------------------------------------------------------------- slot geometry
/** The wall-clock epoch of a network (its own geometry: never the address-network flag). */
export function epochNow(net: Net, now: number): { epoch: number; startSlot: number; startMs: number; wallSlot: number } {
    const wall = slotAt(now, net), epoch = epochForSlot(wall, net), start = firstSlotOfEpoch(epoch, net);
    return { epoch: Number(epoch), startSlot: Number(start), startMs: slotToUnixTime(start, net) * 1000, wallSlot: Number(wall) };
}
export const producerStartedAt = (m: NodeMetrics, now: number) => now - Math.round(Number(m.uptimeSec ?? 0)) * 1000;
/** The producer's leader slots of an epoch, as /metrics reports them. */
export function producerSlots(m: NodeMetrics, epoch: number): number[] {
    return (m.producer?.leaderSlots ?? []).filter((s) => Number(s.epoch) === epoch).map((s) => Number(s.slot)).sort((a, b) => a - b);
}
export function diffSlots(ref: number[], ours: number[]): { missing: number[]; extra: number[] } {
    const r = new Set(ref), o = new Set(ours);
    return { missing: ref.filter((s) => !o.has(s)), extra: ours.filter((s) => !r.has(s)) };
}
const FORGED = new Set(["adopted", "confirmed", "ghosted", "stolen"]);
/** Forged blocks old enough to judge and recent enough to re-check. */
export function forgeCandidates(m: NodeMetrics, net: Net, now: number, pc: ParityConfig = {}): Array<{ slot: number; hash: string; outcome: string }> {
    const o = opts(pc), wall = epochNow(net, now).wallSlot;
    return (m.producer?.leaderSlots ?? [])
        .filter((s) => s.hash && FORGED.has(s.outcome) && Number(s.slot) + o.forgeSettleSec <= wall && Number(s.slot) >= wall - o.forgeWindowHours * 3600)
        .map((s) => ({ slot: Number(s.slot), hash: s.hash!, outcome: s.outcome }));
}
/** The producer's verdict against the relay's chain: adopted/confirmed claim the block is on the chain, ghosted/stolen that it is not. */
export function judgeForge(outcome: string, onRelay: boolean, relayTip: number, slot: number, settleSec: number): ForgeCheck["verdict"] {
    if (relayTip < slot + settleSec) return "pending";
    return (outcome === "adopted" || outcome === "confirmed") === onRelay ? "agree" : "disagree";
}

// ------------------------------------------------------------------------------- what is due now
export interface Due { parity: boolean; schedule: boolean; forge: boolean; why: string[] }
export function dueFor(t: ParityTarget, h: NodeHistory | undefined, m: NodeMetrics | null, pc: ParityConfig = {}, now = Date.now()): Due {
    const o = opts(pc), why: string[] = [], runs = h?.runs ?? [], last = runs[runs.length - 1], ep = epochNow(t.network, now);
    let parity = false;
    // a node still catching up cannot be on the relay's block: own-tip answers would differ for the lag alone
    const lagging = m?.tipSlot != null && ep.wallSlot - Number(m.tipSlot) > o.maxLagSec;
    if (!lagging && now - (h?.lastAttempt ?? 0) >= o.retryMin * 60_000) {
        if (!last || now - last.at >= o.intervalMin * 60_000) { parity = true; why.push("interval"); }
        // a boundary-written state (snapshots, pulser, rewards) must be compared soon after the boundary
        const crossed = runs.some((r) => !r.error && r.pointSlot != null && r.pointSlot >= ep.startSlot);
        if (!crossed && now >= ep.startMs + o.boundaryDelayMin * 60_000 && now < ep.startMs + o.boundaryWindowMin * 60_000) { parity = true; why.push(`epoch ${ep.epoch} boundary`); }
    }
    let schedule = false;
    if (t.producer && o.leaderSchedule !== false && t.vrfSkeyFile && m?.producer && m.tipSlot != null) {
        const tipEpoch = Number(epochForSlot(BigInt(m.tipSlot), t.network)), s = h?.schedule;
        if (tipEpoch === ep.epoch && (m.producer.scheduledEpochs ?? []).includes(ep.epoch)) {
            if (!s || s.epoch !== ep.epoch) { schedule = true; why.push(`schedule of epoch ${ep.epoch}`); }
            else if (s.error && now - s.at >= o.scheduleRetryMin * 60_000) { schedule = true; why.push("schedule retry"); }
            else if (producerStartedAt(m, now) > s.producerStartedAt + 120_000) { schedule = true; why.push("schedule after a producer restart"); }
        }
    }
    let forge = false;
    if (t.producer && o.postForge !== false && m?.producer) {
        for (const c of forgeCandidates(m, t.network, now, pc)) {
            const prev = h?.forge?.[String(c.slot)];
            if (!prev || prev.outcome !== c.outcome || prev.hash !== c.hash
                || (prev.verdict !== "agree" && now - prev.at >= o.retryMin * 60_000) || now - prev.at >= o.intervalMin * 60_000) { forge = true; why.push(`forged slot ${c.slot}`); break; }
        }
    }
    return { parity, schedule, forge, why };
}

// ------------------------------------------------------------------------------ alerts (the tick)
export interface ParityAlert { key: string; title: string; text: string; urgent: boolean }
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
/** Problems the history shows for one node; the watchdog raises them (and says "OK again" once they are gone). */
export function evaluate(t: ParityTarget, h: NodeHistory | undefined, m: NodeMetrics | null, pc: ParityConfig = {}, now = Date.now(), historyPath = "parity-history.json"): ParityAlert[] {
    const o = opts(pc), out: ParityAlert[] = [];
    if (!h) return out;
    // 1. a difference in two consecutive completed runs (one alone can be a race at the tip)
    const done = h.runs.filter((r) => !r.error);
    if (done.length >= 2) {
        const [a, b] = done.slice(-2) as [ParityRun, ParityRun];
        const both = b.diffs.filter((d) => a.diffs.some((x) => x.name === d.name));
        if (both.length) out.push({
            key: `${t.name}:parity`, title: `${t.name}: ${both.length} N2C answer${both.length > 1 ? "s differ" : " differs"} from cardano-node`, urgent: true,
            text: `In two consecutive probe runs (${hhmm(a.at)} and ${hhmm(b.at)} UTC; the last at ${b.point ? b.point.slice(0, 26) : "?"}${b.shared ? ", one block on both sides" : ", own tips"}): `
                + both.map((d) => d.err ? `${d.name} (error: ${d.err})` : `${d.name} (ours ${d.ours} B, relay ${d.ref} B, first difference at byte ${d.firstDiff})`).join("; ")
                + `. History: ${historyPath}; reproduce: bun scripts/n2c-compare.ts --ours ${t.socket} --ref ${t.relay.socket} --only <name>.`,
        });
    }
    const last2 = h.runs.slice(-2), last = h.runs[h.runs.length - 1];
    if (last2.length === 2 && last2.every((r) => r.error)) out.push({ key: `${t.name}:parity-probe`, title: `${t.name}: parity probe failing`, text: `The last two runs failed (${hhmm(last2[0]!.at)}, ${hhmm(last2[1]!.at)} UTC): ${last2[1]!.error}`, urgent: false });
    // stale: not while the node is down or catching up (the probe skips it then; "unreachable"/"behind" alert instead)
    else if (last && m && !(m.tipSlot != null && epochNow(t.network, now).wallSlot - Number(m.tipSlot) > o.maxLagSec) && now - last.at > Math.max(3 * o.intervalMin, 120) * 60_000) out.push({ key: `${t.name}:parity-probe`, title: `${t.name}: parity probe not running`, text: `No parity run since ${new Date(last.at).toISOString().slice(0, 16)} UTC (lock ${o.lockFile ?? "parity.lock"}, log ${o.logFile ?? "parity.log"} next to the watchdog state).`, urgent: false });
    // 2. the leader schedule, against cardano-cli's answer for this epoch (live producer slots when /metrics answers)
    const s = h.schedule, ep = epochNow(t.network, now);
    if (s && s.epoch === ep.epoch) {
        if (s.ref) {
            const ours = m?.producer && (m.producer.scheduledEpochs ?? []).includes(s.epoch) ? producerSlots(m, s.epoch) : s.ours;
            const { missing, extra } = diffSlots(s.ref, ours);
            if (missing.length || extra.length) out.push({
                key: `${t.name}:schedule`, title: `${t.name}: leader schedule differs from cardano-node`, urgent: true,
                text: `Epoch ${s.epoch}: cardano-cli leadership-schedule on the relay has ${s.ref.length} slot(s), the producer ${ours.length}.`
                    + (missing.length ? ` Only cardano-cli: ${missing.join(", ")} (we would not forge them).` : "")
                    + (extra.length ? ` Only ours: ${extra.join(", ")} (blocks there would be rejected).` : ""),
            });
        }
        if (s.error && s.failures >= 2) out.push({ key: `${t.name}:schedule-check`, title: `${t.name}: leader schedule check failing`, text: `${s.failures} attempts for epoch ${s.epoch} failed, the last at ${hhmm(s.at)} UTC: ${s.error}`, urgent: false });
    }
    // 3. forged blocks: the producer's outcome against the relay's chain
    for (const c of Object.values(h.forge ?? {})) {
        if (c.verdict !== "disagree") continue;
        out.push({
            key: `${t.name}:forge-${c.slot}`, title: `${t.name}: forged slot ${c.slot}: producer and relay disagree`, urgent: true,
            text: `Block ${c.hash.slice(0, 16)}… at slot ${c.slot}: the producer says ${c.outcome}, the relay's chain ${c.onRelay ? "holds it" : "does not hold it"} (relay tip ${c.relayTip}, checked ${hhmm(c.at)} UTC). `
                + (c.onRelay ? "Our node left a block the network kept: it may be on a fork." : "Our node keeps a block the network does not have: it may be on a fork."),
        });
    }
    return out;
}

// ----------------------------------------------------------------------------------- lock, spawn
const PROBE_NEEDLE = "parity-" + "probe"; // split: a /proc match must never hit a shell that merely mentions it
export function lockHolder(lockFile: string, needle = PROBE_NEEDLE): number | null {
    try {
        const { pid } = JSON.parse(readFileSync(lockFile, "utf8"));
        if (pid && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle)) return Number(pid);
    } catch { /* no lock, or its process is gone */ }
    return null;
}
/** Take the lock (O_EXCL); a lock whose process is gone is stale and replaced. */
export function takeLock(lockFile: string, needle = PROBE_NEEDLE): boolean {
    for (let i = 0; i < 2; i++) {
        try {
            const fd = openSync(lockFile, "wx");
            writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
            closeSync(fd);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            if (lockHolder(lockFile, needle) != null) return false;
            try { unlinkSync(lockFile); } catch { /* raced with another probe */ }
        }
    }
    return false;
}
export function releaseLock(lockFile: string): void {
    try { if (JSON.parse(readFileSync(lockFile, "utf8")).pid === process.pid) unlinkSync(lockFile); } catch { /* gone */ }
}
/** Start scripts/parity-probe.ts in its own session (it outlives the watchdog's oneshot unit: KillMode=process). */
export function spawnProbe(cfgPath: string, logFile: string): number | undefined {
    const fd = openSync(logFile, "a");
    const child = spawn(process.execPath, [join(import.meta.dir, "..", "parity-probe.ts"), resolve(cfgPath)], { cwd: join(import.meta.dir, "..", ".."), detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    closeSync(fd);
    return child.pid;
}

/**
 * The watchdog tick's part: alerts from the history, and the probe spawned (detached, unless one
 * holds the lock) when a node with answering /metrics has a check due. No network I/O here.
 */
export function parityTick(cfg: ParityHostConfig, cfgPath: string, metricsByNode: Record<string, NodeMetrics | null>, now: number, log: (m: string) => void, spawner = spawnProbe): { alerts: ParityAlert[]; spawned: number | null | undefined; due: string[] } {
    if (cfg.parity?.enabled === false) return { alerts: [], spawned: null, due: [] };
    const paths = parityPaths(cfg), h = readHistory(paths.history), alerts: ParityAlert[] = [], due: string[] = [];
    for (const t of resolveTargets(cfg)) {
        const m = metricsByNode[t.name] ?? null;
        alerts.push(...evaluate(t, h.nodes[t.name], m, cfg.parity, now, paths.history));
        const d = dueFor(t, h.nodes[t.name], m, cfg.parity, now);
        if (m && (d.parity || d.schedule || d.forge)) due.push(`${t.name}: ${d.why.join(", ")}`);
    }
    let spawned: number | null | undefined = null;
    if (due.length && lockHolder(paths.lock) == null) {
        spawned = spawner(cfgPath, paths.log);
        log(`parity: probe started (pid ${spawned ?? "?"}): ${due.join("; ")}`);
    }
    return { alerts, spawned, due };
}

// ---------------------------------------------------------------------------- the checks (probe)
const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);
const strip = (r: QueryResult): StoredResult => { const { excerpt: _x, ...s } = r; return s; };

/** One parity run of a node against its relay. `timing`: acquire attempts while the relay catches up, live-answer retries (tests shorten the waits). */
export async function runParity(t: ParityTarget, pc: ParityConfig = {}, pools?: string[], onResult?: (r: QueryResult) => void,
    timing = { attempts: 5, waitMs: 3000, liveAttempts: 5, retryWaitMs: 3000 }): Promise<ParityRun> {
    const o = opts(pc), at = Date.now(), t0 = performance.now();
    let ours: LsqClient | null = null, ref: LsqClient | null = null;
    const base = { at, point: null, pointSlot: null, epoch: null, shared: false, total: 0, same: 0, diffs: [] };
    try {
        ours = await openLsq(t.socket, t.magic, { acquire: false, timeoutMs: 300_000 });
        ref = await openLsq(t.relay.socket, t.magic, { acquire: false, timeoutMs: 300_000 });
        const acq = await acquireShared(ours, ref, { attempts: timing.attempts, waitMs: timing.waitMs });
        const era = await currentEra(ref);
        const skip = [...(o.skip ?? [])];
        const queries = (await buildQuerySet(ref, { era, pools: o.pools ?? pools, ownerCred: o.ownerCred ?? DEFAULT_OWNER_CRED, huge: !!o.huge, extra: !!o.extra })).filter(([n]) => !skip.some((s) => n.includes(s)));
        const results = (await compareQueries(ours, ref, queries, { shared: acq.shared, onResult, liveAttempts: timing.liveAttempts, retryWaitMs: timing.retryWaitMs })).map(strip);
        return {
            at, ms: Math.round(performance.now() - t0), point: `${acq.slot}:${acq.hash}`, pointSlot: acq.slot == null ? null : Number(acq.slot),
            epoch: acq.slot == null ? null : Number(epochForSlot(acq.slot, t.network)), shared: acq.shared,
            total: results.length, same: results.filter((r) => r.same).length, diffs: results.filter((r) => !r.same), results,
        };
    } catch (e) {
        return { ...base, ms: Math.round(performance.now() - t0), error: errMsg(e) };
    } finally { ours?.close(); ref?.close(); }
}

/** The relay's epoch (GetEpochNo at its tip). */
async function relayEpoch(t: ParityTarget): Promise<number> {
    const c = await openLsq(t.relay.socket, t.magic, { timeoutMs: 60_000 });
    try { return Number((((await c.query(ledger([U(1)], await currentEra(c)))) as CborArray).array[0] as CborUInt).num); } finally { c.close(); }
}

/** Slot numbers from `leadership-schedule --output-json` ([{slotNumber, slotTime}]); null when the output is not that. */
export function parseLeadershipSlots(stdout: string): number[] | null {
    try {
        const j = JSON.parse(stdout);
        if (!Array.isArray(j) || !j.every((x) => typeof x?.slotNumber === "number")) return null;
        return j.map((x) => x.slotNumber as number).sort((a, b) => a - b);
    } catch { return null; }
}

/** Run cardano-cli; its output stays in memory (only slot numbers leave this module), stderr only as a coarse hint. */
export function runCli(cli: string, args: string[], timeoutMs = 600_000): Promise<{ code: number | null; stdout: string; hint?: string }> {
    return new Promise((res) => {
        let stdout = "", stderr = "";
        const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, timeoutMs);
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
        child.on("error", (e) => { clearTimeout(timer); res({ code: -1, stdout: "", hint: (e as NodeJS.ErrnoException).code === "ENOENT" ? "cardano-cli not found" : "could not start cardano-cli" }); });
        child.on("close", (code) => {
            clearTimeout(timer);
            const hint = /no such file|does not exist/i.test(stderr) ? "a file it needs was not found" : /socket|connect/i.test(stderr) ? "cannot reach the relay socket" : stderr ? "run it by hand to see the message" : undefined;
            res({ code, stdout, hint });
        });
    });
}

/** cardano-cli's leader slots for the current epoch, compared with the producer's (the result keeps both lists). */
export async function runScheduleCheck(t: ParityTarget, m: NodeMetrics, genesis: string | null, prev: ScheduleCheck | undefined, now = Date.now()): Promise<ScheduleCheck> {
    const t0 = performance.now(), epoch = Number(epochForSlot(BigInt(m.tipSlot ?? 0), t.network));
    const base = { at: now, epoch, producerStartedAt: producerStartedAt(m, now), ours: producerSlots(m, epoch) };
    const same = prev?.epoch === epoch;
    const fail = (error: string): ScheduleCheck => ({ ...base, ref: same ? prev!.ref : null, error, failures: (same ? prev!.failures ?? 0 : 0) + 1, ms: Math.round(performance.now() - t0) });
    if (!t.vrfSkeyFile || !existsSync(t.vrfSkeyFile)) return fail("the producer's vrfSkeyFile is not there");
    if (!genesis || !existsSync(genesis)) return fail("no Shelley genesis file for cardano-cli (parity.relays.<network>.shelleyGenesis)");
    const poolId = m.producer?.poolId;
    if (!poolId) return fail("the producer's /metrics has no poolId");
    try {
        const e0 = await relayEpoch(t);
        if (e0 !== epoch) return fail(`the relay is at epoch ${e0}, the producer at ${epoch}`);
        const net = t.network === "mainnet" ? ["--mainnet"] : ["--testnet-magic", String(t.magic)];
        const r = await runCli(t.relay.cardanoCli, ["conway", "query", "leadership-schedule", ...net, "--socket-path", t.relay.socket, "--genesis", genesis,
            "--stake-pool-id", poolId, "--vrf-signing-key-file", t.vrfSkeyFile, "--current", "--output-json"]);
        if (r.code !== 0) return fail(`cardano-cli exited with ${r.code}${r.hint ? ` (${r.hint})` : ""}`);
        const slots = parseLeadershipSlots(r.stdout);
        if (!slots) return fail("cardano-cli's output is not a leadership-schedule JSON list");
        const e1 = await relayEpoch(t);
        if (e1 !== epoch) return fail(`the relay moved to epoch ${e1} during the check`);
        const outside = slots.filter((s) => Number(epochForSlot(s, t.network)) !== epoch);
        if (outside.length) return fail(`cardano-cli returned ${outside.length} slot(s) outside epoch ${epoch}`);
        return { ...base, ref: slots, failures: 0, ms: Math.round(performance.now() - t0) };
    } catch (e) { return fail(errMsg(e)); }
}

/** ChainSync FindIntersect on a node-to-client socket: is each block on that node's chain? (one connection, in order) */
export async function findIntersect(sock: string, magic: number, points: Array<{ slot: number; hash: string }>): Promise<Array<{ found: boolean; tip: number }>> {
    const c = await openN2c(sock, magic);
    try {
        const out: Array<{ found: boolean; tip: number }> = [];
        for (const p of points) {
            c.send(5, Cbor.encode(new CborArray([new CborUInt(4), new CborArray([new CborArray([new CborUInt(p.slot), new CborBytes(Uint8Array.from(Buffer.from(p.hash, "hex")))])])])).toBuffer());
            const r = Cbor.parse(await c.recv(5, 30_000)) as CborArray;
            const tag = Number((r.array[0] as CborUInt).num);
            if (tag !== 5 && tag !== 6) throw new Error(`unexpected ChainSync reply ${tag}`);
            const tip = r.array[tag === 5 ? 2 : 1] as CborArray, tp = tip.array[0] as CborArray;
            out.push({ found: tag === 5, tip: tp.array.length ? Number((tp.array[0] as CborUInt).num) : 0 });
        }
        return out;
    } finally {
        try { c.send(5, Cbor.encode(new CborArray([new CborUInt(7)])).toBuffer()); } catch { /* gone */ } // MsgDone, as cardano-cli ends
        c.close();
    }
}

/** Judge every forged block in the window against the relay's chain; forget checks of blocks the producer no longer reports as forged (or out of the window). */
export async function runForgeChecks(t: ParityTarget, m: NodeMetrics, nh: NodeHistory, pc: ParityConfig = {}, now = Date.now()): Promise<ForgeCheck[]> {
    const o = opts(pc), cands = forgeCandidates(m, t.network, now, pc);
    const keep = new Set(cands.map((c) => String(c.slot)));
    nh.forge ??= {};
    for (const k of Object.keys(nh.forge)) if (!keep.has(k)) delete nh.forge[k];
    if (!cands.length) return [];
    const res = await findIntersect(t.relay.socket, t.magic, cands);
    return cands.map((c, i) => {
        const r = res[i]!;
        const chk: ForgeCheck = { at: now, slot: c.slot, hash: c.hash, outcome: c.outcome, relayTip: r.tip, onRelay: r.found, verdict: judgeForge(c.outcome, r.found, r.tip, c.slot, o.forgeSettleSec) };
        nh.forge![String(c.slot)] = chk;
        return chk;
    });
}

async function fetchMetrics(port: number): Promise<NodeMetrics | null> {
    try { const r = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(20_000) }); return r.ok ? ((await r.json()) as NodeMetrics) : null; } catch { return null; }
}

export type CheckName = "parity" | "schedule" | "forge";
/**
 * One probe pass (scripts/parity-probe.ts): under the lock, every check that is due (or forced) on
 * every target; the history is rewritten after each check, summaries go to the watchdog log.
 */
export async function runProbe(cfgPath: string, o: { force?: CheckName[]; node?: string; now?: () => number; metrics?: (port: number) => Promise<NodeMetrics | null>; print?: (s: string) => void } = {}): Promise<{ ran: string[]; skipped?: string }> {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as ParityHostConfig;
    const pc = cfg.parity ?? {}, op = opts(pc), paths = parityPaths(cfg), clock = o.now ?? Date.now, print = o.print ?? ((s: string) => console.log(s));
    const wlog = (msg: string) => { try { writeFileSync(cfg.logFile, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" }); } catch { /* log dir gone */ } print(msg); };
    if (!takeLock(paths.lock)) return { ran: [], skipped: "another probe holds the lock" };
    const guard = setTimeout(() => { wlog(`parity: probe ran over ${op.maxRuntimeMin} min, exiting`); releaseLock(paths.lock); process.exit(3); }, op.maxRuntimeMin * 60_000);
    guard.unref?.();
    const ran: string[] = [];
    try {
        const targets = resolveTargets(cfg).filter((t) => !o.node || t.name === o.node);
        const get = o.metrics ?? fetchMetrics;
        const metrics = new Map<string, NodeMetrics | null>();
        for (const t of targets) metrics.set(t.name, await get(t.port));
        const pools = [...new Set(targets.filter((t) => t.producer).map((t) => metrics.get(t.name)?.producer?.poolId).filter((x): x is string => !!x))];
        const h = readHistory(paths.history);
        const forced = (k: CheckName) => !!o.force?.includes(k);
        for (const t of targets) {
            const nh = (h.nodes[t.name] ??= { runs: [] }), m = metrics.get(t.name) ?? null;
            if (!m) { print(`${t.name}: /metrics does not answer; skipped`); continue; }
            const due = dueFor(t, nh, m, pc, clock());
            if (due.parity || forced("parity")) {
                const next = m.producer?.nextLeaderSlot ? Number(m.producer.nextLeaderSlot) - epochNow(t.network, clock()).wallSlot : Infinity;
                if (t.producer && next >= -30 && next <= op.quietSec) print(`${t.name}: leader slot in ${next} s; parity run deferred`);
                else if (!existsSync(t.relay.socket)) print(`${t.name}: relay socket ${t.relay.socket} missing (relay down?); parity run skipped`);
                else {
                    nh.lastAttempt = clock();
                    writeHistory(paths.history, h);
                    const run = await runParity(t, pc, pools.length ? pools : [DEFAULT_POOL], (r) => { if (!r.same) print(`  ${r.err ? "ERR " : "DIFF"} ${r.name}: ours ${r.ours} B, relay ${r.ref} B${r.firstDiff != null ? `, byte ${r.firstDiff}` : ""}${r.err ? ` ${r.err}` : ""}`); });
                    recordRun(nh, run, pc);
                    writeHistory(paths.history, h);
                    ran.push(`${t.name}:parity`);
                    wlog(run.error ? `parity ${t.name}: run failed after ${run.ms} ms: ${run.error}`
                        : `parity ${t.name}: ${run.same} of ${run.total} same at ${run.pointSlot} (${run.shared ? "one block" : "own tips"}, ${run.ms} ms)${run.diffs.length ? `; DIFF ${run.diffs.map((d) => d.name).join(", ")}` : ""}`);
                }
            }
            if (t.producer && m.producer && (due.schedule || forced("schedule"))) {
                const s = await runScheduleCheck(t, m, shelleyGenesisOf(cfg, t.network), nh.schedule, clock());
                nh.schedule = s;
                writeHistory(paths.history, h);
                ran.push(`${t.name}:schedule`);
                const d = s.ref ? diffSlots(s.ref, s.ours) : null;
                wlog(s.error ? `schedule ${t.name} epoch ${s.epoch}: check failed (${s.failures}): ${s.error}`
                    : `schedule ${t.name} epoch ${s.epoch}: cardano-cli [${s.ref!.join(", ")}], producer [${s.ours.join(", ")}]: ${d!.missing.length || d!.extra.length ? "MISMATCH" : "match"} (${s.ms} ms)`);
            }
            if (t.producer && m.producer && (due.forge || forced("forge"))) {
                try {
                    const checks = await runForgeChecks(t, m, nh, pc, clock());
                    writeHistory(paths.history, h);
                    ran.push(`${t.name}:forge`);
                    for (const c of checks) wlog(`forge ${t.name} slot ${c.slot}: producer ${c.outcome}, relay ${c.onRelay ? "has it" : "does not have it"} (tip ${c.relayTip}): ${c.verdict}`);
                } catch (e) { wlog(`forge ${t.name}: check failed: ${errMsg(e)}`); }
            }
        }
    } finally {
        clearTimeout(guard);
        releaseLock(paths.lock);
    }
    return { ran };
}
