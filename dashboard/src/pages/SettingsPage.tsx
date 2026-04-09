import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { getSettings, saveSettings, type Settings } from "@/lib/settings";
import { toast } from "sonner";
import { Save } from "lucide-react";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(getSettings);

  const handleSave = () => {
    saveSettings(settings);
    toast.success("Settings saved");
  };

  return (
    <div className="space-y-6 animate-fade-in-up max-w-2xl">
      <h1 className="text-2xl font-bold neon-text-red">Settings</h1>

      <div className="glass-panel rounded-lg p-6 space-y-6">
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">API Endpoint</Label>
          <Input
            className="bg-muted/30 border-border"
            value={settings.apiEndpoint}
            onChange={(e) => setSettings({ ...settings, apiEndpoint: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">Auto-Refresh Interval (ms)</Label>
          <Input
            className="bg-muted/30 border-border"
            type="number"
            value={settings.refreshInterval}
            onChange={(e) => setSettings({ ...settings, refreshInterval: parseInt(e.target.value) || 5000 })}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label className="text-sm text-muted-foreground">WebSocket Enabled</Label>
          <Switch
            checked={settings.wsEnabled}
            onCheckedChange={(v) => setSettings({ ...settings, wsEnabled: v })}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label className="text-sm text-muted-foreground">Theme</Label>
          <span className="text-xs text-muted-foreground">Dark (Cyberpunk) — Only option</span>
        </div>

        <Button variant="outline" className="border-primary/30 hover:border-primary" onClick={handleSave}>
          <Save className="h-4 w-4 mr-2" /> Save Settings
        </Button>
      </div>
    </div>
  );
}
