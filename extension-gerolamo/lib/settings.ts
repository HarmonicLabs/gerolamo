export interface Settings {
  network: "preprod" | "mainnet";
  apiEndpoint: string;
  autoConnect: boolean;
  refreshInterval: number;
}

const ENDPOINTS: Record<string, string> = {
  preprod: "https://preprod.koios.rest/api/v1",
  mainnet: "https://api.koios.rest/api/v1",
};

const DEFAULTS: Settings = {
  network: "preprod",
  apiEndpoint: ENDPOINTS.preprod,
  autoConnect: true,
  refreshInterval: 10000,
};

let cache: Settings = { ...DEFAULTS };

export { ENDPOINTS };

export async function loadSettings(): Promise<Settings> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const result = await chrome.storage.local.get("gerolamo-settings");
      const stored = result["gerolamo-settings"];
      if (stored) cache = { ...DEFAULTS, ...JSON.parse(stored) };
    } else {
      const stored = localStorage.getItem("gerolamo-settings");
      if (stored) cache = { ...DEFAULTS, ...JSON.parse(stored) };
    }
  } catch { /* storage unavailable */ }
  return cache;
}

export function getSettings(): Settings {
  return cache;
}

export async function saveSettings(s: Settings): Promise<void> {
  cache = s;
  const json = JSON.stringify(s);
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ "gerolamo-settings": json });
    } else {
      localStorage.setItem("gerolamo-settings", json);
    }
  } catch { /* storage unavailable */ }
}
