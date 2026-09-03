import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { indexAtFraction } from "../../../shared/history";

export type TimeSeriesLine = {
  name: string;
  /** CSS colour (hex/rgb) for the stroke and fill. */
  color: string;
  /** Oldest first; NaN leaves a gap. */
  values: number[];
  /** Formatter for the legend and the tooltip. */
  format?: (v: number) => string;
};

type Props = {
  lines: TimeSeriesLine[];
  /** Sample timestamps (ms since epoch), same length as each line's values. */
  times?: number[];
  /** Fixed y-axis maximum; omitted = auto from the data (never below `minMax`). */
  max?: number;
  minMax?: number;
  /** Label under the left edge, e.g. "30 min ago". */
  leftLabel?: string;
  height?: number;
  title?: string;
  /** Right-aligned text next to the title (current values, bars…). */
  headline?: string;
};

const W = 600;

function yFor(v: number, max: number, h: number): number {
  return h - (Math.min(v, max) / max) * (h - 2) - 1;
}

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
    d += `${pen ? "L" : "M"}${(i * dx).toFixed(1)} ${yFor(v, max, h).toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour12: false });

/**
 * Small dependency-free line chart: fixed 600×H viewBox stretched to the card
 * width, one polyline per series, the first series filled, gridlines at ¼ steps,
 * a legend with the latest value, and a hover tooltip with the sample's time and
 * every series' value at that point.
 */
export const TimeSeries: Component<Props> = (props) => {
  const h = () => props.height ?? 96;
  const n = () => Math.max(...props.lines.map((l) => l.values.length), 0);
  const yMax = createMemo(() => {
    if (props.max != null) return props.max;
    let m = 0;
    for (const l of props.lines) for (const v of l.values) if (Number.isFinite(v) && v > m) m = v;
    const floor = props.minMax ?? 1;
    const raw = Math.max(m * 1.1, floor);
    const p = 10 ** Math.floor(Math.log10(raw));
    return Math.ceil(raw / p) * p;
  });
  const latest = (l: TimeSeriesLine) => {
    for (let i = l.values.length - 1; i >= 0; i--) if (Number.isFinite(l.values[i]!)) return l.values[i]!;
    return Number.NaN;
  };
  const fmt = (l: TimeSeriesLine, v: number) => (Number.isFinite(v) ? (l.format ? l.format(v) : v.toFixed(1)) : "—");

  const [hover, setHover] = createSignal<number | null>(null);
  let svg: SVGSVGElement | undefined;
  const onMove = (e: MouseEvent) => {
    if (!svg || n() < 2) return;
    const r = svg.getBoundingClientRect();
    setHover(indexAtFraction((e.clientX - r.left) / Math.max(1, r.width), n()));
  };
  const hoverX = () => (hover() == null || n() < 2 ? 0 : (hover()! * W) / (n() - 1));
  const hoverLeftPct = () => (n() < 2 ? 0 : (hoverX() / W) * 100);

  return (
    <div class="flex flex-col gap-1">
      <Show when={props.title || props.headline}>
        <div class="flex items-center justify-between gap-3 text-[11px]">
          <span class="text-text-dim">{props.title}</span>
          <span class="truncate font-mono tabular-nums text-text">{props.headline ?? `max ${fmt(props.lines[0]!, yMax())}`}</span>
        </div>
      </Show>
      <div class="relative">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${h()}`}
          preserveAspectRatio="none"
          class="w-full rounded-[6px] bg-bg-sunken/50 cursor-crosshair"
          style={{ height: `${h()}px` }}
          role="img"
          aria-label={props.title ?? "time series"}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <For each={[0.25, 0.5, 0.75]}>
            {(f) => <line x1="0" x2={W} y1={(h() - f * (h() - 2) - 1).toFixed(1)} y2={(h() - f * (h() - 2) - 1).toFixed(1)} stroke="currentColor" stroke-opacity="0.08" stroke-width="1" />}
          </For>
          <For each={props.lines}>
            {(l, i) => {
              const d = () => pathFor(l.values, yMax(), h());
              return (
                <>
                  <Show when={i() === 0 && d()}>
                    <path d={`${d()} L${W} ${h()} L0 ${h()} Z`} fill={l.color} fill-opacity="0.12" stroke="none" />
                  </Show>
                  <path d={d()} fill="none" stroke={l.color} stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
                </>
              );
            }}
          </For>
          <Show when={hover() != null}>
            <line x1={hoverX().toFixed(1)} x2={hoverX().toFixed(1)} y1="0" y2={h()} stroke="currentColor" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke" />
            <For each={props.lines}>
              {(l) => {
                const v = () => l.values[hover()!];
                return (
                  <Show when={Number.isFinite(v()!)}>
                    <circle cx={hoverX().toFixed(1)} cy={yFor(v()!, yMax(), h()).toFixed(1)} r="3" fill={l.color} vector-effect="non-scaling-stroke" />
                  </Show>
                );
              }}
            </For>
          </Show>
        </svg>
        <Show when={hover() != null}>
          <div
            class="pointer-events-none absolute top-1 z-10 rounded-[6px] border border-border bg-bg-raised/95 px-2 py-1 text-[10px] shadow-lg backdrop-blur-sm"
            style={{ left: `${hoverLeftPct()}%`, transform: hoverLeftPct() > 60 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
          >
            <div class="font-mono text-text-dim">{props.times?.[hover()!] != null ? clock(props.times![hover()!]!) : `sample ${hover()! + 1}/${n()}`}</div>
            <For each={props.lines}>
              {(l) => (
                <div class="flex items-center gap-1.5 whitespace-nowrap">
                  <span class="inline-block h-[6px] w-[6px] rounded-full" style={{ background: l.color }} />
                  <span class="text-text-muted">{l.name}</span>
                  <span class="font-mono tabular-nums text-text">{fmt(l, l.values[hover()!] ?? Number.NaN)}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
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
