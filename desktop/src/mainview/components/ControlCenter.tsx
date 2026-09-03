import { Component, For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { manager } from "../lib/manager";
import { gerolamoHttpBase, type BootstrapStatus, type HealthResult, type InstanceConfig, type StatusResult } from "../../shared/types";
import { formatBytes, formatPercent, nodeCpuShare, nodeMemShare, type ResourceSnapshot } from "../../shared/resources";
import { DEFAULT_NODE_SETTINGS, type NodeSettings } from "../../shared/nodeSettings";
import { NodeConfigForm } from "./NodeConfigForm";
import { cn } from "../lib/cn";
import { Badge } from "./ui/Badge";
import { ProgressBar } from "./ui/ProgressBar";
import { ProgressRing } from "./ui/ProgressRing";
import { Stat } from "./ui/Stat";
import {
  btnPrimary,
  btnSecondary,
  btnDanger,
  LogFollowPre,
  ConfirmDialog,
} from "./nodeUI";

type PageId = "overview" | "node" | "mithril" | "logs" | "docs";

const NAV: { id: PageId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "node", label: "Node" },
  { id: "mithril", label: "Mithril" },
  { id: "logs", label: "Logs" },
  { id: "docs", label: "Docs" },
];

const ControlCenter: Component = () => {
  const [page, setPage] = createSignal<PageId>("overview");
  const [name, setName] = createSignal("");
  const [network, setNetwork] = createSignal<"preprod" | "mainnet" | "preview">("preprod");
  const [port, setPort] = createSignal(3030);
  const [dbPath, setDbPath] = createSignal("");
  const [snapshotDir, setSnapshotDir] = createSignal("");
  const [n2cSocket, setN2cSocket] = createSignal("");
  const [skipApply, setSkipApply] = createSignal(false);
  const [settings, setSettings] = createSignal<NodeSettings>({ ...DEFAULT_NODE_SETTINGS });
  const patchSettings = (p: Partial<NodeSettings>) => setSettings({ ...settings(), ...p });

  const [activeConfig, setActiveConfig] = createSignal<InstanceConfig | null>(null);
  const [configWritten, setConfigWritten] = createSignal(false);
  const [nodeRunning, setNodeRunning] = createSignal(false);
  const [bootstrapReady, setBootstrapReady] = createSignal(false);
  const [health, setHealth] = createSignal<HealthResult | null>(null);
  const [sync, setSync] = createSignal<StatusResult["sync"]>(null);
  const [resources, setResources] = createSignal<ResourceSnapshot | null>(null);
  const [boot, setBoot] = createSignal<BootstrapStatus | null>(null);
  const [logLines, setLogLines] = createSignal<string[]>([]);
  const [bootLogLines, setBootLogLines] = createSignal<string[]>([]);
  const [bootLogOpen, setBootLogOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [errorMsg, setErrorMsg] = createSignal("");
  const [docsHtml, setDocsHtml] = createSignal("");
  const [confirm, setConfirm] = createSignal<"db" | "snap" | null>(null);
  /** Mithril bootstrap process alive → it owns the DB (one writer). */
  const bootAlive = () => !!boot()?.processAlive;
  /** Why an action is blocked right now, or null when it is allowed. */
  const blockedBecause = (action: "bootstrap" | "skip" | "stopBootstrap" | "wipeSnap" | "startNode" | "wipeDb"): string | null => {
    switch (action) {
      case "bootstrap":
        if (nodeRunning()) return "Stop the node first: bootstrap and the node cannot both write the chain DB.";
        if (bootAlive()) return "Bootstrap is already running.";
        if (!hasRuntime()) return "Bun or the repo was not detected (Node page).";
        return null;
      case "skip":
        if (!activeConfig()?.id) return "Save the node config first.";
        if (bootAlive()) return "Bootstrap is running; stop it before skipping.";
        if (bootstrapReady()) return "Already marked ready/skipped.";
        return null;
      case "stopBootstrap":
        return bootAlive() ? null : "No bootstrap process is running.";
      case "wipeSnap":
        if (!activeConfig()?.id) return "Save the node config first.";
        if (bootAlive()) return "Bootstrap is running and using the snapshots.";
        return null;
      case "startNode":
        if (nodeRunning()) return "The node is already running.";
        if (bootAlive()) return "Mithril bootstrap holds the chain DB; stop it or wait for it to finish.";
        if (!hasRuntime()) return "Bun or the repo was not detected.";
        return null;
      case "wipeDb":
        if (!activeConfig()?.id) return "Save the node config first.";
        if (nodeRunning()) return "Stop the node first.";
        if (bootAlive()) return "Stop Mithril bootstrap first.";
        return null;
    }
  };

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
        // A single failed /metrics poll while the node runs must not blank the panels.
        if (st?.sync || !st?.running) setSync(st?.sync ?? null);
        setResources(st?.resources ?? null);
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

  /** Load a saved instance into the form and start following it. */
  const loadInstance = async (target: InstanceConfig) => {
    setActiveConfig(target);
    setNetwork(target.network);
    if (target.name) setName(target.name);
    if (target.port) setPort(target.port);
    setDbPath(target.dbPath ?? "");
    setSnapshotDir(target.snapshotDir ?? "");
    setN2cSocket(target.n2cSocket ?? "");
    setSkipApply(!!target.skipApply);
    setSettings({ ...DEFAULT_NODE_SETTINGS, ...(target.nodeSettings ?? {}) });
    setConfigWritten(!!target.instanceDir);
    setBootstrapReady(target.bootstrapState === "ready");
    setSync(null);
    setResources(null);
    setHealth(null);
    const st = await manager.status(target.id);
    if (st?.running) {
      setNodeRunning(true);
      setStatusMsg(`Resumed running · ${target.id}`);
      startNodePolls(target.id);
    } else {
      setNodeRunning(false);
      if (target.instanceDir) setStatusMsg(`Resumed instance · ${target.id}`);
    }
  };

  /**
   * The network dropdown selects an instance, it never retargets one: each
   * network has its own id, folder and chain DB under ~/.local/share/gerolamo.
   * Existing instance for that network → load it; none → a fresh, unsaved form
   * whose paths are computed on save.
   */
  const switchNetwork = async (net: "preprod" | "mainnet" | "preview") => {
    if (net === network() && activeConfig()?.network === net) return;
    stopPolls();
    setErrorMsg("");
    try {
      const nodes = await manager.list();
      const same = nodes.filter((n) => n.network === net);
      const target = same.find((n) => n.runState === "running") ?? same[0];
      if (target) {
        await loadInstance(target);
        return;
      }
    } catch (e) {
      console.error("[ControlCenter] switchNetwork list failed", e);
    }
    // No instance yet for this network: start from a clean form.
    setActiveConfig(null);
    setNetwork(net);
    setDbPath("");
    setSnapshotDir("");
    setN2cSocket("");
    setSkipApply(false);
    setSettings({ ...DEFAULT_NODE_SETTINGS });
    setConfigWritten(false);
    setBootstrapReady(false);
    setNodeRunning(false);
    setSync(null);
    setResources(null);
    setHealth(null);
    setStatusMsg(`New ${net} instance — save config.json to create it (DB and snapshot paths default under ~/.local/share/gerolamo/gerolamo-${net}-<id>/)`);
  };

  onMount(() => {
    void (async () => {
      try {
        const nodes = await manager.list();
        const same = nodes.filter((n) => n.network === network());
        const target = same.find((n) => n.runState === "running") ?? same[0];
        if (!target) return;
        await loadInstance(target);
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
      nodeSettings: settings(),
      pid: prev?.pid,
      runState: prev?.runState,
    };
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
      setPage("logs");
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

  const handleWipe = async (kind: "db" | "snap") => {
    const id = activeConfig()?.id;
    if (!id) return;
    setConfirm(null);
    setBusy(true);
    setErrorMsg("");
    try {
      const result = kind === "db" ? await manager.wipeDb(id) : await manager.wipeSnapshots(id);
      if (!result.ok) {
        setErrorMsg(result.error || "Wipe failed");
        return;
      }
      setStatusMsg(
        kind === "db"
          ? `Deleted chain DB · ${result.path || ""}`
          : `Deleted Mithril snapshots · ${result.removed ?? 0} entries in ${result.path || ""}`,
      );
    } catch (e: any) {
      setErrorMsg(e?.message || "wipe failed");
    } finally {
      setBusy(false);
    }
  };

  const formatMetric = (value: string | number | null | undefined) => {
    if (value == null) return "—";
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toLocaleString("en-US") : String(value);
  };

  const go = (id: PageId) => {
    setPage(id);
    if (id === "docs") void loadDocs();
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

  const EMPTY_PEERS = { hot: 0, warm: 0, cold: 0, total: 0, hotKeys: [] as string[], warmKeys: [] as string[], coldSample: [] as string[], failedPeers: 0, recentErrors: [] as { key: string; error: string; failCount: number }[], maliciousPeers: [] as { key: string; reason: string; until: number }[] };
  /** Peer tiers, always defined so the panels never unmount. */
  const peers = () => sync()?.peers ?? EMPTY_PEERS;
  const mp = () => sync()?.multiPeer ?? null;
  const pct = () => {
    const s = sync();
    return s ? Math.max(0, Math.min(100, s.syncPercent)) : 0;
  };

  const pageTitle = () => NAV.find((n) => n.id === page())?.label ?? "Overview";
  const base = () => gerolamoHttpBase(port());

  return (
    <div class="flex h-screen bg-mesh bg-grid-subtle text-text">
      <aside class="flex flex-col h-screen border-r border-border bg-bg-raised/95 shrink-0 w-56 overflow-hidden">
        <div class="flex items-center h-14 px-4 border-b border-border gap-2">
          <img src="./gerolamo-logo.svg" alt="" class="h-8 w-8 rounded-md bg-white object-contain p-0.5" />
          <span class="font-mono text-[16px] font-bold tracking-wider text-accent text-glow-strong select-none">
            GEROLAMO
          </span>
        </div>
        <nav class="flex-1 flex flex-col gap-0.5 py-2 px-2 overflow-y-auto">
          <For each={NAV}>
            {(item) => (
              <button
                type="button"
                onClick={() => go(item.id)}
                class={cn(
                  "relative flex items-center h-10 px-3 rounded-[8px] text-[13px] font-medium transition-colors",
                  page() === item.id
                    ? "bg-accent-dim text-accent"
                    : "text-text-secondary hover:text-text hover:bg-bg-overlay",
                )}
                aria-current={page() === item.id ? "page" : undefined}
              >
                <Show when={page() === item.id}>
                  <div class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-accent" />
                </Show>
                {item.label}
              </button>
            )}
          </For>
        </nav>
        <div class="shrink-0 border-t border-border px-4 py-3">
          <p class="text-[10px] text-text-muted leading-tight">
            Harmonic Labs
            <br />
            <span class="text-text-dim">Standalone TS node/relay</span>
          </p>
        </div>
      </aside>

      <div class="flex flex-1 flex-col min-w-0">
        <header class="relative z-40 flex items-center h-12 shrink-0 border-b border-border bg-bg-card/90 px-5">
          <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/20 to-transparent" />
          <h1 class="text-[15px] font-semibold text-text tracking-tight">{pageTitle()}</h1>
          <div class="ml-auto flex items-center gap-4">
            <div class="flex items-center gap-2">
              <div
                class={cn(
                  "h-[7px] w-[7px] rounded-full",
                  nodeRunning() ? "bg-green pulse-live-green" : "bg-red pulse-live",
                )}
              />
              <span class="text-[11px] font-medium text-text-secondary">
                {nodeRunning() ? "Online" : "Offline"}
              </span>
            </div>
            <Show when={sync()}>
              <span class={cn("text-[11px] font-mono font-semibold tabular-nums", pct() >= 99.9 ? "text-green" : "text-amber")}>
                {pct().toFixed(2)}%
              </span>
            </Show>
            <Show when={sync()?.tipSlot && sync()!.tipSlot !== "0"}>
              <span class="text-[11px] font-mono text-text-dim tabular-nums">
                Slot {Number(sync()!.tipSlot).toLocaleString("en-US")}
              </span>
            </Show>
            <Badge variant="neon">{network().toUpperCase()}</Badge>
          </div>
        </header>

        <main class="flex-1 min-h-0 overflow-y-auto">
          <div class="mx-auto max-w-[1400px] px-6 py-6 space-y-6">
            <Show when={errorMsg()}>
              <div class="glass-card-accent p-3 text-sm text-accent">{errorMsg()}</div>
            </Show>
            <Show when={statusMsg()}>
              <div class="text-sm text-green">{statusMsg()}</div>
            </Show>

            <Show when={page() === "overview"}>
              <div class="flex flex-col gap-6">
                <Show when={sync()?.multiPeer?.halted}>
                  {(h) => (
                    <div class="rounded-[10px] border border-red/30 bg-red-dim p-4 text-[12px]" title={h().reason}>
                      <div class="font-semibold text-red">Sync halted at slot {Number(h().slot).toLocaleString("en-US")}</div>
                      <div class="mt-1 text-text-secondary">
                        A block every peer agrees on failed our ledger rules. That means the local ledger is inconsistent
                        (missing or extra UTxOs), not that a peer lied. Nothing more is applied until the database is
                        repaired: stop the node, use <span class="font-mono">Wipe DB</span> on the Node page, and start again.
                      </div>
                      <div class="mt-1 truncate font-mono text-[11px] text-text-dim">{h().reason}</div>
                    </div>
                  )}
                </Show>
                <div class="glass-card-accent p-6">
                  <div class="flex items-center justify-between mb-6">
                    <div class="flex items-center gap-3">
                      <div class="flex items-center gap-2">
                        <div class={cn("h-[8px] w-[8px] rounded-full", nodeRunning() ? "bg-green pulse-live-green" : "bg-text-muted")} />
                        <span class="text-[13px] font-medium text-text">{nodeRunning() ? "Online" : "Offline"}</span>
                      </div>
                      <Badge variant="neon">{network().toUpperCase()}</Badge>
                      <Show when={sync()?.eraName}>
                        <Badge variant="muted">{sync()!.eraName}</Badge>
                      </Show>
                      <Show when={sync()?.epoch != null}>
                        <Badge variant="muted">Epoch {sync()!.epoch}</Badge>
                      </Show>
                      <Show when={sync()?.multiPeer?.mode}>
                        <Badge variant="muted">{sync()!.multiPeer!.mode} sync</Badge>
                      </Show>
                      <Show when={sync()?.role}>
                        <Badge
                          variant={sync()!.role === "relay" ? "cyan" : "muted"}
                          title={
                            sync()!.role === "relay"
                              ? `Relay: accepting inbound node-to-node peers on ${sync()!.inbound?.host ?? "?"}:${sync()!.inbound?.port ?? "?"} · ${sync()!.inbound?.clients ?? 0} connected`
                              : "Data node: outbound only, no inbound peers. Switch to relay in Node › config (role)."
                          }
                        >
                          {sync()!.role === "relay" ? `relay · ${sync()!.inbound?.clients ?? 0} in` : "data node"}
                        </Badge>
                      </Show>
                      <Show when={sync()?.multiPeer?.bodyValidation}>
                        <Badge
                          variant={sync()!.multiPeer!.bodyValidation === "strict" ? "success" : "warning"}
                          title={
                            sync()!.multiPeer!.bodyValidation === "strict"
                              ? "Full validation: headers, body hashes, peer agreement and transaction rules are enforced. A failing block halts sync."
                              : "Tip sync: no ledger state behind the tip, so transaction rules and scripts are report-only. Headers, body hashes and peer agreement are still enforced."
                          }
                        >
                          {sync()!.multiPeer!.bodyValidation === "strict" ? "validation full" : "validation partial · tip"}
                        </Badge>
                      </Show>
                    </div>
                    <span class="text-[12px] font-mono text-text-dim">
                      {sync()?.uptimeSec != null ? `Uptime ${sync()!.uptimeSec}s` : "Start the node to live-tail tip"}
                    </span>
                  </div>
                  <div class="flex items-center gap-6 mb-5">
                    <ProgressRing
                      value={pct()}
                      size={100}
                      strokeWidth={7}
                      variant={pct() >= 99.9 ? "green" : "accent"}
                    />
                    <div class="flex flex-col flex-1 gap-3">
                      <div class="flex items-end gap-3">
                        <span class="font-mono text-[42px] font-bold leading-none tabular-nums text-text text-glow-strong">
                          {pct().toFixed(2)}
                        </span>
                        <span class="text-[18px] font-semibold text-text-secondary mb-1">%</span>
                      </div>
                      <div class="relative">
                        <ProgressBar value={pct()} variant={pct() >= 99.9 ? "green" : "accent"} />
                        <div class="shimmer-bar absolute inset-0 rounded-full pointer-events-none" />
                      </div>
                      <Show when={sync()?.epochProgress}>
                        {(ep) => (
                          <div
                            class="flex flex-col gap-1"
                            title={
                              ep().live
                                ? `Epoch ${ep().epoch} is the live epoch. ${ep().slotsLeft.toLocaleString("en-US")} slots between the node's tip and the network clock.`
                                : `The node is applying epoch ${ep().epoch}. ${ep().slotsLeft.toLocaleString("en-US")} of ${ep().lengthSlots.toLocaleString("en-US")} slots remain in it, then ${ep().epochsBehind - 1} more epoch${ep().epochsBehind - 1 === 1 ? "" : "s"} before the live epoch ${ep().clockEpoch}.`
                            }
                          >
                            <div class="flex items-center justify-between text-[11px]">
                              <span class="text-text-dim">
                                Epoch <span class="font-mono text-text">{ep().epoch}</span>
                                <Show when={!ep().live}>
                                  <span class="text-text-muted"> of {ep().clockEpoch} · {ep().epochsBehind} behind</span>
                                </Show>
                                <Show when={ep().live}>
                                  <span class="text-green"> · live</span>
                                </Show>
                              </span>
                              <span class="font-mono tabular-nums text-text">
                                {ep().percent.toFixed(1)}% · {ep().slotsLeft.toLocaleString("en-US")} slots left
                              </span>
                            </div>
                            <ProgressBar value={ep().percent} variant={ep().live ? "green" : "cyan"} />
                          </div>
                        )}
                      </Show>
                    </div>
                  </div>
                  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div
                      class="flex flex-col items-center text-center rounded-[8px] bg-bg-sunken/50 py-3 px-2 min-h-[72px]"
                      title="Slot of the last block this node has applied to its local chain."
                    >
                      <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Chain tip</span>
                      <span class="font-mono text-[18px] font-bold tabular-nums text-accent text-glow">
                        {formatMetric(sync()?.tipSlot)}
                      </span>
                    </div>
                    <div
                      class="flex flex-col items-center text-center rounded-[8px] bg-bg-sunken/50 py-3 px-2 min-h-[72px]"
                      title="Slot the network clock says it is right now. The gap to Chain tip is how far behind the node is."
                    >
                      <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Network tip</span>
                      <span class="font-mono text-[18px] font-bold tabular-nums text-text">
                        {formatMetric(sync()?.networkTipSlot)}
                      </span>
                    </div>
                    <div
                      class="flex flex-col items-center text-center rounded-[8px] bg-bg-sunken/50 py-3 px-2 min-h-[72px]"
                      title={
                        "Unspent transaction outputs in this node's local ledger, genesis outputs included. " +
                        (sync()?.genesisUtxos && sync()!.genesisUtxos!.total > 0
                          ? `Genesis: ${sync()!.genesisUtxos!.total} output${sync()!.genesisUtxos!.total === 1 ? "" : "s"} seeded from the Byron genesis file` +
                            (sync()!.genesisUtxos!.avvm > 0 ? ` (${sync()!.genesisUtxos!.avvm} AVVM redeem)` : "") +
                            `, ${sync()!.genesisUtxos!.unspent} still unspent.`
                          : "No genesis outputs recorded in this database (it was created before genesis seeding existed, or is not a from-genesis sync).")
                      }
                    >
                      <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">UTxOs</span>
                      <span class="font-mono text-[18px] font-bold tabular-nums text-text">{formatMetric(sync()?.utxoCount)}</span>
                      <Show when={sync()?.genesisUtxos && sync()!.genesisUtxos!.total > 0}>
                        <span class="font-mono text-[10px] text-text-muted">
                          genesis {sync()!.genesisUtxos!.unspent}/{sync()!.genesisUtxos!.total} unspent
                        </span>
                      </Show>
                    </div>
                    <div
                      class="flex flex-col items-center text-center rounded-[8px] bg-bg-sunken/50 py-3 px-2 min-h-[72px]"
                      title="Peers with an active ChainSync connection. One is primary, the others cross-check its headers."
                    >
                      <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Hot peers</span>
                      <span class="font-mono text-[18px] font-bold tabular-nums text-text">{formatMetric(sync()?.peers.hot ?? sync()?.hotPeers)}</span>
                    </div>
                  </div>
                </div>

                <div class="stagger grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  <div class="glass-card-accent p-5">
                    <Stat label="Process" title="Whether the gerolamo bun process spawned by this app is alive." value={nodeRunning() ? "alive" : "stopped"} accent glow size="md" />
                  </div>
                  <div class="glass-card-accent p-5">
                    <Stat label="HTTP" title="Health of the node's local HTTP API (MiniBF, /metrics) and its response time." value={health()?.healthy ? `ok · ${health()!.latencyMs ?? "?"}ms` : "down"} size="md" />
                  </div>
                  <div class="glass-card-accent p-5">
                    <Stat label="Port" title="Local port the node's HTTP API listens on." value={port()} size="md" />
                  </div>
                  <div class="glass-card-accent p-5">
                    <Stat label="Warm" title="Connected standby peers. Promoted to hot when a hot peer drops or misbehaves." value={sync()?.peers.warm ?? 0} accent glow glowColor="orange" size="md" />
                  </div>
                  <div class="glass-card-accent p-5">
                    <Stat label="Cold" title="Known peer addresses not currently connected, from topology and peer sharing." value={sync()?.peers.cold ?? 0} accent glow glowColor="cyan" size="md" />
                  </div>
                </div>

                <Show when={resources()}>
                  {(res) => {
                    const sys = () => res().system;
                    const node = () => res().node;
                    const sysMemPct = () => (sys().totalMemBytes > 0 ? (sys().usedMemBytes / sys().totalMemBytes) * 100 : 0);
                    const barVariant = (p: number) => (p >= 90 ? "accent" : p >= 70 ? "orange" : "green");
                    return (
                      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        <div class="glass-card p-4">
                          <div class="mb-3 flex items-center justify-between">
                            <div class="text-[11px] font-semibold text-text-secondary">System</div>
                            <span class="truncate font-mono text-[11px] text-text-dim" title={sys().cpuModel ?? ""}>
                              {sys().cpus} cores · {sys().platform}/{sys().arch}
                            </span>
                          </div>
                          <div class="space-y-3">
                            <div>
                              <div class="mb-1 flex items-center justify-between text-[11px]">
                                <span class="text-text-dim">CPU</span>
                                <span class="font-mono tabular-nums text-text">
                                  {formatPercent(sys().cpuPercent)} · load {sys().loadAvg[0]} / {sys().loadAvg[1]} / {sys().loadAvg[2]}
                                </span>
                              </div>
                              <ProgressBar value={sys().cpuPercent ?? 0} variant={barVariant(sys().cpuPercent ?? 0)} />
                            </div>
                            <div>
                              <div class="mb-1 flex items-center justify-between text-[11px]">
                                <span class="text-text-dim">Memory</span>
                                <span class="font-mono tabular-nums text-text">
                                  {formatBytes(sys().usedMemBytes)} / {formatBytes(sys().totalMemBytes)} · {formatPercent(sysMemPct())}
                                </span>
                              </div>
                              <ProgressBar value={sysMemPct()} variant={barVariant(sysMemPct())} />
                            </div>
                            <Show when={sys().cpuModel}>
                              <div class="truncate text-[11px] text-text-muted">{sys().cpuModel}</div>
                            </Show>
                          </div>
                        </div>

                        <div class="glass-card p-4">
                          <div class="mb-3 flex items-center justify-between">
                            <div class="text-[11px] font-semibold text-text-secondary">Gerolamo</div>
                            <span class="font-mono text-[11px] text-text-dim">
                              {node()?.pid ? `pid ${node()!.pid}` : "not running"}
                              {node()?.threads != null ? ` · ${node()!.threads} threads` : ""}
                              {sync()?.multiPeer ? ` · ${sync()!.multiPeer!.validationWorkers} workers` : ""}
                            </span>
                          </div>
                          <Show
                            when={node() && node()!.source !== "none"}
                            fallback={
                              <div class="space-y-3">
                                <div class="text-[11px] text-text-muted">
                                  {nodeRunning() ? "Waiting for the node's /metrics…" : "Start the node to see its CPU and memory."}
                                </div>
                                <Show when={node()?.dbBytes != null}>
                                  <div class="flex items-center justify-between text-[11px]">
                                    <span class="text-text-dim">Chain DB on disk</span>
                                    <span class="font-mono tabular-nums text-text">{formatBytes(node()!.dbBytes)}</span>
                                  </div>
                                </Show>
                              </div>
                            }
                          >
                            <div class="space-y-3">
                              <div>
                                <div class="mb-1 flex items-center justify-between text-[11px]">
                                  <span class="text-text-dim">CPU</span>
                                  <span class="font-mono tabular-nums text-text">
                                    {formatPercent(node()!.cpuPercent)} of 1 core · {formatPercent(nodeCpuShare(node(), sys()), 1)} of machine
                                  </span>
                                </div>
                                <ProgressBar value={nodeCpuShare(node(), sys())} variant="cyan" />
                              </div>
                              <div>
                                <div class="mb-1 flex items-center justify-between text-[11px]">
                                  <span class="text-text-dim">Memory (RSS)</span>
                                  <span class="font-mono tabular-nums text-text">
                                    {formatBytes(node()!.rssBytes)} · {formatPercent(nodeMemShare(node(), sys()), 1)} of machine
                                  </span>
                                </div>
                                <ProgressBar value={nodeMemShare(node(), sys())} variant="cyan" />
                              </div>
                              <div class="grid grid-cols-3 gap-2 pt-1">
                                <Stat
                                  label="JS heap" title="Memory used by JavaScript objects in the node process, out of what the engine has reserved."
                                  value={node()!.heapUsedBytes != null ? `${formatBytes(node()!.heapUsedBytes)} / ${formatBytes(node()!.heapTotalBytes)}` : "—"}
                                  size="sm"
                                />
                                <Stat label="Native / buffers" title="Memory held outside the JS heap: CBOR buffers, SQLite, crypto." value={formatBytes(node()!.externalBytes)} size="sm" />
                                <Stat label="Chain DB on disk" title="Size of the SQLite chain database plus its WAL and SHM sidecar files." value={formatBytes(node()!.dbBytes)} size="sm" />
                              </div>
                            </div>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </Show>

                <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  <div class="glass-card p-3">
                    <div class="mb-2 text-[11px] font-semibold text-green">Hot · ChainSync ({peers().hot})</div>
                    <Show when={(mp()?.peers.length ?? 0) > 0}>
                      <div class="mb-2 flex flex-col gap-1 font-mono text-[11px]">
                        <For each={mp()!.peers}>
                          {(p) => (
                            <div class="flex items-center gap-2 truncate">
                              <span
                                class={cn(
                                  "inline-block h-[6px] w-[6px] rounded-full",
                                  p.role === "primary"
                                    ? "bg-accent"
                                    : p.status === "agrees"
                                    ? "bg-green"
                                    : p.status === "divergent"
                                    ? "bg-red"
                                    : "bg-text-muted",
                                )}
                              />
                              <span class="truncate">{p.key}</span>
                              <span class="text-text-dim">
                                {p.role === "primary"
                                  ? "primary"
                                  : p.status === "agrees"
                                  ? `✓ agrees @${p.agreedAtSlot ?? "?"}`
                                  : p.status === "divergent"
                                  ? `✗ divergent @${p.divergenceSlot ?? "?"}`
                                  : p.status}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="max-h-36 min-h-[40px] space-y-1 overflow-y-auto font-mono text-[11px] text-text-secondary">
                      <For each={peers().hotKeys}>{(peer) => <div class="truncate">{peer}</div>}</For>
                      <Show when={peers().hotKeys.length === 0}>
                        <div class="text-text-muted">{nodeRunning() ? "Connecting to peers…" : "Node stopped"}</div>
                      </Show>
                    </div>
                  </div>
                  <div class="glass-card p-3">
                    <div class="mb-2 text-[11px] font-semibold text-amber">Warm · standby ({peers().warm})</div>
                    <div class="max-h-36 min-h-[40px] space-y-1 overflow-y-auto font-mono text-[11px] text-text-secondary">
                      <For each={peers().warmKeys}>{(peer) => <div class="truncate">{peer}</div>}</For>
                      <Show when={peers().warmKeys.length === 0}><div class="text-text-muted">No warm peers</div></Show>
                    </div>
                  </div>
                  <div class="glass-card p-3">
                    <div class="mb-2 text-[11px] font-semibold text-blue">Cold · known ({peers().cold})</div>
                    <div class="max-h-36 min-h-[40px] space-y-1 overflow-y-auto font-mono text-[11px] text-text-muted">
                      <For each={peers().coldSample}>{(peer) => <div class="truncate">{peer}</div>}</For>
                      <Show when={peers().coldSample.length === 0}><div class="text-text-muted">No cold peers</div></Show>
                    </div>
                  </div>
                </div>

                <div class="glass-card p-4">
                  <div class="mb-3 flex items-center justify-between">
                    <div class="text-[11px] font-semibold text-text-secondary">Multi-peer sync · honesty & pipeline</div>
                    <span class="font-mono text-[11px] text-text-dim">
                      quorum {mp()?.quorum ?? "—"} · {mp()?.validationWorkers ?? "—"} validation worker{(mp()?.validationWorkers ?? 0) === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <Stat label="Primary" title="Hot peer whose headers drive block download and apply. Others only verify." value={mp()?.primary ?? "—"} size="sm" />
                    <Stat
                      label="Verifiers agreeing" title="Verifier peers whose header hashes match the primary at the same slots."
                      value={mp() ? `${mp()!.agreeing} / ${Math.max(0, mp()!.peers.length - 1)}` : "—"}
                      accent
                      glow
                      glowColor={(mp()?.divergent ?? 0) > 0 ? "orange" : "green"}
                      size="sm"
                    />
                    <Stat label="Divergent" title="Peers that served a different header for a slot the primary already delivered. Held cold for an hour." value={mp()?.divergent ?? "—"} size="sm" />
                    <Stat
                      label="Ranges" title="BlockFetch ranges: downloading now, downloaded but waiting to apply in order, and re-issued after a failed or lying peer."
                      value={mp() ? `${mp()!.rangesInFlight} ↓ · ${mp()!.rangesAwaitingApply} wait · ${mp()!.rangeRetries} retry` : "—"}
                      size="sm"
                    />
                    <Stat label="Blocks / s" title="Blocks applied to the local ledger per second, recent average." value={mp() ? mp()!.blocksPerSec.toFixed(1) : "—"} accent glow size="sm" />
                  </div>
                  <Show when={peers().maliciousPeers.length > 0}>
                    <div class="mt-3 text-[11px] font-semibold text-red">Held cold for bad data</div>
                    <div class="mt-1 flex flex-col gap-1 font-mono text-[11px] text-text-dim">
                      <For each={peers().maliciousPeers}>
                        {(m) => <div class="truncate">{m.key} — {m.reason.replace(/^malicious:\s*/, "")}</div>}
                      </For>
                    </div>
                  </Show>
                  <Show when={peers().recentErrors.length > 0}>
                    <div class="mt-3 text-[11px] font-semibold text-text-secondary">Recent peer errors</div>
                    <div class="mt-1 flex flex-col gap-1 font-mono text-[11px] text-text-dim">
                      <For each={peers().recentErrors.slice(0, 4)}>
                        {(e) => <div class="truncate">{e.key} ×{e.failCount} — {e.error}</div>}
                      </For>
                    </div>
                  </Show>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button onClick={() => void manager.openExternal(`${base()}/docs`)} disabled={!health()?.healthy} class={btnPrimary}>
                    Open MiniBF /docs
                  </button>
                  <button onClick={() => void manager.openExternal(`${base()}/stats`)} disabled={!health()?.healthy} class={btnSecondary}>
                    Open /stats
                  </button>
                  <button onClick={() => go("node")} class={btnSecondary}>Node controls</button>
                  <button onClick={() => go("mithril")} class={btnSecondary}>Mithril</button>
                </div>
              </div>
            </Show>

            <Show when={page() === "node"}>
              <div class="space-y-4">
                <div class="glass-card-accent p-5 space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <h2 class="text-h2">Node</h2>
                    <Badge variant={nodeRunning() ? "success" : "muted"}>{nodeRunning() ? `pid ${activeConfig()?.pid ?? "live"}` : "stopped"}</Badge>
                  </div>
                  <p class="text-[12px] text-text-dim">
                    Spawns <code class="text-text">bun src/index.ts start-gerolamo</code> with NETWORK / GEROLAMO_DB_PATH. Overlay at ~/.local/share/gerolamo.
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <span data-tooltip={blockedBecause("startNode") ?? "Spawn the node for this instance."}>
                      <button onClick={() => void handleStart()} disabled={busy() || !!blockedBecause("startNode")} class={btnPrimary}>
                        Start
                      </button>
                    </span>
                    <span data-tooltip={nodeRunning() ? "Stop the node (SIGTERM, then SIGKILL after 800 ms)." : "The node is not running."}>
                      <button onClick={() => void handleStop()} disabled={busy() || !activeConfig()?.id || !nodeRunning()} class={btnDanger}>
                        Stop
                      </button>
                    </span>
                    <button
                      class={btnDanger}
                      disabled={busy() || !!blockedBecause("wipeDb")}
                      data-tooltip={blockedBecause("wipeDb") ?? "Delete the SQLite chain DB (+ WAL). Start fresh from genesis, tip or Mithril."}
                      onClick={() => setConfirm("db")}
                    >
                      Delete chain DB
                    </button>
                  </div>
                </div>
                <div class="glass-card p-5 space-y-3">
                  <div class="flex items-center justify-between">
                    <h3 class="text-[14px] font-semibold">config.json</h3>
                    <Badge variant={configWritten() ? "success" : "warning"}>{configWritten() ? "saved" : "not saved"}</Badge>
                  </div>
                  <NodeConfigForm
                    name={name()}
                    setName={setName}
                    network={network()}
                    setNetwork={(v) => void switchNetwork(v)}
                    port={port()}
                    setPort={setPort}
                    dbPath={dbPath()}
                    setDbPath={setDbPath}
                    snapshotDir={snapshotDir()}
                    setSnapshotDir={setSnapshotDir}
                    n2cSocket={n2cSocket()}
                    setN2cSocket={setN2cSocket}
                    skipApply={skipApply()}
                    setSkipApply={setSkipApply}
                    settings={settings()}
                    patchSettings={patchSettings}
                    onPickDb={() => void pick("db")}
                    onPickSnap={() => void pick("snap")}
                  />
                  <button
                    onClick={() => void handleWriteConfig()}
                    disabled={busy() || !hasRuntime()}
                    class={btnPrimary}
                    data-tooltip={"Writes ~/.local/share/gerolamo/<id>/config.json\nOverlay on src/config/{network}/config.json\nDoes not edit the repo file."}
                  >
                    Save config.json
                  </button>
                  <Show when={detectInfo()}>
                    <div class="text-[11px] font-mono text-text-dim space-y-1">
                      <div>bun: {detectInfo()!.bunPath || "missing"} · {detectInfo()!.bunVersion || "?"}</div>
                      <div>repo: {detectInfo()!.repoPath || "missing"}</div>
                      <Show when={detectInfo()!.error}>
                        <div class="text-accent">{detectInfo()!.error}</div>
                      </Show>
                      <button onClick={() => void refetchDetect()} disabled={busy()} class={btnSecondary}>
                        Re-detect runtime
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={page() === "mithril"}>
              <div class="space-y-4">
                <div class="glass-card-accent p-5 space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <h2 class="text-h2">Mithril bootstrap</h2>
                    <Badge variant={bootstrapReady() ? "success" : boot()?.stage === "failed" ? "danger" : "warning"}>
                      {boot()?.stage === "ready" ? "ready" : bootstrapReady() ? "skipped" : boot()?.stage || "idle"}
                    </Badge>
                  </div>
                  <p class="text-[12px] text-text-dim">
                    <code class="text-text">mithril-bootstrap --engine ts</code> · no fake percent · one writer on the DB. Preprod first. Skip if you already have a dense SQLite file.
                  </p>
                  <Show when={boot()}>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <div class="rounded-md border border-border px-2 py-1 bg-bg-sunken/50">
                        Snapshot
                        <div class="font-mono text-text">{boot()!.snapshotHuman ?? "—"}</div>
                      </div>
                      <div class="rounded-md border border-border px-2 py-1 bg-bg-sunken/50">
                        Data
                        <div class="font-mono text-text">{boot()!.dataHuman ?? "—"}</div>
                      </div>
                      <div class="rounded-md border border-border px-2 py-1 bg-bg-sunken/50">
                        Immutable
                        <div class="font-mono text-text">{boot()!.immutableCount ?? "—"}</div>
                      </div>
                      <div class="rounded-md border border-border px-2 py-1 bg-bg-sunken/50">
                        Process
                        <div class="font-mono text-text">{boot()!.processAlive ? "alive" : "stopped"}</div>
                      </div>
                    </div>
                  </Show>
                  <div class="flex flex-wrap gap-2">
                    <span data-tooltip={blockedBecause("bootstrap") ?? "Download the latest Mithril snapshot, verify its certificate chain (pure TS) and import it into the chain DB."}>
                      <button onClick={() => void handleBootstrap()} disabled={busy() || !!blockedBecause("bootstrap")} class={btnPrimary}>
                        Start bootstrap
                      </button>
                    </span>
                    <span data-tooltip={blockedBecause("skip") ?? "Mark bootstrap as done and keep whatever the chain DB already holds."}>
                      <button onClick={() => void handleSkipBootstrap()} disabled={busy() || !!blockedBecause("skip")} class={btnSecondary}>
                        Skip (use existing DB)
                      </button>
                    </span>
                    <span data-tooltip={blockedBecause("stopBootstrap") ?? "Stop the running bootstrap process."}>
                      <button onClick={() => void manager.bootstrapStop()} disabled={busy() || !!blockedBecause("stopBootstrap")} class={btnDanger}>
                        Stop bootstrap
                      </button>
                    </span>
                    <span data-tooltip={blockedBecause("wipeSnap") ?? "Delete files in the Mithril snapshot dir. Keeps the empty folder."}>
                      <button
                        class={btnDanger}
                        disabled={busy() || !!blockedBecause("wipeSnap")}
                        onClick={() => setConfirm("snap")}
                      >
                        Delete Mithril snapshots
                      </button>
                    </span>
                    <button onClick={() => setBootLogOpen(!bootLogOpen())} class={btnSecondary}>
                      {bootLogOpen() ? "Hide log" : "Show log"}
                    </button>
                  </div>
                  <Show when={nodeRunning()}>
                    <p class="text-[11px] text-amber">
                      Node is running and owns the chain DB, so bootstrap is unavailable. Stop the node on the Node page to bootstrap from Mithril.
                    </p>
                  </Show>
                  <Show when={bootLogOpen()}>
                    <LogFollowPre lines={bootLogLines()} empty="No bootstrap.log yet." />
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={page() === "logs"}>
              <div class="glass-card-accent p-5 space-y-3">
                <div class="flex items-center justify-between">
                  <h2 class="text-h2">daemon.log</h2>
                  <span class="text-[11px] text-text-dim">Follows newest line</span>
                </div>
                <LogFollowPre lines={logLines()} empty="No daemon.log yet. Start the node from Node." />
              </div>
            </Show>

            <Show when={page() === "docs"}>
              <div class="kb-prose glass-card p-5" innerHTML={docsHtml() || "<p>Loading…</p>"} />
            </Show>
          </div>
        </main>
      </div>

      <Show when={confirm() === "db"}>
        <ConfirmDialog
          title="Delete chain DB?"
          body={`This removes the SQLite file (and WAL/SHM):\n${activeConfig()?.dbPath || ""}\n\nStop the node first. You can then sync from tip or re-run Mithril.`}
          confirmLabel="Delete DB"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void handleWipe("db")}
        />
      </Show>
      <Show when={confirm() === "snap"}>
        <ConfirmDialog
          title="Delete Mithril snapshots?"
          body={`This deletes files inside:\n${activeConfig()?.snapshotDir || ""}\n\nThe folder stays. Stop bootstrap first. Re-download if you need density again.`}
          confirmLabel="Delete snapshots"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void handleWipe("snap")}
        />
      </Show>
    </div>
  );
};

export default ControlCenter;
