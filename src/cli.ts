import { program } from "commander";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { Cbor } from "@harmoniclabs/cbor";
import { SQLNewEpochState } from "./consensus/ledger";
import { SQL } from "bun";

export async function getCbor(cborFile: string, outputDirPath: string) {
    try {
        await fsPromises.stat(outputDirPath);
    } catch {
        await fsPromises.mkdir(outputDirPath);
    }

    const cbor = await fsPromises.readFile(cborFile);
    await SQLNewEpochState.fromCborObj(
        new SQL(path.join(outputDirPath, "nes.db")),
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

    program.command("init-node", "Initialize the node").action(() => undefined);
    program.parse(process.argv);
}
