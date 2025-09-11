import { program } from "commander";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as streamPromises from "node:stream/promises";
import { Cbor } from "@harmoniclabs/cbor";

import { RawNewEpochState } from "./rawNES";
// import { Database } from "bun:sqlite";
// import "./types/polyfills";
// import { logger } from "./utils/logger";

async function fetchLedgerState(cborDirPath: string) {
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
