import { program } from "commander";
import * as path from "node:path";
import { SQLNewEpochState } from "./consensus/ledger";
import { SQL } from "bun";
import { GerolamoConfig, PeerManager } from "./network/PeerManager";
import { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { setDB } from "./network/sqlWorkers/sql";

export async function getCbor(dbPath: string, snapshotRoot: string) {
    await SQLNewEpochState.initFromChunk(
        path.resolve(snapshotRoot),
        path.resolve(dbPath),
    );
}

program.name("gerolamo");

export function Main() {
    program
        .command("import-ledger-state")
        .description(
            "Extract UTxO state from Mithril snapshot into LMDB database",
        )
        .argument(
            "<snapshotRoot>",
            "path to the Mithril snapshot root directory (containing ledger/ subdirectory)",
        )
        .argument("<outputPath>", "path to the output LMDB database file")
        .action(async (
            snapshotRoot: string,
            outputPath: string,
        ) => {
            await getCbor(outputPath, path.normalize(snapshotRoot));
        });

    program
        .command("start-node")
        .description(
            "Start the node with a pre-loaded ledger state DB and sync to tip",
        )
        .argument("<dbPath>", "path to the SQLite database file")
        .action(async (dbPath: string) => {
            const config: GerolamoConfig = {
                network: "preprod" as NetworkT,
                topologyFile: "./src/config/topology.json",
                syncFromTip: true,
                syncFromGenesis: false,
                genesisBlockHash:
                    "1d031daf47281f69cd95ab929c269fd26b1434a56a5bbbd65b7afe85ef96b233",
                syncFromPoint: false,
                syncFromPointSlot: 0n,
                syncFromPointBlockHash: "",
                logLevel: "debug",
                shelleyGenesisFile: "./src/config/preprod-shelley-genesis.json",
            };
            const resolvedPath = path.resolve(dbPath);
            const db = new SQL(`file:${resolvedPath}`);
            setDB(db);
            const lState = new SQLNewEpochState(db);
            await lState.init(); // Ensure tables exist
            const peerManager = new PeerManager(config, lState);
            await peerManager.init();
            // Keep the process running
            setInterval(() => {}, 1000);
            process.on("SIGINT", async () => {
                await peerManager.shutdown();
                process.exit(0);
            });
        });
    program.parse(process.argv);
}
