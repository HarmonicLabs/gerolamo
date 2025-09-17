import { program } from "commander";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as streamPromises from "node:stream/promises";
import { Cbor } from "@harmoniclabs/cbor";
import { RawNewEpochState } from "./rawNES";
import { GerolamoConfig, PeerManager } from "./network/PeerManager";
// import { Database } from "bun:sqlite";
// import "./types/polyfills";
import { logger } from "./utils/logger";

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

export function Main() {
    console.log("Starting CLI");
    program.name("cardano-node-ts");

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

    program.command("init-node", "Initialize the node").action(() => undefined);
    program.parse(process.argv);
}

export function SyncNode() {
    logger.debug("Starting Gerolamo with config: ", process.argv);
    program.name("cardano-node-ts");

    program
        .command("start-node")
        .description("Start Gerolamo node with the specified config file")
        .argument("<configPath>", "Path to the config file (e.g., ./config.json)")
        .action(async (configPath: string) => {
            logger.debug("Starting node with configPath:", configPath);
            try {
                // Load and validate config
                // const config = await loadConfig(configPath);
                const configFile = Bun.file(configPath);
                const config = await configFile.json();
                // logger.debug("Config loaded:", config);

                // Initialize PeerManager
                const peerManager = new PeerManager();
                peerManager.config = config;
                logger.debug("Initializing PeerManager...");
                await peerManager.init();
                logger.debug("PeerManager initialized");

                // Start expressServer if enabled
                if (config.minibf) {
                    logger.debug("Starting express server...");
                    try {
                        await import("./network/minibf/expressServer");
                        logger.debug("Express server started on port 3000");
                    } catch (error) {
                        console.error("Failed to start express server:", error);
                        throw error;
                    }
                } else {
                    logger.debug("Express server not started (disabled in config)");
                }
                logger.debug("Gerolamo node started successfully");

                process.on('SIGINT', async () => {
                    logger.debug('Received SIGINT, Shutting down');
                    await peerManager.shutdown();
                    process.exit(0);
                });
                  
                process.on('SIGTERM', async () => {
                    logger.debug('Received SIGTERM, Shutting down');
                    await peerManager.shutdown();
                    process.exit(0);
                });
            } catch (error) {
                logger.error("Failed to start node:", error);
                process.exit(1);
            }
        });
}

SyncNode();
program.parse(process.argv);
