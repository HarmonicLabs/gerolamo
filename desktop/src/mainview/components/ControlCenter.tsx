import { Component, For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { manager } from "../lib/manager";
import { gerolamoHttpBase, type BootstrapStatus, type HealthResult, type InstanceConfig, type StatusResult } from "../../shared/types";
import {
  ProgressiveNodePanel,
  StepCard,
  fieldClass,
  labelClass,
  btnPrimary,
  btnSecondary,
  btnDanger,
} from "./nodeUI";

const ControlCenter: Component = () => {
  const [activeTab, setActiveTab] = createSignal<"control" | "docs">("control");
  const [name, setName] = createSignal("");
  const [network, setNetwork] = createSignal<"preprod" | "mainnet" | "preview">("preprod");
  const [port, setPort] = createSignal(3030);
  const [dbPath, setDbPath] = createSignal("");
  const [snapshotDir, setSnapshotDir] = createSignal("");
  const [n2cSocket, setN2cSocket] = createSignal("");
  const [skipApply, setSkipApply] = createSignal(false);

  const [activeConfig, setActiveConfig] = createSignal<InstanceConfig | null>(null);
  const [configWritten, setConfigWritten] = createSignal(false);
  const [nodeRunning, setNodeRunning] = createSignal(false);
  const [bootstrapReady, setBootstrapReady] = createSignal(false);
  const [health, setHealth] = createSignal<HealthResult | null>(null);
  const [sync, setSync] = createSignal<StatusResult["sync"]>(null);
  const [boot, setBoot] = createSignal<BootstrapStatus | null>(null);
  const [logLines, setLogLines] = createSignal<string[]>([]);
  const [bootLogLines, setBootLogLines] = createSignal<string[]>([]);
  const [logOpen, setLogOpen] = createSignal(false);
  const [bootLogOpen, setBootLogOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [errorMsg, setErrorMsg] = createSignal("");
  const [docsHtml, setDocsHtml] = createSignal("");

  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let bootTimer: ReturnType<typeof setInterval> | null = null;

  const [detectInfo, { refetch: refetchDetect }] = createResource(async () => {
    try {
      return await manager.detect();
    } catch (e: any) {
      return {
        ok: false,
        bunPath: null,
        bunVersion: null,
        repoPath: null,
        repoVersion: null,
        hasStartEntry: false,
        error: e?.message || "detect failed",
      };
    }
  });

  const stopPolls = () => {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    if (bootTimer) {
      clearInterval(bootTimer);
      bootTimer = null;
    }
  };

  const startNodePolls = (id: string) => {
    if (healthTimer) clearInterval(healthTimer);
    const tick = async () => {
      try {
        const st = await manager.status(id);
        setNodeRunning(!!st?.running);
        setSync(st?.sync ?? null);
        if (st?.health) setHealth(st.health);
        const logs = await manager.logs(id, 120);
        if (logs.ok) setLogLines(logs.lines);
      } catch {
        /* ignore */
      }
    };
    void tick();
    healthTimer = setInterval(tick, 2000);
  };

  const startBootPolls = (id: string) => {
    if (bootTimer) clearInterval(bootTimer);
    const tick = async () => {
      try {
        const st = await manager.bootstrapStatus(id);
        setBoot(st);
        if (st.stage === "ready") setBootstrapReady(true);
        const logs = await manager.bootstrapLogs(id, 80);
        if (logs.ok) setBootLogLines(logs.lines);
      } catch {
        /* ignore */
      }
    };
    void tick();
    bootTimer = setInterval(tick, 2000);
  };

  onCleanup(() => stopPolls());

  onMount(() => {
    void (async () => {
      try {
        const nodes = await manager.list();
        const same = nodes.filter((n) => n.network === network());
        const target = same.find((n) => n.runState === "running") ?? same[0];
        if (!target) return;
        setActiveConfig(target);
        setNetwork(target.network);
        if (target.name) setName(target.name);
        if (target.port) setPort(target.port);
        if (target.dbPath) setDbPath(target.dbPath);
        if (target.snapshotDir) setSnapshotDir(target.snapshotDir);
        if (target.n2cSocket) setN2cSocket(target.n2cSocket);
        setSkipApply(!!target.skipApply);
        setConfigWritten(!!target.instanceDir);
        setBootstrapReady(target.bootstrapState === "ready");
        const st = await manager.status(target.id);
        if (st?.running) {
          setNodeRunning(true);
          setLogOpen(true);
          setStatusMsg(`Resumed running · ${target.id}`);
          startNodePolls(target.id);
        } else if (target.instanceDir) {
          setStatusMsg(`Resumed instance · ${target.id}`);
        }
      } catch (e) {
        console.error("[ControlCenter] hydrate failed", e);
      }
    })();
  });

  const hasRuntime = () => {
    const d = detectInfo();
    return !!(d?.ok && d.bunPath && d.repoPath && d.hasStartEntry);
  };

  const buildConfig = (): Partial<InstanceConfig> => {
    const prev = activeConfig();
    const d = detectInfo();
    return {
      id: prev?.id,
      name: name().trim() || undefined,
      network: network(),
      port: Number(port()) || 3030,
      repoPath: d?.repoPath || prev?.repoPath,
      bunPath: d?.bunPath || prev?.bunPath,
      instanceDir: prev?.instanceDir,
      dbPath: dbPath().trim() || undefined,
      snapshotDir: snapshotDir().trim() || undefined,
      n2cSocket: n2cSocket().trim() || null,
      skipApply: skipApply(),
      pid: prev?.pid,
      runState: prev?.runState,
    };
  };

  const currentStep = () => {
    if (!hasRuntime()) return 1;
    if (!configWritten()) return 2;
    if (!bootstrapReady()) return 3;
    return 4;
  };

  const pick = async (kind: "db" | "snap") => {
    const res = await manager.pickPath();
    if ("cancelled" in res) return;
    if (kind === "db") {
      const p = res.path;
      setDbPath(/\.(db|sqlite|sqlite3)$/i.test(p) ? p : `${p.replace(/\/$/, "")}/gerolamo.db`);
    } else setSnapshotDir(res.path);
  };

  const handleWriteConfig = async () => {
    setErrorMsg("");
    setBusy(true);
    setStatusMsg("Writing instance config…");
    try {
      const result = await manager.writeConfig(buildConfig());
      if (!result.ok || !result.config) {
        setErrorMsg(result.error || "Failed to write config");
        return;
      }
      setActiveConfig(result.config);
      setConfigWritten(true);
      if (result.config.dbPath) setDbPath(result.config.dbPath);
      if (result.config.snapshotDir) setSnapshotDir(result.config.snapshotDir);
      setStatusMsg(`Config saved · ${result.config.id}`);
    } catch (e: any) {
      setErrorMsg(e?.message || "writeConfig failed");
    } finally {
      setBusy(false);
    }
  };

  const handleBootstrap = async () => {
    setErrorMsg("");
    setBusy(true);
    setBootLogOpen(true);
    setStatusMsg("Starting Mithril bootstrap…");
    try {
      const written = await manager.writeConfig(buildConfig());
      if (!written.ok || !written.config) {
        setErrorMsg(written.error || "Write config first");
        return;
      }
      setActiveConfig(written.config);
      setConfigWritten(true);
      if (written.config.dbPath) setDbPath(written.config.dbPath);
      if (written.config.snapshotDir) setSnapshotDir(written.config.snapshotDir);
      const id = written.config.id;
      const result = await manager.bootstrapStart(id);
      if (!result.ok) {
        setErrorMsg(result.error || "bootstrap failed");
        return;
      }
      setStatusMsg(`Bootstrap pid ${result.pid ?? "?"}`);
      startBootPolls(id);
    } catch (e: any) {
      setErrorMsg(e?.message || "bootstrap failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSkipBootstrap = async () => {
    const id = activeConfig()?.id;
    if (!id) {
      setErrorMsg("Write config first");
      return;
    }
    const result = await manager.bootstrapSkip(id);
    if (!result.ok) {
      setErrorMsg(result.error || "skip failed");
      return;
    }
    setBootstrapReady(true);
    setStatusMsg("Skipped Mithril · using existing DB");
  };

  const handleStart = async () => {
    setErrorMsg("");
    setBusy(true);
    setStatusMsg("Starting Gerolamo…");
    try {
      const result = await manager.start(buildConfig());
      if (!result.success) {
        setErrorMsg(result.error || "Start failed");
        return;
      }
      if (result.config) {
        setActiveConfig(result.config);
        setConfigWritten(true);
      }
      setNodeRunning(true);
      setLogOpen(true);
      setStatusMsg(`Started · pid ${result.pid ?? "?"}`);
      const id = result.config?.id || activeConfig()?.id;
      if (id) startNodePolls(id);
    } catch (e: any) {
      setErrorMsg(e?.message || "start failed");
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    const id = activeConfig()?.id;
    if (!id) return;
    setBusy(true);
    try {
      const result = await manager.stop(id);
      if (!result.success) {
        setErrorMsg(result.error || "Stop failed");
        return;
      }
      setNodeRunning(false);
      setSync(null);
      setStatusMsg("Stopped");
    } catch (e: any) {
      setErrorMsg(e?.message || "stop failed");
    } finally {
      setBusy(false);
    }
  };

  const formatMetric = (value: string | number | null | undefined) => {
    if (value == null) return "—";
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toLocaleString("en-US") : String(value);
  };

  const headerRight = () => {
    if (busy()) return "Working…";
    const s = sync();
    if (nodeRunning() && s) return `${s.syncPercent.toFixed(2)}% synced · slot ${Number(s.tipSlot).toLocaleString("en-US")}`;
    if (nodeRunning()) return "Node running · reading tip…";
    if (bootstrapReady()) return "Bootstrap ready · next: Start";
    if (configWritten()) return "Config ready · next: Mithril or Skip";
    if (hasRuntime()) return "Runtime OK · next: Configure";
    return `Step ${currentStep()} of 4`;
  };

  const operationalStatusPanel = () => {
    if (!nodeRunning()) return null;
    const s = sync();
    const pct = s ? Math.max(0, Math.min(100, s.syncPercent)) : 0;
    const base = gerolamoHttpBase(port());
    return (
      <div class="rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-3 space-y-2">
        <div class="flex items-center justify-between gap-2 text-[11px]">
          <span class="font-semibold text-emerald-300">Health, sync & peers</span>
          <span class="font-mono text-zinc-400">{s ? `${s.syncPercent.toFixed(2)}% synced` : "Reading chain tip…"}</span>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
          <div class="rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
            <div class="text-zinc-500">Process</div>
            <div class={nodeRunning() ? "text-emerald-400 font-medium" : "text-zinc-400"}>
              {nodeRunning() ? "alive" : "stopped"}
            </div>
          </div>
          <div class="rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
            <div class="text-zinc-500">HTTP</div>
            <div class={health()?.healthy ? "text-emerald-400 font-medium" : "text-zinc-400"}>
              {health() ? (health()!.healthy ? `ok · ${health()!.latencyMs ?? "?"}ms` : "down") : "—"}
            </div>
          </div>
          <div class="rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
            <div class="text-zinc-500">Port</div>
            <div class="text-zinc-200 font-mono">{port()}</div>
          </div>
          <div class="rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
            <div class="text-zinc-500">N2C</div>
            <div class="text-zinc-200 font-mono truncate">{n2cSocket() || "off"}</div>
          </div>
          <div class="rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
            <div class="text-zinc-500">MiniBF</div>
            <div class="text-zinc-200 font-mono truncate">/api/v0</div>
          </div>
        </div>
        <Show when={s}>
          <div class="space-y-2">
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 text-[11px]">
              <div class="min-w-0">
                <div class="text-zinc-500">Chain tip</div>
                <div class="font-mono text-zinc-100 whitespace-nowrap overflow-hidden text-ellipsis">
                  {formatMetric(s!.tipSlot)}
                </div>
              </div>
              <div class="min-w-0">
                <div class="text-zinc-500">Network tip</div>
                <div class="font-mono text-zinc-100 whitespace-nowrap overflow-hidden text-ellipsis">
                  {formatMetric(s!.networkTipSlot)}
                </div>
              </div>
              <div class="min-w-0">
                <div class="text-zinc-500">Synced</div>
                <div class="font-mono text-emerald-400 font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                  {s!.syncPercent.toFixed(2)}%
                </div>
              </div>
              <div class="min-w-0">
                <div class="text-zinc-500">UTxOs</div>
                <div class="font-mono text-zinc-100 whitespace-nowrap overflow-hidden text-ellipsis">
                  {formatMetric(s!.utxoCount)}
                </div>
              </div>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-zinc-800">
              <div class="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-2">
              <div class="min-w-0 rounded-md border border-emerald-900/60 bg-emerald-950/20 p-2">
                <div class="mb-1 text-[10px] font-semibold text-emerald-400">Hot · ChainSync ({s!.peers.hot})</div>
                <div class="max-h-28 space-y-1 overflow-y-auto font-mono text-[10px] text-zinc-300">
                  <For each={s!.peers.hotKeys}>{(peer) => <div class="truncate">{peer}</div>}</For>
                  <Show when={s!.peers.hotKeys.length === 0}>
                    <div class="text-zinc-600">No hot peers</div>
                  </Show>
                </div>
              </div>
              <div class="min-w-0 rounded-md border border-sky-900/60 bg-sky-950/20 p-2">
                <div class="mb-1 text-[10px] font-semibold text-sky-400">Warm · standby ({s!.peers.warm})</div>
                <div class="max-h-28 space-y-1 overflow-y-auto font-mono text-[10px] text-zinc-300">
                  <For each={s!.peers.warmKeys}>{(peer) => <div class="truncate">{peer}</div>}</For>
                  <Show when={s!.peers.warmKeys.length === 0}>
                    <div class="text-zinc-600">No warm peers</div>
                  </Show>
                </div>
              </div>
              <div class="min-w-0 rounded-md border border-zinc-700 bg-zinc-900/30 p-2">
                <div class="mb-1 text-[10px] font-semibold text-zinc-400">Cold · known ({s!.peers.cold})</div>
                <div class="max-h-28 space-y-1 overflow-y-auto font-mono text-[10px] text-zinc-500">
                  <For each={s!.peers.coldSample}>{(peer) => <div class="truncate">{peer}</div>}</For>
                  <Show when={s!.peers.coldSample.length === 0}>
                    <div class="text-zinc-600">No cold peers</div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </Show>
        <div class="flex flex-wrap gap-2 border-t border-emerald-900/40 pt-2">
          <button
            onClick={() => void manager.openExternal(`${base}/docs`)}
            disabled={!health()?.healthy}
            class={btnPrimary}
          >
            Open MiniBF /docs
          </button>
          <button
            onClick={() => void manager.openExternal(`${base}/stats`)}
            disabled={!health()?.healthy}
            class={btnSecondary}
          >
            Open /stats
          </button>
          <button onClick={() => setLogOpen(!logOpen())} class={btnSecondary}>
            {logOpen() ? "Hide log" : "Show log"}
          </button>
        </div>
        <Show when={logOpen()}>
          <pre class="p-2 bg-black/40 rounded border border-zinc-800 text-[10px] font-mono text-zinc-400 max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
            {logLines().length ? logLines().join("\n") : "No daemon.log yet."}
          </pre>
        </Show>
      </div>
    );
  };

  const loadDocs = async () => {
    try {
      const res = await fetch("./docs/guide.md");
      const text = await res.text();
      const { marked } = await import("marked");
      setDocsHtml(marked.parse(text, { async: false }) as string);
    } catch {
      setDocsHtml("<p>Could not load docs. See repo agent.md.</p>");
    }
  };

  return (
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-2xl font-bold text-white">Gerolamo</h2>
          <p class="text-xs text-zinc-500 mt-1">
            Standalone TS node/relay · Bun · MiniBF subset · not The Lab · not TxPipe
          </p>
        </div>
        <div class="flex gap-2 border-b border-zinc-800">
          <button
            onClick={() => setActiveTab("control")}
            class={`px-4 py-2 text-sm font-medium rounded-t-lg ${activeTab() === "control" ? "bg-harmonic-600 text-white border-b-2 border-harmonic-400" : "text-gray-400 hover:text-white"}`}
          >
            Control Center
          </button>
          <button
            onClick={() => {
              setActiveTab("docs");
              void loadDocs();
            }}
            class={`px-4 py-2 text-sm font-medium rounded-t-lg ${activeTab() === "docs" ? "bg-harmonic-600 text-white border-b-2 border-harmonic-400" : "text-gray-400 hover:text-white"}`}
          >
            Knowledge Base
          </button>
        </div>
      </div>

      <Show when={activeTab() === "control"}>
        <ProgressiveNodePanel
          title="Gerolamo node"
          network={network()}
          headerRight={headerRight()}
          running={nodeRunning()}
          runningLabel={sync() ? `${sync()!.syncPercent.toFixed(1)}% synced` : "Running"}
          banner={operationalStatusPanel()}
          bannerPlacement="after-steps"
          identity={
            activeConfig()
              ? {
                  id: activeConfig()!.id,
                  dir: activeConfig()!.instanceDir,
                  extra: <span class="truncate">HTTP: {gerolamoHttpBase(activeConfig()!.port)}</span>,
                }
              : null
          }
          configSummary={
            <span>
              Configuration
              <span class="ml-2 text-[11px] font-normal text-zinc-500">
                {network()} · port {port()}
              </span>
            </span>
          }
          config={
            <div class="space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label class={labelClass}>Name (optional)</label>
                  <input type="text" value={name()} onInput={(e) => setName(e.currentTarget.value)} class={fieldClass} />
                </div>
                <div>
                  <label class={labelClass}>Network</label>
                  <select
                    value={network()}
                    onChange={(e) => setNetwork(e.currentTarget.value as "preprod" | "mainnet" | "preview")}
                    class={fieldClass}
                  >
                    <option value="preprod">Preprod</option>
                    <option value="mainnet">Mainnet (deferred)</option>
                    <option value="preview">Preview</option>
                  </select>
                </div>
                <div>
                  <label class={labelClass}>HTTP port</label>
                  <input
                    type="number"
                    value={port()}
                    onInput={(e) => setPort(Number(e.currentTarget.value) || 3030)}
                    class={`${fieldClass} font-mono`}
                  />
                </div>
                <div>
                  <label class={labelClass}>N2C socket (optional)</label>
                  <input
                    type="text"
                    value={n2cSocket()}
                    onInput={(e) => setN2cSocket(e.currentTarget.value)}
                    placeholder="off — absolute path to enable"
                    class={`${fieldClass} font-mono text-xs`}
                  />
                </div>
                <div class="md:col-span-2">
                  <label class={labelClass}>Chain DB path (absolute)</label>
                  <div class="flex gap-2">
                    <input
                      type="text"
                      value={dbPath()}
                      onInput={(e) => setDbPath(e.currentTarget.value)}
                      placeholder="default: ~/.local/share/gerolamo/<id>/data/gerolamo.db"
                      class={`${fieldClass} font-mono text-xs`}
                    />
                    <button type="button" class={btnSecondary} onClick={() => void pick("db")}>
                      Browse
                    </button>
                  </div>
                </div>
                <div class="md:col-span-2">
                  <label class={labelClass}>Mithril snapshot dir (absolute)</label>
                  <div class="flex gap-2">
                    <input
                      type="text"
                      value={snapshotDir()}
                      onInput={(e) => setSnapshotDir(e.currentTarget.value)}
                      placeholder="default: repo snapshots/mithril if present"
                      class={`${fieldClass} font-mono text-xs`}
                    />
                    <button type="button" class={btnSecondary} onClick={() => void pick("snap")}>
                      Browse
                    </button>
                  </div>
                </div>
              </div>
              <label class="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={skipApply()} onChange={(e) => setSkipApply(e.currentTarget.checked)} />
                Download only (--skip-apply)
              </label>
              <button onClick={() => void refetchDetect()} disabled={busy()} class={btnSecondary}>
                Re-detect runtime
              </button>
            </div>
          }
          steps={
            <>
              <StepCard
                n={1}
                title="Runtime (Bun + this repo)"
                done={hasRuntime()}
                active={currentStep() === 1}
                open={currentStep() === 1 || !hasRuntime()}
                doneHint={detectInfo()?.repoVersion ? `v${detectInfo()!.repoVersion} · bun ${detectInfo()!.bunVersion || "?"}` : undefined}
              >
                <Show when={detectInfo()}>
                  <div class="text-[11px] font-mono text-zinc-400 space-y-1">
                    <div>
                      bun: <span class={detectInfo()!.bunPath ? "text-emerald-400" : "text-red-400"}>{detectInfo()!.bunPath || "missing"}</span>
                    </div>
                    <div>
                      repo: <span class={detectInfo()!.repoPath ? "text-emerald-400" : "text-red-400"}>{detectInfo()!.repoPath || "missing"}</span>
                    </div>
                    <Show when={detectInfo()!.error}>
                      <div class="text-red-400">{detectInfo()!.error}</div>
                    </Show>
                  </div>
                </Show>
              </StepCard>
              <StepCard
                n={2}
                title="Write instance config"
                done={configWritten()}
                active={currentStep() === 2}
                open={currentStep() === 2 || !configWritten()}
                doneHint={activeConfig()?.id}
              >
                <p class="text-[11px] text-zinc-500">
                  Creates <code class="text-zinc-400">~/.local/share/gerolamo/&lt;id&gt;/</code>. DB path must be absolute.
                </p>
                <button onClick={() => void handleWriteConfig()} disabled={busy() || !hasRuntime()} class={btnPrimary}>
                  Write config
                </button>
              </StepCard>
              <StepCard
                n={3}
                title="Mithril bootstrap"
                done={bootstrapReady()}
                active={currentStep() === 3}
                open={currentStep() === 3 || bootLogOpen()}
                doneHint={boot()?.stage === "ready" ? "ready" : bootstrapReady() ? "skipped" : undefined}
              >
                <p class="text-[11px] text-zinc-500">
                  <code class="text-zinc-300">mithril-bootstrap --engine ts</code> · no fake percent · one writer on the DB.
                  Preprod first. Skip if you already have a dense SQLite file.
                </p>
                <Show when={boot()}>
                  <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                    <div class="rounded-md border border-zinc-800 px-2 py-1">
                      Snapshot
                      <div class="font-mono text-zinc-200">{boot()!.snapshotHuman ?? "—"}</div>
                    </div>
                    <div class="rounded-md border border-zinc-800 px-2 py-1">
                      Data
                      <div class="font-mono text-zinc-200">{boot()!.dataHuman ?? "—"}</div>
                    </div>
                    <div class="rounded-md border border-zinc-800 px-2 py-1">
                      Immutable
                      <div class="font-mono text-zinc-200">{boot()!.immutableCount ?? "—"}</div>
                    </div>
                    <div class="rounded-md border border-zinc-800 px-2 py-1">
                      Process
                      <div class={boot()!.processAlive ? "text-emerald-400" : "text-zinc-400"}>
                        {boot()!.processAlive ? "alive" : "stopped"}
                      </div>
                    </div>
                  </div>
                  <Show when={boot()!.stageLabel}>
                    <div class="text-[11px] text-amber-300">{boot()!.stageLabel}</div>
                  </Show>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <button onClick={() => void handleBootstrap()} disabled={busy() || !configWritten()} class={btnPrimary}>
                    Start bootstrap
                  </button>
                  <button onClick={() => void handleSkipBootstrap()} disabled={busy() || !configWritten()} class={btnSecondary}>
                    Skip (use existing DB)
                  </button>
                  <button
                    onClick={() => void manager.bootstrapStop()}
                    disabled={busy()}
                    class={btnDanger}
                  >
                    Stop bootstrap
                  </button>
                  <button onClick={() => setBootLogOpen(!bootLogOpen())} class={btnSecondary}>
                    {bootLogOpen() ? "Hide log" : "Show log"}
                  </button>
                </div>
                <Show when={bootLogOpen()}>
                  <pre class="p-2 bg-black/40 rounded border border-zinc-800 text-[10px] font-mono text-zinc-400 max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                    {bootLogLines().length ? bootLogLines().join("\n") : "No bootstrap.log yet."}
                  </pre>
                </Show>
              </StepCard>
              <StepCard
                n={4}
                title="Start node"
                done={nodeRunning()}
                active={currentStep() === 4}
                open={currentStep() === 4 || nodeRunning() || logOpen()}
                doneHint={activeConfig()?.pid ? `pid ${activeConfig()!.pid}` : undefined}
              >
                <p class="text-[11px] text-zinc-500">
                  Spawns <code class="text-zinc-300">bun src/index.ts start-gerolamo</code> with NETWORK / GEROLAMO_DB_PATH.
                </p>
                <div class="flex flex-wrap gap-2">
                  <button onClick={() => void handleStart()} disabled={busy() || nodeRunning() || !hasRuntime()} class={btnPrimary}>
                    Start
                  </button>
                  <button onClick={() => void handleStop()} disabled={busy() || !activeConfig()?.id} class={btnDanger}>
                    Stop
                  </button>
                </div>
              </StepCard>
            </>
          }
          statusMsg={statusMsg()}
          errorMsg={errorMsg()}
        />
      </Show>

      <Show when={activeTab() === "docs"}>
        <div class="kb-prose rounded-xl border border-zinc-800 bg-zinc-900 p-4" innerHTML={docsHtml() || "<p>Loading…</p>"} />
      </Show>
    </div>
  );
};

export default ControlCenter;
