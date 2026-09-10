#!/usr/bin/env bun
/**
 * Roll the ledger back to a slot offline, with the node stopped, through the node's own
 * `rollbackChainTo` (blocks after the slot deleted, their UTxO deltas reverted, the ledger
 * journal undone, the explorer projection rolled back in its worker). Use it to leave a
 * dead fork the node is parked on before repairing state — a later online rollback would
 * replay the journal's before-images over the repaired rows (reward_pots is updated by
 * every block's fees). Refuses to cross an epoch boundary, like the node.
 *
 *   bun scripts/rollback-to-slot.ts --db <ledger.db> --network preview --slot <slot> [--apply]
 */
import { initSql, closeSql } from "../src/sql";
import { ensureInitialized, getMaxSlot, rollbackChainTo, countBlocksAfterSlot } from "../src/db";
import { startExplorerIndexer, stopExplorerIndexer } from "../src/db/minibf/explorerIndexer";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : []).filter((x) => x.length));
if (!args.db || !args.slot) { console.error("usage: --db <ledger.db> --network <net> --slot <slot> [--apply]"); process.exit(2); }
setEpochNetwork(args.network ?? "preview");
initSql(args.db);
await ensureInitialized();
const slot = BigInt(args.slot);
const tip = await getMaxSlot();
const above = await countBlocksAfterSlot(slot);
console.log(`DB tip slot ${tip}; ${above} block(s) above slot ${slot}`);
if (args.apply !== "1") { console.log("dry run — pass --apply to roll back"); await closeSql(); process.exit(0); }
if (above === 0) { console.log("nothing to do"); await closeSql(); process.exit(0); }
await startExplorerIndexer(args.db);
const counts = await rollbackChainTo(slot);
await stopExplorerIndexer();
console.log(`rolled back: ${JSON.stringify(counts)}; new tip slot ${await getMaxSlot()}`);
await closeSql();
