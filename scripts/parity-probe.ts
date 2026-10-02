/**
 * The watchdog's continuous verification pass (lib/parityProbe.ts): N2C answers byte-compared with
 * the cardano-node relay's, the producer's leader schedule against cardano-cli's, forged blocks
 * against the relay's chain. The watchdog starts it detached when a check is due; it runs what is
 * due under a lock file (another running probe → exit at once), records the results in
 * parity-history.json next to the watchdog state, and the next watchdog tick alerts from them.
 *   bun scripts/parity-probe.ts <watchdog config.json> [--force parity,schedule,forge] [--node "<name>"]
 * --force runs those checks now whatever their schedule (by hand; the watchdog never passes it).
 */
import { runProbe, type CheckName } from "./lib/parityProbe";

const cfgPath = process.argv[2];
if (!cfgPath || cfgPath.startsWith("--")) { console.error("usage: bun scripts/parity-probe.ts <watchdog config.json> [--force parity,schedule,forge] [--node <name>]"); process.exit(2); }
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const force = arg("force")?.split(",").filter((x): x is CheckName => x === "parity" || x === "schedule" || x === "forge");
const t0 = Date.now();
const r = await runProbe(cfgPath, { force, node: arg("node") });
console.log(`[${new Date().toISOString()}] probe done in ${Date.now() - t0} ms: ${r.skipped ?? (r.ran.join(", ") || "nothing due")}`);
process.exit(0);
