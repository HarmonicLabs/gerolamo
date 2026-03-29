import { createSignal, lazy, Suspense, type Component } from "solid-js";
import { Tabs } from "@kobalte/core/tabs";
import { cn } from "@/lib/cn";

const Overview = lazy(() => import("@/pages/Overview"));
const Blocks = lazy(() => import("@/pages/Blocks"));
const Peers = lazy(() => import("@/pages/Peers"));
const Explorer = lazy(() => import("@/pages/Explorer"));
const Logs = lazy(() => import("@/pages/Logs"));

const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "blocks", label: "Blocks" },
  { id: "peers", label: "Peers" },
  { id: "explorer", label: "Explorer" },
  { id: "logs", label: "Logs" },
] as const;

const App: Component = () => {
  const [tab, setTab] = createSignal<string>("overview");

  return (
    <div class="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header class="flex shrink-0 items-center justify-between border-b border-border bg-bg-raised px-6 py-3">
        <div class="flex items-center gap-3">
          <span class="text-sm font-bold tracking-tight text-accent">GEROLAMO</span>
          <span class="text-[10px] font-medium uppercase tracking-widest text-text-muted">
            Cardano Node Dashboard
          </span>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-text-muted">
          <span>Harmonic Labs</span>
        </div>
      </header>

      {/* Navigation + Content */}
      <Tabs value={tab()} onChange={setTab} class="flex flex-1 overflow-hidden">
        <Tabs.List class="flex shrink-0 flex-col gap-1 border-r border-border bg-bg-raised p-2 pt-4">
          {NAV_ITEMS.map((item) => (
            <Tabs.Trigger
              value={item.id}
              class={cn(
                "rounded-[var(--radius-sm)] px-4 py-2 text-left text-xs font-medium transition-colors",
                "hover:bg-bg-sunken hover:text-text",
                "data-[selected]:bg-accent-dim data-[selected]:text-accent",
                "text-text-dim",
              )}
            >
              {item.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <div class="flex-1 overflow-y-auto p-6">
          <Suspense fallback={<div class="py-12 text-center text-text-dim">Loading...</div>}>
            <Tabs.Content value="overview" class="outline-none"><Overview /></Tabs.Content>
            <Tabs.Content value="blocks" class="outline-none"><Blocks /></Tabs.Content>
            <Tabs.Content value="peers" class="outline-none"><Peers /></Tabs.Content>
            <Tabs.Content value="explorer" class="outline-none"><Explorer /></Tabs.Content>
            <Tabs.Content value="logs" class="outline-none"><Logs /></Tabs.Content>
          </Suspense>
        </div>
      </Tabs>
    </div>
  );
};

export default App;
