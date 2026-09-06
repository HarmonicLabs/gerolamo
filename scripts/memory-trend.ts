/**
 * Memory-leak check from the node's own `Memory:` log lines (one every 5 minutes):
 *   bun scripts/memory-trend.ts <node.log> [--since "06 Sep 2026 01:3"] [--max-mb-per-hour 50]
 * Fits a least-squares slope (MB/hour) to RSS, main heap, worker heaps, external and the
 * unaccounted native remainder over the selected samples. A leak shows as a sustained
 * positive slope on one component while the others stay flat; GC-driven oscillation of the
 * heaps is normal and averages out. Exit code 1 when RSS or native exceed the threshold.
 */
const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : [])).filter((x) => x.length));
const file = process.argv[2]; if (!file) { console.error("usage: memory-trend.ts <log> [--since <date prefix>] [--max-mb-per-hour N]"); process.exit(2); }
const since = args.since ? String(args.since) : null;
const maxSlope = Number(args["max-mb-per-hour"] ?? 50);
const re = /\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2}) GMT\]: Memory: rss ([0-9.]+) GB, main heap (\d+) MB, external (\d+) MB, (\d+) worker heaps (\d+) MB(?: \(max \d+ MB\))?(?:, worker external (\d+) MB, unaccounted native ([0-9.]+) GB)?/;
type S = { t: number; rss: number; heap: number; ext: number; workers: number; wext: number; native: number };
const samples: S[] = [];
// stream: node logs run to gigabytes
let sinceSeen = !since;
const lines: string[] = [];
{
    const reader = Bun.file(file).stream().getReader();
    const dec = new TextDecoder();
    let rest = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += dec.decode(value, { stream: true });
        const parts = rest.split("\n"); rest = parts.pop()!;
        for (const l of parts) if (l.includes("Memory: rss")) lines.push(l);
    }
    if (rest.includes("Memory: rss")) lines.push(rest);
}
for (const line of lines) {
    const m = re.exec(line); if (!m) continue;
    if (!sinceSeen) { if (m[1]!.startsWith(since!) || m[1]!.includes(since!)) sinceSeen = true; else continue; }
    samples.push({ t: Date.parse(m[1] + " UTC"), rss: Number(m[2]) * 1024, heap: Number(m[3]), ext: Number(m[4]), workers: Number(m[6]), wext: Number(m[7] ?? 0), native: Number(m[8] ?? 0) * 1024 });
}
if (samples.length < 3) { console.error(`only ${samples.length} sample(s) matched`); process.exit(2); }
const hours = (samples[samples.length - 1]!.t - samples[0]!.t) / 3.6e6;
function slope(key: keyof S): { perHour: number; first: number; last: number; min: number; max: number } {
    const xs = samples.map((s) => (s.t - samples[0]!.t) / 3.6e6), ys = samples.map((s) => s[key] as number);
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2; }
    return { perHour: den ? num / den : 0, first: ys[0]!, last: ys[n - 1]!, min: Math.min(...ys), max: Math.max(...ys) };
}
console.log(`${samples.length} samples over ${hours.toFixed(1)} h (${new Date(samples[0]!.t).toISOString()} → ${new Date(samples[samples.length - 1]!.t).toISOString()})`);
console.log(`${"component".padEnd(14)} ${"first".padStart(8)} ${"last".padStart(8)} ${"min".padStart(8)} ${"max".padStart(8)}   slope MB/h`);
let bad = false;
for (const k of ["rss", "heap", "ext", "workers", "wext", "native"] as const) {
    const s = slope(k);
    const flag = (k === "rss" || k === "native") && s.perHour > maxSlope ? "  <-- above threshold" : "";
    if (flag) bad = true;
    console.log(`${k.padEnd(14)} ${s.first.toFixed(0).padStart(8)} ${s.last.toFixed(0).padStart(8)} ${s.min.toFixed(0).padStart(8)} ${s.max.toFixed(0).padStart(8)}   ${s.perHour >= 0 ? "+" : ""}${s.perHour.toFixed(1)}${flag}`);
}
console.log(bad ? `\nVERDICT: growth above ${maxSlope} MB/h — investigate (heap-diff.ts for JS classes; smaps for native)` : `\nVERDICT: no sustained growth above ${maxSlope} MB/h over ${hours.toFixed(1)} h`);
process.exit(bad ? 1 : 0);
