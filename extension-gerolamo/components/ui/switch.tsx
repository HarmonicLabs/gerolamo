import { createSignal, splitProps } from "solid-js";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  class?: string;
  disabled?: boolean;
}

export function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ["checked", "onCheckedChange", "class", "disabled"]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={local.checked}
      class={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        local.checked ? "bg-primary" : "bg-input",
        local.class,
      )}
      disabled={local.disabled}
      onClick={() => local.onCheckedChange?.(!local.checked)}
    >
      <span
        class={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          local.checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
