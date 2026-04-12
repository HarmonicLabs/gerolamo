export const ERA_COLORS: Record<string, string> = {
  Byron: "#9AA6B2",
  Shelley: "#00B3FF",
  Allegra: "#00B3FF",
  Mary: "#00B3FF",
  Alonzo: "#FF8A00",
  Babbage: "#9B59B6",
  Conway: "#00E676",
};

export const NETWORK_MAGICS: Record<string, number> = {
  preprod: 1,
  mainnet: 764824073,
};

export const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: "layout-dashboard" },
  { id: "node", label: "Node", icon: "server" },
  { id: "blocks", label: "Blocks", icon: "boxes" },
  { id: "peers", label: "Peers", icon: "users" },
  { id: "explorer", label: "Explorer", icon: "search" },
  { id: "wallet", label: "Wallet", icon: "wallet" },
  { id: "pebble", label: "Pebble", icon: "code" },
  { id: "logs", label: "Logs", icon: "file-text" },
  { id: "settings", label: "Settings", icon: "settings" },
] as const;

export type NavItemId = (typeof NAV_ITEMS)[number]["id"];
