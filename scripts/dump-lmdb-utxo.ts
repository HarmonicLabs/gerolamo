/**
 * dump-lmdb-utxo.ts — Extract UTxO entries from an LMDB snapshot using Bun FFI
 *
 * Uses lmdb-ffi.ts (Bun FFI bindings to liblmdb) instead of spawning a
 * separate C binary. Reads all key-value pairs, detects 34-byte UTxO keys
 * (32-byte tx hash + 2-byte LE output index), attempts CBOR decode, and
 * writes NDJSON output.
 *
 * Usage:
 *   bun run scripts/dump-lmdb-utxo.ts [lmdb-dir]
 *   Default: db/tmp/snapshots/118971022_lmdb/tables/
 */
import { Cbor, CborArray, CborMap, CborBytes, CborUInt, CborNegInt, CborText, CborSimple, CborTag } from "@harmoniclabs/cbor";
import type { CborObj } from "@harmoniclabs/cbor";
import { mkdirSync, existsSync } from "fs";
import { iterateLmdb } from "./lmdb-ffi.ts";

const args = process.argv.slice(2);
const DB_DIR = args[0]
    ? args[0]
    : new URL("../db/tmp/snapshots/118971022_lmdb/tables/", import.meta.url).pathname;
const OUTPUT_DIR = new URL("./output/", import.meta.url).pathname;
const OUTPUT_FILE = OUTPUT_DIR + "lmdb-utxo.ndjson";

function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString("hex");
}

function cborToJson(obj: CborObj): any {
    if (obj instanceof CborUInt) return obj.num.toString();
    if (obj instanceof CborNegInt) return obj.num.toString();
    if (obj instanceof CborBytes) return toHex(obj.bytes);
    if (obj instanceof CborText) return obj.text;
    if (obj instanceof CborSimple) return obj.simple;
    if (obj instanceof CborArray) return obj.array.map(cborToJson);
    if (obj instanceof CborMap) {
        const result: Record<string, any> = {};
        for (const { k, v } of obj.map) {
            const key = (k instanceof CborText) ? k.text
                : (k instanceof CborUInt) ? k.num.toString()
                : (k instanceof CborBytes) ? toHex(k.bytes)
                : JSON.stringify(cborToJson(k));
            result[key] = cborToJson(v);
        }
        return result;
    }
    if (obj instanceof CborTag) return { tag: obj.tag.toString(), data: cborToJson(obj.data) };
    return null;
}

function main() {
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

    console.log("Reading LMDB via FFI:", DB_DIR);
    const outFile = Bun.file(OUTPUT_FILE).writer();
    let totalEntries = 0;

    const { databases } = iterateLmdb(DB_DIR, ({ dbName, key, value }) => {
        const keyHex = toHex(key);
        const valHex = toHex(value);

        const entry: any = {
            db: dbName,
            rawKey: keyHex,
        };

        // UTxO keys are 34 bytes: 32-byte tx hash + 2-byte LE output index
        if (key.length === 34) {
            entry.txHash = keyHex.substring(0, 64);
            entry.outputIndex = key[32] | (key[33] << 8);
        }

        // Try CBOR decode the value (only accept if it consumes most of the buffer)
        try {
            const { parsed, offset: consumed } = Cbor.parseWithOffset(value);
            if (consumed >= value.length - 1) {
                entry.decodedValue = cborToJson(parsed);
            } else {
                entry.rawValue = valHex;
                entry.cborPartial = { consumed, totalSize: value.length, firstItem: cborToJson(parsed) };
            }
        } catch {
            entry.rawValue = valHex;
        }

        outFile.write(JSON.stringify(entry) + "\n");
        totalEntries++;

        if (totalEntries % 100000 === 0) {
            console.log(`  ... ${totalEntries} entries processed`);
            outFile.flush();
        }
    }, {
        onProgress: (db, count) => console.log(`  ${db}: ${count} entries`),
    });

    outFile.flush();
    outFile.end();

    console.log(`\nDone! Total entries: ${totalEntries}`);
    console.log(`Databases found: ${databases.join(", ")}`);
    console.log(`Output: ${OUTPUT_FILE}`);
}

main();
