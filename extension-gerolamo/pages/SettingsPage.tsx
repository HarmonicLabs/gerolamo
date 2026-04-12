import { createSignal, onMount, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { loadSettings, saveSettings, ENDPOINTS, type Settings } from "@/lib/settings";
import { Save } from "lucide-solid";

export default function SettingsPage() {
  const [settings, setSettings] = createSignal<Settings | null>(null);

  onMount(async () => {
    setSettings(await loadSettings());
  });

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const s = settings();
    if (s) setSettings({ ...s, [key]: value });
  };

  const handleSave = async () => {
    const s = settings();
    if (s) {
      await saveSettings(s);
      toast.success("Settings saved — reconnect to apply");
    }
  };

  return (
    <Show when={settings()}>
      {(s) => (
        <div class="space-y-3">
          <div class="space-y-2">
            <div>
              <Label class="text-[10px]">Network</Label>
              <div class="flex gap-2 mt-1">
                <Button
                  variant={s().network === "preprod" ? "default" : "outline"}
                  size="sm"
                  class="h-8 text-[9px] px-3 flex-1"
                  onClick={() => {
                    update("network", "preprod");
                    update("apiEndpoint", ENDPOINTS.preprod);
                  }}
                >
                  Preprod
                </Button>
                <Button
                  variant={s().network === "mainnet" ? "default" : "outline"}
                  size="sm"
                  class="h-8 text-[9px] px-3 flex-1"
                  onClick={() => {
                    update("network", "mainnet");
                    update("apiEndpoint", ENDPOINTS.mainnet);
                  }}
                >
                  Mainnet
                </Button>
              </div>
            </div>

            <div>
              <Label class="text-[10px]">API Endpoint</Label>
              <Input
                value={s().apiEndpoint}
                onInput={(e) => update("apiEndpoint", e.currentTarget.value)}
                class="text-xs h-8 mt-1"
              />
              <p class="text-[9px] text-muted-foreground mt-0.5">Koios — free, no API key needed</p>
            </div>

            <div>
              <Label class="text-[10px]">Refresh Interval (ms)</Label>
              <Input
                type="number"
                value={s().refreshInterval}
                onInput={(e) => update("refreshInterval", parseInt(e.currentTarget.value) || 10000)}
                class="text-xs h-8 mt-1"
              />
            </div>

            <div class="flex items-center justify-between">
              <Label class="text-[10px]">Auto-Connect on startup</Label>
              <Switch checked={s().autoConnect} onCheckedChange={(v) => update("autoConnect", v)} />
            </div>
          </div>

          <Button size="sm" class="w-full" onClick={handleSave}>
            <Save size={12} /> Save Settings
          </Button>

          <div class="glass-panel rounded-lg p-3 border border-border">
            <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">About</h3>
            <div class="space-y-1 text-[10px]">
              <div class="flex justify-between">
                <span class="text-muted-foreground">Extension</span>
                <span>v0.3.0</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Mode</span>
                <span>Standalone (Koios)</span>
              </div>
              <div class="flex justify-between">
                <span class="text-muted-foreground">Network</span>
                <span class="capitalize">{s().network}</span>
              </div>
            </div>
            <p class="text-[8px] text-muted-foreground mt-2">
              Funded by Catalyst F11 + Intersect 2025
            </p>
            <p class="text-[8px] text-muted-foreground">
              Harmonic Labs S.R.L.
            </p>
          </div>
        </div>
      )}
    </Show>
  );
}
