import { program } from "commander";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as streamPromises from "node:stream/promises";
import { Cbor } from "@harmoniclabs/cbor";
import { RawNewEpochState } from "./rawNES";
import { Worker } from "worker_threads";
import { startPeerManager } from "./network/peerManagerWorkers/startPeerManager";
// import { Database } from "bun:sqlite";
// import "./types/polyfills";
import { logger } from "./utils/logger";
import { startMinibfWorker } from "./minibfWorkers/minibf";
import { closeDB, startLmdbWorker } from "./network/lmdbWorkers/lmdb";

let peerManagerWorker: Worker;
let lmdbWorker: Worker;

export async function startNode(configPath: string) {
    logger.debug("Starting Gerolamo with configPath:", configPath);
    try {
        // Load and validate config
        // const config = await loadConfig(configPath);
        const configFile = Bun.file(configPath);
        const config = await configFile.json();
        logger.debug("Config loaded:", config);

        // Start LMDB worker
        logger.debug("Starting LMDB worker...");
        lmdbWorker = startLmdbWorker();
        logger.debug("LMDB worker started");

        // Start PeerManager worker
        logger.debug("Starting PeerManager worker...");
        peerManagerWorker = await startPeerManager(config) as Worker;
        logger.debug("PeerManager worker started");

        // Start minibf worker if enabled
        if (config.minibf) {
            logger.debug("Starting minibf worker on port 3000...");
            await startMinibfWorker();
        } else {
            logger.debug("Minibf worker not started (disabled in config)");
        }
        logger.debug("Gerolamo node started successfully");

        process.on('SIGINT', async () => {
            logger.debug('Received SIGINT, Shutting down');
            peerManagerWorker.postMessage({ type: "shutdown" });
            peerManagerWorker.on("message", async (msg) => {
                if (msg.type === "shutdownComplete") {
                    try {
                        await closeDB();
                        logger.debug("LMDB worker closed");
                    } catch (error) {
                        logger.error(`Error closing LMDB worker: ${error}`);
                    }
                    process.exit(0);
                }
            });
        });

        process.on('SIGTERM', async () => {
            logger.debug('Received SIGTERM, Shutting down');
            peerManagerWorker.postMessage({ type: "shutdown" });
            peerManagerWorker.on("message", async (msg) => {
                if (msg.type === "shutdownComplete") {
                    try {
                        await closeDB();
                        logger.debug("LMDB worker closed");
                    } catch (error) {
                        logger.error(`Error closing LMDB worker: ${error}`);
                    }
                    process.exit(0);
                }
            });
        });
    } catch (error) {
        logger.error("Failed to start node:", error);
        process.exit(1);
    }
};

export function SyncNode() {
    program
        .command("start")
        .description("Start Gerolamo node:(bun src/index.ts --config ./src/config/preprod/config.json)")
        .option("--config <path>", "Path to config file")
        .action(async (options) => {
            await startNode(options.config);
        });
};

async function fetchLedgerState(cborDirPath: string) {
    console.log("Downloading ledger state snapshots to", cborDirPath);
    try {
        await fsPromises.stat(cborDirPath);
    } catch {
        await fsPromises.mkdir(cborDirPath);
    }

    await fetch(
        "https://raw.githubusercontent.com/pragma-org/amaru/0400aa073a02f0a8733e763433e87a6890335be2/data/preprod/snapshots.json",
    )
        .then((resp) => resp.json())
        .then((json) =>
            Promise.all(
                json.map(async ({ point, url }) =>
                    fetch(url as string).then((resp) => {
                        if (resp.body === null) {
                            throw new Error(`Response body for ${url} is null`);
                        } else {
                            const fullPath = path.join(
                                cborDirPath,
                                `${point}.cbor`,
                            );
                            // logger.info("writing snapshot to", fullPath);
                            return streamPromises.pipeline(
                                resp.body,
                                zlib.createGunzip(),
                                fs.createWriteStream(
                                    fullPath,
                                ),
                            );
                        }
                    })
                ),
            )
        );
}

export async function getCbor(cborFile: string, outputDirPath: string) {
    try {
        await fsPromises.stat(outputDirPath);
    } catch {
        await fsPromises.mkdir(outputDirPath);
    }

    const cbor = await fsPromises.readFile(cborFile);
    // const db = new Database(
    //     path.join(outputDirPath, "new_epoch_state.db"),
    // );
    RawNewEpochState.fromCborObj(Cbor.parse(cbor));

    // NewEpochState.bootstrap(db);
    // nes.put(db);
}

/*
export function Main() {
    console.log("Starting CLI");
    program.name("Gerolamo");

    program.option("--config <path>", "Path to config file", "./config.json");

    program
        .command("download-ledger-state")
        .description(
            "Download ledger state snapshots and write them decompressed to disk",
        )
        .argument(
            "<cborDirPath>",
            "path where to write the cbor files",
        )
        .action((cPath) => fetchLedgerState(path.normalize(cPath)));

    program
        .command("import-ledger-state")
        .description("Import and load ledger state snapshots into KVStore")
        .argument("<cborDirPath>")
        .argument("[topoFile]", undefined, path.normalize("./topology.json"))
        .argument("[outputDirPath]", undefined, path.normalize("./output"))
        .action(async (
            cborDirPath: string,
            _topoFile: string,
            outputDirPath: string,
        ) => {
            // logger.info("reading leger state from", cborDirPath);
            await getCbor(path.normalize(cborDirPath), outputDirPath);
        });

    program.command("init", "Initialize Gerolamo(not implement yet)").action(() => undefined);
}
*/

export { program };
