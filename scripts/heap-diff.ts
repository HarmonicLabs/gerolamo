/**
 * Diff two heap class summaries written by SIGUSR2 (logs/heap-<ts>.json):
 *   bun scripts/heap-diff.ts <heap-A.json> <heap-B.json> [--top 20]
 * A leak of JS objects shows as a class whose count and bytes grow between two
 * snapshots taken hours apart while the node did the same kind of work.
 */
const [a, b] = [process.argv[2], process.argv[3]];
if (!a || !b) { console.error("usage: heap-diff.ts <heap-A.json> <heap-B.json> [--top N]"); process.exit(2); }
const top = Number(process.argv.includes("--top") ? process.argv[process.argv.indexOf("--top") + 1] : 20);
type Row = { count: number; bytes: number };
const load = async (p: string) => { const d = await Bun.file(p).json(); const rows = new Map<string, Row>(); for (const r of d.top) { const [name, v] = Array.isArray(r) ? r : [r.name, r]; rows.set(name, v); } return { at: d.at, rss: d.rss, heapUsed: d.heapUsed, rows }; };
const A = await load(a), B = await load(b);
const mb = (n: number) => (n / 1048576).toFixed(1);
console.log(`A ${A.at} rss ${mb(A.rss)} MB heap ${mb(A.heapUsed)} MB\nB ${B.at} rss ${mb(B.rss)} MB heap ${mb(B.heapUsed)} MB\n`);
const keys = new Set([...A.rows.keys(), ...B.rows.keys()]);
const rows = [...keys].map((k) => { const x = A.rows.get(k) ?? { count: 0, bytes: 0 }, y = B.rows.get(k) ?? { count: 0, bytes: 0 }; return { k, dc: y.count - x.count, db: y.bytes - x.bytes, x, y }; }).sort((p, q) => q.db - p.db);
console.log(`${"class".padEnd(36)} ${"count A".padStart(10)} ${"count B".padStart(10)} ${"MB A".padStart(8)} ${"MB B".padStart(8)} ${"ΔMB".padStart(8)}`);
for (const r of rows.slice(0, top)) console.log(`${r.k.padEnd(36)} ${r.x.count.toLocaleString().padStart(10)} ${r.y.count.toLocaleString().padStart(10)} ${mb(r.x.bytes).padStart(8)} ${mb(r.y.bytes).padStart(8)} ${(r.db >= 0 ? "+" : "") + mb(r.db).padStart(7)}`);
