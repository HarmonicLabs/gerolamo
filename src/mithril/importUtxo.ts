/**
 * Snapshot bootstrap, phase B: the UTxO set of a Mithril ancillary ledger snapshot
 * (`ledger/<slot>/tables`, `utxohd-mem` codec version 1) → our `utxo` table.
 *
 * Each entry is a CBOR bstr pair whose payloads are MemPack (`decodeUtxoEntry`). Rather than
 * translating the decoded parts into rows by hand, every output is re-encoded as its Babbage
 * wire CBOR and handed to the applier's own parser and row builder (`TxOut.fromCbor`,
 * `buildUtxoRowForOutput`), so an imported row is byte-for-byte what the applier would have
 * written for that output: same JSON, same side columns, same typed stake key. The
 * `stake_balance` triggers on `utxo` maintain the balances as the rows land.
 */
import { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { decodeUtxoEntry, type CompactValueDecoded, type TxOutDecoded } from "../state/utxohdMemCodec";

const READ_CHUNK = 8 * 1024 * 1024;

type Hdr = { major: number; ai: number; len: number | null; next: number };
function readHdr(buf: Uint8Array, off: number): Hdr | null {
    if (off >= buf.length) return null;
    const b = buf[off]!, major = b >> 5, ai = b & 0x1f;
    let pos = off + 1, len: number | null = null;
    if (ai < 24) len = ai;
    else if (ai === 24) { if (pos >= buf.length) return null; len = buf[pos++]!; }
    else if (ai === 25) { if (pos + 2 > buf.length) return null; len = (buf[pos]! << 8) | buf[pos + 1]!; pos += 2; }
    else if (ai === 26) { if (pos + 4 > buf.length) return null; len = ((buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) >>> 0; pos += 4; }
    else if (ai === 27) { if (pos + 8 > buf.length) return null; len = Number(new DataView(buf.buffer, buf.byteOffset + pos, 8).getBigUint64(0)); pos += 8; }
    else if (ai === 31) len = null;
    else return null;
    return { major, ai, len, next: pos };
}

/** Stream the (key, value) byte pairs of a `tables` file: `[1] + map-indef of bstr → bstr`. */
export function streamTablesFile(path: string, onEntry: (key: Uint8Array, value: Uint8Array, index: number) => void, opts: { limit?: number } = {}): { entries: number; fileSize: number } {
    const fd = openSync(path, "r");
    const fileSize = fstatSync(fd).size;
    let fileOff = 0, buf = Buffer.alloc(0), eof = false, entries = 0;
    const refill = (need: number) => {
        while (buf.length < need && !eof) {
            const chunk = Buffer.alloc(READ_CHUNK);
            const n = readSync(fd, chunk, 0, READ_CHUNK, fileOff);
            if (n <= 0) { eof = true; break; }
            fileOff += n;
            buf = Buffer.concat([buf, chunk.subarray(0, n)]);
        }
    };
    const consume = (n: number) => { buf = buf.subarray(n); };
    try {
        refill(16);
        const top = readHdr(buf, 0);
        if (!top || top.major !== 4) throw new Error(`tables: top-level is not an array (major ${top?.major})`);
        const map = readHdr(buf, top.next);
        if (!map || map.major !== 5) throw new Error(`tables: not a map (major ${map?.major})`);
        consume(map.next);
        for (;;) {
            if (opts.limit != null && entries >= opts.limit) break;
            refill(16);
            if (buf.length === 0) break;
            const k = readHdr(buf, 0);
            if (!k) break;
            if (k.major === 7 && k.ai === 31) break; // map break
            if (k.major !== 2 || k.len == null) throw new Error(`tables: key is not a definite bstr at entry ${entries}`);
            const keyEnd = k.next + k.len;
            refill(keyEnd + 16);
            const v = readHdr(buf, keyEnd);
            if (!v || v.major !== 2 || v.len == null) throw new Error(`tables: value is not a definite bstr at entry ${entries}`);
            const valEnd = v.next + v.len;
            refill(valEnd);
            if (buf.length < valEnd) throw new Error(`tables: truncated at entry ${entries}`);
            onEntry(buf.subarray(k.next, keyEnd), buf.subarray(v.next, valEnd), entries);
            entries++;
            consume(valEnd);
        }
    } finally {
        closeSync(fd);
    }
    return { entries, fileSize };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Raw 57-byte base address of the AddrHash28 compact forms (tag 2/3): header ‖ payment28 ‖ stake28. */
export function addr28ToRaw(txOut: { stakeCred: "script" | "key"; payHashHex: string; addr28: Uint8Array }): Uint8Array {
    const a28 = Buffer.from(txOut.addr28);
    if (a28.length !== 32) throw new Error(`addr28 length ${a28.length}`);
    const a = a28.readBigUInt64LE(0), b = a28.readBigUInt64LE(8), c = a28.readBigUInt64LE(16), d = a28.readBigUInt64LE(24);
    const networkMain = (d & 2n) !== 0n, paymentKey = (d & 1n) !== 0n;
    const pay = Buffer.alloc(28);
    pay.writeBigUInt64BE(a, 0); pay.writeBigUInt64BE(b, 8); pay.writeBigUInt64BE(c, 16); pay.writeUInt32BE(Number(d >> 32n) >>> 0, 24);
    const stake = Buffer.from(txOut.payHashHex, "hex");
    if (stake.length !== 28) throw new Error(`stake hash length ${stake.length}`);
    let h = 0;
    if (networkMain) h |= 1;
    if (!paymentKey) h |= 1 << 4;
    if (txOut.stakeCred === "script") h |= 1 << 5;
    return Buffer.concat([Buffer.from([h]), pay, stake]);
}

function valueCbor(value: CompactValueDecoded): CborObj {
    if (value.kind === "ada") return new CborUInt(value.lovelace);
    const byPolicy = new Map<string, Array<{ name: string; qty: bigint }>>();
    for (const a of value.assets) {
        const l = byPolicy.get(a.policyIdHex) ?? [];
        l.push({ name: a.assetNameHex, qty: a.quantity });
        byPolicy.set(a.policyIdHex, l);
    }
    const policies: CborMap["map"] = [];
    for (const [pol, assets] of byPolicy) {
        policies.push({ k: new CborBytes(Buffer.from(pol, "hex")), v: new CborMap(assets.map((x) => ({ k: new CborBytes(Buffer.from(x.name, "hex")), v: new CborUInt(x.qty) }))) });
    }
    return new CborArray([new CborUInt(value.lovelace), new CborMap(policies)]);
}

/** The Babbage wire form of a decoded MemPack TxOut: {0: addr, 1: value, 2: datum, 3: #6.24(script)}. */
export function txOutWireCbor(t: TxOutDecoded): Uint8Array {
    const entries: CborMap["map"] = [];
    const put = (k: number, v: CborObj) => entries.push({ k: new CborUInt(k), v });
    // Narrow on `variant`: the codec's "unknown" member carries `tag: number`, which defeats a tag switch.
    switch (t.variant) {
        case "TxOutCompact": put(0, new CborBytes(t.addrRaw)); put(1, valueCbor(t.value)); break;
        case "TxOutCompactDH": put(0, new CborBytes(t.addrRaw)); put(1, valueCbor(t.value)); if (t.dataHashHex) put(2, new CborArray([new CborUInt(0), new CborBytes(Buffer.from(t.dataHashHex, "hex"))])); break;
        case "TxOut_AddrHash28_AdaOnly": put(0, new CborBytes(addr28ToRaw(t))); put(1, new CborUInt(t.lovelace)); break;
        case "TxOut_AddrHash28_AdaOnly_DataHash32": put(0, new CborBytes(addr28ToRaw(t))); put(1, new CborUInt(t.lovelace)); put(2, new CborArray([new CborUInt(0), new CborBytes(Buffer.from(t.dataHash32Hex, "hex"))])); break;
        case "TxOutCompactDatum": put(0, new CborBytes(t.addrRaw)); put(1, valueCbor(t.value)); put(2, new CborArray([new CborUInt(1), new CborTag(24, new CborBytes(t.inlineDatum))])); break;
        case "TxOutCompactRefScript": {
            put(0, new CborBytes(t.addrRaw)); put(1, valueCbor(t.value));
            if (t.datum.kind === "datumHash") put(2, new CborArray([new CborUInt(0), new CborBytes(Buffer.from(t.datum.hashHex, "hex"))]));
            else if (t.datum.kind === "inline") put(2, new CborArray([new CborUInt(1), new CborTag(24, new CborBytes(t.datum.bytes))]));
            // script_ref = #6.24(bytes .cbor script); script = [0, native] | [1, bytes] | [2, bytes] | [3, bytes]
            const script = t.script.kind === "native"
                ? new CborArray([new CborUInt(0), Cbor.parse(t.script.bytes)])
                : new CborArray([new CborUInt(t.script.language + 1), new CborBytes(t.script.bytes)]);
            put(3, new CborTag(24, new CborBytes(Cbor.encode(script).toBuffer())));
            break;
        }
        default: throw new Error(`unknown TxOut tag ${(t as any).tag}`);
    }
    return Cbor.encode(new CborMap(entries)).toBuffer();
}

export interface ImportUtxoOptions {
    tablesPath: string;
    /** Target database (must have our schema: run ensureInitialized on it first). */
    dbPath: string;
    batchSize?: number;
    limit?: number;
    log?: (m: string) => void;
}

export interface ImportUtxoResult {
    entries: number;
    inserted: number;
    errors: number;
    byTag: Record<number, number>;
    lovelace: bigint;
    seconds: number;
}

export async function importUtxoFromTables(opts: ImportUtxoOptions): Promise<ImportUtxoResult> {
    const log = opts.log ?? (() => {});
    const { buildUtxoRowForOutput } = await import("../db");
    const t0 = performance.now();
    const db = new Database(opts.dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 10000");
    const insert = db.prepare(`INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const result: ImportUtxoResult = { entries: 0, inserted: 0, errors: 0, byTag: {}, lovelace: 0n, seconds: 0 };
    const batchSize = opts.batchSize ?? 5000;
    let batch: unknown[][] = [];
    const flush = db.transaction((rows: unknown[][]) => { for (const r of rows) insert.run(...(r as any[])); });
    const errorsShown: string[] = [];
    const { entries } = streamTablesFile(opts.tablesPath, (key, val, index) => {
        result.entries++;
        const dec = decodeUtxoEntry(key, val);
        if (!dec.ok) { result.errors++; if (errorsShown.length < 10) errorsShown.push(`entry ${index}: ${dec.error} @${dec.off}`); return; }
        const { txIn, txOut } = dec.value;
        result.byTag[txOut.tag] = (result.byTag[txOut.tag] ?? 0) + 1;
        try {
            const wire = txOutWireCbor(txOut);
            const out = TxOut.fromCbor(wire);
            const txHash = txIn.txIdHex.toLowerCase();
            const row = buildUtxoRowForOutput(txHash, txIn.txIx, out);
            batch.push([row.utxoRef, row.txOutJson, txHash, row.cols.address ?? row.address, row.cols.lovelace ?? row.lovelace, row.cols.referenceScriptHash ?? null, row.cols.stakeKey ?? null]);
            result.lovelace += BigInt(row.lovelace);
            if (batch.length >= batchSize) { flush(batch); result.inserted += batch.length; batch = []; }
        } catch (err) {
            result.errors++;
            if (errorsShown.length < 10) errorsShown.push(`entry ${index} tag ${txOut.tag}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (result.entries % 250_000 === 0) log(`import-utxo: ${result.entries} entries, ${result.inserted} rows, ${result.errors} error(s), ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }, { limit: opts.limit });
    if (batch.length) { flush(batch); result.inserted += batch.length; batch = []; }
    // The stake balances are kept by triggers on `utxo`; `INSERT OR REPLACE` over rows that
    // already existed (a repeated import) fires the insert trigger without the delete one and
    // doubles them (preview phase E, 2026-09-10: 7.80 P vs 3.90 P). Rebuild them from the table.
    db.exec("DELETE FROM stake_balance; INSERT INTO stake_balance (stake_key, lovelace) SELECT stake_key, SUM(lovelace) FROM utxo WHERE stake_key IS NOT NULL GROUP BY stake_key");
    for (const e of errorsShown) log(`import-utxo error: ${e}`);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    result.seconds = (performance.now() - t0) / 1000;
    void entries;
    return result;
}
