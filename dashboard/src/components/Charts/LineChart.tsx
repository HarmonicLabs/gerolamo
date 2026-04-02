import { type Component, For } from "solid-js";
import { cn } from "@/lib/cn";

interface LineChartProps {
  data: number[];
  width?: number;
  height?: number;
  class?: string;
  variant?: "accent" | "green" | "orange" | "cyan";
}

const strokeColors: Record<string, string> = {
  accent: "var(--accent-rog-red)",
  green: "var(--accent-green)",
  orange: "var(--accent-orange)",
  cyan: "var(--accent-cyan)",
};

const fillColors: Record<string, string> = {
  accent: "rgba(255,45,85,0.08)",
  green: "rgba(0,230,118,0.08)",
  orange: "rgba(255,138,0,0.08)",
  cyan: "rgba(0,179,255,0.08)",
};

export const LineChart: Component<LineChartProps> = (props) => {
  const w = () => props.width ?? 200;
  const h = () => props.height ?? 60;
  const variant = () => props.variant ?? "accent";

  const points = () => {
    const d = props.data;
    if (d.length === 0) return "";
    const max = Math.max(...d, 1);
    const step = w() / Math.max(d.length - 1, 1);
    return d.map((v, i) => `${i * step},${h() - (v / max) * (h() - 8) - 4}`).join(" ");
  };

  const areaPath = () => {
    const d = props.data;
    if (d.length === 0) return "";
    const max = Math.max(...d, 1);
    const step = w() / Math.max(d.length - 1, 1);
    const pts = d.map((v, i) => `${i * step},${h() - (v / max) * (h() - 8) - 4}`);
    return `M0,${h()} L${pts.join(" L")} L${w()},${h()} Z`;
  };

  return (
    <svg
      width={w()}
      height={h()}
      viewBox={`0 0 ${w()} ${h()}`}
      class={cn("overflow-visible", props.class)}
    >
      <path d={areaPath()} fill={fillColors[variant()]} />
      <polyline
        points={points()}
        fill="none"
        stroke={strokeColors[variant()]}
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
};
