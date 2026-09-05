#!/usr/bin/env bun
/**
 * Run the body rules on a block stored in one DB against the ledger state of
 * another (or the same) DB, inline, with timings. For debugging a halt or a
 * stall without a network:
 *
 *   bun scripts/validate-stored-block.ts --db /path/ledger.db --blocks /path/with-blocks.db --slot 3200 [--network mainnet]
 *   bun scripts/validate-stored-block.ts --db /path/ledger.db --hex logs/failed-block-86440.hex --slot 86440 --network preprod
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { initSql } from "../src/sql";
import { ensureInitialized } from "../src/db";
import { evaluateBlockRules } from "../src/consensus/rules/blockRules";
import { getEpochBodyParams } from "../src/consensus/epochParams";
import { epochForSlot } from "../src/utils/epochFromSlotCalculations";
import { getShelleyGenesisConfig } from "../src/utils/paths";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const ledgerDb = opt("db")!; const blocksDb = opt("blocks", ledgerDb)!; const slot = Number(opt("slot")); const network = opt("network", "mainnet")!;
if (!ledgerDb || !Number.isFinite(slot)) { console.error("usage: --db <ledger.db> [--blocks <blocks.db>] --slot <n>"); process.exit(2); }

let bytes: Uint8Array;
let hashLabel = "";
const hexFile = opt("hex");
if (hexFile) {
    bytes = new Uint8Array(Buffer.from(readFileSync(hexFile, "utf8").trim(), "hex"));
} else {
    const bdb = new Database(blocksDb, { readonly: true });
    const row = bdb.query("SELECT slot, hash, block_data FROM blocks WHERE slot = ? ORDER BY block_no DESC LIMIT 1").get(slot) as any;
    if (!row) { console.error(`no block at slot ${slot} in ${blocksDb}`); process.exit(1); }
    bytes = new Uint8Array(row.block_data as Buffer);
    hashLabel = String(row.hash);
}
const t0 = performance.now();
const block = MultiEraBlock.fromCbor(bytes);
const t1 = performance.now();
console.log(`block ${hashLabel} era ${block.era} bytes ${bytes.length} parse ${(t1 - t0).toFixed(1)} ms`);

initSql(ledgerDb);
await ensureInitialized();
const config: any = {
    network,
    networkMagic: network === "mainnet" ? 764824073 : network === "preprod" ? 1 : 2,
    byronGenesisFile: `./src/config/${network}/byron-genesis.json`,
    shelleyGenesisFile: `./src/config/${network}/shelley-genesis.json`,
};
const genesis = block.era >= 2 ? await getShelleyGenesisConfig(config as any).catch(() => null) : null;
const params = block.era >= 2 ? await getEpochBodyParams(config, Number(epochForSlot(slot, network as any))).catch(() => null) : null;
const t2 = performance.now();
const out = await evaluateBlockRules(block, { config, pool: null, params, genesis, slot: BigInt(slot) });
const t3 = performance.now();
console.log(`rules ${(t3 - t2).toFixed(1)} ms · txs ${out.txs} · witnesses ${out.witnessesVerified}`);
console.log("failures:", out.failures.length ? out.failures : "none");
console.log("reports:", out.reports.length ? out.reports.slice(0, 10) : "none");
process.exit(out.failures.length ? 1 : 0);
