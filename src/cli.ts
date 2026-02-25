import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { ensureInitialized } from "./db";

import { start } from "./network";

import { Logger, LogLevel } from "./utils/logger";
import { parse, resolve } from "node:path";
import { readdir } from "node:fs/promises";

import { processChunk, loadLedgerStateFromAncilliary } from "./state";

export async function getCbor(dbPath: string, snapshotRoot: string) {
    // TODO: Implement Mithril snapshot import
    console.log(
        `Mithril import not implemented yet. Snapshot: ${snapshotRoot}, DB: ${dbPath}`,
    );
}

program.name("gerolamo");

export function Main() {
    program
        .command("import-ledger-state")
        .description(
            "Import ledger state from Blockfrost for a specific block",
        )
        .argument(
            "<blockHash>",
            "block hash to import ledger state for",
        )
        .option(
            "--project-id [id]",
            "Blockfrost project ID (optional, uses custom backend if not provided)",
        )
        .option(
            "--custom-backend <url>",
            "Custom Blockfrost backend URL",
            // no default hard-coded URL; use config.blockfrostUrl or explicit arg
        )
        .option(
            "--import-chain",
            "Import chain blocks starting from specified slot",
        )
        .option(
            "--from-slot <number>",
            "Starting slot for chain import",
            parseInt,
        )
        .option("--count <number>", "Number of blocks to import", parseInt)
        .action(async (
            blockHash: string,
            options: {
                dbPath: string;
                projectId?: string;
                customBackend?: string;
                importChain?: boolean;
                fromSlot?: number;
                count?: number;
            },
        ) => {
            await ensureInitialized();
            await initNewEpochState();
            await importFromBlockfrost(blockHash, options);
        });

    program
        .command("start-gerolamo")
        .description(
            "Start the gerolamo node based on config.json settings",
        )
        .action(start);

    program
        .command("read-raw-chunks")
        .description(
            "Read and optionally output raw blocks from Cardano immutable chunk files",
        )
        .argument(
            "<immutable_dir>",
            "Directory containing the .primary, .secondary, .chunk files",
        )
        .action(
            async (
                immutableDir: string,
            ) => {
                await ensureInitialized();
                const dir = resolve(immutableDir);

                const logger = new Logger({ logLevel: LogLevel.INFO });
                const maxChunkNo = Math.max(
                    ...(await readdir(dir)).map((v) => parseInt(parse(v).name))
                );

                for (let chunkNo = 0; chunkNo <= maxChunkNo; chunkNo++) {
                    await processChunk(dir, chunkNo, logger);
                }
            },
        );

    program
        .command("load-ancillary")
        .description("Load ledger state from ancillary LMDB database")
        .argument(
            "<ledger_path>",
            "Path to the ledger directory (e.g., ./db/ledger)",
        )
        .action(async (ledgerPath: string) => {
            await ensureInitialized();
            await loadLedgerStateFromAncilliary(ledgerPath);
        });

    program.parse(process.argv);
}
