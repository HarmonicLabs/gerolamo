/**
 * Serve node-to-client LocalStateQuery (and the other N2C protocols) from a running Gerolamo node's
 * stores, opened read-only, on a separate socket: for testing this build's query answers against a
 * live node without restarting it (cardano-cli, scripts/n2c-compare.ts). Nothing is written to the
 * node's directories; the stores are re-attached when the node's selected tip moves.
 *   bun scripts/lsq-host.ts --config <node config.json> --socket <path> [--magic 2] [--gov-cache <file>]
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const cfgPath = arg("config");
const socketPath = arg("socket");
if (!cfgPath || !socketPath) { console.error("usage: bun scripts/lsq-host.ts --config <node config.json> --socket <path> [--magic 2] [--gov-cache <file>]"); process.exit(2); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const dbPath: string = process.env.GEROLAMO_NODE_DB_PATH ?? join(dirname(cfgPath), "preview.db");
// the SQLite writer connection opens at import: point it at a scratch file, never the node's database
process.env.GEROLAMO_DB_PATH = arg("sqlite", join(dirname(socketPath), "lsq-host-scratch.db"));
process.env.GEROLAMO_LSQ_GOV_CACHE ??= arg("gov-cache", "") ?? "";
const magic = Number(arg("magic", "2"));
const k = Number(arg("k", "432"));

const { setEpochNetwork } = await import("../src/utils/epochFromSlotCalculations");
setEpochNetwork(magic === 2 ? "preview" : magic === 764824073 ? "mainnet" : "preprod"); // slot → epoch geometry of the served network
const { attachReadOnlyBlockStore } = await import("../src/storage/nodeBlockStore");
const { attachReadOnlyLedgerStore, getLedgerStore } = await import("../src/ledger/nodeLedgerStore");
const { setLsqRefresher, clearLsqViews } = await import("../src/network/n2c/lsq/view");
const { rebindGovIndex } = await import("../src/network/n2c/lsq/govIndex");
const { startN2CServer } = await import("../src/network/n2c");

const storeCfg = { dbPath, ledgerDir: cfg.ledgerDir, ledgerStore: cfg.ledgerStore, blockStoreDir: cfg.blockStoreDir };
const tipFile = join(cfg.blockStoreDir?.trim() || join(dirname(dbPath), "db"), "gerolamo", "selected-tip.hex");
const readTip = () => { try { return readFileSync(tipFile, "utf8").trim(); } catch { return ""; } };
let attachedTip = "", attachedAt = 0;
const retired: Array<{ close(): void; at: number }> = [];

async function attach(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const tip = readTip();
        const prev = getLedgerStore();
        const bs = await attachReadOnlyBlockStore(storeCfg, k);
        const ls = attachReadOnlyLedgerStore(storeCfg);
        if (bs) rebindGovIndex(bs);
        // the node writes the tip file and the block's diff file separately: wait for a consistent pair
        if (ls && !ls.chainReachesAnchor(ls.selectedTip())) { await new Promise((r) => setTimeout(r, 300)); continue; }
        if (prev && prev !== ls) retired.push({ close: () => prev.close(), at: Date.now() });
        attachedTip = tip; attachedAt = Date.now();
        clearLsqViews();
        break;
    }
    // stores a client may still be reading: closed a minute after they were replaced
    for (let i = retired.length - 1; i >= 0; i--) if (Date.now() - retired[i]!.at > 60_000) { try { retired[i]!.close(); } catch { /* gone */ } retired.splice(i, 1); }
}
await attach();
setLsqRefresher(async () => { if (readTip() !== attachedTip && Date.now() - attachedAt > 1000) await attach(); });

if (existsSync(socketPath)) unlinkSync(socketPath);
const server = await startN2CServer({ socketPath, networkMagic: magic });
console.log(`lsq-host: serving ${cfgPath} read-only on ${server.socketPath} (magic ${magic})`);
const stop = async () => { await server.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
