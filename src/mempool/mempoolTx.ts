/**
 * A transaction as the mempool holds it: the bytes as submitted, the ledger-ts objects the rule
 * functions read (`body`, `witnessSet`), the original slices (body, witness set, auxiliary data,
 * each output, the collateral return) and the few body fields ledger-ts drops or reshapes.
 *
 * The id is blake2b-256 of the body bytes as submitted (not of the whole transaction).
 */
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { ConwayTx, DijkstraTx } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { utxoRefOf } from "../consensus/rules/resolvedUtxo";

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

export interface MempoolTx {
    bytes: Uint8Array;
    /** Ledger era of the transaction (7 Conway, 8 Dijkstra). */
    era: number;
    /** blake2b-256 of the body bytes (hex). Conway tx id; Dijkstra `hashTx` over the block form. */
    txId: string;
    txIdBytes: Uint8Array;
    /** blake2b-256 of the body bytes (the id witnesses sign; Dijkstra `hashTx` is the block form). */
    bodyHashBytes: Uint8Array;
    /** Dijkstra: the canonical `[body, wits, aux, is_valid]` block transaction and its `hashTx`. */
    blockBytes: Uint8Array;
    blockTxIdBytes: Uint8Array;
    /** Dijkstra sub-transactions (`[sub_body, wits, aux]`), empty for Conway. */
    subTransactions: any[];
    body: any;
    witnessSet: any;
    isValid: boolean;
    bodyBytes: Uint8Array;
    witnessSetBytes: Uint8Array;
    /** Auxiliary data bytes, or null when the slot holds CBOR null. */
    auxBytes: Uint8Array | null;
    /** Bytes as submitted. */
    wireSize: number;
    /**
     * The ledger's `sizeTxF`, priced by the minimum fee and bounded by `maxTxSize`: the
     * submitted bytes minus the isValid flag (relay captures: a 119-byte tx is priced as 118,
     * a 20 127-byte one fails MaxTxSizeUTxO with 20 126).
     */
    size: number;
    /** Original bytes of each output, then of the collateral return (for min-UTxO sizing). */
    outputSlices: Uint8Array[];
    collateralReturnSlice: Uint8Array | null;
    /** Body fields read from the bytes: ledger-ts drops `total_collateral` (inverted guard in ConwayTxBody). */
    totalCollateral: bigint | null;
    networkId: number | null;
    auxDataHash: string | null;
    scriptDataHash: string | null;
    currentTreasuryValue: bigint | null;
    /** Withdrawals in body order: reward account bytes, amount, and its credential. */
    withdrawals: Array<{ account: Uint8Array; amount: bigint; credType: 0 | 1; credHex: string }>;
    /** Spending inputs / collateral / reference inputs as `txid:ix`. */
    inputs: string[];
    collateral: string[];
    refInputs: string[];
}

/** Byte slice of every element of a top-level array/map payload (definite or indefinite). */
function itemSlices(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    const ib = bytes[0]!;
    const mt = ib >> 5, ai = ib & 31;
    let i = 1, n = -1;
    if (ai < 24) n = ai;
    else if (ai === 24) { n = bytes[1]!; i = 2; }
    else if (ai === 25) { n = (bytes[1]! << 8) | bytes[2]!; i = 3; }
    else if (ai === 26) { n = Number(new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0)); i = 5; }
    else if (ai === 31) n = -1;
    else throw new Error("unsupported CBOR length");
    const count = mt === 5 ? (n < 0 ? -1 : n * 2) : n;
    for (let k = 0; count < 0 ? bytes[i] !== 0xff : k < count; k++) {
        const { offset } = Cbor.parseWithOffset(bytes.subarray(i));
        out.push(bytes.subarray(i, i + offset));
        i += offset;
    }
    return out;
}

const refsOf = (list: any[] | undefined): string[] => (list ?? []).map((i) => utxoRefOf(i)).filter((r): r is string => !!r);

export function parseConwayMempoolTx(bytes: Uint8Array): MempoolTx {
    if (bytes[0] !== 0x84) throw new Error("not a 4-element Alonzo+ transaction");
    const parts = itemSlices(bytes);
    if (parts.length !== 4) throw new Error(`transaction has ${parts.length} elements, expected 4`);
    const [bodyBytes, witnessSetBytes, validBytes, auxRaw] = parts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const isValid = validBytes.length === 1 && validBytes[0] === 0xf5;
    if (!(validBytes.length === 1 && (validBytes[0] === 0xf5 || validBytes[0] === 0xf4))) throw new Error("isValid flag is not a boolean");
    const auxBytes = auxRaw.length === 1 && auxRaw[0] === 0xf6 ? null : auxRaw;
    const tx: any = ConwayTx.fromCbor(bytes);
    const txIdBytes = new Uint8Array(blake2b_256(bodyBytes));

    // body fields straight from the bytes
    let totalCollateral: bigint | null = null, networkId: number | null = null, auxDataHash: string | null = null, scriptDataHash: string | null = null, currentTreasuryValue: bigint | null = null;
    let outputSlices: Uint8Array[] = [], collateralReturnSlice: Uint8Array | null = null;
    const withdrawals: MempoolTx["withdrawals"] = [];
    const entries = itemSlices(bodyBytes);
    for (let k = 0; k + 1 < entries.length; k += 2) {
        const key = Cbor.parse(entries[k]!);
        if (!(key instanceof CborUInt)) continue;
        const v = entries[k + 1]!;
        const obj = () => Cbor.parse(v);
        switch (Number(key.num)) {
            case 1: outputSlices = itemSlices(v); break;
            case 5: {
                const o = obj();
                if (o instanceof CborMap) for (const { k: a, v: q } of o.map) {
                    if (!(a instanceof CborBytes) || !(q instanceof CborUInt) || a.bytes.length !== 29) continue;
                    withdrawals.push({ account: a.bytes, amount: q.num, credType: (a.bytes[0]! & 0x10) ? 1 : 0, credHex: toHex(a.bytes.subarray(1)) });
                }
                break;
            }
            case 7: { const o = obj(); if (o instanceof CborBytes) auxDataHash = toHex(o.bytes); break; }
            case 11: { const o = obj(); if (o instanceof CborBytes) scriptDataHash = toHex(o.bytes); break; }
            case 15: { const o = obj(); if (o instanceof CborUInt) networkId = Number(o.num); break; }
            case 16: collateralReturnSlice = v; break;
            case 17: { const o = obj(); if (o instanceof CborUInt) totalCollateral = o.num; break; }
            case 21: { const o = obj(); if (o instanceof CborUInt) currentTreasuryValue = o.num; break; }
        }
    }
    const body = tx.body;
    return {
        bytes, era: 7, blockBytes: bytes, blockTxIdBytes: txIdBytes, subTransactions: [], bodyHashBytes: txIdBytes,
        txId: toHex(txIdBytes), txIdBytes, body, witnessSet: tx.witnesses, isValid,
        bodyBytes, witnessSetBytes, auxBytes,
        wireSize: bytes.length, size: bytes.length - 1,
        outputSlices, collateralReturnSlice, withdrawals, totalCollateral, networkId, auxDataHash, scriptDataHash, currentTreasuryValue,
        inputs: refsOf(body.inputs), collateral: refsOf(body.collateralInputs), refInputs: refsOf(body.refInputs),
    };
}

/**
 * Dijkstra `mempool_transaction` (`[body, wits, aux]`, or the legacy `[body, wits, true, aux]`):
 * the body carries sub-transactions; the id is `hashTx` over the block-format transaction
 * (`[body, wits, aux, is_valid]`), so the id is computed from the canonical block bytes.
 */
export function parseDijkstraMempoolTx(bytes: Uint8Array): MempoolTx {
    if (!(bytes[0] === 0x83 || bytes[0] === 0x84)) throw new Error("not a Dijkstra mempool transaction");
    const parts = itemSlices(bytes);
    if (parts.length !== 3 && parts.length !== 4) throw new Error(`transaction has ${parts.length} elements, expected 3 or 4`);
    const mempoolFlag = parts.length === 4;
    if (mempoolFlag && !(parts[2]!.length === 1 && parts[2]![0] === 0xf5)) throw new Error("Dijkstra legacy mempool flag is not true");
    const bodyBytes = parts[0]!, witnessSetBytes = parts[1]!;
    const auxRaw = parts[mempoolFlag ? 3 : 2]!;
    const auxBytes = auxRaw.length === 1 && auxRaw[0] === 0xf6 ? null : auxRaw;
    const blockBytes = concatBytes(new Uint8Array([0x84]), bodyBytes, witnessSetBytes, auxBytes ?? new Uint8Array([0xf6]), new Uint8Array([0xf5]));
    const blockTxIdBytes = new Uint8Array(blake2b_256(blockBytes));
    const tx: any = DijkstraTx.fromCbor(bytes);

    let totalCollateral: bigint | null = null, networkId: number | null = null, auxDataHash: string | null = null, scriptDataHash: string | null = null, currentTreasuryValue: bigint | null = null;
    let outputSlices: Uint8Array[] = [], collateralReturnSlice: Uint8Array | null = null;
    const withdrawals: MempoolTx["withdrawals"] = [];
    const entries = itemSlices(bodyBytes);
    for (let k = 0; k + 1 < entries.length; k += 2) {
        const key = Cbor.parse(entries[k]!);
        if (!(key instanceof CborUInt)) continue;
        const v = entries[k + 1]!;
        const obj = () => Cbor.parse(v);
        switch (Number(key.num)) {
            case 1: outputSlices = itemSlices(v); break;
            case 5: {
                const o = obj();
                if (o instanceof CborMap) for (const { k: a, v: q } of o.map) {
                    if (!(a instanceof CborBytes) || !(q instanceof CborUInt) || a.bytes.length !== 29) continue;
                    withdrawals.push({ account: a.bytes, amount: q.num, credType: (a.bytes[0]! & 0x10) ? 1 : 0, credHex: toHex(a.bytes.subarray(1)) });
                }
                break;
            }
            case 7: { const o = obj(); if (o instanceof CborBytes) auxDataHash = toHex(o.bytes); break; }
            case 11: { const o = obj(); if (o instanceof CborBytes) scriptDataHash = toHex(o.bytes); break; }
            case 15: { const o = obj(); if (o instanceof CborUInt) networkId = Number(o.num); break; }
            case 16: collateralReturnSlice = v; break;
            case 17: { const o = obj(); if (o instanceof CborUInt) totalCollateral = o.num; break; }
            case 21: { const o = obj(); if (o instanceof CborUInt) currentTreasuryValue = o.num; break; }
        }
    }
    const body = tx.body;
    const bodyHashBytes = new Uint8Array(blake2b_256(bodyBytes));
    return {
        bytes, era: 8, blockBytes, blockTxIdBytes, bodyHashBytes, subTransactions: (body?.subTransactions ?? []) as any[],
        txId: toHex(blockTxIdBytes), txIdBytes: blockTxIdBytes, body, witnessSet: tx.witnesses, isValid: true,
        bodyBytes, witnessSetBytes, auxBytes,
        wireSize: bytes.length, size: blockBytes.length - 1,
        outputSlices, collateralReturnSlice, withdrawals, totalCollateral, networkId, auxDataHash, scriptDataHash, currentTreasuryValue,
        inputs: refsOf(body.inputs), collateral: refsOf(body.collateralInputs), refInputs: refsOf(body.refInputs),
    };
}

/** Era-aware parse: Dijkstra (era 8+) vs Conway (era 7 and below). Without an era, Conway is tried first. */
export function parseMempoolTx(bytes: Uint8Array, era?: number): MempoolTx {
    if (era != null) return era >= 8 ? parseDijkstraMempoolTx(bytes) : parseConwayMempoolTx(bytes);
    try { return parseConwayMempoolTx(bytes); }
    catch (err) {
        if (bytes[0] !== 0x83 && bytes[0] !== 0x84) throw err;
        return parseDijkstraMempoolTx(bytes);
    }
}

/**
 * The canonical Dijkstra block transaction `[body, wits, aux, is_valid]` from submitted mempool
 * bytes (`[body, wits, aux]` or `[body, wits, true, aux]`), copying the original slices.
 */
export function mempoolToBlockTransactionBytes(bytes: Uint8Array): Uint8Array {
    const parts = itemSlices(bytes);
    if (parts.length !== 3 && parts.length !== 4) throw new Error(`Dijkstra transaction has ${parts.length} elements`);
    const legacy = parts.length === 4 && parts[2]!.length === 1 && parts[2]![0] === 0xf5;
    const aux = parts[legacy ? 3 : 2]!;
    return concatBytes(new Uint8Array([0x84]), parts[0]!, parts[1]!, aux, new Uint8Array([0xf5]));
}


export function unwrapHfcTx(obj: CborObj): { era: number | null; bytes: Uint8Array } | null {
    if (obj instanceof CborBytes) return { era: null, bytes: obj.bytes };
    if (obj instanceof CborArray && obj.array.length === 2 && obj.array[0] instanceof CborUInt) {
        const payload = obj.array[1];
        const inner = payload instanceof CborTag && Number(payload.tag) === 24 ? payload.data : payload;
        if (inner instanceof CborBytes) return { era: Number((obj.array[0] as CborUInt).num), bytes: inner.bytes };
    }
    return null;
}

export function wrapHfcTx(era: number, bytes: Uint8Array): CborArray {
    return new CborArray([new CborUInt(era), new CborTag(24, new CborBytes(bytes))]);
}

/** `[eraIndex, txid]` (GenTxId on node-to-client) or a bare 32-byte id. */
export function unwrapHfcTxId(obj: CborObj): Uint8Array | null {
    if (obj instanceof CborBytes) return obj.bytes;
    if (obj instanceof CborArray && obj.array.length === 2 && obj.array[1] instanceof CborBytes) return (obj.array[1] as CborBytes).bytes;
    return null;
}

