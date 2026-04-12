import { type JSX, splitProps } from "solid-js";
import { cn } from "@/lib/utils";

const variantStyles: Record<string, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  outline: "text-foreground",
};

interface BadgeProps extends JSX.HTMLAttributes<HTMLDivElement> {
  variant?: string;
}

export function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "children"]);
  return (
    <div
      class={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
        variantStyles[local.variant ?? "default"],
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}
