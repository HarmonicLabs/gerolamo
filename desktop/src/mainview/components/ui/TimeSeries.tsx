import { For, Show, createMemo, type Component } from "solid-js";

export type TimeSeriesLine = {
  name: string;
  /** CSS colour (hex/rgb) for the stroke and fill. */
  color: string;
  /** Oldest first; NaN leaves a gap. */
  values: number[];
  /** Formatter for the legend's latest value. */
  format?: (v: number) => string;
};

type Props = {
  lines: TimeSeriesLine[];
  /** Fixed y-axis maximum; omitted = auto from the data (never below `minMax`). */
  max?: number;
  minMax?: number;
  /** Label under the left edge, e.g. "30 min ago". */
  leftLabel?: string;
  height?: number;
  title?: string;
};

const W = 600;

/** Build an SVG path through the finite points, breaking at NaN gaps. */
function pathFor(values: number[], max: number, h: number): string {
  const n = values.length;
  if (n === 0) return "";
  const dx = n > 1 ? W / (n - 1) : 0;
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = (i * dx).toFixed(1);
    const y = (h - (Math.min(v, max) / max) * (h - 2) - 1).toFixed(1);
    d += `${pen ? "L" : "M"}${x} ${y} `;
    pen = true;
  }
  return d.trim();
}

/**
 * Small dependency-free line chart for the Control Center: a fixed 600×H
 * viewBox stretched to the card width, one polyline per series, the first
 * series filled under the curve, gridlines at ¼ steps, legend with the
 * latest value.
 */
export const TimeSeries: Component<Props> = (props) => {
  const h = () => props.height ?? 96;
  const yMax = createMemo(() => {
    if (props.max != null) return props.max;
    let m = 0;
    for (const l of props.lines) for (const v of l.values) if (Number.isFinite(v) && v > m) m = v;
    const floor = props.minMax ?? 1;
    const raw = Math.max(m * 1.1, floor);
    // round up to a tidy number
    const p = 10 ** Math.floor(Math.log10(raw));
    return Math.ceil(raw / p) * p;
  });
  const latest = (l: TimeSeriesLine) => {
    for (let i = l.values.length - 1; i >= 0; i--) if (Number.isFinite(l.values[i]!)) return l.values[i]!;
    return Number.NaN;
  };
  const fmt = (l: TimeSeriesLine, v: number) => (Number.isFinite(v) ? (l.format ? l.format(v) : v.toFixed(1)) : "—");
  return (
    <div class="flex flex-col gap-1">
      <Show when={props.title}>
        <div class="flex items-center justify-between text-[11px]">
          <span class="text-text-dim">{props.title}</span>
          <span class="font-mono tabular-nums text-text-dim">max {fmt(props.lines[0]!, yMax())}</span>
        </div>
      </Show>
      <svg viewBox={`0 0 ${W} ${h()}`} preserveAspectRatio="none" class="w-full rounded-[6px] bg-bg-sunken/50" style={{ height: `${h()}px` }} role="img" aria-label={props.title ?? "time series"}>
        <For each={[0.25, 0.5, 0.75]}>
          {(f) => <line x1="0" x2={W} y1={(h() - f * (h() - 2) - 1).toFixed(1)} y2={(h() - f * (h() - 2) - 1).toFixed(1)} stroke="currentColor" stroke-opacity="0.08" stroke-width="1" />}
        </For>
        <For each={props.lines}>
          {(l, i) => {
            const d = () => pathFor(l.values, yMax(), h());
            return (
              <>
                <Show when={i() === 0 && d()}>
                  <path d={`${d()} L${W} ${h()} L0 ${h()} Z`} fill={l.color} fill-opacity="0.12" stroke="none" vector-effect="non-scaling-stroke" />
                </Show>
                <path d={d()} fill="none" stroke={l.color} stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
              </>
            );
          }}
        </For>
      </svg>
      <div class="flex items-center justify-between text-[10px] text-text-dim">
        <span>{props.leftLabel ?? ""}</span>
        <div class="flex gap-3">
          <For each={props.lines}>
            {(l) => (
              <span class="flex items-center gap-1 font-mono tabular-nums">
                <span class="inline-block h-[6px] w-[6px] rounded-full" style={{ background: l.color }} />
                <span class="text-text-muted">{l.name}</span>
                <span class="text-text">{fmt(l, latest(l))}</span>
              </span>
            )}
          </For>
        </div>
        <span>now</span>
      </div>
    </div>
  );
};
