#!/usr/bin/env bun
/**
 * Bug 166: recompute the votes of a node's live proposals from its own chain (the ledger's vote
 * semantics, src/consensus/governance/govVotesRepair.ts) and print what the node's one-time repair
 * would change. Read-only: the LMDB environment, the chunk and the volatile stores are opened
 * read-only and the node's SQLite is never opened (a scratch file stands in for it).
 *
 *   bun scripts/gov-votes-repair.ts --node <node dir> --dry-run [--network preview]
 *
 * The repair itself runs inside the node on restart (govCredMigration → repairLiveProposalVotesOnce).
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node"), network = opt("network", "preview")!;
if (!node || !argv.includes("--dry-run")) { console.error("usage: bun scripts/gov-votes-repair.ts --node <node dir> --dry-run [--network preview]"); process.exit(2); }
process.env.GEROLAMO_DB_PATH ||= `/tmp/gov-votes-repair-${process.pid}.db`; // never the node's SQLite
const { attachReadOnlyLedgerStore, getLedgerStore, ledgerGovReads } = await import("../src/ledger/nodeLedgerStore");
const { BlockStore } = await import("../src/storage/blockStore");
const { selectedChain, setSelectedTipHash } = await import("../src/storage/blockReads");
const { setEpochNetwork } = await import("../src/utils/epochFromSlotCalculations");
const { describeVoteRepair, repairLiveProposalVotes } = await import("../src/consensus/governance/govVotesRepair");
const { logger, LogLevel } = await import("../src/utils/logger");
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);
const dbName = `${network}.db`;
const store = attachReadOnlyLedgerStore({ dbPath: join(node, dbName), ledgerDir: join(node, "ledger"), ledgerStore: "lmdb", blockStoreDir: join(node, "db") });
if (!store || !ledgerGovReads()) { console.error("no LMDB ledger store under the node directory (SQLite-mode nodes are not supported here)"); process.exit(1); }
const blocks = await BlockStore.open(join(node, "db"), { k: network === "mainnet" ? 2160 : 432, readOnly: true });
const tipFile = join(node, "db", "gerolamo", "selected-tip.hex");
if (existsSync(tipFile)) { const h = readFileSync(tipFile, "utf8").trim(); if (/^[0-9a-f]{64}$/i.test(h)) setSelectedTipHash(Uint8Array.from(Buffer.from(h, "hex"))); }
const t0 = performance.now();
const r = await repairLiveProposalVotes((from) => selectedChain(blocks, from, Number.MAX_SAFE_INTEGER), { dryRun: true });
console.log(`gov-votes-repair --dry-run ${node} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
for (const line of describeVoteRepair(r)) console.log("  " + line);
getLedgerStore()?.close();
process.exit(0);
