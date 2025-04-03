import { program } from "commander";
import * as fs from "node:fs/promises";
import * as fSync from "node:fs";
import * as path from "node:path";

// import * as Node from "../node";
import {
    Cbor,
    CborArray,
    CborBytes,
    CborMap,
    CborNegInt,
    CborObj,
    CborTag,
    CborText,
    CborUInt,
} from "@harmoniclabs/cbor";
import { toHex } from "@harmoniclabs/uint8array-utils";

async function fetchLedgerState(cborDirPath: string) {
    const response = await fetch(
        "https://raw.githubusercontent.com/pragma-org/amaru/refs/heads/main/data/snapshots.json",
    );

    if (!response.ok) {
        throw new Error("Response is null");
    }

    if (!fSync.existsSync(cborDirPath)) {
        fSync.mkdirSync(cborDirPath);
    }

    await response.json().then((json) =>
        Promise.all(
            json.map(async ({ point, url }) =>
                fetch(url as string)
                    .then((response) => response.bytes())
                    .then((bytes) =>
                        fs.writeFile(
                            `./snapshots/${point as string}.cbor`,
                            bytes,
                        ),
                    ),
            ),
        ),
    );
}

function looksLikeUtxoRef(cbor: CborObj): cbor is CborArray {
    return (
        cbor instanceof CborArray &&
        cbor.array.length === 2 &&
        cbor.array[0] instanceof CborBytes &&
        cbor.array[1] instanceof CborUInt &&
        cbor.array[0].bytes.length === 32
    );
}

function jsonifyCborObj(cbor: CborObj): any {
    if (cbor instanceof CborUInt) return cbor.num.toString();
    if (cbor instanceof CborNegInt) return cbor.num.toString();
    if (cbor instanceof CborText) return cbor.text;
    if (cbor instanceof CborBytes) return toHex(cbor.bytes);
    if (cbor instanceof CborTag)
        return { tag: Number(cbor.tag), data: jsonifyCborObj(cbor.data) };
    if (cbor instanceof CborArray) return cbor.array.map(jsonifyCborObj);
    if (cbor instanceof CborMap) {
        const res = {};
        for (const { k: _k, v } of cbor.map) {
            let k: any = undefined;
            if (looksLikeUtxoRef(_k)) {
                k = `${toHex((_k as any).array[0].bytes)}#${(_k as any).array[1].num}`;
            } else k = jsonifyCborObj(_k);

            if (typeof k !== "string") k = JSON.stringify(k);
            (res as any)[k] = jsonifyCborObj(v);
        }
        return res;
    }

    return cbor.simple ?? null;
}

export function Main() {
    program.name("cardano-node-ts");

    // Can be faster for large snapshots, but suffers from buffer overflow
    program.command("download-ledger-state").action(fetchLedgerState);

    program
        .command("import-ledger-state")
        // .description("Import and load ledger state into KVStore"),
        .argument("<cborDirPath>")
        .argument("[topoFile]", undefined, "./topology.json")
        .action(async (cborDirPath: string, _topoFile: string) => {
            const cborData = fs.readdir(cborDirPath).then(async (filePaths) =>
                Promise.all(
                    filePaths
                        .filter((filePath) =>
                            path.extname(filePath).endsWith("cbor"),
                        )
                        .map((fPath) =>
                            path.normalize(path.join(cborDirPath, fPath)),
                        )
                        .map((fPath) =>
                            fs
                                .readFile(fPath, "utf-8")
                                .then((data) =>
                                    jsonifyCborObj(Cbor.parse(data)),
                                ),
                        )
                        .map((p, i) =>
                            p.then((data) =>
                                fs.writeFile(`./output/${i}.json`, data),
                            ),
                        ),
                ),
            );

            await (fSync.existsSync("./output")
                ? fs
                      .readdir("./output")
                      .then((paths) =>
                          Promise.all(
                              paths.map((path) =>
                                  fs.unlink(`./output/${path}`),
                              ),
                          ),
                      )
                : fs.mkdir("./output")
            ).then((_) => cborData);
        });

    program.command("init-node", "Initialize the node").action(() => undefined);

    program.parse(process.argv);
}
