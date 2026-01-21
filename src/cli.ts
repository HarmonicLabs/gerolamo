import { program } from "commander";
import { initNewEpochState } from "./state/ledger";
import { importFromBlockfrost } from "./state";
import { startPeerManager } from "./network/startPeerManager";

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
            "https://blockfrost-preprod.onchainapps.io/",
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
                projectId?: string;
                customBackend?: string;
                importChain?: boolean;
                fromSlot?: number;
                count?: number;
            },
        ) => {
            await initNewEpochState();
            await importFromBlockfrost(blockHash, options);
        });

    program
        .command("start-node")
        .description(
            "Start the node with a pre-loaded ledger state DB and sync to tip",
        )
        .action(async () => {
            console.log("Starting Gerolamo node...");

            // Start the peer manager with network magic
            const networkMagic = 1; // Preprod magic
            await startPeerManager(networkMagic);

            console.log("Node started successfully. Press Ctrl+C to stop.");

            // Keep the process running
            return new Promise(() => {
                // The node will keep running
            });
        });

    program.parse(process.argv);
}
