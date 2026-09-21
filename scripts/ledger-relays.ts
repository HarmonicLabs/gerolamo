/**
 * Write <node dir>/ledger-relays.json from a Mithril ledger snapshot's `state` file: every
 * registered pool's relays, for the peer governor's "ledger" source (pools registered after
 * the snapshot come from the pool_relays table the node maintains itself).
 *   bun scripts/ledger-relays.ts --state <…/ledger/<slot>/state> --out <node dir>/ledger-relays.json
 */
import { decodeLedgerSnapshot } from "../src/mithril/nesDecoder";
import { dedupeRelays, ledgerRelaysFromSnapshotPools, type LedgerRelaysFile } from "../src/network/ledgerPeers";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : []).filter((x) => x.length));
if (!args.state || !args.out) { console.error("usage: --state <state file> --out <ledger-relays.json>"); process.exit(2); }
const bytes = new Uint8Array(await Bun.file(args.state).arrayBuffer());
const snap = decodeLedgerSnapshot(bytes);
const relays = dedupeRelays(ledgerRelaysFromSnapshotPools(snap.pools as any));
const file: LedgerRelaysFile = { generatedAt: new Date().toISOString(), stateSlot: Number(snap.slot ?? null), relays };
await Bun.write(args.out, JSON.stringify(file, null, 1) + "\n");
const pools = new Set(relays.map((r) => r.pool)).size;
console.log(`${args.out}: ${relays.length} relay(s) from ${pools} pool(s) (snapshot slot ${file.stateSlot}); ${relays.filter((r) => /^\d+\.\d+\.\d+\.\d+$/.test(r.host)).length} by IP, ${relays.filter((r) => !/^\d+\.\d+\.\d+\.\d+$/.test(r.host)).length} by name`);
process.exit(0);
