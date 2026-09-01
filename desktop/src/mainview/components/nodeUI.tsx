import { Component, JSX, Show } from "solid-js";

export type NodeNetwork = "mainnet" | "preprod" | "preview";

export function networkLabel(network: NodeNetwork | string): string {
  if (network === "mainnet") return "Mainnet";
  if (network === "preview") return "Preview";
  return "Preprod";
}

export function networkBadgeClass(network: NodeNetwork | string): string {
  if (network === "mainnet") return "bg-emerald-950/70 text-emerald-300 border-emerald-700/50";
  if (network === "preview") return "bg-violet-950/70 text-violet-300 border-violet-700/50";
  return "bg-sky-950/70 text-sky-300 border-sky-700/50";
}

export function networkDotClass(network: NodeNetwork | string): string {
  if (network === "mainnet") return "bg-emerald-400";
  if (network === "preview") return "bg-violet-400";
  return "bg-sky-400";
}

export function stepCardClass(done: boolean, active?: boolean): string {
  if (done) return "border-emerald-700/60 bg-emerald-950/30 text-emerald-300";
  if (active) return "border-amber-700/50 bg-amber-950/20 text-amber-200";
  return "border-zinc-800 bg-zinc-950/40 text-zinc-400";
}

export const NetworkBadge: Component<{ network: NodeNetwork | string; title?: string }> = (props) => (
  <span
    class={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold border ${networkBadgeClass(props.network)}`}
    title={props.title || "Active network for this instance"}
  >
    <span class={`inline-block w-1.5 h-1.5 rounded-full ${networkDotClass(props.network)}`} />
    {networkLabel(props.network)}
  </span>
);

export const RunningPill: Component<{ label?: string }> = (props) => (
  <span class="inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
    <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
    {props.label || "Running"}
  </span>
);

export const IdentityRow: Component<{
  network: NodeNetwork | string;
  id?: string | null;
  dir?: string | null;
  extra?: JSX.Element;
}> = (props) => (
  <div class="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-400 font-mono flex flex-wrap gap-x-4 gap-y-1">
    <span>
      Network: <span class="text-sky-300 font-semibold">{props.network}</span>
    </span>
    <Show when={props.id}>
      <span class="truncate">id: {props.id}</span>
    </Show>
    <Show when={props.dir}>
      <span class="truncate">dir: …/{props.dir!.split("/").pop()}</span>
    </Show>
    {props.extra}
  </div>
);

export const CollapsibleConfig: Component<{
  summary: JSX.Element | string;
  children: JSX.Element;
  open?: boolean;
}> = (props) => (
  <details class="rounded-lg border border-zinc-800 bg-zinc-950/40 group" open={props.open}>
    <summary class="cursor-pointer select-none px-3 py-2.5 text-sm text-zinc-300 hover:text-white flex items-center justify-between gap-2 list-none [&::-webkit-details-marker]:hidden">
      <span class="font-medium min-w-0">{props.summary}</span>
      <span class="text-[10px] text-zinc-500 group-open:hidden shrink-0">Show</span>
      <span class="text-[10px] text-zinc-500 hidden group-open:inline shrink-0">Hide</span>
    </summary>
    <div class="px-3 pb-3 space-y-4 border-t border-zinc-800/80 pt-3">{props.children}</div>
  </details>
);

export const StepCard: Component<{
  n: number;
  title: string;
  done: boolean;
  active?: boolean;
  open?: boolean;
  doneHint?: string;
  children?: JSX.Element;
}> = (props) => (
  <div class={`rounded-lg border px-3 py-2 ${stepCardClass(props.done, props.active)}`}>
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <div class="text-sm font-medium flex items-center gap-2">
          <span class={props.done ? "text-emerald-400" : ""}>{props.done ? "✓" : `${props.n}.`}</span>
          {props.title}
          <Show when={props.done && props.doneHint}>
            <span class="text-[11px] font-normal opacity-70">· {props.doneHint}</span>
          </Show>
        </div>
      </div>
    </div>
    <Show when={props.open !== false && props.children}>
      <div class="mt-2 space-y-2">{props.children}</div>
    </Show>
  </div>
);

export const ProgressiveNodePanel: Component<{
  title: string;
  network: NodeNetwork | string;
  headerRight?: JSX.Element | string;
  running?: boolean;
  runningLabel?: string;
  identity?: { id?: string | null; dir?: string | null; extra?: JSX.Element } | null;
  banner?: JSX.Element;
  bannerPlacement?: "before-config" | "after-steps";
  configSummary: JSX.Element | string;
  config: JSX.Element;
  steps: JSX.Element;
  footer?: JSX.Element;
  statusMsg?: string | null;
  errorMsg?: string | null;
}> = (props) => (
  <div class="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="text-sm font-semibold text-white">{props.title}</div>
        <NetworkBadge network={props.network} />
        <Show when={props.running}>
          <RunningPill label={props.runningLabel} />
        </Show>
      </div>
      <div class="text-[11px] text-zinc-500">{props.headerRight}</div>
    </div>
    <Show when={props.identity}>
      <IdentityRow
        network={props.network}
        id={props.identity!.id}
        dir={props.identity!.dir}
        extra={props.identity!.extra}
      />
    </Show>
    <Show when={props.bannerPlacement !== "after-steps" && props.banner}>{props.banner}</Show>
    <CollapsibleConfig summary={props.configSummary}>{props.config}</CollapsibleConfig>
    <div class="space-y-2">{props.steps}</div>
    <Show when={props.bannerPlacement === "after-steps" && props.banner}>{props.banner}</Show>
    <Show when={props.statusMsg}>
      <div class="text-sm text-emerald-400/90">{props.statusMsg}</div>
    </Show>
    <Show when={props.errorMsg}>
      <div class="p-3 rounded-lg bg-red-950 border border-red-800 text-red-400 text-sm">{props.errorMsg}</div>
    </Show>
    {props.footer}
  </div>
);

export const fieldClass =
  "w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-500";
export const labelClass = "block text-xs text-zinc-400 mb-1";
export const btnSecondary =
  "px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-white";
export const btnPrimary =
  "px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-white font-medium";
export const btnDanger =
  "px-3 py-1.5 text-xs bg-red-900 hover:bg-red-800 disabled:opacity-50 rounded-lg text-red-100";
