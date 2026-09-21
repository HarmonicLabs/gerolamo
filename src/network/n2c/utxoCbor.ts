import { CborArray, CborBytes, CborMap, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { base58Decode, base58Encode } from "@harmoniclabs/cardano-ledger-ts/dist/utils/base58.js";
import { shelleyAddressBech32 } from "../../db/stakeCred";

/** One `utxo` row as the ledger's `UTxO` map entry: `[txid, ix]` → post-Alonzo map-form output. */
export interface UtxoRowLike {
    utxo_ref: string;
    tx_out: string | Record<string, unknown>;
}

/** `UTxO` = `{ * transaction_input => transaction_output }` (definite map, query result shape). */
export function utxoMapCbor(rows: UtxoRowLike[]): CborMap {
    const entries: { k: CborObj; v: CborObj }[] = [];
    for (const row of rows) {
        const json = typeof row.tx_out === "string" ? (JSON.parse(row.tx_out) as Record<string, unknown>) : row.tx_out;
        const out = txOutCbor(json);
        if (!out) continue;
        entries.push({ k: txInCbor(row.utxo_ref), v: out });
    }
    return new CborMap(entries);
}

/** `"txid:ix"` → `[h'txid', ix]`. */
export function txInCbor(ref: string): CborArray {
    const [id, ix] = ref.split(":");
    return new CborArray([new CborBytes(hexBytes(id ?? "")), new CborUInt(BigInt(ix ?? "0"))]);
}

/** `[h'txid', ix]` → `"txid:ix"`, or null when the shape is off. */
export function txInRef(o: CborObj): string | null {
    if (!(o instanceof CborArray) || o.array.length < 2) return null;
    const [id, ix] = o.array;
    if (!(id instanceof CborBytes) || !(ix instanceof CborUInt)) return null;
    return `${Buffer.from(id.bytes).toString("hex")}:${ix.num}`;
}

/**
 * The stored `tx_out` JSON (`address`, `amount`, `assets`, `datum_hash` | `inline_datum`,
 * `reference_script_cbor`) as a Babbage/Conway map-form output
 * `{0: address, 1: value, ?2: datum_option, ?3: script_ref}`.
 */
export function txOutCbor(json: Record<string, unknown>): CborMap | null {
    const addr = addressBytes(String(json.address ?? ""));
    if (!addr) return null;
    const entries: { k: CborObj; v: CborObj }[] = [
        { k: new CborUInt(0), v: new CborBytes(addr) },
        { k: new CborUInt(1), v: valueCbor(String(json.amount ?? "0"), json.assets) },
    ];
    if (typeof json.inline_datum === "string" && json.inline_datum.length) {
        entries.push({ k: new CborUInt(2), v: new CborArray([new CborUInt(1), new CborTag(24, new CborBytes(hexBytes(json.inline_datum)))]) });
    } else if (typeof json.datum_hash === "string" && json.datum_hash.length) {
        entries.push({ k: new CborUInt(2), v: new CborArray([new CborUInt(0), new CborBytes(hexBytes(json.datum_hash))]) });
    }
    if (typeof json.reference_script_cbor === "string" && json.reference_script_cbor.length) {
        entries.push({ k: new CborUInt(3), v: new CborTag(24, new CborBytes(hexBytes(json.reference_script_cbor))) });
    }
    return new CborMap(entries);
}

/** `coin` or `[coin, multiasset]`; the stored map keeps lovelace under the empty policy id. */
export function valueCbor(lovelace: string, assets: unknown): CborObj {
    const coin = new CborUInt(BigInt(lovelace || "0"));
    const policies: { k: CborObj; v: CborObj }[] = [];
    if (assets && typeof assets === "object") {
        for (const [policy, names] of Object.entries(assets as Record<string, Record<string, string>>)) {
            if (!policy || !names || typeof names !== "object") continue;
            const inner = Object.entries(names)
                .filter(([, q]) => BigInt(q || "0") !== 0n)
                .map(([name, q]) => ({ k: new CborBytes(hexBytes(name)), v: new CborUInt(BigInt(q)) }));
            if (inner.length) policies.push({ k: new CborBytes(hexBytes(policy)), v: new CborMap(inner) });
        }
    }
    return policies.length ? new CborArray([coin, new CborMap(policies)]) : coin;
}

/** Raw bytes of a stored address string: bech32 payload for Shelley, base58 payload (its CBOR) for Byron. */
export function addressBytes(addr: string): Uint8Array | null {
    if (!addr) return null;
    if (addr.startsWith("addr") || addr.startsWith("stake")) return bech32Bytes(addr);
    try {
        return base58Decode(addr);
    } catch {
        return null;
    }
}

/** Stored string form of raw address bytes (the `utxo.address` column): bech32 for Shelley, base58 for Byron. */
export function addressString(raw: Uint8Array): string | null {
    if (raw.length === 0) return null;
    if (raw[0] === 0x82) return base58Encode(raw); // Byron address CBOR: [#6.24(payload), crc]
    return shelleyAddressBech32(raw);
}

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Bytes(addr: string): Uint8Array | null {
    const i = addr.lastIndexOf("1");
    if (i <= 0 || addr.length < i + 7) return null;
    const data = addr.slice(i + 1, -6).toLowerCase();
    let acc = 0, bits = 0;
    const out: number[] = [];
    for (const c of data) {
        const v = BECH32_ALPHABET.indexOf(c);
        if (v < 0) return null;
        acc = (acc << 5) | v;
        bits += 5;
        while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    return Uint8Array.from(out);
}

function hexBytes(hex: string): Uint8Array {
    return Uint8Array.from(Buffer.from(hex, "hex"));
}
