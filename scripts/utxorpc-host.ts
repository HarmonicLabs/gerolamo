#!/usr/bin/env bun
/**
 * Serve UTxO RPC from a running Gerolamo node's stores, opened read-only, on a port of its own: for
 * trying this build's answers on a live chain without restarting the node (pair it with
 * scripts/utxorpc-smoke.ts). Nothing is written to the node's directories. The stores are attached
 * once at start (a long FollowTip sees no new blocks); submission is refused. The live store has no
 * `utxo_idx` until the node itself runs this build, so payment / delegation / asset searches
 * answer empty here (exact addresses use the existing `utxo_addr` index).
 *   bun scripts/utxorpc-host.ts --config <node config.json> --port 3250 [--magic 2] [--k 432]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const cfgPath = arg("config");
const port = Number(arg("port", "3250"));
if (!cfgPath) { console.error("usage: bun scripts/utxorpc-host.ts --config <node config.json> --port <port> [--magic 2] [--k 432]"); process.exit(2); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const dbPath: string = process.env.GEROLAMO_NODE_DB_PATH ?? join(dirname(cfgPath), "preview.db");
// the SQLite writer connection opens at import: point it at a scratch file, never the node's database
process.env.GEROLAMO_DB_PATH = arg("sqlite", join(tmpdir(), `utxorpc-host-${process.pid}.db`));
const magic = Number(arg("magic", "2"));
const k = Number(arg("k", "432"));

const { setEpochNetwork } = await import("../src/utils/epochFromSlotCalculations");
setEpochNetwork(magic === 2 ? "preview" : magic === 764824073 ? "mainnet" : "preprod");
const { attachReadOnlyBlockStore } = await import("../src/storage/nodeBlockStore");
const { attachReadOnlyLedgerStore } = await import("../src/ledger/nodeLedgerStore");
const { nodeProvider } = await import("../src/api/utxorpc/provider");
const { startUtxorpcServer } = await import("../src/api/utxorpc/server");

const storeCfg = { dbPath, ledgerDir: cfg.ledgerDir, ledgerStore: cfg.ledgerStore, blockStoreDir: cfg.blockStoreDir };
const bs = await attachReadOnlyBlockStore(storeCfg, k);
const ls = attachReadOnlyLedgerStore(storeCfg);
if (!bs || !ls) { console.error("utxorpc-host: the node has no block store or LMDB ledger store"); process.exit(1); }
const provider = nodeProvider({ ...cfg, networkMagic: magic }, async () => ({ status: "refused: read-only host" }));
const server = await startUtxorpcServer({ host: "127.0.0.1", port }, { ...provider, mempool: () => null });
console.log(`utxorpc-host: serving ${cfgPath} read-only on 127.0.0.1:${server.port}`);
const stop = async () => { await server.stop(); ls.close({ flush: false }); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
