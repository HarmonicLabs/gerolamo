import { createSignal, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Toaster } from "solid-sonner";
import {
  LayoutDashboard, Server, Boxes, Users, Search,
  Wallet, Code, FileText, Settings,
} from "lucide-solid";
import { useBrowserNodeState } from "@/lib/background-bridge";
import { Badge } from "@/components/ui/badge";

import OverviewPage from "@/pages/OverviewPage";
import NodePage from "@/pages/NodePage";
import BlocksPage from "@/pages/BlocksPage";
import PeersPage from "@/pages/PeersPage";
import ExplorerPage from "@/pages/ExplorerPage";
import WalletPage from "@/pages/WalletPage";
import PebblePage from "@/pages/PebblePage";
import LogsPage from "@/pages/LogsPage";
import SettingsPage from "@/pages/SettingsPage";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 3000 } },
});

type TabId = "overview" | "node" | "blocks" | "peers" | "explorer" | "wallet" | "pebble" | "logs" | "settings";

const TABS: { id: TabId; label: string; Icon: Component<{ size?: number; class?: string }> }[] = [
  { id: "overview", label: "Home", Icon: LayoutDashboard },
  { id: "node", label: "Node", Icon: Server },
  { id: "blocks", label: "Blocks", Icon: Boxes },
  { id: "peers", label: "Network", Icon: Users },
  { id: "explorer", label: "Search", Icon: Search },
  { id: "wallet", label: "Wallet", Icon: Wallet },
  { id: "pebble", label: "Pebble", Icon: Code },
  { id: "logs", label: "Logs", Icon: FileText },
  { id: "settings", label: "Config", Icon: Settings },
];

const PAGES: Record<TabId, Component> = {
  overview: OverviewPage,
  node: NodePage,
  blocks: BlocksPage,
  peers: PeersPage,
  explorer: ExplorerPage,
  wallet: WalletPage,
  pebble: PebblePage,
  logs: LogsPage,
  settings: SettingsPage,
};

function Header() {
  const { bgState } = useBrowserNodeState();

  const statusColor = () => {
    const s = bgState().state;
    return s === "synced" ? "bg-green-500" :
      s === "connecting" ? "bg-yellow-500 animate-pulse" :
      "bg-red-500";
  };

  return (
    <header class="flex items-center justify-between px-3 py-2 border-b border-border glass-panel">
      <div class="flex items-center gap-2">
        <span class="text-sm font-bold neon-text-red">GEROLAMINO</span>
        <span class="text-[9px] text-muted-foreground">v0.3.0</span>
      </div>
      <div class="flex items-center gap-2">
        <Badge variant="outline" class="text-[9px] py-0 px-1.5 h-4">{bgState().network}</Badge>
        <div class={`h-2 w-2 rounded-full ${statusColor()}`} title={bgState().state} />
      </div>
    </header>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = createSignal<TabId>("overview");

  return (
    <QueryClientProvider client={queryClient}>
      <div class="flex flex-col h-full">
        <Header />
        <main class="flex-1 overflow-y-auto p-3 animate-fade-in-up">
          <Dynamic component={PAGES[activeTab()]} />
        </main>
        <nav class="grid grid-cols-9 border-t border-border glass-panel">
          {TABS.map(({ id, label, Icon }) => (
            <button
              onClick={() => setActiveTab(id)}
              class={`flex flex-col items-center gap-0.5 py-1.5 transition-colors ${
                activeTab() === id ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon size={14} />
              <span class="text-[7px] leading-none">{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <Toaster theme="dark" position="top-center" />
    </QueryClientProvider>
  );
}
