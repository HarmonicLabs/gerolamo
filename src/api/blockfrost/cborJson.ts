/**
 * CBOR → JSON renderings Blockfrost uses:
 *   metadataJson   transaction metadata, cardano-db-sync's "no schema" form (bytes → "0x…" text,
 *                  map keys rendered as strings, integers as JSON numbers);
 *   datumJson      Plutus data in the detailed schema ({constructor, fields} / {map} / {list} / {int} / {bytes});
 *   nativeScriptJson  timelock scripts as cardano-cli JSON (sig / all / any / atLeast / after / before).
 */
import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, type CborObj, CborSimple, CborTag, CborText, CborUInt } from "@harmoniclabs/cbor";
import { hex } from "../../db/minibf/cborWalk";

const parse = (b: Uint8Array): CborObj => Cbor.parse(b);
const bytesOf = (o: CborBytes): Uint8Array => (o as any).bytes ?? (o as any).buffer;

function intOf(o: CborObj): bigint | null {
    if (o instanceof CborUInt) return o.num;
    if (o instanceof CborNegInt) return o.num;
    if (o instanceof CborTag && (o.tag === 2n || o.tag === 3n) && o.data instanceof CborBytes) {
        let v = 0n; for (const x of bytesOf(o.data)) v = (v << 8n) | BigInt(x);
        return o.tag === 2n ? v : -1n - v;
    }
    return null;
}
const numOrBig = (v: bigint): number | bigint => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

function metaValue(o: CborObj): unknown {
    const i = intOf(o);
    if (i != null) return numOrBig(i);
    if (o instanceof CborBytes) return "0x" + hex(bytesOf(o));
    if (o instanceof CborText) return o.text;
    if (o instanceof CborArray) return o.array.map(metaValue);
    if (o instanceof CborMap) {
        const out: Record<string, unknown> = {};
        for (const { k, v } of o.map) {
            const kv = metaValue(k);
            out[typeof kv === "string" ? kv : typeof kv === "number" || typeof kv === "bigint" ? String(kv) : JSON.stringify(kv)] = metaValue(v);
        }
        return out;
    }
    if (o instanceof CborTag) return metaValue(o.data);
    if (o instanceof CborSimple) return o.simple ?? null;
    return null;
}

/** One metadata value (the CBOR under a label) as Blockfrost `json_metadata`. */
export function metadataJson(cbor: Uint8Array): unknown {
    try { return metaValue(parse(cbor)); } catch { return null; }
}

function dataValue(o: CborObj): unknown {
    const i = intOf(o);
    if (i != null) return { int: numOrBig(i) };
    if (o instanceof CborBytes) return { bytes: hex(bytesOf(o)) };
    if (o instanceof CborArray) return { list: o.array.map(dataValue) };
    if (o instanceof CborMap) return { map: o.map.map(({ k, v }) => ({ k: dataValue(k), v: dataValue(v) })) };
    if (o instanceof CborTag) {
        const t = Number(o.tag);
        const fields = (d: CborObj) => (d instanceof CborArray ? d.array.map(dataValue) : []);
        if (t >= 121 && t <= 127) return { constructor: t - 121, fields: fields(o.data) };
        if (t >= 1280 && t <= 1400) return { constructor: t - 1280 + 7, fields: fields(o.data) };
        if (t === 102 && o.data instanceof CborArray) return { constructor: Number(intOf(o.data.array[0]!) ?? 0), fields: fields(o.data.array[1]!) };
    }
    throw new Error("not Plutus data");
}

/** Plutus data (datum / redeemer) in the detailed JSON schema; null when the bytes are not Plutus data. */
export function datumJson(cbor: Uint8Array): unknown {
    try { return dataValue(parse(cbor)); } catch { return null; }
}

function nativeValue(o: CborObj): unknown {
    if (!(o instanceof CborArray)) throw new Error("native script");
    const t = Number(intOf(o.array[0]!));
    const list = (x: CborObj) => (x instanceof CborArray ? x.array.map(nativeValue) : []);
    switch (t) {
        case 0: return { type: "sig", keyHash: hex(bytesOf(o.array[1] as CborBytes)) };
        case 1: return { type: "all", scripts: list(o.array[1]!) };
        case 2: return { type: "any", scripts: list(o.array[1]!) };
        case 3: return { type: "atLeast", required: Number(intOf(o.array[1]!)), scripts: list(o.array[2]!) };
        case 4: return { type: "after", slot: Number(intOf(o.array[1]!)) };
        case 5: return { type: "before", slot: Number(intOf(o.array[1]!)) };
    }
    throw new Error(`native script tag ${t}`);
}
export function nativeScriptJson(cbor: Uint8Array): unknown {
    try { return nativeValue(parse(cbor)); } catch { return null; }
}

/** Plain JSON of CIP-25 / CIP-68 metadata (bytes as UTF-8 text when printable, else hex). */
export function plainJson(o: CborObj): unknown {
    const i = intOf(o);
    if (i != null) return numOrBig(i);
    if (o instanceof CborBytes) {
        const b = bytesOf(o);
        const s = new TextDecoder("utf-8", { fatal: false }).decode(b);
        return /^[\x20-\x7e -￿]*$/.test(s) && !s.includes("�") ? s : hex(b);
    }
    if (o instanceof CborText) return o.text;
    if (o instanceof CborArray) return o.array.map(plainJson);
    if (o instanceof CborMap) {
        const out: Record<string, unknown> = {};
        for (const { k, v } of o.map) { const kv = plainJson(k); out[typeof kv === "string" ? kv : String(kv)] = plainJson(v); }
        return out;
    }
    if (o instanceof CborTag) return plainJson(o.data);
    return null;
}
export { parse as parseCbor };
