#!/usr/bin/env bun
/**
 * Summarise a `bun --cpu-prof` profile (.cpuprofile, Chrome format): self time per function and
 * per file, plus inclusive time for the functions you name.
 *   bun scripts/cpuprofile-top.ts <file.cpuprofile> [--top 40] [--incl applyBlock,validateBlock] [--file-top 15] [--callers join,BigInt]
 *   --callers: for native/builtin frames, the nearest non-native caller frames (who is paying for `join`?)
 *   --weight next|prev|count (default next): what one sample is worth. `next` = the time until the following
 *     sample (DevTools: the sampled stack holds until the next sample); `prev` = the gap before it (this
 *     script's old rule — it charged the main thread's idle waits to the first function that ran after
 *     them: `chain` showed 4–5 % on the 2026-10-06 sync profiles for 34–49 samples, bug 381); `count` =
 *     one per sample. Idle time (awaiting I/O) is still charged to a neighbour under `next`; compare with
 *     `count` before trusting a small entry.
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : []).filter((x) => x.length));
const file = process.argv[2];
if (!file || file.startsWith("--")) { console.error("usage: cpuprofile-top.ts <file.cpuprofile> [--top N] [--incl a,b] [--file-top N]"); process.exit(2); }
const prof = JSON.parse(readFileSync(file, "utf8")) as { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const weight = String(args.weight ?? "next");
const dtOf = (i: number): number => weight === "count" ? 1000 : weight === "prev" ? (prof.timeDeltas[i] ?? 0) : (prof.timeDeltas[i + 1] ?? 0);
const self = new Map<number, number>();
let total = 0;
for (let i = 0; i < prof.samples.length; i++) {
    const dt = dtOf(i);
    total += dt;
    self.set(prof.samples[i]!, (self.get(prof.samples[i]!) ?? 0) + dt);
}
const label = (id: number): string => { const n = byId.get(id)!; const f = n.callFrame; const short = f.url.replace(/^.*\/(node_modules\/)/, "$1").replace(/^.*\/src\//, "src/"); return `${f.functionName || "(anonymous)"} ${short}:${f.lineNumber + 1}`; };
// self time per function (merging nodes with the same frame)
const selfByFrame = new Map<string, number>();
const selfByFile = new Map<string, number>();
for (const [id, t] of self) {
    const k = label(id); selfByFrame.set(k, (selfByFrame.get(k) ?? 0) + t);
    const f = byId.get(id)!.callFrame.url.replace(/^.*\/(node_modules\/)/, "$1").replace(/^.*\/src\//, "src/") || "(native)";
    selfByFile.set(f, (selfByFile.get(f) ?? 0) + t);
}
const pct = (t: number) => `${(100 * t / total).toFixed(1)}%`;
const ms = (t: number) => `${(t / 1000).toFixed(0)} ms`;
console.log(`profile ${file}: ${(total / 1e6).toFixed(1)} s sampled, ${prof.samples.length} samples (weight: ${weight}${weight === "count" ? ", 1 ms per sample" : ""})\n`);
const top = Number(args.top ?? 40);
console.log(`== self time, top ${top} functions`);
for (const [k, t] of [...selfByFrame].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${pct(t).padStart(6)} ${ms(t).padStart(9)}  ${k}`);
console.log(`\n== self time by file, top ${Number(args["file-top"] ?? 15)}`);
for (const [k, t] of [...selfByFile].sort((a, b) => b[1] - a[1]).slice(0, Number(args["file-top"] ?? 15))) console.log(`${pct(t).padStart(6)} ${ms(t).padStart(9)}  ${k}`);
if (args.callers) {
    // Attribute a native frame's self time to its nearest non-native ancestor (and that one's parent).
    const names = String(args.callers).split(",").map((x) => x.trim()).filter(Boolean);
    const isNative = (id: number) => { const f = byId.get(id)!.callFrame; return !f.url || f.url === ""; };
    for (const name of names) {
        const byCaller = new Map<string, number>();
        let sum = 0;
        for (const [id, t] of self) {
            if (byId.get(id)!.callFrame.functionName !== name) continue;
            sum += t;
            let c: number | undefined = parent.get(id);
            while (c != null && isNative(c)) c = parent.get(c);
            const c2 = c != null ? parent.get(c) : undefined;
            const k = c != null ? `${label(c)}  ←  ${c2 != null ? label(c2) : "(root)"}` : "(root)";
            byCaller.set(k, (byCaller.get(k) ?? 0) + t);
        }
        console.log(`\n== callers of ${name} (${pct(sum)} self)`);
        for (const [k, t] of [...byCaller].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${pct(t).padStart(6)} ${ms(t).padStart(9)}  ${k}`);
    }
}
if (args.incl) {
    // inclusive: a sample counts for every named ancestor frame once
    const names = String(args.incl).split(",").map((s) => s.trim()).filter(Boolean);
    const incl = new Map<string, number>(names.map((n) => [n, 0]));
    for (let i = 0; i < prof.samples.length; i++) {
        const dt = dtOf(i);
        const seen = new Set<string>();
        for (let id: number | undefined = prof.samples[i]; id != null; id = parent.get(id)) {
            const fn = byId.get(id)!.callFrame.functionName;
            for (const n of names) if (!seen.has(n) && (fn === n || fn.startsWith(n))) { seen.add(n); incl.set(n, incl.get(n)! + dt); }
        }
    }
    console.log(`\n== inclusive time`);
    for (const [n, t] of incl) console.log(`${pct(t).padStart(6)} ${ms(t).padStart(9)}  ${n}`);
}
