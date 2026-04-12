import { createSignal, Show } from "solid-js";
import { Copy, Check } from "lucide-solid";
import { truncateHash } from "@/lib/format";

interface CopyHashProps {
  hash: string;
  chars?: number;
}

export function CopyHash(props: CopyHashProps) {
  const [copied, setCopied] = createSignal(false);
  const chars = () => props.chars ?? 8;

  const handleCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(props.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Show when={props.hash} fallback={<span class="text-muted-foreground">—</span>}>
      <span class="inline-flex items-center gap-1 font-mono text-xs">
        <span class="text-muted-foreground">{truncateHash(props.hash, chars())}</span>
        <button onClick={handleCopy} class="text-muted-foreground hover:text-secondary transition-colors">
          <Show when={copied()} fallback={<Copy size={12} />}>
            <Check size={12} class="text-green-500" />
          </Show>
        </button>
      </span>
    </Show>
  );
}
