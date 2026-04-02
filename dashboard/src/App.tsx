import { createSignal, lazy, Suspense, Show, type Component } from "solid-js";
import { Sidebar, Topbar, Footer } from "@/components/Layout";
import { SkeletonCard } from "@/components/ui/skeleton";
import ErrorBoundary from "@/components/ui/error-boundary";
import { ToastProvider } from "@/components/ui/toast";
import type { NavItemId } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Lazy-loaded pages
// ---------------------------------------------------------------------------
const Overview = lazy(() => import("@/pages/Overview"));
const Blocks = lazy(() => import("@/pages/Blocks"));
const Peers = lazy(() => import("@/pages/Peers"));
const Mempool = lazy(() => import("@/pages/Mempool"));
const Explorer = lazy(() => import("@/pages/Explorer"));
const Logs = lazy(() => import("@/pages/Logs"));
const Settings = lazy(() => import("@/pages/Settings"));
const ChainDiagram = lazy(() => import("@/components/Diagram/ChainDiagram"));

// ---------------------------------------------------------------------------
// Loading skeleton fallback — replaces the old spinner
// ---------------------------------------------------------------------------
const PageSkeleton: Component = () => (
  <div class="flex flex-col gap-4 py-2">
    <SkeletonCard lines={2} />
    <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
      <SkeletonCard lines={1} />
      <SkeletonCard lines={1} />
      <SkeletonCard lines={1} />
    </div>
    <SkeletonCard lines={4} />
  </div>
);

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------
const App: Component = () => {
  const [activePage, setActivePage] = createSignal<NavItemId>("overview");

  // Read initial collapsed state from localStorage
  let initialCollapsed = false;
  try {
    initialCollapsed = localStorage.getItem("gerolamo:sidebar-collapsed") === "true";
  } catch { /* noop */ }
  const [collapsed, setCollapsed] = createSignal(initialCollapsed);

  function toggleSidebar() {
    const next = !collapsed();
    setCollapsed(next);
    try {
      localStorage.setItem("gerolamo:sidebar-collapsed", String(next));
    } catch { /* noop in restricted contexts */ }
  }

  return (
    <ToastProvider>
      <div class="flex h-screen bg-mesh bg-grid-subtle">
        {/* Skip-to-content link for a11y */}
        <a
          href="#main-content"
          class="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-[100] focus-visible:rounded focus-visible:bg-accent focus-visible:px-3 focus-visible:py-1 focus-visible:text-[13px] focus-visible:text-white"
        >
          Skip to content
        </a>

        {/* ---- Sidebar ---- */}
        <Sidebar
          activePage={activePage()}
          onNavigate={(page) => setActivePage(page as NavItemId)}
          collapsed={collapsed()}
          onToggle={toggleSidebar}
        />

        {/* ---- Centre column: topbar + main + footer ---- */}
        <div class="flex flex-1 flex-col min-w-0">
          <Topbar activePage={activePage()} />

          {/* Main + diagram grid */}
          <div class="flex flex-1 min-h-0">
            {/* Scrollable page area */}
            <main id="main-content" class="flex-1 overflow-y-auto" aria-label="Dashboard content">
              <div class="mx-auto max-w-[1400px] px-6 py-6 h-full">
                <ErrorBoundary>
                  <Suspense fallback={<PageSkeleton />}>
                    <Show when={activePage() === "overview"}><Overview /></Show>
                    <Show when={activePage() === "blocks"}><Blocks /></Show>
                    <Show when={activePage() === "peers"}><Peers /></Show>
                    <Show when={activePage() === "mempool"}><Mempool /></Show>
                    <Show when={activePage() === "explorer"}><Explorer /></Show>
                    <Show when={activePage() === "logs"}><Logs /></Show>
                    <Show when={activePage() === "settings"}><Settings /></Show>
                  </Suspense>
                </ErrorBoundary>
              </div>
            </main>

            {/* Right panel -- live chain diagram (hidden on mobile / small screens) */}
            <aside class="sidebar-chain w-[280px] min-w-[280px] max-w-[360px] shrink-0 border-l border-border overflow-hidden hidden md:block" aria-label="Live chain diagram">
              <Suspense fallback={<div />}>
                <ChainDiagram />
              </Suspense>
            </aside>
          </div>

          <Footer />
        </div>
      </div>
    </ToastProvider>
  );
};

export default App;
