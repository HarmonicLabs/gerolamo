import { createSignal, createEffect, onMount, Show, For, type Component } from "solid-js";
import { Motion } from "@motionone/solid";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { API_BASE_URL, useSSE, type NodeStatus } from "@/lib/api";

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`gerolamo.settings.${key}`);
    return v !== null ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting<T>(key: string, value: T): void {
  localStorage.setItem(`gerolamo.settings.${key}`, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Color-blind mode CSS class overrides
// ---------------------------------------------------------------------------

type ColorBlindMode = "default" | "deuteranopia" | "protanopia" | "tritanopia";

const COLOR_BLIND_LABELS: Record<ColorBlindMode, string> = {
  default: "Default",
  deuteranopia: "Deuteranopia (red-green)",
  protanopia: "Protanopia (red-green)",
  tritanopia: "Tritanopia (blue-yellow)",
};

// ---------------------------------------------------------------------------
// Locale options
// ---------------------------------------------------------------------------

const LOCALES = [
  { code: "en-US", label: "English (US)" },
] as const;

// ---------------------------------------------------------------------------
// Toggle component
// ---------------------------------------------------------------------------

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label class="flex items-center justify-between py-3 cursor-pointer group">
      <div class="flex flex-col gap-0.5">
        <span class="text-[13px] font-medium text-text group-hover:text-accent transition-colors">
          {props.label}
        </span>
        <Show when={props.description}>
          <span class="text-[11px] text-text-dim">{props.description}</span>
        </Show>
      </div>
      <button
        role="switch"
        aria-checked={props.checked}
        onClick={() => props.onChange(!props.checked)}
        class="relative inline-flex h-[24px] w-[44px] shrink-0 rounded-full border border-border transition-colors"
        classList={{
          "bg-accent": props.checked,
          "bg-bg-sunken": !props.checked,
        }}
      >
        <span
          class="pointer-events-none block h-[20px] w-[20px] rounded-full bg-text shadow-sm transition-transform"
          classList={{
            "translate-x-[20px]": props.checked,
            "translate-x-[1px]": !props.checked,
          }}
        />
      </button>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Dropdown component
// ---------------------------------------------------------------------------

function Dropdown<T extends string>(props: {
  value: T;
  options: readonly { code: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  description?: string;
}) {
  return (
    <div class="flex items-center justify-between py-3">
      <div class="flex flex-col gap-0.5">
        <span class="text-[13px] font-medium text-text">{props.label}</span>
        <Show when={props.description}>
          <span class="text-[11px] text-text-dim">{props.description}</span>
        </Show>
      </div>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
        aria-label={props.label}
        class="rounded-[var(--radius-sm)] border border-border bg-bg-input px-3 py-1.5 text-[12px] font-medium text-text focus:border-accent focus:outline-none appearance-none cursor-pointer min-w-[180px]"
      >
        <For each={[...props.options]}>
          {(opt) => <option value={opt.code}>{opt.label}</option>}
        </For>
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color-blind dropdown
// ---------------------------------------------------------------------------

function ColorBlindDropdown(props: { value: ColorBlindMode; onChange: (v: ColorBlindMode) => void }) {
  const options = (Object.entries(COLOR_BLIND_LABELS) as [ColorBlindMode, string][]).map(
    ([code, label]) => ({ code, label }),
  );

  return (
    <div class="flex items-center justify-between py-3">
      <div class="flex flex-col gap-0.5">
        <span class="text-[13px] font-medium text-text" id="cb-mode-label">Color blind mode</span>
        <span class="text-[11px] text-text-dim">Adjusts accent colors for accessibility</span>
      </div>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as ColorBlindMode)}
        aria-labelledby="cb-mode-label"
        class="rounded-[var(--radius-sm)] border border-border bg-bg-input px-3 py-1.5 text-[12px] font-medium text-text focus:border-accent focus:outline-none appearance-none cursor-pointer min-w-[180px]"
      >
        <For each={options}>
          {(opt) => <option value={opt.code}>{opt.label}</option>}
        </For>
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Settings: Component = () => {
  // Appearance
  const [highContrast, setHighContrast] = createSignal(loadSetting("highContrast", false));
  const [colorBlind, setColorBlind] = createSignal<ColorBlindMode>(loadSetting("colorBlind", "default"));
  const [locale, setLocale] = createSignal(loadSetting("locale", "en-US"));

  // Connection
  const { connected } = useSSE<NodeStatus | null>("/sse/status", null);

  // Persist and apply high contrast
  createEffect(() => {
    const hc = highContrast();
    saveSetting("highContrast", hc);
    if (hc) {
      document.documentElement.classList.add("high-contrast");
    } else {
      document.documentElement.classList.remove("high-contrast");
    }
  });

  // Persist and apply color blind mode
  createEffect(() => {
    const mode = colorBlind();
    saveSetting("colorBlind", mode);
    document.documentElement.classList.remove("cb-deuteranopia", "cb-protanopia", "cb-tritanopia");
    if (mode !== "default") {
      document.documentElement.classList.add(`cb-${mode}`);
    }
  });

  // Persist locale
  createEffect(() => {
    saveSetting("locale", locale());
  });

  // Restore classes on mount
  onMount(() => {
    if (highContrast()) document.documentElement.classList.add("high-contrast");
    const mode = colorBlind();
    if (mode !== "default") document.documentElement.classList.add(`cb-${mode}`);
  });

  const apiUrl = () => API_BASE_URL || `${window.location.origin}`;

  return (
    <div class="flex flex-col gap-6">
      {/* ─── APPEARANCE ─── */}
      <Motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, easing: [0.16, 1, 0.3, 1] }}
      >
        <Card class="glass-card-accent">
          <CardHeader>
            <div class="flex items-center gap-3">
              <CardTitle>Appearance</CardTitle>
              <Badge variant="muted">theme</Badge>
            </div>
            <CardDescription>Visual customization for the dashboard</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="divide-y divide-border-subtle">
              {/* Theme (dark only for now) */}
              <div class="flex items-center justify-between py-3">
                <div class="flex flex-col gap-0.5">
                  <span class="text-[13px] font-medium text-text">Theme</span>
                  <span class="text-[11px] text-text-dim">Dashboard color scheme</span>
                </div>
                <div class="flex gap-2">
                  <button
                    class="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium border-accent/30 bg-accent-dim text-accent"
                    aria-pressed="true"
                    aria-label="Dark theme (active)"
                  >
                    Dark
                  </button>
                  <button
                    class="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[12px] font-medium border-border bg-bg-sunken text-text-muted cursor-not-allowed opacity-50"
                    disabled
                    aria-pressed="false"
                    aria-label="Light theme (coming soon)"
                    title="Coming soon"
                  >
                    Light
                  </button>
                </div>
              </div>

              {/* High contrast */}
              <Toggle
                checked={highContrast()}
                onChange={setHighContrast}
                label="High contrast"
                description="Increases border visibility and text contrast"
              />

              {/* Color blind mode */}
              <ColorBlindDropdown value={colorBlind()} onChange={setColorBlind} />
            </div>
          </CardContent>
        </Card>
      </Motion.div>

      {/* ─── NETWORK ─── */}
      <Motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <Card class="glass-card-accent">
          <CardHeader>
            <div class="flex items-center gap-3">
              <CardTitle>Network</CardTitle>
              <Badge variant={connected() ? "success" : "danger"}>
                {connected() ? "Connected" : "Disconnected"}
              </Badge>
            </div>
            <CardDescription>API connection settings</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="divide-y divide-border-subtle">
              {/* API endpoint */}
              <div class="flex items-center justify-between py-3">
                <div class="flex flex-col gap-0.5">
                  <span class="text-[13px] font-medium text-text">API Endpoint</span>
                  <span class="text-[11px] text-text-dim">Read-only -- set via VITE_API_URL env variable</span>
                </div>
                <div class="flex items-center gap-2">
                  <code class="rounded-[var(--radius-sm)] border border-border bg-bg-sunken px-3 py-1.5 font-mono text-[11px] text-text-secondary">
                    {apiUrl()}
                  </code>
                </div>
              </div>

              {/* Connection status */}
              <div class="flex items-center justify-between py-3">
                <div class="flex flex-col gap-0.5">
                  <span class="text-[13px] font-medium text-text">Connection Status</span>
                  <span class="text-[11px] text-text-dim">SSE event stream health</span>
                </div>
                <div class="flex items-center gap-2">
                  <div
                    class="h-[8px] w-[8px] rounded-full"
                    classList={{
                      "bg-green pulse-live-green": connected(),
                      "bg-red pulse-live": !connected(),
                    }}
                    aria-hidden="true"
                  />
                  <span
                    class="text-[12px] font-medium"
                    classList={{
                      "text-green": connected(),
                      "text-red": !connected(),
                    }}
                  >
                    {connected() ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </Motion.div>

      {/* ─── LANGUAGE ─── */}
      <Motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
      >
        <Card class="glass-card-accent">
          <CardHeader>
            <div class="flex items-center gap-3">
              <CardTitle>Language</CardTitle>
              <Badge variant="muted">i18n</Badge>
            </div>
            <CardDescription>Display language preferences</CardDescription>
          </CardHeader>
          <CardContent>
            <Dropdown
              value={locale()}
              options={LOCALES}
              onChange={setLocale}
              label="Locale"
              description="Dashboard display language"
            />
          </CardContent>
        </Card>
      </Motion.div>

      {/* ─── ABOUT ─── */}
      <Motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
      >
        <Card class="glass-card-rog">
          <CardHeader>
            <div class="flex items-center gap-3">
              <CardTitle>About</CardTitle>
              <Badge variant="neon">Gerolamo</Badge>
            </div>
            <CardDescription>TypeScript Cardano Node implementation by Harmonic Labs</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 gap-x-8 gap-y-4">
              <div class="flex flex-col gap-0.5">
                <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium">Version</span>
                <span class="font-mono text-[14px] font-semibold text-accent text-glow">v0.0.1-dev16</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium">Runtime</span>
                <span class="font-mono text-[14px] font-semibold text-text">Bun v1.3.10</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium">Network</span>
                <span class="font-mono text-[14px] font-semibold text-green text-glow-green">preprod</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium">Consensus</span>
                <span class="font-mono text-[14px] font-semibold text-purple">Ouroboros Praos</span>
              </div>
            </div>

            <div class="mt-6 pt-4 border-t border-border-subtle flex items-center gap-4">
              <a
                href="https://github.com/HarmonicLabs/gerolamo"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Gerolamo on GitHub (opens in new tab)"
                class="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-sunken px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-accent hover:border-accent/20 transition-colors"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                </svg>
                GitHub
              </a>
              <a
                href="https://harmoniclabs.tech"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Harmonic Labs website (opens in new tab)"
                class="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-sunken px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-accent hover:border-accent/20 transition-colors"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                </svg>
                Harmonic Labs
              </a>
            </div>
          </CardContent>
        </Card>
      </Motion.div>
    </div>
  );
};

export default Settings;
