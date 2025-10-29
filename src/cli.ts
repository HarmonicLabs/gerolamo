import { program } from "commander";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { Cbor } from "@harmoniclabs/cbor";
import { SQLNewEpochState } from "./consensus/ledger";
import { SQL } from "bun";
import { GerolamoConfig, PeerManager } from "./network/PeerManager";
import { NetworkT } from "@harmoniclabs/cardano-ledger-ts";

export async function getCbor(cborFile: string, outputDirPath: string) {
    try {
        await fsPromises.stat(outputDirPath);
    } catch {
        await fsPromises.mkdir(outputDirPath);
    }

    const cbor = await fsPromises.readFile(cborFile);
    await SQLNewEpochState.fromCborObj(
        new SQL(`file:${path.join(outputDirPath, "nes.db")}`),
        Cbor.parse(cbor),
    );
}

program.name("gerolamo");

export function Main() {
    program
        .command("import-ledger-state")
        .description("Import and load ledger state snapshots into SQLite")
        .argument(
            "<cborFilePath>",
            "path to the CBOR file containing the ledger state",
        )
        .argument("[outputDirPath]", undefined, path.normalize("./output"))
        .action(async (
            cborFilePath: string,
            outputDirPath: string,
        ) => {
            await getCbor(path.normalize(cborFilePath), outputDirPath);
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
            const db = new SQL(`file:${path.normalize(dbPath)}`);
            const lState = new SQLNewEpochState(db);
            await lState.init(); // Ensure tables exist
            const peerManager = new PeerManager(config, lState);
            await peerManager.init();
            // Keep the process running
            process.on("SIGINT", async () => {
                await peerManager.shutdown();
                process.exit(0);
            });
        });

    program.command("init-node", "Initialize the node").action(() => undefined);
    program.parse(process.argv);
}
