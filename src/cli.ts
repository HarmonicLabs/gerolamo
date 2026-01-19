import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { DB } from "./db/DB";
import { Database } from "bun:sqlite";

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
            "Custom Blockfrost backend URL"
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
            const db = new DB(options.dbPath);
            await db.ensureInitialized();
            await initNewEpochState();
            await importFromBlockfrost(db as unknown as Database, blockHash, options);
        });

    program
        .command("start-gerolamo")
        .description(
            "Start the gerolamo node based on config.json settings",
        )
        .action(async () => {
            import ("./start").then(() => {
                // Node started
            });
        });

    program.parse(process.argv);
}
