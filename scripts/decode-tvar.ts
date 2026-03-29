import { mkdirSync, existsSync } from "fs";

const args = process.argv.slice(2);
const TVAR_PATH = args[0]
    ? args[0]
    : new URL("../db/ledger/118971022/tables/tvar", import.meta.url).pathname;
const OUTPUT_DIR = new URL("./output/", import.meta.url).pathname;
const OUTPUT_FILE = OUTPUT_DIR + "tvar-decoded.ndjson";
const STRUCTURE_FILE = OUTPUT_DIR + "tvar-structure.json";

function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString("hex");
}

// Minimal streaming CBOR reader for the TVAR file structure:
// array(1) -> indefinite-map -> entries of (bytes key, bytes value)
class CborReader {
    private data: Uint8Array;
    private pos: number;

    constructor(data: Uint8Array) {
        this.data = data;
        this.pos = 0;
    }

    get offset() { return this.pos; }
    get remaining() { return this.data.length - this.pos; }

    readU8(): number {
        if (this.pos >= this.data.length) throw new Error(`Read past end of buffer at offset ${this.pos}`);
        return this.data[this.pos++];
    }

    readU16(): number {
        const v = (this.data[this.pos] << 8) | this.data[this.pos + 1];
        this.pos += 2;
        return v;
    }

    readU32(): number {
        const dv = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4);
        this.pos += 4;
        return dv.getUint32(0);
    }

    readU64(): bigint {
        const dv = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8);
        this.pos += 8;
        return dv.getBigUint64(0);
    }

    readBytes(n: number): Uint8Array {
        if (this.pos + n > this.data.length) throw new Error(`Read ${n} bytes past end at offset ${this.pos}, remaining ${this.remaining}`);
        const slice = this.data.subarray(this.pos, this.pos + n);
        this.pos += n;
        return slice;
    }

    peekU8(): number {
        if (this.pos >= this.data.length) throw new Error(`Peek past end of buffer at offset ${this.pos}`);
        return this.data[this.pos];
    }

    // Read a CBOR "argument" (the additional info after major type)
    readCborArg(additionalInfo: number): number | bigint {
        if (additionalInfo < 24) return additionalInfo;
        if (additionalInfo === 24) return this.readU8();
        if (additionalInfo === 25) return this.readU16();
        if (additionalInfo === 26) return this.readU32();
        if (additionalInfo === 27) return this.readU64();
        if (additionalInfo === 31) return -1; // indefinite length
        throw new Error(`Unsupported CBOR additional info: ${additionalInfo} at offset ${this.pos}`);
    }

    // Read a CBOR header: returns [majorType, argument]
    readHeader(): [number, number | bigint] {
        const byte = this.readU8();
        const majorType = byte >> 5;
        const additionalInfo = byte & 0x1f;
        const arg = this.readCborArg(additionalInfo);
        return [majorType, arg];
    }

    // Skip over a complete CBOR item
    skipItem(): void {
        const [majorType, arg] = this.readHeader();
        switch (majorType) {
            case 0: // unsigned int
            case 1: // negative int
                break;
            case 2: // byte string
            case 3: // text string
                if (arg === -1 || arg === BigInt(-1)) {
                    // indefinite length - skip chunks until break
                    while (this.peekU8() !== 0xff) this.skipItem();
                    this.readU8(); // consume break
                } else {
                    this.pos += Number(arg);
                }
                break;
            case 4: // array
                if (arg === -1 || arg === BigInt(-1)) {
                    while (this.peekU8() !== 0xff) this.skipItem();
                    this.readU8();
                } else {
                    const len = Number(arg);
                    for (let i = 0; i < len; i++) this.skipItem();
                }
                break;
            case 5: // map
                if (arg === -1 || arg === BigInt(-1)) {
                    while (this.peekU8() !== 0xff) {
                        this.skipItem(); // key
                        this.skipItem(); // value
                    }
                    this.readU8();
                } else {
                    const len = Number(arg);
                    for (let i = 0; i < len; i++) {
                        this.skipItem(); // key
                        this.skipItem(); // value
                    }
                }
                break;
            case 6: // tag
                this.skipItem(); // tagged value
                break;
            case 7: // simple/float
                break;
        }
    }
}

async function main() {
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

    console.log("Reading TVAR file:", TVAR_PATH);
    const fileData = await Bun.file(TVAR_PATH).arrayBuffer();
    const data = new Uint8Array(fileData);
    console.log(`File size: ${(data.length / (1024 * 1024)).toFixed(1)} MB`);

    const reader = new CborReader(data);

    // Read outer array header: should be array(1)
    const [outerType, outerLen] = reader.readHeader();
    console.log(`Outer: major type ${outerType}, length ${outerLen}`);
    if (outerType !== 4) throw new Error(`Expected array (major type 4), got ${outerType}`);

    // Read map header: should be indefinite-length map (bf)
    const [mapType, mapLen] = reader.readHeader();
    const isIndefinite = mapLen === -1 || mapLen === BigInt(-1);
    console.log(`Map: major type ${mapType}, ${isIndefinite ? "indefinite length" : `length ${mapLen}`}`);
    if (mapType !== 5) throw new Error(`Expected map (major type 5), got ${mapType}`);

    // Iterate map entries, writing NDJSON
    const outFile = Bun.file(OUTPUT_FILE).writer();
    let entryCount = 0;
    let sampleEntries: any[] = [];

    while (true) {
        // Check for break byte (end of indefinite map)
        if (isIndefinite && reader.peekU8() === 0xff) {
            reader.readU8();
            break;
        }
        // For definite-length maps, check count
        if (!isIndefinite && entryCount >= Number(mapLen)) break;

        // Read key
        const [keyType, keyLen] = reader.readHeader();
        if (keyType !== 2) throw new Error(`Expected bytes key (major type 2), got ${keyType} at entry ${entryCount}`);
        const keyBytes = reader.readBytes(Number(keyLen));

        // Read value
        const [valType, valLen] = reader.readHeader();
        let valBytes: Uint8Array;
        if (valType === 2) {
            valBytes = reader.readBytes(Number(valLen));
        } else {
            // Non-bytes value — skip it and record type info
            // Back up and skip the whole item
            // Actually we already consumed the header, so handle inline
            const valHex = `type${valType}:${valLen}`;
            const entry: any = {
                rawKey: toHex(keyBytes),
                rawValue: valHex,
            };
            if (keyBytes.length === 34) {
                entry.txHash = toHex(keyBytes.slice(0, 32));
                entry.outputIndex = keyBytes[32] | (keyBytes[33] << 8);
            }
            outFile.write(JSON.stringify(entry) + "\n");
            entryCount++;
            continue;
        }

        const entry: any = {
            rawKey: toHex(keyBytes),
            rawValue: toHex(valBytes),
        };

        if (keyBytes.length === 34) {
            entry.txHash = toHex(keyBytes.slice(0, 32));
            entry.outputIndex = keyBytes[32] | (keyBytes[33] << 8);
        }

        outFile.write(JSON.stringify(entry) + "\n");

        if (entryCount < 5) sampleEntries.push(entry);
        entryCount++;

        if (entryCount % 100000 === 0) {
            console.log(`  ... ${entryCount} entries processed (offset: ${(reader.offset / (1024 * 1024)).toFixed(1)} MB)`);
            outFile.flush();
        }
    }

    outFile.flush();
    outFile.end();

    // Write structure summary
    const structure = {
        fileSize: data.length,
        outerType: `array(${outerLen})`,
        mapType: isIndefinite ? "indefinite-map" : `map(${mapLen})`,
        totalEntries: entryCount,
        sampleEntries,
        remainingBytes: reader.remaining,
    };
    await Bun.write(STRUCTURE_FILE, JSON.stringify(structure, null, 2));

    console.log(`\nDone! Total entries: ${entryCount}`);
    console.log(`Output: ${OUTPUT_FILE}`);
    console.log(`Structure: ${STRUCTURE_FILE}`);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
