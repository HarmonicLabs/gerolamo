// Settings stored in localStorage

export interface Settings {
  apiEndpoint: string;
  refreshInterval: number;
  wsEnabled: boolean;
}

const DEFAULTS: Settings = {
  apiEndpoint: "http://localhost:3050",
  refreshInterval: 5000,
  wsEnabled: true,
};

export function getSettings(): Settings {
  try {
    const stored = localStorage.getItem("gerolamo-settings");
    if (stored) return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch {}
  return DEFAULTS;
}

export function saveSettings(s: Settings) {
  localStorage.setItem("gerolamo-settings", JSON.stringify(s));
}
