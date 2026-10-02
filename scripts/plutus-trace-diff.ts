#!/usr/bin/env bun
/** First divergence between our builtin trace (GEROLAMO_PLUTUS_BUILTIN_TRACE=1) and tools/uplc-ref's (UPLC_BUILTIN_TRACE=1): bun scripts/plutus-trace-diff.ts ours.trace aiken.trace */
import { readFileSync } from "node:fs";
const names: Record<number, string> = {};
const tags = require("@harmoniclabs/uplc").UPLCBuiltinTag;
for (const k of Object.keys(tags)) if (!isNaN(Number(k))) names[Number(k)] = tags[k][0].toUpperCase() + tags[k].slice(1);
const ours = readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.startsWith("BUILTIN")).map((l) => { const m = /^BUILTIN (\d+) (.*) -> (.*)$/.exec(l)!; return { n: names[Number(m[1])], args: m[2], res: m[3] }; });
const aik = readFileSync(process.argv[3], "utf8").split("\n").filter((l) => l.startsWith("BUILTIN")).map((l) => { const m = /^BUILTIN (\w+)\((.*)\) -> (.*)$/.exec(l)!; return { n: m[1], args: m[2], res: m[3] }; });
const norm = (s: string) => s.replace(/^Integer\((-?\d+)\)$/, "$1").replace(/^Bool\((\w+)\)$/, "$1");
for (let i = 0; i < Math.max(ours.length, aik.length); i++) {
  const a = ours[i], b = aik[i];
  const nn = (x: string) => x.toLowerCase().replace(/equals/g, "equal").replace(/_/g, ""); if (!a || !b || nn(a.n) !== nn(b.n)) { console.log("name diverges at", i, a, b); console.log("prev", ours[i-1], aik[i-1]); break; }
  const ra = norm(a.res), rb = norm(b.res);
  if ((/^-?\d+$/.test(ra) || /^(true|false)$/.test(ra)) && ra !== rb) { console.log("result diverges at", i, a, b); break; }
}
console.log("ours", ours.length, "aiken", aik.length);
