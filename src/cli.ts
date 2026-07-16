import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { ensureInitialized } from "./db";

import { start } from "./network";

import { Logger, LogLevel } from "./utils/logger";
import { parse, resolve } from "node:path";
import { readdir } from "node:fs/promises";

import { processChunk, loadLedgerStateFromAncilliary } from "./state";

/**
 * Mithril snapshot download/verify is external (Dolos / The Lab).
 * Gerolamo bootstraps from local immutable chunk dirs via read-raw-chunks.
 */
export async function getCbor(dbPath: string, snapshotRoot: string) {
    console.error(
        [
            "Mithril snapshot import is not implemented in Gerolamo.",
            "Mithril bootstrap is owned externally (Dolos / The Lab).",
            "For local chain bootstrap use:",
            "  bun src/index.ts read-raw-chunks <immutable_dir>",
            `Snapshot root (ignored): ${snapshotRoot}`,
            `DB path: ${dbPath}`,
        ].join("\n"),
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
            "Bootstrap from Cardano immutable chunk files (primary bootstrap path; Mithril is external)",
        )
        .argument(
            "<immutable_dir>",
            "Directory containing the .primary, .secondary, .chunk files",
        )
        .option(
            "--from-chunk <n>",
            "First chunk number (inclusive)",
            (v) => parseInt(v, 10),
            0,
        )
        .option(
            "--to-chunk <n>",
            "Last chunk number (inclusive); default = max present",
            (v) => parseInt(v, 10),
        )
        .action(
            async (
                immutableDir: string,
                options: { fromChunk?: number; toChunk?: number },
            ) => {
                await ensureInitialized();
                const dir = resolve(immutableDir);

                const logger = new Logger({ logLevel: LogLevel.INFO });
                const names = await readdir(dir);
                const chunkNos = names
                    .map((v) => parseInt(parse(v).name, 10))
                    .filter((n) => Number.isFinite(n) && n >= 0);
                if (chunkNos.length === 0) {
                    throw new Error(`No chunk files found in ${dir}`);
                }
                const maxChunkNo = Math.max(...chunkNos);
                const from = Math.max(0, options.fromChunk ?? 0);
                const to = Math.min(
                    maxChunkNo,
                    options.toChunk ?? maxChunkNo,
                );
                if (from > to) {
                    throw new Error(
                        `Invalid chunk range: from=${from} to=${to} (max=${maxChunkNo})`,
                    );
                }
                logger.info(
                    `read-raw-chunks: dir=${dir} chunks ${from}..${to} (max=${maxChunkNo})`,
                );

                for (let chunkNo = from; chunkNo <= to; chunkNo++) {
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
