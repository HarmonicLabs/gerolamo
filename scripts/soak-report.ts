/**
 * Soak report: how the preview nodes behaved over a window, from the watchdog's records and the nodes' /metrics.
 *
 *   bun scripts/soak-report.ts [--since 2026-10-09T20:40:00Z] [--until <iso>] [--watchdog /media/bakon/data/cardano/watchdog]
 *
 * Criteria (docs/PLAN_DINGO_PARITY.md follow-up, 2026-10-09): over ≥ 3 epoch boundaries, no halt; every parity probe
 * 64/64 on every node; every forged block confirmed unless a slot battle explains it; no equivocation; no restart
 * the operator did not make; node-specific lag (a node > 60 s behind while another Gerolamo node is within 20 s)
 * under 0.1 % of minutes per node.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const WD = arg("watchdog", "/media/bakon/data/cardano/watchdog")!;
const since = Date.parse(arg("since", "2026-10-09T22:37:00Z")!); // soak start: last code rollout (bug 390)
const until = Date.parse(arg("until", new Date().toISOString())!);
const PREVIEW_SYSTEM_START = 1666656000; // preview slot 0 (unix seconds), 1 slot = 1 s
const slotTime = (slot: number) => (PREVIEW_SYSTEM_START + slot) * 1000;
const inWindow = (t: number) => t >= since && t <= until;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

type NodeCfg = { name: string; port: number; dir: string; logName: string };
const cfg = JSON.parse(readFileSync(join(WD, "config.json"), "utf8")) as { nodes: NodeCfg[] };
const nodes = cfg.nodes.filter((n) => n.port);

// ---- watchdog.log: alerts and per-minute tips
const alerts: Array<{ t: number; node: string; text: string }> = [];
const behind = new Map<string, Map<number, number>>(); // node → minute → seconds behind
for (const line of readFileSync(join(WD, "watchdog.log"), "utf8").split("\n")) {
    const m = /^\[([^\]]+)\] (.*)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (!inWindow(t)) continue;
    const rest = m[2]!;
    const a = /^ALERT (preview [a-z -]+?): (.*)$/.exec(rest);
    if (a) { alerts.push({ t, node: a[1]!, text: a[2]! }); continue; }
    const b = /^(preview [a-z -]+?): tip \d+ behind (\d+)s/.exec(rest);
    if (b) {
        let mm = behind.get(b[1]!); if (!mm) behind.set(b[1]!, (mm = new Map()));
        mm.set(Math.floor(t / 60_000), Number(b[2]));
    }
}
const openAlerts = alerts.filter((a) => !a.text.startsWith("OK again"));

// ---- node-specific lag: behind > 60 s while another Gerolamo node is within 20 s in the same minute
const minutes = new Set<number>(); for (const mm of behind.values()) for (const k of mm.keys()) minutes.add(k);
const lag: Record<string, { minutes: number; specific: number; at: string[] }> = {};
for (const [node, mm] of behind) {
    let specific = 0; const at: string[] = [];
    for (const [min, s] of mm) {
        if (s <= 60) continue;
        const othersCurrent = [...behind].some(([o, om]) => o !== node && (om.get(min) ?? 9e9) <= 20);
        if (othersCurrent) { specific++; if (at.length < 8) at.push(iso(min * 60_000)); }
    }
    lag[node] = { minutes: mm.size, specific, at };
}

// ---- parity probes
const hist = JSON.parse(readFileSync(join(WD, "parity-history.json"), "utf8")) as { nodes: Record<string, { runs: Array<{ at: number; total: number; same: number; diffs: Array<{ name?: string } | string> }> }> };
const parity: Record<string, { runs: number; clean: number; bad: string[] }> = {};
for (const [node, h] of Object.entries(hist.nodes)) {
    const runs = (h.runs ?? []).filter((r) => inWindow(r.at));
    parity[node] = { runs: runs.length, clean: runs.filter((r) => r.same === r.total).length, bad: runs.filter((r) => r.same !== r.total).slice(0, 5).map((r) => `${iso(r.at)} ${r.same}/${r.total} ${(r.diffs ?? []).map((d) => (typeof d === "string" ? d : d.name ?? "?")).join(",")}`) };
}

// ---- forged blocks (state.json slotsSeen: "<node>:<slot>" → outcome)
const state = JSON.parse(readFileSync(join(WD, "state.json"), "utf8")) as { slotsSeen?: Record<string, string> };
const forged: Array<{ slot: number; outcome: string }> = [];
for (const [k, outcome] of Object.entries(state.slotsSeen ?? {})) {
    const slot = Number(k.slice(k.lastIndexOf(":") + 1));
    if (inWindow(slotTime(slot))) forged.push({ slot, outcome });
}
forged.sort((a, b) => a.slot - b.slot);

// ---- restarts (supervisor launches; the first one in the window may be the operator's)
const restarts: Record<string, string[]> = {};
for (const n of nodes) {
    const f = join(n.dir, "logs", "supervisor.log");
    if (!existsSync(f)) continue;
    const out: string[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = /^\[supervisor ([^\]]+)\] (launching|pid \d+ rss .*restarting)/.exec(line);
        if (m && inWindow(Date.parse(m[1]!))) out.push(`${iso(Date.parse(m[1]!))} ${m[2]!.startsWith("pid") ? "rss cap" : "launch"}`);
    }
    restarts[n.name] = out;
}

// ---- live metrics
const live: Record<string, unknown> = {};
for (const n of nodes) {
    try {
        const r = await fetch(`http://localhost:${n.port}/metrics`, { signal: AbortSignal.timeout(5000) });
        const d = await r.json() as Record<string, any>;
        const cs = d.sync?.chainSelection ?? {};
        live[n.name] = { tip: d.tipSlot, halted: d.sync?.halted ?? null, equivocations: d.equivocations?.total ?? null, selection: cs.selection, decisions: cs.decisions, switches: cs.switches, shadow: cs.shadow ?? null };
    } catch (e) { live[n.name] = { error: (e as Error).message }; }
}

// ---- report
const days = (until - since) / 86_400_000;
const boundaries = Math.floor((until / 1000 - PREVIEW_SYSTEM_START) / 86400) - Math.floor((since / 1000 - PREVIEW_SYSTEM_START) / 86400);
console.log(`Soak ${iso(since)} → ${iso(until)} UTC (${days.toFixed(2)} days, ${boundaries} epoch boundaries)\n`);
// repeated alerts collapse into one line per node and kind ("1 N2C answer differs…", "public port unreachable", …)
const groups = new Map<string, { node: string; kind: string; n: number; first: number; last: number; sample: string }>();
for (const a of openAlerts) {
    const kind = a.text.replace(/\(still, since [^)]*\)/, "").split(":")[0]!.replace(/\d+/g, "N").trim();
    const k = `${a.node}|${kind}`;
    const g = groups.get(k);
    if (g) { g.n++; g.last = a.t; } else groups.set(k, { node: a.node, kind, n: 1, first: a.t, last: a.t, sample: a.text.slice(0, 140) });
}
console.log(`Alerts (not "OK again"): ${openAlerts.length} in ${groups.size} group(s)`);
for (const g of groups.values()) console.log(`  ${g.node}: "${g.kind}" ×${g.n}, ${iso(g.first)}${g.n > 1 ? ` … ${iso(g.last)}` : ""} — e.g. ${g.sample}`);
console.log(`\nParity probes:`);
for (const [n, p] of Object.entries(parity)) console.log(`  ${n}: ${p.clean}/${p.runs} clean${p.bad.length ? `; not clean: ${p.bad.join(" | ")}` : ""}`);
const counts: Record<string, number> = {}; for (const f of forged) counts[f.outcome] = (counts[f.outcome] ?? 0) + 1;
console.log(`\nForged blocks: ${forged.length} ${JSON.stringify(counts)}`);
for (const f of forged.filter((x) => x.outcome !== "confirmed")) console.log(`  ${f.slot} (${iso(slotTime(f.slot))}) ${f.outcome}`);
console.log(`\nNode-specific lag (> 60 s while another Gerolamo node was within 20 s):`);
for (const [n, l] of Object.entries(lag)) console.log(`  ${n}: ${l.specific} of ${l.minutes} minutes (${((100 * l.specific) / Math.max(1, l.minutes)).toFixed(2)} %)${l.at.length ? ` e.g. ${l.at.join(", ")}` : ""}`);
console.log(`\nSupervisor launches / rss-cap restarts:`);
for (const [n, r] of Object.entries(restarts)) console.log(`  ${n}: ${r.length ? r.join("; ") : "none"}`);
console.log(`\nLive:`);
for (const [n, v] of Object.entries(live)) console.log(`  ${n}: ${JSON.stringify(v)}`);
