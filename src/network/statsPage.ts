/**
 * The node's built-in stats page (GET /stats): one of the two Gerolamo UIs (the other is
 * the desktop app). Self-contained HTML; the script inside uses string concatenation only,
 * never template literals, because the whole page is one TypeScript template literal.
 *
 * Layout: header (role badge, network, build, transport) → KPI row → block production
 * (producers only; gLiveView vocabulary) → peers (outbound table with duplex state,
 * inbound clients, governor tiers / local roots / errors) → resources charts → chain
 * (recent blocks, mempool) → raw JSON.
 */
export function statsHtmlPage(port: number, network: string, epochLengthSlots: number): string {
    const cfg = JSON.stringify({ port, net: String(network || "unknown"), epochLength: epochLengthSlots });
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Gerolamo stats · :${port}</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --sunk:#0b0f14; --b:#30363d; --t:#e6edf3; --m:#8b949e; --d:#6e7681; --g:#3fb950; --y:#d29922; --r:#f85149; --a:#58a6ff; --p:#bc8cff; --hot:#3fb950; --warm:#d29922; --cold:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,sans-serif; background:var(--bg); color:var(--t); }
  a { color:var(--a); }
  code, .mono { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
  code { background:var(--sunk); padding:1px 5px; border-radius:4px; }
  header { position:sticky; top:0; z-index:20; padding:10px 20px; border-bottom:1px solid var(--b); background:rgba(13,17,23,.92); backdrop-filter:blur(6px); display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; }
  header h1 { margin:0; font-size:17px; font-weight:650; display:flex; align-items:center; gap:10px; }
  header .meta { color:var(--m); font-size:12px; display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; }
  header .right { margin-left:auto; display:flex; gap:10px; align-items:center; }
  .badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:650; border:1px solid var(--b); letter-spacing:.02em; white-space:nowrap; }
  .ok { color:var(--g); border-color:#238636; background:#12261a; }
  .warn { color:var(--y); border-color:#9e6a03; background:#2a2108; }
  .bad { color:var(--r); border-color:#da3633; background:#2a1214; }
  .info { color:var(--a); border-color:#1f6feb; background:#0f1d33; }
  .purple { color:var(--p); border-color:#8957e5; background:#211735; }
  .muted { color:var(--m); }
  main { padding:16px 20px 32px; max-width:min(1800px,98vw); margin:0 auto; display:flex; flex-direction:column; gap:14px; }
  section > h2, .card > h2 { margin:0 0 10px; font-size:13px; font-weight:650; color:var(--m); text-transform:uppercase; letter-spacing:.06em; display:flex; align-items:center; gap:10px; }
  section > h2 .badge, .card > h2 .badge { text-transform:none; letter-spacing:0; }
  .card { background:var(--card); border:1px solid var(--b); border-radius:10px; padding:12px 14px; min-width:0; position:relative; }
  .card[data-tooltip] { cursor:help; }
  .card[data-tooltip]:hover { border-color:#484f58; }
  .card[data-tooltip]::after { content:attr(data-tooltip); position:absolute; left:0; top:calc(100% + 8px); width:max-content; max-width:min(360px,80vw); padding:10px 12px; border-radius:8px; background:#1c2128; color:var(--t); border:1px solid #484f58; box-shadow:0 8px 24px rgba(0,0,0,.45); font:12px/1.45 ui-sans-serif,system-ui,sans-serif; white-space:pre-line; text-align:left; opacity:0; pointer-events:none; z-index:50; transition:opacity .12s ease; }
  .card[data-tooltip]:hover::after { opacity:1; }
  .kpis { display:grid; grid-template-columns:repeat(8,minmax(0,1fr)); gap:10px; }
  @media (max-width:1400px) { .kpis { grid-template-columns:repeat(4,minmax(0,1fr)); } }
  @media (max-width:700px) { .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  .kpi .k { color:var(--m); font-size:11px; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .kpi .v { font-size:22px; font-weight:650; margin-top:4px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.2; }
  .kpi .s { color:var(--m); font-size:11px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar { height:6px; background:var(--b); border-radius:3px; margin-top:8px; overflow:hidden; }
  .bar > i { display:block; height:100%; width:0; background:var(--a); border-radius:3px; transition:width .6s ease; }
  .bar.hot > i { background:var(--hot); } .bar.warm > i { background:var(--warm); } .bar.cold > i { background:var(--cold); } .bar.kes > i { background:var(--p); }
  .grid { display:grid; gap:12px; }
  .g3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .g2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .prod { grid-template-columns:1.1fr 1.6fr 1.4fr; }
  @media (max-width:1200px) { .g3, .prod { grid-template-columns:1fr; } .g2 { grid-template-columns:1fr; } }
  .kv { display:grid; grid-template-columns:max-content 1fr; gap:5px 14px; font-size:12.5px; }
  .kv span:nth-child(odd) { color:var(--m); white-space:nowrap; }
  .kv span:nth-child(even) { font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .tiles { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .tile { background:var(--sunk); border:1px solid var(--b); border-radius:8px; padding:8px 10px; text-align:center; }
  .tile .k { color:var(--m); font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
  .tile .v { font-size:20px; font-weight:650; font-variant-numeric:tabular-nums; margin-top:2px; }
  .tile.good .v { color:var(--g); } .tile.warnv .v { color:var(--y); } .tile.badv .v { color:var(--r); } .tile.accent .v { color:var(--a); }
  .big { font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.1; }
  .countdown { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--a); }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:var(--m); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding:6px 8px; border-bottom:1px solid var(--b); white-space:nowrap; }
  td { padding:6px 8px; border-bottom:1px solid #21262d; font-variant-numeric:tabular-nums; vertical-align:top; white-space:nowrap; }
  td.wrap { white-space:normal; overflow-wrap:anywhere; }
  tr:last-child td { border-bottom:0; }
  .tbl { overflow-x:auto; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; background:var(--m); }
  .dot.hot { background:var(--hot); } .dot.warm { background:var(--warm); } .dot.cold { background:var(--cold); } .dot.in { background:var(--p); }
  .empty { color:var(--d); font-style:italic; }
  .out { font-weight:650; }
  .out.upcoming { color:var(--a); } .out.adopted { color:var(--g); } .out.confirmed { color:var(--g); } .out.invalid { color:var(--r); } .out.missed { color:var(--y); } .out.ghosted { color:var(--r); } .out.stolen { color:var(--r); }
  ul.list { list-style:none; margin:0; padding:0; font-size:12.5px; }
  ul.list li { padding:4px 0; border-bottom:1px solid #21262d; display:flex; gap:8px; align-items:baseline; }
  ul.list li:last-child { border-bottom:0; }
  .res .head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; color:var(--m); font-size:12px; }
  .res .head b { color:var(--t); font-size:13px; font-weight:650; }
  .res .win button { background:transparent; color:var(--m); border:1px solid var(--b); border-radius:4px; padding:2px 8px; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; margin-left:4px; }
  .res .win button.on { color:var(--a); border-color:rgba(88,166,255,.45); background:rgba(88,166,255,.08); }
  .chart .t { display:flex; justify-content:space-between; gap:8px; color:var(--m); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .chart .t span:last-child { color:var(--t); text-transform:none; letter-spacing:0; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .chart svg { width:100%; height:96px; display:block; margin-top:6px; background:var(--sunk); border:1px solid var(--b); border-radius:6px; }
  .chart .lg { display:flex; justify-content:space-between; gap:8px; margin-top:4px; color:var(--m); font-size:10px; }
  .chart .lg i { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle; }
  pre { background:var(--sunk); border:1px solid var(--b); border-radius:8px; padding:12px; overflow:auto; font-size:11px; margin:10px 0 0; max-height:320px; }
  details summary { cursor:pointer; color:var(--m); font-size:12px; }
  footer { color:var(--m); font-size:12px; padding:0 20px 24px; max-width:min(1800px,98vw); margin:0 auto; }
  .hint { color:var(--m); font-size:11.5px; margin:8px 0 0; }
</style>
</head>
<body>
<header>
  <h1>Gerolamo <span id="roleBadge" class="badge muted">…</span></h1>
  <div class="meta">
    <span>network <code id="net">—</code></span>
    <span>port <code>${port}</code></span>
    <span>build <code id="build">—</code></span>
    <span id="transport" class="badge warn">connecting</span>
  </div>
  <div class="right">
    <span id="status" class="badge warn">loading</span>
    <span class="meta" id="updated"></span>
  </div>
</header>
<main>
  <section class="kpis">
    <div class="card kpi" data-tooltip="Chain tip: the last block applied to this node's chain. The subtitle is the gap to the best tip our peers report; at the tip it reads 0 slots."><div class="k">Chain tip</div><div class="v" id="tip">—</div><div class="s" id="tipNote">—</div></div>
    <div class="card kpi" data-tooltip="Epoch of the tip, progress through it, and the epoch nonce (η0) once known. While syncing the target epoch (best peer tip) follows a slash."><div class="k">Epoch</div><div class="v" id="epoch">—</div><div class="bar"><i id="epochBar"></i></div><div class="s" id="epochNote"></div></div>
    <div class="card kpi" data-tooltip="Ledger era of the tip block (Byron … Conway) and the era index the hard-fork combinator uses."><div class="k">Era</div><div class="v" id="era">—</div><div class="s" id="eraNote"></div></div>
    <div class="card kpi" data-tooltip="Process uptime and the build label (package version + commit; -dirty = local edits)."><div class="k">Uptime</div><div class="v" id="up">—</div><div class="s" id="upNote"></div></div>
    <div class="card kpi" data-tooltip="Validation policy: body (strict = reject bad bodies) / script (Plutus evaluation). ledgerComplete false means the node follows the tip without a full ledger behind it."><div class="k">Validation</div><div class="v" id="flags">—</div><div class="s" id="flagsNote"></div></div>
    <div class="card kpi" data-tooltip="Outbound peers by tier: hot = ChainSync running (one primary, the others verify its headers), warm = connected standby (KeepAlive), cold = known addresses."><div class="k">Peers</div><div class="v" id="peersV">—</div><div class="s" id="peersNote">hot · warm · cold</div></div>
    <div class="card kpi" data-tooltip="Inbound node-to-node listener: connected clients, and how many of our outbound peers pull our chain over duplex (the connections we opened). Both paths carry the blocks this node forges."><div class="k">Serving</div><div class="v" id="serveV">—</div><div class="s" id="serveNote">—</div></div>
    <div class="card kpi" data-tooltip="Transactions waiting in the mempool (pulled from peers over tx-submission and local submits). A producer forges from these."><div class="k">Mempool</div><div class="v" id="mpV">—</div><div class="s" id="mpNote">—</div></div>
  </section>

  <section id="prodSection" hidden>
    <h2>Block production <span id="prodMode" class="badge muted">—</span></h2>
    <div class="grid prod">
      <div class="card" data-tooltip="Operator keys and certificate. KES: current period, evolutions used of the maximum, and when the certificate expires (rotate before then). OP cert: counter on disk vs the last one the chain has seen for this pool (disk must be ≥ chain). Missed slot leader checks: slots the wall-clock ticker never evaluated because the process stalled.">
        <h2>Core</h2>
        <div class="kv" id="coreKv"></div>
        <div class="bar kes"><i id="kesBar"></i></div>
        <div class="hint" id="kesNote"></div>
      </div>
      <div class="card" data-tooltip="This epoch, gLiveView terms. Leader: slots scheduled for the pool. Ideal: expected slots for its stake (σ·f·epoch length). Luck: leader/ideal. Adopted: forged and applied to our chain. Confirmed: adopted and still on our chain 10 blocks deep. Invalid: our own rules rejected the forge. Missed: a leader slot passed without a forge. Ghosted: adopted, then rolled away with nothing at the slot. Stolen: another pool's block replaced ours (slot battle lost).">
        <h2>Epoch <span id="prodEpoch" class="mono"></span></h2>
        <div class="tiles" id="epochTiles"></div>
      </div>
      <div class="card" data-tooltip="Next leader slot with a live countdown from the wall clock, then every leader slot of the scheduled epochs with its outcome.">
        <h2>Schedule</h2>
        <div id="nextSlot" class="big">—</div>
        <div id="countdown" class="countdown">—</div>
        <div class="hint" id="nextNote"></div>
        <div class="hint" id="carriers" title="Who would carry a block forged right now: inbound clients chain-syncing from us and remotes pulling over duplex. Zero means a forged block stays on this node."></div>
        <div class="tbl" style="margin-top:10px"><table><thead><tr><th>Slot</th><th>Time (local)</th><th>Outcome</th><th>Detail</th></tr></thead><tbody id="slotRows"><tr><td colspan="4" class="empty">no schedule yet</td></tr></tbody></table></div>
      </div>
    </div>
  </section>

  <section>
    <h2>Peers <span id="peerSummary" class="badge muted">—</span></h2>
    <div class="card tbl" data-tooltip="Outbound connections this node opened. Tier: hot (ChainSync), warm (KeepAlive standby), cold (known only). Role: the primary drives block download; verifiers cross-check its headers (agrees / divergent / behind). Tip and lag: the peer's reported tip against ours. Duplex: with InitiatorAndResponder negotiated we also serve our chain over this connection; 'pulling' means the peer has started reading it — the path a forged block takes out. Source: topology local root, public root, ledger (registered relays) or shared (peer sharing). Version: negotiated node-to-node protocol.">
      <table>
        <thead><tr><th>Peer</th><th>Tier</th><th>Role · status</th><th>Tip</th><th>Lag</th><th>Headers</th><th>RTT</th><th>Duplex</th><th>Source</th><th>Ver</th><th>Connected</th><th>Last block</th><th>Fails</th></tr></thead>
        <tbody id="peerRows"><tr><td colspan="13" class="empty">no peers yet</td></tr></tbody>
      </table>
    </div>
    <div class="grid g3" style="margin-top:12px">
      <div class="card tbl" data-tooltip="Peers that connected to our inbound listener (port forwarded from the registered relay address). Pulled: the slot the client has read up to over ChainSync; a client at our tip is carrying our blocks. Connections without a handshake are probes or scanners and drop after 10 s.">
        <h2>Inbound clients <span id="inboundBadge" class="badge muted">—</span></h2>
        <table><thead><tr><th>Client</th><th>Ver</th><th>Since</th><th>Pulled to</th></tr></thead><tbody id="inRows"><tr><td colspan="4" class="empty">none connected</td></tr></tbody></table>
      </div>
      <div class="card" data-tooltip="Governor tiers against their targets (max = hard cap). The tick line is the governor loop: count, duration and age of the last run. Local roots: each topology localRoots[] group must keep at least its valency in hot peers.">
        <h2>Governor</h2>
        <div class="kv" style="margin-bottom:8px"><span>Hot</span><span id="tierHotLab">—</span></div><div class="bar hot"><i id="barHot"></i></div>
        <div class="kv" style="margin:8px 0"><span>Warm</span><span id="tierWarmLab">—</span></div><div class="bar warm"><i id="barWarm"></i></div>
        <div class="kv" style="margin:8px 0"><span>Cold</span><span id="tierColdLab">—</span></div><div class="bar cold"><i id="barCold"></i></div>
        <div class="kv" style="margin-top:10px" id="govKv"></div>
        <ul class="list" id="groupList" style="margin-top:8px"></ul>
      </div>
      <div class="card" data-tooltip="Peers that failed recently (handshake timeout, connect failure, terminated), with their fail count and backoff, and peers held cold for serving bad data (malicious).">
        <h2>Peer errors <span id="errBadge" class="badge muted">—</span></h2>
        <ul class="list" id="errList"><li class="empty">none</li></ul>
        <h2 style="margin-top:12px">Held as malicious</h2>
        <ul class="list" id="malList"><li class="empty">none</li></ul>
      </div>
    </div>
  </section>

  <section class="res card" data-tooltip="One sample every 2 s from GET /resources: process CPU / RSS / heap, host CPU / memory, blocks applied per second. The browser keeps the samples.">
    <div class="head"><b>Resources</b><span id="resMeta">—</span><span class="win">window <button id="win5" class="on">5 min</button><button id="win10">10 min</button> <span id="resSpan"></span></span></div>
    <div class="grid g3">
      <div class="chart"><div class="t"><span>CPU</span><span id="cpuHead">—</span></div><svg id="cpuSvg" viewBox="0 0 600 96" preserveAspectRatio="none"></svg><div class="lg"><span><i style="background:var(--a)"></i>node (cores)</span><span><i style="background:var(--m)"></i>host %</span></div></div>
      <div class="chart"><div class="t"><span>Memory</span><span id="memHead">—</span></div><svg id="memSvg" viewBox="0 0 600 96" preserveAspectRatio="none"></svg><div class="lg"><span><i style="background:var(--a)"></i>RSS</span><span><i style="background:var(--p)"></i>heap</span><span><i style="background:var(--m)"></i>host %</span></div></div>
      <div class="chart"><div class="t"><span>Blocks / s</span><span id="bpsHead">—</span></div><svg id="bpsSvg" viewBox="0 0 600 96" preserveAspectRatio="none"></svg><div class="lg"><span><i style="background:var(--g)"></i>applied</span></div></div>
    </div>
  </section>

  <section class="grid g2">
    <div class="card tbl" data-tooltip="The newest stored blocks, newest first: slot, height, hash, size. A block this pool forged shows its slot in the schedule above.">
      <h2>Recent blocks</h2>
      <div class="muted" id="ledgerStoreLine" data-tooltip="LMDB ledger store (docs/PLAN_LMDB_LEDGER.md): state at the anchor in LMDB plus one in-memory diff per volatile block. dual = written beside SQLite and compared after every block; lmdb = answers the ledger reads."></div>
      <div class="muted" id="blockStoreLine" data-tooltip="cardano-node-format block store: immutable chunk files + volatile files under <nodeDir>/db. mirror = written beside SQLite; primary = the block store IS the block store (SQLite blocks table frozen). relay = which store peers are served from."></div>
      <table><thead><tr><th>Slot</th><th>Height</th><th>Hash</th><th>Size</th></tr></thead><tbody id="blockRows"><tr><td colspan="4" class="empty">—</td></tr></tbody></table>
    </div>
    <div class="card" data-tooltip="Sync engine: mode (genesis / tip / point / resume), primary peer, quorum, BlockFetch ranges in flight / queued / awaiting apply / retried, validation workers, pending headers. A halt means strict validation stopped the applier.">
      <h2>Sync engine</h2>
      <div class="kv" id="syncKv"></div>
      <h2 style="margin-top:12px">Mempool</h2>
      <div class="kv" id="mempoolKv"></div>
      <ul class="list" id="mempoolTxs"></ul>
    </div>
  </section>

  <details class="card">
    <summary>Raw JSON · /metrics + /governor</summary>
    <pre id="raw">{}</pre>
  </details>
</main>
<footer>
  Live over <code>/ws/stats</code> (tip / peers / metrics), polling <code>/metrics</code> + <code>/governor</code> every 5 s as fallback · <a href="/docs">OpenAPI /docs</a> · <a href="/openapi.json">openapi.json</a>
</footer>
<script>
const CFG = ${cfg};
const fmt = (n) => n == null || n === "" || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US");
const el = (id) => document.getElementById(id);
const esc = (s) => { const t = String(s == null ? "" : s); return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); };
let useWs = false, lastMetrics = null, lastGov = null;
function setBadge(id, kind, text) { const b = el(id); b.textContent = text; b.className = "badge " + kind; }
function fmtUptime(sec) {
  if (sec == null) return "—";
  const s = Math.max(0, Math.floor(Number(sec)));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + r + "s";
  return r + "s";
}
function fmtAgo(ms) { if (!ms) return "—"; const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000)); return s < 60 ? s + " s" : s < 3600 ? Math.round(s / 60) + " min" : s < 86400 ? (s / 3600).toFixed(1) + " h" : (s / 86400).toFixed(1) + " d"; }
function fmtIn(sec) { if (sec == null) return "—"; if (sec <= 0) return "now"; return sec < 90 ? sec + " s" : sec < 5400 ? Math.round(sec / 60) + " min" : (sec / 3600).toFixed(1) + " h"; }
function fmtBytes(b) { if (b == null || !isFinite(Number(b)) || Number(b) < 0) return "—"; const n = Number(b); return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB"; }
function when(iso) { if (!iso) return "—"; const t = new Date(iso); return isNaN(t.getTime()) ? String(iso) : t.toLocaleString(undefined, { hour12: false }); }
function hms(sec) { const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r; }
function barPct(cur, max) { const c = Number(cur) || 0, m = Math.max(1, Number(max) || 1); return Math.min(100, Math.round((c / m) * 100)); }
function kv(container, rows) { container.innerHTML = rows.map((r) => "<span>" + esc(r[0]) + "</span><span>" + (r[2] ? r[1] : esc(r[1])) + "</span>").join(""); }
function badge(kind, text) { return '<span class="badge ' + kind + '">' + esc(text) + "</span>"; }
function short(h, n) { return h ? esc(String(h).slice(0, n || 12)) + "…" : "—"; }

// ── next leader slot countdown (wall clock, from the schedule's ISO time) ──
let nextSlotTime = null;
setInterval(() => {
  if (!nextSlotTime) return;
  const d = (nextSlotTime - Date.now()) / 1000;
  el("countdown").textContent = d > 0 ? "in " + hms(d) : "now";
}, 1000);

function renderProducer(m) {
  const p = m.producer;
  const sec = el("prodSection");
  if (!p) { sec.hidden = true; nextSlotTime = null; return; }
  sec.hidden = false;
  setBadge("prodMode", p.dryRun ? "warn" : "ok", p.dryRun ? "dry run · nothing forged" : "forging");
  const kes = p.kes, oc = p.opcert || {};
  const chainBad = oc.chainCounter != null && Number(oc.counter) < Number(oc.chainCounter);
  kv(el("coreKv"), [
    ["Pool", '<code title="' + esc(p.poolId) + '">' + short(p.poolId, 16) + "</code>", true],
    ["VRF key hash", short(p.vrfKeyHash, 16)],
    ["KES current | remaining | exp", kes ? kes.period + " | " + kes.remaining + " of " + kes.maxEvolutions + " | " + when(kes.expiresAt) : "period " + oc.kesPeriod + " · evolution " + p.kesEvolution],
    ["OP cert disk | chain", badge(chainBad || (kes && kes.counter === "ahead-of-chain") ? "bad" : "ok", oc.counter + " | " + (oc.chainCounter == null ? "none yet" : oc.chainCounter)), true],
    ["KES health", kes && kes.health ? badge({ ok: "ok", "rotate-soon": "warn", "rotate-now": "bad", expired: "bad", "not-yet-valid": "bad" }[kes.health] || "muted", { ok: "ok", "rotate-soon": "rotate soon", "rotate-now": "ROTATE NOW", expired: "EXPIRED: no blocks", "not-yet-valid": "certificate not valid yet" }[kes.health] || kes.health) : "—", true],
    ["Missed slot leader checks", badge(Number(p.missedLeaderChecks) > 0 ? "warn" : "ok", String(p.missedLeaderChecks || 0)), true],
    ["Schedules", (p.scheduledEpochs && p.scheduledEpochs.length ? "epochs " + p.scheduledEpochs.join(", ") : "none yet") + " · " + p.leaderSlotsKnown + " leader slot(s)"],
    ["Forged (all time)", fmt(p.forged) + (p.lastForgedSlot != null ? " · last slot " + fmt(p.lastForgedSlot) : "")],
    ["Last error", p.lastError ? badge("bad", p.lastError) : "—", !!p.lastError],
  ]);
  if (kes) {
    el("kesBar").style.width = barPct(kes.evolution, kes.maxEvolutions) + "%";
    el("kesBar").style.background = kes.health === "ok" ? "" : kes.health === "rotate-soon" ? "var(--y)" : "var(--r)";
    const left = (new Date(kes.expiresAt).getTime() - Date.now()) / 86400000;
    el("kesNote").textContent = "KES evolution " + kes.evolution + " of " + kes.maxEvolutions + (isFinite(left) ? " · certificate expires in " + left.toFixed(1) + " days" : "")
      + (kes.health === "ok" ? "" : " · rotate: bun scripts/pool-register.ts rotate-kes --dir <pool keys> (where the cold key lives), copy kes.skey / kes.vkey / node.cert to the producer, restart it")
      + (kes.counter === "ahead-of-chain" ? " · certificate counter is more than one above the chain's: blocks will be rejected" : "");
  }
  const es = p.epochStats;
  el("prodEpoch").textContent = es ? String(es.epoch) : "";
  if (es) {
    const tile = (k, v, cls) => '<div class="tile ' + (cls || "") + '"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div></div>";
    el("epochTiles").innerHTML =
      tile("Leader", es.leader, "accent") + tile("Ideal", es.ideal == null ? "—" : es.ideal.toFixed(2)) + tile("Luck", es.luck == null ? "—" : es.luck.toFixed(0) + " %", es.luck == null ? "" : es.luck >= 100 ? "good" : "warnv") +
      tile("Adopted", es.adopted, es.adopted ? "good" : "") + tile("Confirmed", es.confirmed, es.confirmed ? "good" : "") + tile("Invalid", es.invalid, es.invalid ? "badv" : "") +
      tile("Missed", es.missed, es.missed ? "warnv" : "") + tile("Ghosted", es.ghosted, es.ghosted ? "badv" : "") + tile("Stolen", es.stolen, es.stolen ? "badv" : "");
  } else el("epochTiles").innerHTML = '<div class="empty">no σ for this epoch yet</div>';
  const slots = p.leaderSlots || [];
  const next = slots.find((s) => s.slot === p.nextLeaderSlot) || null;
  if (p.nextLeaderSlot != null) {
    el("nextSlot").textContent = "slot " + fmt(p.nextLeaderSlot);
    nextSlotTime = next && next.time ? new Date(next.time).getTime() : null;
    el("nextNote").textContent = next ? when(next.time) + " · epoch " + next.epoch : "";
    if (!nextSlotTime) el("countdown").textContent = "—";
  } else { el("nextSlot").textContent = p.scheduling && !slots.length ? "computing the schedule…" : "no upcoming leader slot"; el("countdown").textContent = ""; el("nextNote").textContent = slots.length ? "all scheduled slots have passed" : ""; nextSlotTime = null; }
  var car = p.carriers;
  if (car) {
    var ncar = car.inbound.length + car.duplex.length;
    el("carriers").innerHTML = "Carriers now: " + badge(ncar > 0 && car.publicReachable !== false ? "ok" : "bad", ncar + " · " + car.inbound.length + " inbound pulling · " + car.duplex.length + " duplex" + (car.publicReachable === false ? " · PUBLIC PORT UNREACHABLE" : "")) + (ncar === 0 ? ' <span class="muted">a block forged now would not leave this node</span>' : "");
  } else el("carriers").textContent = "";
  el("slotRows").innerHTML = slots.length ? slots.map((s) =>
    "<tr><td>" + fmt(s.slot) + "</td><td>" + esc(when(s.time)) + '</td><td><span class="out ' + esc(s.outcome) + '">' + esc(s.outcome) + '</span></td><td class="wrap">' + (s.hash ? "<code>" + short(s.hash, 12) + "</code> " : "") + esc(s.note && s.outcome !== "upcoming" ? s.note : "") + "</td></tr>"
  ).join("") : '<tr><td colspan="4" class="empty">' + (p.scheduling ? "computing the leader schedule (a VRF pass over the epoch)…" : "no schedule yet") + "</td></tr>";
}

function renderPeers(m, gov) {
  const sync = m.sync || {};
  const byKey = {};
  for (const sp of (sync.peers || [])) byKey[sp.key] = sp;
  const ourTip = m.tipSlot != null ? Number(m.tipSlot) : null;
  const list = (gov && gov.peers) || [];
  const rows = list.map((p) => {
    const sp = byKey[p.key];
    const tipN = sp && sp.tipSlot != null ? Number(sp.tipSlot) : (p.tipSlot != null ? Number(p.tipSlot) : null);
    const lag = tipN != null && ourTip != null ? ourTip - tipN : null;
    const role = sp ? (sp.role === "primary" ? badge("info", "primary") : badge("muted", "verifier")) + " " + badge(sp.status === "agrees" ? "ok" : sp.status === "divergent" ? "bad" : sp.status === "behind" || sp.status === "ahead" ? "warn" : "muted", sp.status || "?") : "";
    const dp = p.duplexProtocols || [];
    const duplex = p.duplexPullingSince ? badge("ok", "pulling · " + fmtAgo(p.duplexPullingSince)) : dp.indexOf("keep-alive") >= 0 ? badge("info", "warm at remote") : p.duplexServing ? badge("muted", "offered") : (p.connected ? badge("muted", "no") : "");
    const fails = (p.failCount ? badge(p.malicious ? "bad" : "warn", String(p.failCount)) : "0") + (p.lastError ? ' <span class="muted" title="' + esc(p.lastError) + '">' + esc(String(p.lastError).slice(0, 40)) + "</span>" : "");
    return "<tr><td><span class=\\"dot " + esc(p.tier) + "\\"></span>" + esc(p.key) + (p.localRootGroupId ? ' <span class="muted">' + esc(p.localRootGroupId) + "</span>" : "") + "</td>" +
      "<td>" + esc(p.tier) + "</td><td>" + role + "</td>" +
      "<td>" + (tipN != null ? fmt(tipN) : "—") + "</td><td>" + (lag == null ? "—" : lag === 0 ? badge("ok", "0") : lag > 0 ? badge("warn", "−" + fmt(lag)) : badge("info", "+" + fmt(-lag))) + "</td>" +
      "<td>" + (sp ? fmt(sp.headersSeen) : "—") + "</td><td>" + (p.lastRttMs != null ? p.lastRttMs + " ms" : "—") + "</td>" +
      "<td>" + duplex + "</td><td>" + esc(p.source || "") + (p.trustable ? " ✓" : "") + "</td><td>" + (p.version != null ? p.version : "—") + "</td>" +
      "<td>" + (p.connectedAt ? fmtAgo(p.connectedAt) : (p.nextRetryAt && p.nextRetryAt > Date.now() ? "retry in " + fmtIn(Math.round((p.nextRetryAt - Date.now()) / 1000)) : "—")) + "</td>" +
      "<td>" + (p.lastRollForwardAt ? fmtAgo(p.lastRollForwardAt) : "—") + "</td><td>" + fails + "</td></tr>";
  });
  el("peerRows").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="13" class="empty">no peers yet</td></tr>';
  const inb = m.inbound || {};
  const clients = inb.clientList || [];
  el("inRows").innerHTML = clients.length ? clients.map((c) => {
    const lag = c.chainSyncSlot != null && ourTip != null ? ourTip - c.chainSyncSlot : null;
    return "<tr><td><span class=\\"dot in\\"></span>" + esc(c.peer) + (c.transport === "ws" ? " <span class=\\"muted\\">ws</span>" : "") + "</td><td>" + (c.version != null ? c.version : (c.handshakeOk ? "?" : badge("warn", "no handshake"))) + "</td><td>" + fmtAgo(c.since) + "</td><td>" +
      (c.chainSyncSlot != null ? fmt(c.chainSyncSlot) + " " + (lag === 0 ? badge("ok", "at our tip") : lag != null ? badge("warn", fmt(lag) + " behind") : "") : '<span class="muted">' + ((c.protocols || []).length ? esc((c.protocols || []).join(", ")) : "not pulling") + "</span>") + "</td></tr>";
  }).join("") : '<tr><td colspan="4" class="empty">' + (inb.listening ? "none connected" : "inbound listener off") + "</td></tr>";
  setBadge("inboundBadge", inb.publicReachable && !inb.publicReachable.ok ? "bad" : inb.listening ? (clients.length ? "ok" : "muted") : "warn", inb.publicReachable && !inb.publicReachable.ok ? inb.publicReachable.address + " UNREACHABLE (" + (inb.publicReachable.error || "") + ")" : inb.listening ? inb.host + ":" + inb.port + " · " + clients.length : "off");
}

function applyView(m, gov) {
  if (!m && !gov) return;
  m = m || lastMetrics || {};
  gov = gov || lastGov || m.governor || null;
  if (m && m.tipSlot != null) lastMetrics = m;
  if (gov) lastGov = gov;
  const peers = (m && m.peers) || gov || {};
  const hot = Number(peers.hot != null ? peers.hot : (gov ? gov.hot : 0)) || 0, warm = Number(peers.warm != null ? peers.warm : (gov ? gov.warm : 0)) || 0, cold = Number(peers.cold != null ? peers.cold : (gov ? gov.cold : 0)) || 0;
  const total = Number(peers.total != null ? peers.total : hot + warm + cold);
  const t = (gov && gov.targets) || {};
  const tip = m.tipSlot != null ? Number(m.tipSlot) : null;
  const peerTip = m.peerTipSlot != null ? Number(m.peerTipSlot) : null;
  // header
  el("net").textContent = m.network || CFG.net;
  el("build").textContent = m.version || "—";
  const role = m.role || "data";
  setBadge("roleBadge", role === "producer" ? "purple" : role === "relay" ? "info" : "muted", role === "producer" ? "block producer" : role === "relay" ? "relay" : "client (outbound only)");
  // KPIs
  if (tip != null) el("tip").textContent = fmt(tip);
  const lag = tip != null && peerTip != null ? peerTip - tip : null;
  el("tipNote").textContent = lag == null ? "no peer tip yet" : lag <= 0 ? "at the network tip" : fmt(lag) + " slots behind peers";
  if (m.epoch != null) el("epoch").textContent = (m.targetEpoch != null && m.targetEpoch > m.epoch) ? m.epoch + " / " + m.targetEpoch : String(m.epoch);
  if (m.epochProgress) { const p = m.epochProgress; el("epochBar").style.width = p.percent.toFixed(1) + "%"; el("epochNote").textContent = p.percent.toFixed(1) + "% · " + fmt(p.slotInEpoch) + " / " + fmt(p.epochLength) + (m.epochNonce ? " · η0 " + String(m.epochNonce).slice(0, 8) + "…" : ""); }
  if (m.eraName) { el("era").textContent = m.eraName; el("eraNote").textContent = m.era != null ? "era " + m.era : ""; }
  if (m.uptimeSec != null) { el("up").textContent = fmtUptime(m.uptimeSec); el("upNote").textContent = m.process && m.process.pid ? "pid " + m.process.pid : ""; }
  if (m.bodyValidation || m.scriptValidation) { el("flags").textContent = (m.bodyValidation || "?") + " / " + (m.scriptValidation || "?"); el("flagsNote").textContent = m.ledgerComplete === false ? "ledger incomplete (tip follow)" : "body / script · full ledger"; }
  el("peersV").textContent = hot + " · " + warm + " · " + cold;
  el("peersNote").textContent = "hot · warm · cold of " + fmt(total) + " known";
  const inb = m.inbound || {};
  const pullers = (inb.duplexPullers || []).length;
  el("serveV").textContent = (inb.listening ? inb.clients : "—") + " · " + pullers;
  var pr = inb.publicReachable;
  el("serveNote").innerHTML = (inb.listening ? "inbound clients · duplex pulls" : "inbound off · duplex pulls " + pullers) + (pr ? " · " + badge(pr.ok ? "ok" : "bad", pr.ok ? "public port reachable" : "PUBLIC PORT UNREACHABLE") : "");
  const mp = m.mempool || { count: 0, bytes: 0, txs: [] };
  el("mpV").textContent = fmt(mp.count);
  el("mpNote").textContent = fmtBytes(mp.bytes);
  // sections
  renderProducer(m);
  renderPeers(m, gov);
  setBadge("peerSummary", hot > 0 ? "ok" : "warn", hot + " hot · " + warm + " warm · " + cold + " cold");
  el("tierHotLab").textContent = hot + " / target " + (t.targetHot != null ? t.targetHot : "—") + " · max " + (t.maxHot != null ? t.maxHot : "—");
  el("tierWarmLab").textContent = warm + " / target " + (t.targetWarm != null ? t.targetWarm : "—") + " · max " + (t.maxWarm != null ? t.maxWarm : "—");
  el("tierColdLab").textContent = cold + " / target " + (t.targetCold != null ? t.targetCold : "—") + " · max " + (t.maxCold != null ? t.maxCold : "—");
  el("barHot").style.width = barPct(hot, t.maxHot || t.targetHot || 8) + "%";
  el("barWarm").style.width = barPct(warm, t.maxWarm || t.targetWarm || 24) + "%";
  el("barCold").style.width = barPct(cold, t.maxCold || t.targetCold || 64) + "%";
  kv(el("govKv"), [
    ["Governor ticks", (gov && gov.tickCount != null ? fmt(gov.tickCount) : "—") + (gov && gov.lastTickMs != null ? " · last " + gov.lastTickMs + " ms" : "") + (gov && gov.lastTickAt ? " · " + fmtAgo(gov.lastTickAt) + " ago" : "")],
    ["Failed peers", gov && gov.failedPeers != null ? String(gov.failedPeers) : "—"],
  ]);
  const groups = (gov && gov.localRootGroups) || [];
  el("groupList").innerHTML = groups.length ? groups.map((g) => "<li>" + badge(Number(g.hot) >= Number(g.valency) ? "ok" : "warn", g.groupId) + "<span>hot " + (g.hot || 0) + " / valency " + (g.valency || 0) + (g.accessPoints != null ? " · " + g.accessPoints + " access point(s)" : "") + "</span></li>").join("") : '<li class="empty">no local root groups</li>';
  const errs = (gov && gov.recentErrors) || [];
  el("errList").innerHTML = errs.length ? errs.map((e) => "<li>" + badge("warn", "×" + e.failCount) + "<span><b>" + esc(e.key) + "</b> " + esc(e.error) + "</span></li>").join("") : '<li class="empty">none</li>';
  setBadge("errBadge", errs.length ? "warn" : "muted", errs.length + " recent");
  const mal = (gov && gov.maliciousPeers) || [];
  el("malList").innerHTML = mal.length ? mal.map((x) => "<li>" + badge("bad", "held " + fmtIn(Math.round((x.until - Date.now()) / 1000))) + "<span><b>" + esc(x.key) + "</b> " + esc(x.reason) + "</span></li>").join("") : '<li class="empty">none</li>';
  // chain
  if (el("ledgerStoreLine")) el("ledgerStoreLine").textContent = m.ledgerStore ? "Ledger store (" + m.ledgerStore.mode + "): anchor slot " + fmt(m.ledgerStore.anchorSlot) + ", " + fmt(m.ledgerStore.volatileBlocks) + " volatile diffs (" + fmtBytes(m.ledgerStore.volatileBytes) + "), " + fmt(m.ledgerStore.utxoCount) + " UTxOs" + (m.ledgerStore.mode === "dual" ? ", dual-run " + fmt(m.ledgerStore.dual.checked) + " refs compared over " + fmt(m.ledgerStore.dual.blocks) + " blocks, " + fmt(m.ledgerStore.dual.differences) + " differences" : "") : "";
  if (el("blockStoreLine")) el("blockStoreLine").textContent = m.blockStore ? "Block store (" + m.blockStore.mode + "): " + fmt(m.blockStore.chunks) + " chunks, immutable tip slot " + fmt(m.blockStore.immutableSlot) + ", " + fmt(m.blockStore.volatileBlocks) + " volatile blocks, peers served from " + m.blockStore.relayStore : "";
  el("blockRows").innerHTML = (m.recentBlocks || []).length ? m.recentBlocks.map((b) => "<tr><td>" + fmt(b.slot) + "</td><td>" + (b.blockNo != null ? fmt(b.blockNo) : "EBB") + "</td><td><code>" + short(b.hash, 16) + "</code></td><td>" + fmtBytes(b.bytes) + "</td></tr>").join("") : '<tr><td colspan="4" class="empty">—</td></tr>';
  const sy = m.sync || {}, sch = sy.scheduler || {};
  kv(el("syncKv"), [
    ["Mode", (sy.mode || "—") + (sy.bodyValidation ? " · " + sy.bodyValidation : "")],
    ["Halted", sy.halted ? badge("bad", "slot " + sy.halted.slot + " · " + sy.halted.reason) : badge("ok", "no"), true],
    ["Primary", sy.primary || "—"], ["Quorum", sy.quorum != null ? String(sy.quorum) : "—"],
    ["Ranges", "in flight " + (sch.inFlight != null ? sch.inFlight : "—") + " · queued " + (sch.queued != null ? sch.queued : "—") + " · awaiting apply " + (sch.awaitingApply != null ? sch.awaitingApply : "—") + " · retries " + (sch.retries != null ? sch.retries : "—")],
    ["Blocks / s", sy.blocksPerSec != null ? Number(sy.blocksPerSec).toFixed(1) : "—"],
    ["Workers · pending headers", (sy.validationWorkers != null ? sy.validationWorkers : "—") + " · " + (sy.pendingHeaders != null ? sy.pendingHeaders : "—")],
    ["Mithril", m.mithril ? (m.mithril.replay ? m.mithril.replay.label : m.mithril.phase) : "not used"],
  ]);
  kv(el("mempoolKv"), [["Transactions", String(mp.count)], ["Bytes", fmtBytes(mp.bytes)]]);
  el("mempoolTxs").innerHTML = (mp.txs || []).map((x) => "<li><code>" + short(x.hash, 20) + "</code><span>" + fmtBytes(x.size) + "</span></li>").join("") + (mp.count > (mp.txs || []).length ? '<li class="muted">… ' + (mp.count - mp.txs.length) + " more</li>" : "");
  // status
  const behind = lag != null && lag > 60;
  setBadge("status", hot > 0 ? (behind ? "warn" : "ok") : (total > 0 ? "warn" : "bad"), hot > 0 ? (behind ? "syncing" : "at tip") : (total > 0 ? "no hot peers" : "no peers"));
  setBadge("transport", useWs ? "ok" : "warn", useWs ? "live · ws" : "polling");
  el("updated").textContent = new Date().toLocaleTimeString(undefined, { hour12: false });
  el("raw").textContent = JSON.stringify({ metrics: m, governor: gov, transport: useWs ? "ws" : "poll" }, null, 2);
}
function applyTip(d) {
  if (!d) return;
  const m = Object.assign({}, lastMetrics || {}, { tipSlot: d.slot });
  if (d.epoch != null) m.epoch = d.epoch;
  if (m.epochProgress && (d.epoch == null || d.epoch === (lastMetrics || {}).epoch)) {
    const inEpoch = Number(BigInt(String(d.slot)) - BigInt(m.epochProgress.firstSlot));
    if (inEpoch >= 0 && inEpoch < m.epochProgress.epochLength) m.epochProgress = Object.assign({}, m.epochProgress, { slotInEpoch: inEpoch, percent: inEpoch / m.epochProgress.epochLength * 100 });
  }
  applyView(m, lastGov);
}
async function jget(path) { const r = await fetch(path, { cache: "no-store" }); if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }
async function tick() {
  if (useWs) return;
  try { const res = await Promise.all([jget("/metrics"), jget("/governor").catch(() => null)]); applyView(res[0], res[1] || res[0].governor || null); }
  catch (e) { setBadge("status", "bad", "error"); el("updated").textContent = String(e.message || e); }
}
// ── Resources: 2 s samples, 10 min ring, SVG line charts ──
const RES_MAX = 300, RES_EVERY = 2000;
const resHist = [];
let resWin = 5;
const fmtP = (v, d) => v == null || !isFinite(v) ? "—" : v.toFixed(d == null ? 0 : d) + "%";
function resShown() { const cut = Date.now() - resWin * 60000; return resHist.filter((x) => x.t >= cut); }
function resAgo(list) { if (list.length < 2) return "—"; const s = Math.round((list[list.length - 1].t - list[0].t) / 1000); return s < 90 ? s + " s" : Math.round(s / 60) + " min"; }
function pathFor(vals, yMax, W, H) {
  const n = vals.length; if (n < 2) return "";
  const pts = []; for (let i = 0; i < n; i++) { const v = vals[i]; if (v == null || !isFinite(v)) continue; pts.push((i / (n - 1) * W).toFixed(1) + "," + (H - Math.min(1, Math.max(0, v / (yMax || 1))) * (H - 4) - 2).toFixed(1)); }
  return pts.length ? "M" + pts.join(" L") : "";
}
function drawChart(svgId, lines, yMax) {
  const svg = el(svgId); const W = 600, H = 96;
  let out = "";
  for (let g = 1; g < 4; g++) out += '<line x1="0" y1="' + (H * g / 4).toFixed(1) + '" x2="' + W + '" y2="' + (H * g / 4).toFixed(1) + '" stroke="#21262d" stroke-width="1"/>';
  for (const l of lines) { const d = pathFor(l.vals, yMax, W, H); if (d) out += '<path d="' + d + '" fill="none" stroke="' + l.color + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/>'; }
  svg.innerHTML = out;
}
function renderResources() {
  const s = resShown(); const last = s[s.length - 1];
  el("resMeta").textContent = last ? "node " + fmtP(last.nodeCpu) + " cpu · " + fmtBytes(last.rss) + " rss · host " + fmtP(last.hostCpu) + " cpu · " + fmtP(last.hostMem) + " mem" : "—";
  el("resSpan").textContent = "· " + resAgo(s);
  const cores = last && last.cores ? last.cores : 1;
  el("cpuHead").textContent = last ? (last.nodeCpu / 100).toFixed(2) + " cores · host " + fmtP(last.hostCpu) : "—";
  drawChart("cpuSvg", [{ vals: s.map((x) => x.nodeCpu / 100 / cores * 100), color: "#58a6ff" }, { vals: s.map((x) => x.hostCpu), color: "#8b949e" }], 100);
  const memMax = Math.max.apply(null, s.map((x) => x.rss || 0).concat([1]));
  el("memHead").textContent = last ? fmtBytes(last.rss) + " rss · " + fmtBytes(last.heap) + " heap · host " + fmtP(last.hostMem) : "—";
  drawChart("memSvg", [{ vals: s.map((x) => x.rss / memMax * 100), color: "#58a6ff" }, { vals: s.map((x) => x.heap / memMax * 100), color: "#bc8cff" }, { vals: s.map((x) => x.hostMem), color: "#8b949e" }], 100);
  const bpsMax = Math.max.apply(null, s.map((x) => x.bps || 0).concat([1]));
  el("bpsHead").textContent = last && last.bps != null ? Number(last.bps).toFixed(1) + " / s · peak " + bpsMax.toFixed(1) : "—";
  drawChart("bpsSvg", [{ vals: s.map((x) => (x.bps || 0) / bpsMax * 100), color: "#3fb950" }], 100);
}
async function sampleResources() {
  try {
    const r = await fetch("/resources", { cache: "no-store" }); if (!r.ok) return;
    const j = await r.json(); const p = j.process || {}, h = j.system || {};
    resHist.push({ t: Date.now(), nodeCpu: Number(p.cpuPercent) || 0, rss: Number(p.rssBytes) || 0, heap: Number(p.heapUsedBytes) || 0, hostCpu: Number(h.cpuPercent) || 0, hostMem: h.totalMemBytes ? Number(h.usedMemBytes) / Number(h.totalMemBytes) * 100 : 0, cores: Number(h.cpus) || 1, bps: j.blocksPerSec != null ? Number(j.blocksPerSec) : (lastMetrics && lastMetrics.sync ? Number(lastMetrics.sync.blocksPerSec) : null) });
    while (resHist.length > RES_MAX) resHist.shift();
    renderResources();
  } catch (_) {}
}
el("win5").onclick = () => { resWin = 5; el("win5").className = "on"; el("win10").className = ""; renderResources(); };
el("win10").onclick = () => { resWin = 10; el("win10").className = "on"; el("win5").className = ""; renderResources(); };
sampleResources();
setInterval(sampleResources, RES_EVERY);
function connectWs() {
  let ws;
  try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/stats"); } catch (e) { useWs = false; return; }
  ws.onopen = () => { useWs = true; setBadge("transport", "ok", "live · ws"); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "metrics") applyView(msg.data, msg.data && msg.data.governor);
      else if (msg.type === "peers" || msg.type === "governor") applyView(lastMetrics, msg.data);
      else if (msg.type === "tip") applyTip(msg.data);
    } catch (_) {}
  };
  ws.onclose = () => { useWs = false; setBadge("transport", "warn", "polling"); setTimeout(connectWs, 5000); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
connectWs();
tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;
}
