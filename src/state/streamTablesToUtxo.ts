/**
 * A2 stream tables → Gerolamo `utxo` rows.
 *
 * Streams CBOR indefinite map from utxohd-mem `tables` file without full unwrap.
 * Inserts fully-decoded entries we can address:
 *   - tag0 TxOutCompact (ada + multiAsset) via CompactAddr → bech32
 *   - tag1 TxOutCompactDH: same as tag0 + datum_hash (32B DataHash)
 *   - tag2 AddrHash28_AdaOnly via PackedBytes28 BE rebuild → bech32
 *   - tag3 AddrHash28_AdaOnly_DataHash32: same as tag2 + datum_hash
 *   - tag4 TxOutCompactDatum: same value fields + optional inline_datum hex
 *   - tag5 TxOutCompactRefScript: same value fields + datum/script metadata
 *
 * Honesty:
 *   - datum/script bodies stored as opaque hex/len — no Plutus interpreter
 *   - skips only decode failures / non-fullyConsumed envelopes
 *   - `utxoExtracted` is true when stream finishes without hard fail AND inserted > 0
 *   - does not claim checksum verify of full 940MB tables
 *
 * DB shape matches apply path:
 *   utxo_ref = `${txHash}:${txIx}`
 *   tx_out   = JSON { address, amount, assets, ...optional datum/script meta }
 *   tx_hash  = hex tx id
 */

import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { BACKFILL_UTXO_COLUMNS_SQL } from "../db";
import { Database } from "bun:sqlite";
import { Address, Script } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import {
    decodeUtxoEntry,
    type CompactValueDecoded,
    type MultiAssetTriple,
    type TxOutDecoded,
} from "./utxohdMemCodec";

// ── CBOR header (tables envelope) ───────────────────────────────────────────

type CborHdr = {
    major: number;
    ai: number;
    len: number | null;
    next: number;
};

function readCborHdr(buf: Uint8Array, off: number): CborHdr | null {
    if (off >= buf.length) return null;
    const b = buf[off]!;
    const major = b >> 5;
    const ai = b & 0x1f;
    let pos = off + 1;
    let len: number | null = null;
    if (ai < 24) len = ai;
    else if (ai === 24) {
        if (pos >= buf.length) return null;
        len = buf[pos++]!;
    } else if (ai === 25) {
        if (pos + 2 > buf.length) return null;
        len = (buf[pos]! << 8) | buf[pos + 1]!;
        pos += 2;
    } else if (ai === 26) {
        if (pos + 4 > buf.length) return null;
        len =
            ((buf[pos]! << 24) |
                (buf[pos + 1]! << 16) |
                (buf[pos + 2]! << 8) |
                buf[pos + 3]!) >>>
            0;
        pos += 4;
    } else if (ai === 27) {
        if (pos + 8 > buf.length) return null;
        const hi =
            ((buf[pos]! << 24) |
                (buf[pos + 1]! << 16) |
                (buf[pos + 2]! << 8) |
                buf[pos + 3]!) >>>
            0;
        const lo =
            ((buf[pos + 4]! << 24) |
                (buf[pos + 5]! << 16) |
                (buf[pos + 6]! << 8) |
                buf[pos + 7]!) >>>
            0;
        pos += 8;
        len = hi * 2 ** 32 + lo;
    } else if (ai === 31) {
        len = -1; // indefinite
    } else {
        return null;
    }
    return { major, ai, len, next: pos };
}

// ── Address rebuild ─────────────────────────────────────────────────────────

/**
 * tag2 Addr28Extra is MemPack 4× host-LE Word64 on disk.
 * PackedBytes28 unpacks as BE Word64×3 + BE Word32 (payment hash).
 * Credential before Addr28 is the **stake** credential (field misnamed payHashHex in codec).
 */
export function tag2Addr28ToBech32(txOut: {
    stakeCred: "script" | "key";
    payHashHex: string;
    addr28: Uint8Array;
}): string {
    if (txOut.addr28.length !== 32) {
        throw new Error(`addr28 len ${txOut.addr28.length} !== 32`);
    }
    const a28 = Buffer.from(txOut.addr28);
    const a = a28.readBigUInt64LE(0);
    const b = a28.readBigUInt64LE(8);
    const c = a28.readBigUInt64LE(16);
    const d = a28.readBigUInt64LE(24);
    const networkMain = (d & 2n) !== 0n;
    const paymentKey = (d & 1n) !== 0n;
    const w3hi = Number(d >> 32n) >>> 0;

    const pay = Buffer.alloc(28);
    pay.writeBigUInt64BE(a, 0);
    pay.writeBigUInt64BE(b, 8);
    pay.writeBigUInt64BE(c, 16);
    pay.writeUInt32BE(w3hi, 24);

    const stakeHash = Buffer.from(txOut.payHashHex, "hex");
    if (stakeHash.length !== 28) {
        throw new Error(`stake hash len ${stakeHash.length}`);
    }
    const stakeIsScript = txOut.stakeCred === "script";

    // CompactAddr base: header | pay28 | stake28
    let h = 0;
    if (networkMain) h |= 1;
    if (!paymentKey) h |= 1 << 4;
    if (stakeIsScript) h |= 1 << 5;
    const raw = Buffer.concat([Buffer.from([h]), pay, stakeHash]);
    return Address.fromBytes(raw).toString();
}

export function compactAddrRawToBech32(addrRaw: Uint8Array): string {
    return Address.fromBytes(addrRaw).toString();
}

// ── tx_out JSON ─────────────────────────────────────────────────────────────

export type TxOutJson = {
    address: string;
    amount: string;
    assets: Record<string, Record<string, string>>;
    /** Present for tag4/5 when fullyConsumed. Opaque — not interpreted. */
    inline_datum?: string;
    datum_hash?: string;
    /** tag5: native | plutus */
    script_kind?: "native" | "plutus";
    script_language?: number;
    script_bytes_hex?: string;
    script_bytes_len?: number;
    reference_script_hash?: string;
    reference_script_cbor?: string;
};

function assetsFromTriples(
    assets: MultiAssetTriple[],
): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const a of assets) {
        const pol = a.policyIdHex;
        if (!out[pol]) out[pol] = {};
        out[pol]![a.assetNameHex] = a.quantity.toString();
    }
    return out;
}

function valueToAmountAssets(value: CompactValueDecoded): {
    amount: string;
    assets: Record<string, Record<string, string>>;
} {
    if (value.kind === "ada") {
        return { amount: value.lovelace.toString(), assets: {} };
    }
    return {
        amount: value.lovelace.toString(),
        assets: assetsFromTriples(value.assets),
    };
}

/**
 * Map a fully-decoded TxOut to DB row fields, or null if not insertable yet.
 * tag0–5 when fullyConsumed + addressable.
 */
export function txOutToDbRow(
    txIdHex: string,
    txIx: number,
    txOut: TxOutDecoded,
): { utxoRef: string; txOutJson: string; txHash: string } | null {
    let address: string | null = null;
    let amount = "0";
    let assets: Record<string, Record<string, string>> = {};
    const meta: Partial<TxOutJson> = {};

    if (
        (txOut.tag === 0 ||
            txOut.tag === 1 ||
            txOut.tag === 4 ||
            txOut.tag === 5) &&
        txOut.fullyConsumed &&
        txOut.addrRaw
    ) {
        try {
            address = compactAddrRawToBech32(txOut.addrRaw);
        } catch {
            return null;
        }
        const va = valueToAmountAssets(txOut.value);
        amount = va.amount;
        assets = va.assets;

        if (txOut.tag === 1) {
            // Compact + DataHash (32B) — only insert when hash was consumed
            if (!txOut.dataHashHex) return null;
            meta.datum_hash = txOut.dataHashHex;
        } else if (txOut.tag === 4) {
            // opaque inline BinaryData (Plutus Data CBOR)
            meta.inline_datum = Buffer.from(txOut.inlineDatum).toString("hex");
        } else if (txOut.tag === 5) {
            if (txOut.datum.kind === "datumHash") {
                meta.datum_hash = txOut.datum.hashHex;
            } else if (txOut.datum.kind === "inline") {
                meta.inline_datum = Buffer.from(txOut.datum.bytes).toString(
                    "hex",
                );
            }
            // kind === "noDatum" → no meta field
            meta.script_kind = txOut.script.kind;
            if (txOut.script.kind === "plutus") {
                meta.script_language = txOut.script.language;
            }
            meta.script_bytes_hex = Buffer.from(txOut.script.bytes).toString(
                "hex",
            );
            meta.script_bytes_len = txOut.script.bytes.length;
            const script = txOut.script.kind === "native"
                ? new Script("NativeScript", txOut.script.bytes)
                : txOut.script.language === 0
                    ? Script.plutusV1(txOut.script.bytes)
                    : txOut.script.language === 1
                        ? Script.plutusV2(txOut.script.bytes)
                        : txOut.script.language === 2
                            ? Script.plutusV3(txOut.script.bytes)
                            : txOut.script.language === 3
                                ? Script.plutusV4(txOut.script.bytes)
                                : null;
            if (script) {
                meta.reference_script_hash = script.hash.toString();
                meta.reference_script_cbor = toHex(script.cbor);
            }
        }
    } else if (
        (txOut.tag === 2 || txOut.tag === 3) &&
        txOut.fullyConsumed
    ) {
        try {
            address = tag2Addr28ToBech32(txOut);
        } catch {
            return null;
        }
        amount = txOut.lovelace.toString();
        assets = {};
        if (txOut.tag === 3) {
            meta.datum_hash = txOut.dataHash32Hex;
        }
    } else {
        return null;
    }

    if (!address || address.length < 10) return null;

    const txOutJson = JSON.stringify({
        address,
        amount,
        assets,
        ...meta,
    } satisfies TxOutJson);

    return {
        utxoRef: `${txIdHex}:${txIx}`,
        txOutJson,
        txHash: txIdHex,
    };
}

// ── Streaming apply ─────────────────────────────────────────────────────────

export type StreamTablesToUtxoOpts = {
    tablesPath: string;
    dbPath: string;
    /** Max map entries to scan (smoke). Omit = full file. */
    limit?: number;
    /** Rows per SQLite transaction (default 2000). */
    batchSize?: number;
    /** Log every N scanned entries (default 50000). */
    logEvery?: number;
    logger?: { info: (m: string) => void; warn: (m: string) => void };
};

export type StreamTablesToUtxoResult = {
    tablesPath: string;
    dbPath: string;
    fileSize: number;
    scanned: number;
    inserted: number;
    skipped: number;
    decodeErrors: number;
    byTag: Record<number, number>;
    insertedByTag: Record<number, number>;
    /** True only if stream finished and inserted > 0 (still partial vs full ledger). */
    utxoExtracted: boolean;
    /** Partial: only tag0/2 fully-consumed rows. */
    partial: true;
    elapsedMs: number;
};

const READ_CHUNK = 4 * 1024 * 1024; // 4MB sliding window refill

/**
 * Stream `tables` CBOR map into SQLite `utxo`.
 * Uses bun:sqlite directly (batched transactions) — single writer on dbPath.
 */
export function streamTablesToUtxo(
    opts: StreamTablesToUtxoOpts,
): StreamTablesToUtxoResult {
    const log = opts.logger ?? {
        info: (m: string) => console.log(m),
        warn: (m: string) => console.warn(m),
    };
    const batchSize = opts.batchSize ?? 2000;
    const logEvery = opts.logEvery ?? 50_000;
    const limit = opts.limit;

    const t0 = Date.now();
    const fd = openSync(opts.tablesPath, "r");
    const fileSize = fstatSync(fd).size;

    const db = new Database(opts.dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(
        `CREATE TABLE IF NOT EXISTS utxo (
            utxo_ref TEXT PRIMARY KEY,
            tx_out TEXT,
            tx_hash TEXT,
            address TEXT,
            lovelace INTEGER,
            reference_script_hash TEXT
        )`,
    );
    const insertStmt = db.prepare(
        `INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash) VALUES (?, ?, ?)`,
    );

    const result: StreamTablesToUtxoResult = {
        tablesPath: opts.tablesPath,
        dbPath: opts.dbPath,
        fileSize,
        scanned: 0,
        inserted: 0,
        skipped: 0,
        decodeErrors: 0,
        byTag: {},
        insertedByTag: {},
        utxoExtracted: false,
        partial: true,
        elapsedMs: 0,
    };

    // Sliding buffer over the file
    let fileOff = 0;
    let buf = Buffer.alloc(0);
    let eof = false;

    const refill = (need: number) => {
        while (buf.length < need && !eof) {
            const chunk = Buffer.alloc(READ_CHUNK);
            const n = readSync(fd, chunk, 0, READ_CHUNK, fileOff);
            if (n <= 0) {
                eof = true;
                break;
            }
            fileOff += n;
            buf = Buffer.concat([buf, chunk.subarray(0, n)]);
        }
    };

    const consume = (n: number) => {
        buf = buf.subarray(n);
    };

    try {
        // Need at least envelope header
        refill(16);
        let off = 0;
        const top = readCborHdr(buf, off);
        if (!top || top.major !== 4) {
            throw new Error(
                `tables top not array: major=${top?.major ?? "null"}`,
            );
        }
        off = top.next;
        const map = readCborHdr(buf, off);
        if (!map || map.major !== 5) {
            throw new Error(
                `tables map not map: major=${map?.major ?? "null"}`,
            );
        }
        off = map.next;
        consume(off);
        off = 0;

        type Row = [string, string, string];
        let batch: Row[] = [];

        const flush = db.transaction((rows: Row[]) => {
            for (const r of rows) insertStmt.run(r[0], r[1], r[2]);
        });

        const flushBatch = () => {
            if (batch.length === 0) return;
            flush(batch);
            result.inserted += batch.length;
            batch = [];
        };

        log.info(
            `streamTablesToUtxo: file=${opts.tablesPath} size=${fileSize} ` +
                `db=${opts.dbPath} limit=${limit ?? "full"} batch=${batchSize}`,
        );

        while (true) {
            if (limit != null && result.scanned >= limit) break;

            // Ensure we have header bytes
            refill(16);
            if (buf.length < 1) break;

            const kHdr = readCborHdr(buf, 0);
            if (!kHdr) break;
            // break marker
            if (kHdr.major === 7 && kHdr.ai === 31) {
                consume(kHdr.next);
                break;
            }
            if (kHdr.major !== 2 || kHdr.len == null || kHdr.len < 0) {
                log.warn(
                    `streamTablesToUtxo: unexpected key hdr major=${kHdr.major} ai=${kHdr.ai} at scanned=${result.scanned}`,
                );
                break;
            }

            const keyTotal = kHdr.next + kHdr.len;
            refill(keyTotal + 16);
            if (buf.length < keyTotal + 1) {
                // truncated
                break;
            }
            const key = buf.subarray(kHdr.next, kHdr.next + kHdr.len);

            // readCborHdr(buf, keyTotal) → vHdr.next is absolute index in buf
            const vHdr = readCborHdr(buf, keyTotal);
            if (!vHdr || vHdr.major !== 2 || vHdr.len == null || vHdr.len < 0) {
                log.warn(
                    `streamTablesToUtxo: bad value hdr at scanned=${result.scanned}`,
                );
                break;
            }
            const valAbsStart = vHdr.next;
            const valAbsEnd = vHdr.next + vHdr.len;
            const entryEnd = valAbsEnd;

            refill(entryEnd);
            if (buf.length < entryEnd) break;

            const val = buf.subarray(valAbsStart, valAbsEnd);
            consume(entryEnd);

            result.scanned++;
            const entry = decodeUtxoEntry(key, val);
            if (!entry.ok) {
                result.decodeErrors++;
                result.skipped++;
                continue;
            }

            const tag =
                typeof entry.value.txOut.tag === "number"
                    ? entry.value.txOut.tag
                    : -1;
            result.byTag[tag] = (result.byTag[tag] ?? 0) + 1;

            const row = txOutToDbRow(
                entry.value.txIn.txIdHex,
                entry.value.txIn.txIx,
                entry.value.txOut,
            );
            if (!row) {
                result.skipped++;
                continue;
            }

            batch.push([row.utxoRef, row.txOutJson, row.txHash]);
            result.insertedByTag[tag] = (result.insertedByTag[tag] ?? 0) + 1;

            if (batch.length >= batchSize) flushBatch();

            if (result.scanned % logEvery === 0) {
                log.info(
                    `streamTablesToUtxo: scanned=${result.scanned} inserted=${result.inserted + batch.length} ` +
                        `skipped=${result.skipped} errors=${result.decodeErrors}`,
                );
            }
        }

        flushBatch();

        // utxoExtracted: stream completed (hit limit or natural end) with inserts
        result.utxoExtracted = result.inserted > 0;
        result.elapsedMs = Date.now() - t0;

        log.info(
            `streamTablesToUtxo complete scanned=${result.scanned} inserted=${result.inserted} ` +
                `skipped=${result.skipped} errors=${result.decodeErrors} ` +
                `utxoExtracted=${result.utxoExtracted} partial=true elapsedMs=${result.elapsedMs}`,
        );
    } finally {
        closeSync(fd);
        // Indexed side columns (address / lovelace / reference script) beside the JSON.
        db.exec(BACKFILL_UTXO_COLUMNS_SQL);
        db.close();
    }

    return result;
}
