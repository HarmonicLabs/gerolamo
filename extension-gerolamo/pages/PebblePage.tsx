import { createSignal, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyHash } from "@/components/CopyHash";
import { compilePebble, PEBBLE_EXAMPLE, type CompileResult } from "@/lib/pebble-compiler";
import { Play, Copy, Loader2 } from "lucide-solid";

export default function PebblePage() {
  const [source, setSource] = createSignal(PEBBLE_EXAMPLE);
  const [result, setResult] = createSignal<CompileResult | null>(null);
  const [compiling, setCompiling] = createSignal(false);

  const handleCompile = async () => {
    setCompiling(true);
    try {
      const r = await compilePebble(source());
      setResult(r);
      if (r.success) {
        toast.success("Compiled successfully");
      } else {
        toast.error("Compilation failed");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCompiling(false);
    }
  };

  const handleCopy = async () => {
    const r = result();
    if (r?.uplcHex) {
      await navigator.clipboard.writeText(r.uplcHex);
      toast.success("UPLC hex copied");
    }
  };

  return (
    <div class="space-y-3">
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground">Pebble Source</h3>
          <a
            href="https://pluts.harmoniclabs.tech/"
            target="_blank"
            rel="noopener noreferrer"
            class="text-[9px] text-secondary hover:underline"
          >
            Docs
          </a>
        </div>
        <Textarea
          value={source()}
          onInput={(e) => setSource(e.currentTarget.value)}
          class="text-[10px] h-[200px] resize-none leading-relaxed"
          spellcheck={false}
        />
      </div>

      <Button size="sm" class="w-full" onClick={handleCompile} disabled={compiling() || !source().trim()}>
        <Show when={compiling()} fallback={<><Play size={12} /> Compile to UPLC</>}>
          <Loader2 size={12} class="animate-spin" />
        </Show>
      </Button>

      <Show when={result()}>
        {(r) => (
          <div>
            <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Output</h3>

            <Show when={r().success && r().uplcHex}>
              <div class="glass-panel rounded-lg p-3 border neon-border-cyan">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[9px] neon-text-cyan font-medium">UPLC (CBOR hex)</span>
                  <button onClick={handleCopy} class="text-muted-foreground hover:text-secondary">
                    <Copy size={12} />
                  </button>
                </div>
                <div class="bg-muted/50 rounded p-2 break-all text-[8px] font-mono max-h-[100px] overflow-y-auto">
                  {r().uplcHex}
                </div>
                <p class="text-[8px] text-muted-foreground mt-1">
                  {r().uplcHex!.length / 2} bytes
                </p>
              </div>
            </Show>

            <Show when={r().errors.length > 0}>
              <div class="glass-panel rounded-lg p-3 border border-destructive space-y-1">
                {r().errors.map((err) => (
                  <p class="text-[10px] text-destructive">{err}</p>
                ))}
              </div>
            </Show>

            <Show when={r().warnings.length > 0}>
              <div class="glass-panel rounded-lg p-2 border border-yellow-500/50 mt-1">
                {r().warnings.map((w) => (
                  <p class="text-[10px] text-yellow-500">{w}</p>
                ))}
              </div>
            </Show>
          </div>
        )}
      </Show>

      <p class="text-[8px] text-muted-foreground text-center">
        Pebble — Cardano smart contract language by Harmonic Labs
      </p>
    </div>
  );
}
