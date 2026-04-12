import { type JSX, splitProps } from "solid-js";
import { cn } from "@/lib/utils";

interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea(props: TextareaProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <textarea
      class={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono",
        local.class,
      )}
      {...rest}
    />
  );
}
