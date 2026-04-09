import {
  LayoutDashboard, Server, Blocks, Users, Inbox, Search, Wallet, GitBranch, FileText, Settings, Menu,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useState } from "react";

const navItems = [
  { title: "Overview", url: "/", icon: LayoutDashboard },
  { title: "Node", url: "/node", icon: Server },
  { title: "Blocks", url: "/blocks", icon: Blocks },
  { title: "Peers", url: "/peers", icon: Users },
  { title: "Mempool", url: "/mempool", icon: Inbox },
  { title: "Explorer", url: "/explorer", icon: Search },
  { title: "Wallet", url: "/wallet", icon: Wallet },
  { title: "Chain Diagram", url: "/chain", icon: GitBranch },
  { title: "Logs", url: "/logs", icon: FileText },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="fixed top-3 left-3 z-50 lg:hidden p-2 rounded-md glass-panel border border-border"
        onClick={() => setCollapsed(!collapsed)}
      >
        <Menu className="h-5 w-5 text-foreground" />
      </button>

      {/* Overlay on mobile */}
      {!collapsed && (
        <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setCollapsed(true)} />
      )}

      <aside
        className={`fixed lg:sticky top-0 left-0 z-40 h-screen flex flex-col border-r border-border bg-sidebar transition-all duration-300
          ${collapsed ? "-translate-x-full lg:translate-x-0 lg:w-16" : "w-60 translate-x-0"}`}
      >
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-border gap-2">
          <div className="h-8 w-8 rounded-md bg-primary/20 border border-primary/40 flex items-center justify-center neon-text-red font-bold text-lg">
            G
          </div>
          {!collapsed && <span className="text-lg font-bold neon-text-red tracking-wider">GEROLAMO</span>}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.url}
              to={item.url}
              end={item.url === "/"}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              activeClassName="bg-sidebar-accent border-r-2 border-primary text-primary"
              onClick={() => {
                if (window.innerWidth < 1024) setCollapsed(true);
              }}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{item.title}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border">
          {!collapsed && (
            <p className="text-[10px] text-muted-foreground">Powered by Gerolamo v0.0.1-dev16</p>
          )}
        </div>

        {/* Collapse toggle (desktop) */}
        <button
          className="hidden lg:block absolute -right-3 top-20 w-6 h-6 rounded-full bg-card border border-border text-muted-foreground hover:text-primary text-xs"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </aside>
    </>
  );
}
