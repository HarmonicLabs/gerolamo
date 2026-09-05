/**
 * Block body from transactions (block plan §3/§4).
 *
 * A post-Alonzo transaction is `[body, witness_set, is_valid, auxiliary_data / null]`;
 * the block carries the same parts column-wise:
 *   tx_bodies            = [body_0, body_1, …]
 *   tx_witness_sets      = [wits_0, wits_1, …]
 *   auxiliary_data_set   = { i ↦ aux_i } for the transactions that have one
 *   invalid_transactions = [i …] for is_valid = false
 * Every element is copied as its original bytes (lazy CBOR slicing), so the
 * block re-serialises exactly what was submitted and hashes match.
 */
import { Cbor, CborUInt, LazyCborArray, CborSimple } from "@harmoniclabs/cbor";
import type { BodySegments } from "./forge";

export interface TxParts {
    hash: Uint8Array;
    bytes: Uint8Array;
    body: Uint8Array;
    witnessSet: Uint8Array;
    isValid: boolean;
    auxiliaryData: Uint8Array | null;
}

/** Split a serialised transaction into its raw parts (Alonzo+ four-element form; Shelley–Mary three-element). */
export function splitTx(hash: Uint8Array, bytes: Uint8Array): TxParts {
    const lazy = Cbor.parseLazy(bytes);
    if (!(lazy instanceof LazyCborArray) || lazy.array.length < 3) throw new Error("transaction is not [body, witness_set, …]");
    const [body, witnessSet, third, fourth] = lazy.array;
    let isValid = true, auxiliaryData: Uint8Array | null = null;
    if (lazy.array.length >= 4) {
        const v = Cbor.parse(third!);
        if (!(v instanceof CborSimple) || typeof v.simple !== "boolean") throw new Error("transaction is_valid is not a boolean");
        isValid = v.simple;
        auxiliaryData = isNull(fourth!) ? null : fourth!;
    } else {
        auxiliaryData = isNull(third!) ? null : third!;
    }
    return { hash, bytes, body: body!, witnessSet: witnessSet!, isValid, auxiliaryData };
}

function isNull(raw: Uint8Array): boolean {
    return raw.length === 1 && raw[0] === 0xf6;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * cardano-binary `encodeFoldableEncoder`: up to 23 elements get a definite
 * header, more get the indefinite form (`9f … ff` / `bf … ff`). Real blocks:
 * 1 tx → `81`, 2 → `82`, 30 → `9f…ff`; an empty block is `80 80 a0 80`.
 */
function rawCollection(majorDefinite: number, majorIndef: number, count: number, items: Uint8Array[]): Uint8Array {
    if (count <= 23) return concat([new Uint8Array([majorDefinite | count]), ...items]);
    return concat([new Uint8Array([majorIndef]), ...items, new Uint8Array([0xff])]);
}

/** CBOR array of raw elements. */
function rawArray(elements: Uint8Array[]): Uint8Array {
    return rawCollection(0x80, 0x9f, elements.length, elements);
}

/** CBOR map with uint keys (ascending) and raw values. */
function rawUintMap(entries: Array<[number, Uint8Array]>): Uint8Array {
    const items = entries.flatMap(([k, v]) => [Cbor.encode(new CborUInt(BigInt(k))).toBuffer(), v]);
    return rawCollection(0xa0, 0xbf, entries.length, items);
}

export interface AssembledBody {
    segments: BodySegments;
    included: TxParts[];
    /** bytes of tx_bodies + witness_sets + aux + invalid, what `block_body_size` reports */
    size: number;
}

/**
 * Greedy in arrival order under `maxBlockBodySize`: a transaction that does not
 * fit is skipped (later, smaller ones may still fit). Returns the segments the
 * header commits to.
 */
export function assembleBody(txs: TxParts[], maxBlockBodySize: number): AssembledBody {
    const included: TxParts[] = [];
    let cur = build([]);
    for (const tx of txs) {
        const next = build([...included, tx]);
        if (next.size > maxBlockBodySize) continue;
        included.push(tx);
        cur = next;
    }
    return { segments: cur.segments, included, size: cur.size };
}

function build(txs: TxParts[]): { segments: BodySegments; size: number } {
    const txBodies = rawArray(txs.map((t) => t.body));
    const witnessSets = rawArray(txs.map((t) => t.witnessSet));
    const aux: Array<[number, Uint8Array]> = [];
    const invalid: Uint8Array[] = [];
    txs.forEach((t, i) => {
        if (t.auxiliaryData) aux.push([i, t.auxiliaryData]);
        if (!t.isValid) invalid.push(Cbor.encode(new CborUInt(BigInt(i))).toBuffer());
    });
    const segments: BodySegments = { txBodies, witnessSets, auxiliaryData: rawUintMap(aux), invalidTransactions: rawArray(invalid) };
    return { segments, size: txBodies.length + witnessSets.length + segments.auxiliaryData.length + segments.invalidTransactions.length };
}
