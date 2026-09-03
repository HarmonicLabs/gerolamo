import { toHex } from "@harmoniclabs/uint8array-utils";
import { getBasePath } from "../utils/paths";
import {
    getUtxosByTxHash,
    getUtxoByRef,
    getBlockBySlot,
    getBlockByHash,
    getMaxSlot,
    getUtxoCount,
    getEpochNonce,
} from "../db";
import { handleMiniBlockfrost } from "../api/miniBlockfrost";
import { handleOpenApiRoutes } from "../api/openApi";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { eraName } from "../utils/eraNames";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { logger } from "../utils/logger";
import { createResourceSampler } from "../utils/processStats";
import { resolveNodeRole } from "./nodeRole";

import type { GerolamoConfig } from "./peerManager";
import {
    attachWsServer,
    nextClientId,
    defaultTopics,
    allTopics,
    isWsTopic,
    wsPublish,
    type WsClientData,
    type WsTopic,
} from "./wsHub";
import {
    setTipListener,
    setPeersListener,
} from "./liveEvents";

/**
 * Ledger era of the block at `tipSlot`, decoded from the stored BlockFetch
 * message (`[4, #6.24([era, block])]`) or a bare `[era, block]` payload.
 * null when the DB is empty or the row cannot be decoded.
 */
async function tipEra(tipSlot: bigint): Promise<number | null> {
    if (tipSlot <= 0n) return null;
    try {
        const row = await getBlockBySlot(tipSlot);
        if (!row) return null;
        // getBlockBySlot uses .values(): positional row; 8 = block_fetch_RawCbor, 6 = block_data
        const raw: unknown = Array.isArray(row)
            ? (row[8] ?? row[6])
            : (row.block_fetch_RawCbor ?? row.block_data);
        if (!(raw instanceof Uint8Array) || raw.length === 0) return null;
        let obj = Cbor.parse(raw);
        if (
            obj instanceof CborArray && obj.array.length >= 2 &&
            obj.array[0] instanceof CborUInt && Number(obj.array[0].num) === 4 &&
            obj.array[1] instanceof CborTag && obj.array[1].data instanceof CborBytes
        ) {
            obj = Cbor.parse(obj.array[1].data.bytes);
        }
        if (obj instanceof CborArray && obj.array[0] instanceof CborUInt) {
            const era = Number(obj.array[0].num);
            return era >= 0 && era <= 32 ? era : null;
        }
        return null;
    } catch {
        return null;
    }
}

/** BigInt-free view of the orchestrator's multi-peer sync state. */
function serializeSync(snap: unknown): Record<string, unknown> | null {
    if (!snap || typeof snap !== "object") return null;
    return JSON.parse(
        JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ) as Record<string, unknown>;
}

/** Process/host CPU % are deltas between /metrics builds; one sampler per process. */
const sampleResources = createResourceSampler();

/** Shared metrics blob for /metrics JSON and /stats HTML. */
async function buildMetricsPayload(
    config: GerolamoConfig,
    manager: any,
): Promise<Record<string, unknown>> {
    const tipSlot = await getMaxSlot();
    const utxoCount = await getUtxoCount();
    const epoch = Number(calculatePreProdCardanoEpoch(Number(tipSlot)));
    const era = await tipEra(tipSlot);
    const epochNonce =
        Number.isFinite(epoch) && epoch >= 0
            ? await getEpochNonce(epoch)
            : null;
    const gov =
        typeof manager?.getGovernorSnapshot === "function"
            ? manager.getGovernorSnapshot()
            : null;
    const resources = sampleResources();
    return {
        network: config.network ?? process.env.NETWORK ?? "unknown",
        tipSlot: tipSlot.toString(),
        utxoCount,
        epoch: Number.isFinite(epoch) ? epoch : null,
        era,
        eraName: eraName(era),
        epochNonce,
        bodyValidation: config.bodyValidation ?? "soft",
        scriptValidation: config.scriptValidation ?? "off",
        uptimeSec: Math.round(process.uptime()),
        node: "gerolamo",
        /** "data" (outbound only) or "relay" (accepts inbound N2N). */
        role: resolveNodeRole(config),
        /** Inbound node-to-node listener state. */
        inbound:
            typeof manager?.getInboundStatus === "function"
                ? manager.getInboundStatus()
                : { listening: false, host: null, port: null, clients: 0 },
        /** This node process: rss/heap bytes, cpuPercent (100 = one core). */
        process: resources.process,
        /** Host: cpus, cpuPercent (0–100), mem bytes, loadAvg. */
        system: resources.system,
        peers: gov
            ? {
                cold: gov.cold,
                warm: gov.warm,
                hot: gov.hot,
                total: gov.total,
                hotKeys: gov.hotKeys,
            }
            : null,
        governor: gov ?? null,
        peerTipSlot:
            typeof manager?.getBestPeerTipSlot === "function"
                ? manager.getBestPeerTipSlot()
                : null,
        sync:
            typeof manager?.getSyncSnapshot === "function"
                ? serializeSync(manager.getSyncSnapshot())
                : null,
        syncFromTip: !!config.syncFromTip,
        syncFromGenesis: !!config.syncFromGenesis,
        syncFromPoint: !!config.syncFromPoint,
    };
}

/**
 * Self-contained HTML dashboard. Client polls /metrics + /governor every 5s.
 * Local-only (no external tip APIs). Peer + metrics panels, not link dumps.
 */
function statsHtmlPage(port: number, network: string): string {
    const net = String(network || "unknown");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Gerolamo stats · :${port}</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --b:#30363d; --t:#e6edf3; --m:#8b949e; --g:#3fb950; --y:#d29922; --r:#f85149; --a:#58a6ff; --hot:#3fb950; --warm:#d29922; --cold:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,sans-serif; background:var(--bg); color:var(--t); }
  header { padding:16px 20px; border-bottom:1px solid var(--b); display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
  h1 { margin:0; font-size:18px; font-weight:600; }
  .meta { color:var(--m); font-size:12px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid var(--b); }
  .ok { color:var(--g); border-color:#238636; background:#12261a; }
  .warn { color:var(--y); border-color:#9e6a03; background:#2a2108; }
  .bad { color:var(--r); border-color:#da3633; background:#2a1214; }
  main { padding:16px 20px 32px; max-width:min(1760px,98vw); margin:0 auto; display:flex; flex-direction:column; gap:14px; }
  .kpis { display:grid; grid-template-columns:repeat(11,minmax(0,1fr)); gap:10px; align-items:stretch; }
  @media (max-width:1500px) { .kpis { grid-template-columns:repeat(6,minmax(0,1fr)); } }
  @media (max-width:980px) { .kpis { grid-template-columns:repeat(3,minmax(0,1fr)); } }
  @media (max-width:640px) { .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  .card { background:var(--card); border:1px solid var(--b); border-radius:10px; padding:12px 14px; min-width:0; position:relative; }
  .card[data-tooltip], .card[title] { cursor:help; }
  .card[data-tooltip]:hover, .card[title]:hover { border-color:#484f58; box-shadow:0 0 0 1px rgba(88,166,255,.18); }
  /* Multi-line CSS popover (richer than native title) */
  .card[data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%) translateY(4px);
    width: max-content; max-width: min(320px, 70vw);
    padding: 10px 12px; border-radius: 8px;
    background: #1c2128; color: var(--t); border: 1px solid #484f58;
    box-shadow: 0 8px 24px rgba(0,0,0,.45);
    font: 12px/1.45 ui-sans-serif,system-ui,sans-serif; font-weight: 400; letter-spacing: 0;
    text-transform: none; white-space: pre-line; text-align: left;
    opacity: 0; pointer-events: none; z-index: 50;
    transition: opacity .12s ease, transform .12s ease;
  }
  .card[data-tooltip]::before {
    content: "";
    position: absolute; left: 50%; bottom: calc(100% + 4px); transform: translateX(-50%);
    border: 6px solid transparent; border-top-color: #484f58;
    opacity: 0; pointer-events: none; z-index: 51;
    transition: opacity .12s ease;
  }
  .card[data-tooltip]:hover::after { opacity: 1; transform: translateX(-50%) translateY(0); }
  .card[data-tooltip]:hover::before { opacity: 1; }
  .kpis .card[data-tooltip]::after { left: 0; right: auto; transform: translateY(4px); max-width: min(300px, 40vw); }
  .kpis .card[data-tooltip]::before { left: 18px; transform: none; }
  .kpis .card[data-tooltip]:hover::after { transform: translateY(0); }
  .card .k { color:var(--m); font-size:11px; text-transform:uppercase; letter-spacing:.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .card .v { font-size:20px; font-weight:650; margin-top:4px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.2; }
  .card .s { color:var(--m); font-size:11px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .panels { display:grid; grid-template-columns:1.1fr 1fr 1fr; gap:12px; }
  @media (max-width:980px) { .panels { grid-template-columns:1fr; } }
  .panel-title { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--m); margin:0 0 10px; font-weight:600; }
  .tier { margin:0 0 12px; }
  .tier-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; font-size:12px; }
  .tier-head strong { font-variant-numeric:tabular-nums; }
  .bar { height:8px; background:#0d1117; border:1px solid var(--b); border-radius:999px; overflow:hidden; }
  .bar > i { display:block; height:100%; width:0; transition:width .35s ease; border-radius:999px; }
  .bar.hot > i { background:var(--hot); }
  .bar.warm > i { background:var(--warm); }
  .bar.cold > i { background:var(--cold); }
  .peer-list { list-style:none; margin:0; padding:0; max-height:220px; overflow:auto; }
  .peer-list li { display:flex; align-items:center; gap:8px; padding:7px 8px; border:1px solid var(--b); border-radius:8px; margin-bottom:6px; background:#0d1117; font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
  .dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
  .dot.hot { background:var(--hot); box-shadow:0 0 0 3px rgba(63,185,80,.15); }
  .dot.warm { background:var(--warm); }
  .dot.cold { background:var(--cold); }
  .empty { color:var(--m); font-size:12px; padding:8px 0; }
  .kv { display:grid; grid-template-columns:1fr auto; gap:6px 12px; font-size:13px; }
  .kv span:first-child { color:var(--m); }
  .kv span:last-child { font-variant-numeric:tabular-nums; text-align:right; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .err-list { list-style:none; margin:0; padding:0; max-height:180px; overflow:auto; }
  .err-list li { padding:6px 8px; border:1px solid var(--b); border-radius:8px; margin-bottom:6px; background:#0d1117; font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .err-list .ek { color:var(--a); }
  .err-list .ee { color:var(--m); display:block; margin-top:2px; word-break:break-all; }
  .err-list .ef { color:var(--y); float:right; }
  .group-list { list-style:none; margin:0; padding:0; }
  .group-list li { display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:center; padding:8px; border:1px solid var(--b); border-radius:8px; margin-bottom:6px; background:#0d1117; font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .group-list .gid { color:var(--a); font-weight:600; }
  .group-list .gmeta { color:var(--m); font-size:11px; }
  .group-list .gstat.ok { color:var(--g); }
  .group-list .gstat.warn { color:var(--y); }
  .group-list .gstat.bad { color:var(--r); }
  .group-bar { height:6px; background:#0d1117; border:1px solid var(--b); border-radius:999px; overflow:hidden; margin-top:4px; }
  .group-bar > i { display:block; height:100%; background:var(--hot); border-radius:999px; }
  details.card summary { cursor:pointer; color:var(--m); font-size:12px; text-transform:uppercase; letter-spacing:.04em; list-style:none; }
  details.card summary::-webkit-details-marker { display:none; }
  pre { background:#0d1117; border:1px solid var(--b); border-radius:8px; padding:12px; overflow:auto; font-size:11px; margin:10px 0 0; max-height:240px; }
  code { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0d1117; padding:1px 5px; border-radius:4px; }
  footer { color:var(--m); font-size:12px; padding:0 20px 24px; max-width:min(1760px,98vw); margin:0 auto; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Gerolamo · live stats</h1>
    <div class="meta">port <code>${port}</code> · network <code id="net">${net}</code> · local only · ws /ws/stats · poll fallback 5s · <a href="/docs" style="color:var(--a)">OpenAPI</a></div>
  </div>
  <div>
    <span id="status" class="badge warn">loading</span>
    <span class="meta" id="updated"></span>
  </div>
</header>
<main>
  <section class="kpis" id="kpis">
    <div class="card" data-tooltip="Tip slot — chain tip from DB MAX(slot).
Advances on each ChainSync RollForward
(header → BlockFetch → apply).
Frozen tip + hot=0 = stalled."><div class="k">Tip slot</div><div class="v" id="tip">—</div><div class="s">MAX(slot) DB</div></div>
    <div class="card" data-tooltip="UTxO count — set size in DB.
Soft ledger applies blocks even when
body/UTxO checks fail (mid-chain sync tolerance).
Not full consensus proof."><div class="k">UTxO</div><div class="v" id="utxo">—</div><div class="s">soft ledger</div></div>
    <div class="card" data-tooltip="Epoch — Cardano epoch from tip slot.
Subtitle shows epoch nonce prefix when known.
Preprod epoch length ≈ 5 days."><div class="k">Epoch</div><div class="v" id="epoch">—</div><div class="s" id="epochNote"></div></div>
    <div class="card" data-tooltip="Uptime — live process wall time since start.
Subtitle is raw seconds.
Resets on live-only restart (not soak)."><div class="k">Uptime</div><div class="v" id="up">—</div><div class="s" id="upNote">process</div></div>
    <div class="card" data-tooltip="Body / script validation policy.
soft = apply on body failure (mid-chain OK).
strict = reject bad bodies.
Script flag is separate (off/on)."><div class="k">Body / script</div><div class="v" id="flags">—</div><div class="s">validation</div></div>
    <div class="card" data-tooltip="Peers total — PeerGovernor map size
(hot + warm + cold).
Subtitle breaks out each tier.
Grows via PeerSharing + topology seed."><div class="k">Peers total</div><div class="v" id="peersTotal">—</div><div class="s" id="peersNote">governor</div></div>
    <div class="card" data-tooltip="Hot peers — active ChainSync connections
pushing headers and blocks.
Target usually 2; max hard cap 8.
Only tier doing real consensus work."><div class="k">Hot</div><div class="v" id="hotN" style="color:var(--hot)">—</div><div class="s">ChainSync headers</div></div>
    <div class="card" data-tooltip="Warm / cold tiers.
warm = connected standby (KeepAlive, no sync).
cold = known addresses not yet connected
(discovery pool from share/topology)."><div class="k">Warm / cold</div><div class="v" id="warmCold">—</div><div class="s">standby / pool</div></div>
    <div class="card" data-tooltip="Gov ticks — completed PeerGovernor loops
since process start (default every 15s).
Subtitle = lastTickMs + age of last tick.
Stuck tickCount = hung share/connect."><div class="k">Gov ticks</div><div class="v" id="tickN">—</div><div class="s" id="tickNote">lastTickMs</div></div>
    <div class="card" data-tooltip="Failed peers — failCount &gt; 0
(HS timeout, connect fail, terminated).
nextRetryAt exponential backoff (15s→5m).
Subtitle = recentErrors count (top 8)."><div class="k">Failed peers</div><div class="v" id="failN" style="color:var(--y)">—</div><div class="s" id="failNote">recent errors</div></div>
    <div class="card" data-tooltip="LR valency — localRoot groups meeting
hot ≥ valency (filled / with-valency).
Empty topology accessPoints → hot=0
until peers are listed. Demote blocked at floor."><div class="k">LR valency</div><div class="v" id="lrN">—</div><div class="s" id="lrNote">localRoot groups</div></div>
  </section>

  <section class="panels">
    <div class="card" data-tooltip="Peer tiers vs targets
Progress = current / target (max hard cap).
Hot green = ChainSync syncing.
Warm amber = connected standby.
Cold blue = discovery pool.
Tip advances on each RollForward.">
      <h2 class="panel-title">Peer tiers vs targets</h2>
      <div class="tier">
        <div class="tier-head"><span>Hot</span><strong id="tierHotLab">—</strong></div>
        <div class="bar hot"><i id="barHot"></i></div>
      </div>
      <div class="tier">
        <div class="tier-head"><span>Warm</span><strong id="tierWarmLab">—</strong></div>
        <div class="bar warm"><i id="barWarm"></i></div>
      </div>
      <div class="tier">
        <div class="tier-head"><span>Cold</span><strong id="tierColdLab">—</strong></div>
        <div class="bar cold"><i id="barCold"></i></div>
      </div>
      <p class="s" style="margin:10px 0 0">Tip advances on each ChainSync <code>RollForward</code> (header + tip → BlockFetch → apply). Frozen tip + hot=0 = stalled.</p>
    </div>

    <div class="card" data-tooltip="Hot peers — active ChainSync connections
pushing headers and blocks to this node.
Warm peers — connected standby (KeepAlive
alive, no sync). Promoted when hot drops.">
      <h2 class="panel-title">Hot peers</h2>
      <ul class="peer-list" id="hotList"><li class="empty">—</li></ul>
      <h2 class="panel-title" style="margin-top:14px">Warm peers</h2>
      <ul class="peer-list" id="warmList"><li class="empty">—</li></ul>
    </div>

    <div class="card" data-tooltip="Cold sample — known addresses not yet connected
(from PeerSharing or topology bootstrap).
Governor targets — target/max per tier,
tickCount, failedPeers, lrGroups.
Connect attempts appear in Recent errors.">
      <h2 class="panel-title">Cold sample</h2>
      <ul class="peer-list" id="coldList"><li class="empty">—</li></ul>
      <h2 class="panel-title" style="margin-top:14px">Governor targets</h2>
      <div class="kv" id="targetsKv"></div>
    </div>

    <div class="card" data-tooltip="LocalRoot groups · hard valency (P1)
Each topology localRoots[] group must hold
≥ valency hot peers. Demote blocked at floor.
Empty accessPoints → hot=0 until peers listed.
groupId = lr_0, lr_1, … from topology order.">
      <h2 class="panel-title">LocalRoot groups · hard valency</h2>
      <ul class="group-list" id="groupList"><li class="empty">—</li></ul>
      <p class="s" style="margin:8px 0 0">P1: each topology <code>localRoots[]</code> group holds ≥ valency hot. Demote blocked while at floor. Empty APs → hot=0 until peers are listed.</p>
    </div>
    <div class="card" data-tooltip="Recent peer errors (P0)
Top by failCount (HS timeout / connect fail /
terminated). nextRetryAt exponential backoff
15s → 30s → … capped 5m.
Emergency force-clear if hot=0 and all backed off.">
      <h2 class="panel-title">Recent peer errors</h2>
      <ul class="err-list" id="errList"><li class="empty">—</li></ul>
      <p class="s" style="margin:8px 0 0">P0: HS timeout / connect fail · <code>nextRetryAt</code> backoff. Top by failCount.</p>
    </div>
    <div class="card" data-tooltip="Metrics + governor ops
node, network, tipSlot, utxoCount, epoch,
epochNonce, body/script validation,
uptimeSec, hot/warm/cold, tickCount,
lastTickMs, failedPeers, lrGroups, transport.
Refreshed via WS /ws/stats or poll 5s.">
      <h2 class="panel-title">Metrics + governor ops</h2>
      <div class="kv" id="metricsKv"></div>
    </div>
  </section>

  <details class="card">
    <summary>Raw JSON · /metrics + /governor</summary>
    <pre id="raw">{}</pre>
  </details>
</main>
<footer>
  Local dashboard — <strong>WebSocket</strong> <code>/ws/stats</code> (tip/peers/metrics); falls back to poll <code>/metrics</code>+<code>/governor</code> every 5s.
  No external tip APIs. N2C <code>node.socket</code> optional (<code>GEROLAMO_N2C_SOCKET</code>).
  · <a href="/docs">OpenAPI /docs</a> · <a href="/openapi.json">openapi.json</a> (MiniBF BF-subset explorer).
</footer>
<script>
const fmt = (n) => n == null || n === "" || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US");
const el = (id) => document.getElementById(id);
const esc = (s) => { const t=String(s??''); return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
let useWs = false;
let lastMetrics = null;
let lastGov = null;
function setBadge(kind, text) {
  const b = el("status");
  b.textContent = text;
  b.className = "badge " + (kind === "ok" ? "ok" : kind === "bad" ? "bad" : "warn");
}
function fmtUptime(sec) {
  if (sec == null) return "—";
  const s = Math.max(0, Math.floor(Number(sec)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + r + "s";
  return r + "s";
}
function barPct(cur, max) {
  const c = Number(cur) || 0;
  const m = Math.max(1, Number(max) || 1);
  return Math.min(100, Math.round((c / m) * 100));
}
function renderPeers(listEl, keys, tier) {
  const arr = Array.isArray(keys) ? keys : [];
  if (!arr.length) { listEl.innerHTML = '<li class="empty">none</li>'; return; }
  listEl.innerHTML = arr.map((k) =>
    '<li><span class="dot ' + tier + '"></span><span>' + esc(k) + '</span></li>'
  ).join("");
}
function renderKv(container, rows) {
  container.innerHTML = rows.map(([k, v]) =>
    "<span>" + esc(k) + "</span><span>" + esc(v) + "</span>"
  ).join("");
}
function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b)) || Number(b) < 0) return "—";
  var u = ["B","KB","MB","GB","TB"], v = Number(b), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + u[i];
}
function fmtAgo(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return "—";
  const age = Math.max(0, Date.now() - Number(ms));
  if (age < 1000) return age + "ms ago";
  if (age < 60_000) return Math.round(age / 1000) + "s ago";
  if (age < 3600_000) return Math.round(age / 60_000) + "m ago";
  return Math.round(age / 3600_000) + "h ago";
}
function renderErrors(listEl, errors) {
  const arr = Array.isArray(errors) ? errors : [];
  if (!arr.length) { listEl.innerHTML = '<li class="empty">none</li>'; return; }
  listEl.innerHTML = arr.map((e) =>
    '<li><span class="ef">×' + esc(e.failCount ?? 1) + '</span>' +
    '<span class="ek">' + esc(e.key ?? "?") + '</span>' +
    '<span class="ee">' + esc(e.error ?? "") + '</span></li>'
  ).join("");
}
function renderGroups(listEl, groups) {
  const arr = Array.isArray(groups) ? groups : [];
  if (!arr.length) { listEl.innerHTML = '<li class="empty">none registered</li>'; return; }
  listEl.innerHTML = arr.map((g) => {
    const want = Number(g.valency) || 0;
    const hotG = Number(g.hot) || 0;
    const warmG = Number(g.warm) || 0;
    const coldG = Number(g.cold) || 0;
    const ok = want > 0 && hotG >= want;
    const partial = hotG > 0 && !ok;
    const cls = ok ? "ok" : (partial ? "warn" : "bad");
    const mark = ok ? "OK" : (want === 0 ? "n/a" : hotG + "/" + want);
    const pct = want > 0 ? Math.min(100, Math.round((hotG / want) * 100)) : 0;
    return '<li><span class="gid">' + esc(g.groupId ?? "?") + '</span>' +
      '<div style="min-width:0">' +
      '<div class="gmeta">valency ' + want + ' · h' + hotG + ' w' + warmG + ' c' + coldG + '</div>' +
      '<div class="group-bar"><i style="width:' + pct + '%"></i></div></div>' +
      '<span class="gstat ' + cls + '">' + mark + '</span></li>';
  }).join("");
}
function applyView(m, gov) {
  if (!m && !gov) return;
  m = m || lastMetrics || {};
  gov = gov || lastGov || m.governor || null;
  if (m && m.tipSlot != null) lastMetrics = m;
  if (gov) lastGov = gov;
  const peers = (m && m.peers) || gov || {};
  const hot = Number(peers.hot ?? gov?.hot ?? 0);
  const warm = Number(peers.warm ?? gov?.warm ?? 0);
  const cold = Number(peers.cold ?? gov?.cold ?? 0);
  const total = Number(peers.total ?? gov?.total ?? (hot + warm + cold));
  const t = gov?.targets || {};
  const tip = m.tipSlot;
  const tickCount = gov?.tickCount;
  const lastTickMs = gov?.lastTickMs;
  const lastTickAt = gov?.lastTickAt;
  const failedPeers = gov?.failedPeers;
  const groups = gov?.localRootGroups || [];
  const recentErrors = gov?.recentErrors || [];
  el("net").textContent = m.network || ${JSON.stringify(net)};
  if (tip != null) el("tip").textContent = fmt(tip);
  if (m.utxoCount != null) el("utxo").textContent = fmt(m.utxoCount);
  if (m.epoch != null) el("epoch").textContent = String(m.epoch);
  if (m.epochNonce) el("epochNote").textContent = "nonce " + String(m.epochNonce).slice(0, 16) + "…";
  if (m.uptimeSec != null) { el("up").textContent = fmtUptime(m.uptimeSec); el("upNote").textContent = fmt(m.uptimeSec) + "s"; }
  if (m.bodyValidation || m.scriptValidation) el("flags").textContent = (m.bodyValidation || "?") + " / " + (m.scriptValidation || "?");
  el("peersTotal").textContent = fmt(total);
  el("peersNote").textContent = "hot " + hot + " · warm " + warm + " · cold " + cold;
  el("hotN").textContent = fmt(hot);
  el("warmCold").textContent = fmt(warm) + " / " + fmt(cold);
  el("tickN").textContent = tickCount != null ? fmt(tickCount) : "—";
  el("tickNote").textContent =
    (lastTickMs != null ? lastTickMs + "ms" : "—") +
    (lastTickAt ? " · " + fmtAgo(lastTickAt) : "");
  el("failN").textContent = failedPeers != null ? fmt(failedPeers) : "—";
  el("failNote").textContent = (recentErrors.length || 0) + " recent";
  const filled = groups.filter((g) => Number(g.valency) > 0 && Number(g.hot) >= Number(g.valency)).length;
  const withValency = groups.filter((g) => Number(g.valency) > 0).length;
  el("lrN").textContent = groups.length ? (filled + " / " + withValency) : "—";
  el("lrNote").textContent = groups.length
    ? groups.map((g) => g.groupId + ":" + (g.hot ?? 0) + "/" + (g.valency ?? 0)).join(" · ")
    : "no groups";
  el("tierHotLab").textContent = hot + " / tgt " + (t.targetHot ?? "—") + " (max " + (t.maxHot ?? "—") + ")";
  el("tierWarmLab").textContent = warm + " / tgt " + (t.targetWarm ?? "—") + " (max " + (t.maxWarm ?? "—") + ")";
  el("tierColdLab").textContent = cold + " / tgt " + (t.targetCold ?? "—") + " (max " + (t.maxCold ?? "—") + ")";
  el("barHot").style.width = barPct(hot, t.maxHot ?? t.targetHot ?? 8) + "%";
  el("barWarm").style.width = barPct(warm, t.maxWarm ?? t.targetWarm ?? 24) + "%";
  el("barCold").style.width = barPct(cold, t.maxCold ?? t.targetCold ?? 64) + "%";
  renderPeers(el("hotList"), peers.hotKeys || gov?.hotKeys || [], "hot");
  renderPeers(el("warmList"), gov?.warmKeys || [], "warm");
  renderPeers(el("coldList"), gov?.coldSample || [], "cold");
  renderErrors(el("errList"), recentErrors);
  renderGroups(el("groupList"), groups);
  renderKv(el("targetsKv"), [
    ["targetHot", t.targetHot ?? "—"], ["targetWarm", t.targetWarm ?? "—"], ["targetCold", t.targetCold ?? "—"],
    ["maxHot", t.maxHot ?? "—"], ["maxWarm", t.maxWarm ?? "—"], ["maxCold", t.maxCold ?? "—"],
    ["tickCount", tickCount ?? "—"], ["lastTickMs", lastTickMs ?? "—"],
    ["failedPeers", failedPeers ?? "—"], ["lrGroups", groups.length],
  ]);
  renderKv(el("metricsKv"), [
    ["node", m.node ?? "gerolamo"], ["network", m.network ?? "—"], ["tipSlot", tip ?? "—"],
    ["utxoCount", m.utxoCount ?? "—"], ["epoch", m.epoch ?? "—"],
    ["epochNonce", m.epochNonce ? String(m.epochNonce).slice(0, 24) + "…" : "—"],
    ["role", m.role ?? "—"], ["inbound", m.inbound ? (m.inbound.listening ? m.inbound.host + ":" + m.inbound.port + " · " + m.inbound.clients + " client(s)" : "off") : "—"],
    ["bodyValidation", m.bodyValidation ?? "—"], ["scriptValidation", m.scriptValidation ?? "—"],
    ["uptimeSec", m.uptimeSec ?? "—"], ["hot", hot], ["warm", warm], ["cold", cold], ["total", total],
    ["nodeCpu", m.process && m.process.cpuPercent != null ? m.process.cpuPercent + "%" : "—"],
    ["nodeRss", m.process ? fmtBytes(m.process.rssBytes) : "—"],
    ["nodeHeap", m.process ? fmtBytes(m.process.heapUsedBytes) + " / " + fmtBytes(m.process.heapTotalBytes) : "—"],
    ["hostCpu", m.system ? (m.system.cpuPercent != null ? m.system.cpuPercent + "%" : "—") + " · " + m.system.cpus + " cores" : "—"],
    ["hostMem", m.system ? fmtBytes(m.system.usedMemBytes) + " / " + fmtBytes(m.system.totalMemBytes) : "—"],
    ["tickCount", tickCount ?? "—"], ["lastTickMs", lastTickMs ?? "—"], ["lastTickAt", lastTickAt ? fmtAgo(lastTickAt) : "—"],
    ["failedPeers", failedPeers ?? "—"], ["recentErrors", recentErrors.length],
    ["lrGroups", groups.length],
    ["transport", useWs ? "ws" : "poll"],
  ]);
  if (useWs) setBadge(hot > 0 ? "ok" : (total > 0 ? "warn" : "bad"), hot > 0 ? "ws · syncing" : (total > 0 ? "ws · no hot" : "ws · no peers"));
  else if (hot > 0) setBadge("ok", "poll · syncing");
  else if (total > 0) setBadge("warn", "poll · no hot");
  else setBadge("bad", "poll · no peers");
  el("updated").textContent = " · " + new Date().toLocaleTimeString();
  el("raw").textContent = JSON.stringify({ metrics: m, governor: gov, transport: useWs ? "ws" : "poll" }, null, 2);
}
function applyTip(d) {
  if (!d) return;
  const m = Object.assign({}, lastMetrics || {}, { tipSlot: d.slot });
  if (d.epoch != null) m.epoch = d.epoch;
  applyView(m, lastGov);
}
async function jget(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}
async function tick() {
  if (useWs) return;
  try {
    const [m, g] = await Promise.all([jget("/metrics"), jget("/governor").catch(() => null)]);
    applyView(m, g || m.governor || null);
  } catch (e) {
    setBadge("bad", "error");
    el("updated").textContent = " · " + String(e.message || e);
  }
}
function connectWs() {
  let ws;
  try {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host + "/ws/stats");
  } catch (e) { useWs = false; return; }
  ws.onopen = () => { useWs = true; setBadge("ok", "ws"); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "metrics") applyView(msg.data, msg.data && msg.data.governor);
      else if (msg.type === "peers" || msg.type === "governor") applyView(lastMetrics, msg.data);
      else if (msg.type === "tip") applyTip(msg.data);
      else if (msg.type === "hello") { /* ok */ }
    } catch (_) {}
  };
  ws.onclose = () => { useWs = false; setBadge("warn", "poll"); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
connectWs();
tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;
}

export async function startPeerBlockServer(
    config: GerolamoConfig,
    manager: any,
) {
    const BASE_PATH = getBasePath();
    const port = config.port || 3030;
    const network = config.network ?? process.env.NETWORK ?? "unknown";

    interface BlockRow {
        block_fetch_RawCbor?: Uint8Array;
    }

    const server = Bun.serve({
        ...(config.unixSocket
            ? { unix: "./src/gerolamo.socket" }
            : { port }),
        async fetch(req: Request, srv: import("bun").Server<WsClientData>): Promise<Response | undefined> {
            const url = new URL(req.url);

            // Bun WebSocket upgrade — ops stream (tip/peers/metrics)
            if (url.pathname === "/ws/stats" || url.pathname === "/ws") {
                const ok = srv.upgrade(req, {
                    data: {
                        id: nextClientId(),
                        topics: defaultTopics(),
                    } satisfies WsClientData,
                });
                if (!ok) {
                    return new Response("WebSocket upgrade failed", { status: 400 });
                }
                return undefined;
            }

            // OpenAPI 3 + Swagger docs (/docs, /openapi.json); old /dashboard/ai → 302 /docs
            const oaResp = await handleOpenApiRoutes(req, url, {
                network: config.network ?? process.env.NETWORK,
                port,
            });
            if (oaResp) return oaResp;

            // Mini-Blockfrost core (/api/v0/*) — before generic fallback
            const bfResp = await handleMiniBlockfrost(req, url, {
                network: config.network ?? process.env.NETWORK,
                submitTx: manager
                    ? (txCbor: Uint8Array) => {
                        manager.submitTx({ txCbor });
                    }
                    : undefined,
            });
            if (bfResp) return bfResp;

            if (url.pathname === "/health" || url.pathname === "/healthz") {
                return new Response(
                    JSON.stringify({
                        healthy: true,
                        network,
                        port,
                        uptimeSec: Math.round(process.uptime()),
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            }
            // Landing page = live stats dashboard (not the endpoints text dump)
            if (url.pathname === "/" || url.pathname === "/index.html") {
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: "/stats",
                        "Cache-Control": "no-store",
                    },
                });
            }
            if (
                url.pathname === "/stats" ||
                url.pathname === "/dashboard"
            ) {
                return new Response(statsHtmlPage(port, String(network)), {
                    status: 200,
                    headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cache-Control": "no-store",
                    },
                });
            }
            if (
                url.pathname === "/governor" ||
                url.pathname === "/api/v0/governor"
            ) {
                const snap =
                    typeof manager?.getGovernorSnapshot === "function"
                        ? manager.getGovernorSnapshot()
                        : null;
                return new Response(
                    JSON.stringify(
                        snap ?? {
                            note: "governor unavailable (legacy path or not started)",
                        },
                    ),
                    {
                        status: snap ? 200 : 503,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            }
            if (url.pathname === "/metrics") {
                try {
                    const body = await buildMetricsPayload(config, manager);
                    return new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                } catch (e: any) {
                    logger.error("/metrics error:", e?.message || e);
                    return new Response(
                        JSON.stringify({ error: "metrics unavailable" }),
                        {
                            status: 500,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                }
            }
            if (req.method === "POST" && url.pathname === "/txsubmit") {
                if (!manager) {
                    return new Response("Peer manager not available", {
                        status: 500,
                    });
                }
                try {
                    const txCbor = new Uint8Array(await req.arrayBuffer());
                    if (txCbor.length === 0) {
                        return new Response("Empty tx body", { status: 400 });
                    }
                    logger.info(
                        `HTTP txsubmit: ${txCbor.length} bytes from ${
                            req.headers.get("user-agent") || "unknown"
                        }`,
                    );
                    manager.submitTx({ txCbor });
                    return new Response(
                        JSON.stringify({ status: "relayed to hot peers" }),
                        {
                            status: 202,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                } catch (e: any) {
                    logger.error("txsubmit error:", e.message || e);
                    return new Response("Invalid request", { status: 400 });
                }
            }
            if (url.pathname.startsWith("/utxo/")) {
                const ref = decodeURIComponent(url.pathname.slice(6));
                logger.info(`UTXO query for ref: ${ref}`);

                // Validate format: txhash (64 hex) or txhash:index (digits)
                if (!/^[0-9a-f]{64}(:\d+)?$/i.test(ref)) {
                    return new Response(
                        "Invalid format: /utxo/{64hex-txhash} or /utxo/{64hex-txhash}:{index}",
                        { status: 400 },
                    );
                }

                const parts = ref.split(":");
                let responseBody: string;
                let status = 200;

                if (parts.length === 1) {
                    // txhash only: all outputs
                    const txHash = parts[0];
                    const utxos = await getUtxosByTxHash(txHash);
                    if (utxos.length === 0) {
                        return new Response("No UTXOs found for tx hash", {
                            status: 404,
                        });
                    }
                    logger.info(
                        `Found ${utxos.length} UTXOs for tx ${
                            txHash.slice(0, 8)
                        }...`,
                    );
                    responseBody = JSON.stringify(
                        utxos.map((u: any) => u.tx_out),
                    );
                } else {
                    // specific utxo_ref
                    const idx = parseInt(parts[1], 10);
                    if (isNaN(idx) || idx < 0) {
                        return new Response("Invalid output index", {
                            status: 400,
                        });
                    }
                    const utxo = await getUtxoByRef(ref);
                    if (!utxo) {
                        return new Response("UTXO not found", { status: 404 });
                    }
                    responseBody = utxo.tx_out;
                }

                return new Response(responseBody, {
                    status,
                    headers: { "Content-Type": "application/json" },
                });
            }
            if (
                !url.pathname.startsWith("/block/") &&
                !url.pathname.startsWith("/utxo/")
            ) {
                return new Response(
                    "Endpoints: GET /health GET /metrics GET /governor GET /stats GET /ws/stats GET /docs GET /openapi.json GET /api/v0/* GET /block/{slot|hash} GET /utxo/{txhash:index} POST /txsubmit (CBOR tx body)",
                    { status: 200 },
                );
            }
            const id = decodeURIComponent(url.pathname.slice(7));
            let row: any;

            if (/^\d+n?$/.test(id)) {
                const slot = BigInt(id.replace("n", ""));
                row = (await getBlockBySlot(slot)) ?? null;
            } else {
                row = (await getBlockByHash(id)) ?? null;
            }

            if (!row?.block_fetch_RawCbor) {
                return new Response("Block not found", { status: 404 });
            }
            return new Response(toHex(row.block_fetch_RawCbor), {
                headers: { "Content-Type": "application/cbor" },
            });
        },
        websocket: {
            data: {} as WsClientData,
            open(ws) {
                for (const t of ws.data.topics) {
                    try { ws.subscribe(t); } catch { /* */ }
                }
                try {
                    ws.send(JSON.stringify({
                        v: 1,
                        type: "hello",
                        network: String(network),
                        port,
                        topics: [...allTopics()],
                    }));
                } catch { /* */ }
                void (async () => {
                    try {
                        const body = await buildMetricsPayload(config, manager);
                        if (ws.getBufferedAmount() < 256_000) {
                            ws.send(JSON.stringify({
                                v: 1, type: "metrics", data: body,
                                ts: new Date().toISOString(),
                            }));
                        }
                        const snap = typeof manager?.getGovernorSnapshot === "function"
                            ? manager.getGovernorSnapshot()
                            : null;
                        if (snap && ws.getBufferedAmount() < 256_000) {
                            ws.send(JSON.stringify({
                                v: 1, type: "peers", data: snap,
                                ts: new Date().toISOString(),
                            }));
                        }
                    } catch { /* */ }
                })();
            },
            message(ws, message) {
                try {
                    const msg = JSON.parse(String(message));
                    if (msg?.op === "ping") {
                        ws.send(JSON.stringify({ v: 1, type: "pong", t: msg.t }));
                        return;
                    }
                    if (msg?.op === "subscribe" && Array.isArray(msg.topics)) {
                        for (const t of msg.topics) {
                            if (isWsTopic(t)) {
                                ws.data.topics.add(t);
                                try { ws.subscribe(t); } catch { /* */ }
                            }
                        }
                        return;
                    }
                    if (msg?.op === "unsubscribe" && Array.isArray(msg.topics)) {
                        for (const t of msg.topics) {
                            if (isWsTopic(t)) {
                                ws.data.topics.delete(t);
                                try { ws.unsubscribe(t); } catch { /* */ }
                            }
                        }
                    }
                } catch { /* ignore */ }
            },
            close(_ws) { /* */ },
        },
    });
    attachWsServer(server);

    let lastMetricsPush = 0;
    setTipListener((tip) => {
        wsPublish("tip", tip);
        const now = Date.now();
        if (now - lastMetricsPush < 1000) return;
        lastMetricsPush = now;
        void buildMetricsPayload(config, manager)
            .then((body) => wsPublish("metrics", body))
            .catch(() => {});
    });
    setPeersListener((snap) => {
        wsPublish("peers", snap);
        wsPublish("governor", snap);
    });

    logger.info(
        `Serving blocks, stats, WS /ws/stats, OpenAPI /docs, and txsubmit on http://localhost:${port}`,
    );
}
