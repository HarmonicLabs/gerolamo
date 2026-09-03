/**
 * Fixed-length sample history for the resource graphs (one sample per status
 * poll, 2 s apart; 900 samples = 30 minutes). Pure so it can be unit-tested.
 */
export type ResourceSample = {
  /** ms since epoch */
  t: number;
  /** cores kept busy by the node process (cpuPercent / 100); null when unknown */
  nodeCores: number | null;
  /** node RSS bytes */
  nodeRss: number | null;
  /** node JS heap used bytes */
  nodeHeap: number | null;
  /** host CPU busy 0–100 */
  sysCpu: number | null;
  /** host memory used 0–100 */
  sysMem: number | null;
  /** blocks applied per second */
  bps: number | null;
};

export const HISTORY_MAX_SAMPLES = 900;

/** Append a sample, dropping the oldest beyond `max`. Returns a new array (Solid signals compare by reference). */
export function pushSample<T>(history: readonly T[], sample: T, max = HISTORY_MAX_SAMPLES): T[] {
  const out = history.length >= max ? history.slice(history.length - max + 1) : history.slice();
  out.push(sample);
  return out;
}

/** Values of one field, oldest first; nulls become NaN so the chart leaves a gap. */
export function series(history: readonly ResourceSample[], key: keyof ResourceSample): number[] {
  return history.map((s) => {
    const v = s[key];
    return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
  });
}

/** Human span of the history window, e.g. "12 min". */
export function spanLabel(history: readonly ResourceSample[]): string {
  if (history.length < 2) return "—";
  const ms = history[history.length - 1]!.t - history[0]!.t;
  const min = Math.round(ms / 60_000);
  if (min < 1) return `${Math.round(ms / 1000)} s`;
  return `${min} min`;
}
