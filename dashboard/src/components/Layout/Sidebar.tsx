import { type Component, For, Show } from "solid-js";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Inline SVG icon set (24 x 24)
// ---------------------------------------------------------------------------
const icons: Record<string, () => import("solid-js").JSX.Element> = {
  grid: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  cube: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  ),
  network: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="12" y1="7" x2="5" y2="17" />
      <line x1="12" y1="7" x2="19" y2="17" />
      <line x1="5" y1="19" x2="19" y2="19" />
    </svg>
  ),
  inbox: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  ),
  search: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  terminal: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  gear: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001.08 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1.08z" />
    </svg>
  ),
  chevronLeft: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  chevronRight: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface SidebarProps {
  activePage: string;
  onNavigate: (page: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const Sidebar: Component<SidebarProps> = (props) => {
  return (
    <aside
      class={cn(
        "flex flex-col h-screen border-r border-border bg-bg-raised/95 backdrop-blur-md transition-[width] duration-200 ease-out shrink-0 overflow-hidden",
        props.collapsed ? "w-16" : "w-60",
      )}
      aria-label="Sidebar"
    >
      {/* ---- Header ---- */}
      <div class="relative flex items-center h-14 px-4 border-b border-border shrink-0">
        <Show when={!props.collapsed}>
          <span class="font-mono text-[18px] font-bold tracking-wider text-accent text-glow-strong select-none">
            GEROLAMO
          </span>
        </Show>
        <Show when={props.collapsed}>
          <span class="font-mono text-[18px] font-bold text-accent text-glow-strong select-none mx-auto">
            G
          </span>
        </Show>

        {/* Collapse / expand toggle */}
        <button
          onClick={props.onToggle}
          class={cn(
            "absolute right-2 flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] text-text-dim hover:text-text hover:bg-bg-overlay transition-colors",
            props.collapsed && "right-auto left-1/2 -translate-x-1/2 relative",
          )}
          aria-label={props.collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          <Show when={!props.collapsed} fallback={icons.chevronRight()}>
            {icons.chevronLeft()}
          </Show>
        </button>
      </div>

      {/* ---- Nav items ---- */}
      <nav class="flex-1 flex flex-col gap-0.5 py-2 px-2 overflow-y-auto" aria-label="Main navigation">
        <For each={[...NAV_ITEMS]}>
          {(item) => {
            const Icon = icons[item.icon];
            const isActive = () => props.activePage === item.id;

            return (
              <button
                onClick={() => props.onNavigate(item.id)}
                class={cn(
                  "group relative flex items-center gap-3 rounded-[var(--radius-sm)] h-10 transition-colors",
                  props.collapsed ? "justify-center px-0" : "px-3",
                  isActive()
                    ? "bg-accent-dim text-accent"
                    : "text-text-secondary hover:text-text hover:bg-bg-overlay",
                )}
                aria-current={isActive() ? "page" : undefined}
                aria-label={props.collapsed ? item.label : undefined}
                title={props.collapsed ? item.label : undefined}
              >
                {/* Active indicator — red left bar */}
                <Show when={isActive()}>
                  <div class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-accent" />
                </Show>

                <span class={cn("shrink-0", isActive() ? "text-accent" : "text-text-dim group-hover:text-text")}>
                  {Icon ? <Icon /> : null}
                </span>

                <Show when={!props.collapsed}>
                  <span class="text-[13px] font-medium truncate">{item.label}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </nav>

      {/* ---- Bottom branding ---- */}
      <div class="shrink-0 border-t border-border px-4 py-3">
        <Show when={!props.collapsed}>
          <p class="text-[10px] text-text-muted leading-tight">
            Harmonic Labs
            <br />
            <span class="text-text-dim">v0.0.1-dev16</span>
          </p>
        </Show>
      </div>
    </aside>
  );
};
