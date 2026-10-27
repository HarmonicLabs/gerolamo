#!/usr/bin/env bun
/**
 * Bug 167: reconstruct the current epoch's frozen DRep pulser snapshot from a node's stores (the
 * one-time backfill a restarted node runs, src/consensus/governance/govPulser.ts) and print what it
 * holds and how its votes differ from the live proposals. Read-only: LMDB, chunk and volatile
 * stores opened read-only, the node's SQLite never opened.
 *
 *   bun scripts/gov-pulser-backfill.ts --node <node dir> --dry-run [--network preview] [--epoch E] [--out <json file>]
 *       [--db-path <scratch db> (default /tmp/gov-pulser-backfill-<pid>.db)]
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node"), network = opt("network", "preview")!;
if (!node || !argv.includes("--dry-run")) { console.error("usage: bun scripts/gov-pulser-backfill.ts --node <node dir> --dry-run [--network preview] [--epoch E] [--out file]"); process.exit(2); }
const { initSettings } = await import("../src/config/settings");
initSettings({ dbPath: opt("db-path") || `/tmp/gov-pulser-backfill-${process.pid}.db` }); // never the node's SQLite
const { attachReadOnlyLedgerStore, getLedgerStore, ledgerGovReads, ledgerStakeReads } = await import("../src/ledger/nodeLedgerStore");
const { BlockStore } = await import("../src/storage/blockStore");
const { selectedChain, selectedTip, setSelectedTipHash } = await import("../src/storage/blockReads");
const { epochForSlot, setEpochNetwork } = await import("../src/utils/epochFromSlotCalculations");
const { backfillPulserSnapshot, describePulserSnapshot, ledgerViewAt } = await import("../src/consensus/governance/govPulser");
const { logger, LogLevel } = await import("../src/utils/logger");
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);
const store = attachReadOnlyLedgerStore({ dbPath: join(node, `${network}.db`), ledgerDir: join(node, "ledger"), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
const gr = ledgerGovReads(), sr = ledgerStakeReads();
if (!store || !gr || !sr) { console.error("no LMDB ledger store under the node directory"); process.exit(1); }
const blocks = await BlockStore.open(join(node, "db"), { k: network === "mainnet" ? 2160 : 432, readOnly: true });
const tipFile = join(node, "db", "gerolamo", "selected-tip.hex");
if (existsSync(tipFile)) { const h = readFileSync(tipFile, "utf8").trim(); if (/^[0-9a-f]{64}$/i.test(h)) setSelectedTipHash(Uint8Array.from(Buffer.from(h, "hex"))); }
const tip = await selectedTip(blocks);
const epoch = Number(opt("epoch", String(tip ? Number(epochForSlot(tip.slot)) : 0)));
const t0 = performance.now();
const stored = gr.pulserSnapshot(epoch);
const { snap, blocks: n, txs } = await backfillPulserSnapshot({ epoch, ledger: store, chain: (from, to) => selectedChain(blocks, from, to), now: { gov: gr, stake: sr }, viewAt: await ledgerViewAt(store) });
console.log(`gov-pulser-backfill --dry-run ${node} (${((performance.now() - t0) / 1000).toFixed(1)} s; tip slot ${tip?.slot ?? "-"}; the store ${stored ? `already holds a snapshot of epoch ${epoch} (${stored.source})` : `holds no snapshot of epoch ${epoch}`})`);
console.log(`  ${n} block(s), ${txs} transaction(s) with certificates or votes walked for the votes`);
for (const line of describePulserSnapshot(snap, gr)) console.log("  " + line);
if (stored) {
    const same = JSON.stringify(stored) === JSON.stringify(snap);
    console.log(`  the reconstruction ${same ? "equals" : "DIFFERS from"} the stored snapshot`);
}
const out = opt("out");
if (out) { await Bun.write(out, JSON.stringify(snap)); console.log(`  written to ${out}`); }
getLedgerStore()?.close();
process.exit(0);
