#!/usr/bin/env bun
/**
 * Repeatable sync benchmark: samples /metrics and reports block/s plus the range/validation profile.
 *   bun scripts/benchmark-sync.ts --url http://127.0.0.1:3040 --seconds 30 --interval 5
 */
const arg = (k: string, d: string): string => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1]! : d;
};
const url = arg("url", "http://127.0.0.1:3040");
const seconds = Number(arg("seconds", "30"));
const interval = Number(arg("interval", "5"));

const read = async (): Promise<any> => {
    const r = await fetch(`${url.replace(/\/$/, "")}/metrics`);
    if (!r.ok) throw new Error(`metrics HTTP ${r.status}`);
    return r.json();
};
const first = await read();
const t0 = Date.now();
let last = first;
const samples: any[] = [];
for (let elapsed = interval; elapsed <= seconds; elapsed += interval) {
    await Bun.sleep(interval * 1000);
    last = await read();
    const tip = BigInt(last.tipSlot ?? 0);
    const prev = BigInt(samples.length ? samples[samples.length - 1].tip : first.tipSlot ?? 0);
    samples.push({ at: elapsed, tip: String(tip), blocks: tip > prev ? Number(tip - prev) : Number(last.sync?.blocksApplied ?? 0) });
}
const elapsed = (Date.now() - t0) / 1000;
const tipDelta = Number(BigInt(last.tipSlot ?? 0) - BigInt(first.tipSlot ?? 0));
const appliedDelta = Number(last.sync?.blocksApplied ?? 0) - Number(first.sync?.blocksApplied ?? 0);
console.log(JSON.stringify({
    url, elapsedSec: elapsed,
    tipStart: first.tipSlot, tipEnd: last.tipSlot, tipDelta,
    blocksAppliedStart: first.sync?.blocksApplied, blocksAppliedEnd: last.sync?.blocksApplied, appliedDelta,
    blocksPerSecByTip: elapsed > 0 ? tipDelta / elapsed : 0,
    halted: last.sync?.halted ?? null,
    profile: last.sync?.profile ?? null,
    samples,
}, null, 2));
