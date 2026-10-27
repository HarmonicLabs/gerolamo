#!/usr/bin/env bun
/**
 * Run the governance rules (GOV / GOVCERT / DELEG / POOL / LEDGER) over a node's most recent blocks
 * against its own LMDB ledger store, read-only: for every block whose parent the store holds (the
 * anchor or a volatile diff) the view is pinned to the parent and `checkBlockGovernance` runs as the
 * body validator would. This exercises the LMDB readers the SQLite replay (gov-replay.ts) does not.
 *
 *   bun scripts/gov-rules-shadow.ts --db-path <scratch>/x.db --node <node dir> [--blocks 600] [--network preview]
 *
 * Nothing of the node is written: the LMDB environment is opened read-only, the chunk and volatile
 * stores read-only, SQLite not at all (the node's parameters come from its LMDB store).
 */
import { join } from "node:path";
import { attachReadOnlyLedgerStore, getLedgerStore, ledgerGovReads } from "../src/ledger/nodeLedgerStore";
import { ChunkStore } from "../src/storage/chunkStore";
import { VolatileStore } from "../src/storage/volatileStore";
import { epochForSlot, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { blockTxBodies, decodeCbor } from "../src/consensus/governance/govTxDecode";
import { checkBlockGovernance, govRuleSummary } from "../src/consensus/governance/govValidate";
import { logger, LogLevel } from "../src/utils/logger";
import { initSettings } from "../src/config/settings";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node")!;
const network = opt("network", "preview")!;
const want = Number(opt("blocks", "600"));
if (!node) { console.error("usage: bun scripts/gov-rules-shadow.ts --db-path <scratch>.db --node <node dir> [--blocks N]"); process.exit(2); }
const scratchDb = opt("db-path");
if (!scratchDb) { console.error("pass --db-path <scratch file>: this tool must not open the node's SQLite"); process.exit(2); }
initSettings({ dbPath: scratchDb });
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);

const store = attachReadOnlyLedgerStore({ dbPath: join(node, "preview.db"), ledgerDir: join(node, "ledger"), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
if (!store || !ledgerGovReads()) { console.error("no LMDB ledger store"); process.exit(1); }
const tipAtStart = store.selectedTip();
const imm = await ChunkStore.open(join(node, "db", "immutable"), { chunkSlots: network === "mainnet" ? 21600 : 4320, cacheChunks: 4, readOnly: true });
const vol = await VolatileStore.open(join(node, "db", "volatile"), { readOnly: true });
const immTip = await imm.tip();
// candidate blocks: the last chunks of the immutable store plus the volatile ones, oldest first
const blocks: Array<{ slot: number; hash: Uint8Array; bytes: Uint8Array; prev?: Uint8Array | null }> = [];
const chunks = imm.chunks();
for (const n of chunks.slice(-Math.ceil(want / 180) - 2)) for await (const b of imm.iterate(n * 4320, n * 4320 + 4319)) blocks.push({ slot: b.slot, hash: b.hash, bytes: b.bytes });
for (const b of vol.all()) if (!immTip || b.slot > immTip.slot) blocks.push({ slot: b.slot, hash: b.hash, bytes: b.bytes, prev: b.prevHash });
blocks.sort((a, b) => a.slot - b.slot);
const prevOf = (bytes: Uint8Array): Uint8Array | null => {
    // [era, [header, …]]: header = [header_body, sig], header_body[2] = prev hash
    const top: any = decodeCbor(bytes).v;
    const hb = top.v[1].v[0].v[0].v;
    const prev = hb[2];
    return prev?.t === "b" ? prev.v : null;
};
let checked = 0, withGov = 0, failures = 0, skipped = 0;
for (const b of blocks.slice(-want)) {
    if (!b.bytes) { skipped++; continue; }
    let prev: Uint8Array | null = null;
    try { prev = b.prev !== undefined ? b.prev : prevOf(b.bytes); } catch { skipped++; continue; }
    if (!prev || !store.knows(prev)) { skipped++; continue; }
    store.selectTip(prev);
    const e = Number(epochForSlot(b.slot));
    const raw = ledgerGovReads()!.epochParams(e)?.params;
    if (!raw) { skipped++; continue; }
    const parsed = blockTxBodies(b.bytes);
    const v = await checkBlockGovernance({ slot: b.slot, epoch: e, bodies: parsed.bodies.map((bytes) => ({ bytes })), invalid: parsed.invalid, raw, networkId: network === "mainnet" ? 1 : 0 });
    checked++;
    if (v.checked) withGov++;
    for (const f of v.failures) { failures++; console.log(`FAIL slot ${b.slot}: ${f}`); }
    for (const r of v.reports) console.log(`report slot ${b.slot}: ${r}`);
}
if (tipAtStart) store.selectTip(tipAtStart);
const s = govRuleSummary();
console.log(`shadow over ${node}: ${checked} block(s) checked against the LMDB state at their parent (${skipped} skipped: parent not held or no parameters), ${withGov} with governance content, ${s.txs} transaction(s), ${failures} failure(s)`);
getLedgerStore()?.close();
process.exit(failures ? 1 : 0);
