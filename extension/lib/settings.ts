// ---------------------------------------------------------------------------
// Settings — persistent configuration via chrome.storage.local
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "gerolamo:settings";

export interface Settings {
  apiBase: string;
}

const DEFAULT_SETTINGS: Settings = {
  apiBase: "http://localhost:3050",
};

/** Load settings from chrome.storage.local (async) */
export async function loadSettings(): Promise<Settings> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = result[SETTINGS_KEY];
    if (stored && typeof stored === "object") {
      return { ...DEFAULT_SETTINGS, ...stored };
    }
  } catch {
    // Fallback to localStorage if chrome.storage unavailable (dev mode)
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {}
  }
  return { ...DEFAULT_SETTINGS };
}

/** Save settings to chrome.storage.local */
export async function saveSettings(settings: Settings): Promise<void> {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch {
    // Fallback to localStorage
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }
}

/** Get the API base URL (sync helper reads from cache or default) */
let cachedApiBase: string = DEFAULT_SETTINGS.apiBase;

export function getApiBase(): string {
  return cachedApiBase;
}

/** Initialize settings — call once on startup to prime the cache */
export async function initSettings(): Promise<string> {
  const settings = await loadSettings();
  cachedApiBase = settings.apiBase;
  return cachedApiBase;
}
