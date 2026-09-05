import { Cbor, CborArray, CborBytes, CborMap, CborObj, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { Hash32, Script } from "@harmoniclabs/cardano-ledger-ts";
import { dataToCbor, isData } from "@harmoniclabs/plutus-data";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

export type MiniBfTxOutMetadata = {
    datumHash: string | null;
    inlineDatumCbor: string | null;
    scriptRefHash: string | null;
    scriptRefCbor: string | null;
};

export type StoredTxOut = MiniBfTxOutMetadata & {
    address: string;
    amount: string;
    assets: Record<string, Record<string, string>>;
};

const EMPTY_METADATA: MiniBfTxOutMetadata = {
    datumHash: null,
    inlineDatumCbor: null,
    scriptRefHash: null,
    scriptRefCbor: null,
};

function scriptFromStoredFields(value: Record<string, unknown>): Script | null {
    const bytesHex = typeof value.script_bytes_hex === "string"
        ? value.script_bytes_hex
        : "";
    if (!/^[0-9a-f]*$/i.test(bytesHex) || bytesHex.length === 0 || bytesHex.length % 2 !== 0) {
        return null;
    }

    const bytes = fromHex(bytesHex);
    if (value.script_kind === "native") {
        return new Script("NativeScript", bytes);
    }
    if (value.script_kind !== "plutus") return null;

    switch (Number(value.script_language)) {
        case 0:
            return Script.plutusV1(bytes);
        case 1:
            return Script.plutusV2(bytes);
        case 2:
            return Script.plutusV3(bytes);
        case 3:
            return Script.plutusV4(bytes);
        default:
            return null;
    }
}

/**
 * Datum / reference-script metadata of a ledger-ts output, read from the
 * output's own CBOR bytes. The class-based checks (`instanceof Hash32`,
 * `isData`) silently failed for objects built by ledger-ts's nested copies of
 * plutus-data / cbor, which dropped every inline datum from the UTxO set.
 */
export function extractLedgerTxOutMetadata(output: unknown): MiniBfTxOutMetadata {
    if (output == null || typeof output !== "object") return { ...EMPTY_METADATA };
    const txOut = output as { datum?: unknown; refScript?: unknown; cborRef?: any; toCborBytes?: () => Uint8Array };
    let bytes: Uint8Array | null = null;
    try {
        bytes = txOut.cborRef?.toBuffer?.() ?? txOut.toCborBytes?.() ?? null;
    } catch {
        bytes = null;
    }
    const fromBytes = bytes ? txOutMetadataFromCbor(bytes) : null;
    if (fromBytes) return fromBytes;

    // Fallback: duck-typed object inspection.
    let datumHash: string | null = null;
    let inlineDatumCbor: string | null = null;
    const d: any = txOut.datum;
    if (d != null) {
        const asHex = typeof d.toString === "function" ? String(d.toString()) : "";
        if (/^[0-9a-f]{64}$/i.test(asHex)) datumHash = asHex.toLowerCase();
        else {
            try {
                inlineDatumCbor = toHex(typeof d.toCbor === "function" ? d.toCbor().toBuffer() : dataToCbor(d).toBuffer());
            } catch {
                inlineDatumCbor = null;
            }
        }
    }
    let scriptRefHash: string | null = null;
    let scriptRefCbor: string | null = null;
    const rs: any = txOut.refScript;
    if (rs && rs.hash != null) {
        scriptRefHash = String(rs.hash.toString()).toLowerCase();
        try {
            scriptRefCbor = rs.cbor ? toHex(rs.cbor) : null;
        } catch {
            scriptRefCbor = null;
        }
    }
    return { datumHash, inlineDatumCbor, scriptRefHash, scriptRefCbor };
}

/**
 * Babbage map-form output `{0: addr, 1: value, 2: datum_option, 3: script_ref}`
 * with `datum_option = [0, hash32] / [1, #6.24(bytes .cbor data)]` and
 * `script_ref = #6.24(bytes .cbor [lang, script])`; pre-Babbage array form
 * `[addr, value, datum_hash?]`.
 */
export function txOutMetadataFromCbor(bytes: Uint8Array): MiniBfTxOutMetadata | null {
    let obj: CborObj;
    try {
        obj = Cbor.parse(bytes);
    } catch {
        return null;
    }
    const out: MiniBfTxOutMetadata = { ...EMPTY_METADATA };
    if (obj instanceof CborArray) {
        const third = obj.array[2];
        if (third instanceof CborBytes && third.bytes.length === 32) out.datumHash = toHex(third.bytes);
        return out;
    }
    if (!(obj instanceof CborMap)) return null;
    for (const { k, v } of obj.map) {
        if (!(k instanceof CborUInt)) continue;
        const key = Number(k.num);
        if (key === 2 && v instanceof CborArray) {
            const kind = v.array[0], payload = v.array[1];
            if (kind instanceof CborUInt && Number(kind.num) === 0 && payload instanceof CborBytes) out.datumHash = toHex(payload.bytes);
            else if (kind instanceof CborUInt && Number(kind.num) === 1 && payload instanceof CborTag && payload.data instanceof CborBytes) out.inlineDatumCbor = toHex(payload.data.bytes);
        } else if (key === 3 && v instanceof CborTag && v.data instanceof CborBytes) {
            const inner = v.data.bytes; // cbor of [lang, script]
            out.scriptRefCbor = toHex(inner);
            out.scriptRefHash = scriptHashOfWrapped(inner);
        }
    }
    return out;
}

/** Script hash of a `[lang, script]` wrapper: blake2b_224(lang_tag ‖ script bytes) — native scripts hash their CBOR, Plutus their flat bytes. */
export function scriptHashOfWrapped(wrapped: Uint8Array): string | null {
    try {
        const arr = Cbor.parse(wrapped);
        if (!(arr instanceof CborArray) || !(arr.array[0] instanceof CborUInt)) return null;
        const lang = Number((arr.array[0] as CborUInt).num);
        const body = arr.array[1];
        if (!body) return null;
        const scriptBytes = lang === 0 ? Cbor.encode(body).toBuffer() : body instanceof CborBytes ? body.bytes : null;
        if (!scriptBytes) return null;
        const pre = new Uint8Array(1 + scriptBytes.length);
        pre[0] = lang;
        pre.set(scriptBytes, 1);
        return toHex(blake2b_224(pre));
    } catch {
        return null;
    }
}

export function parseStoredTxOut(raw: unknown): StoredTxOut {
    let value: Record<string, unknown> = {};
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
    } catch {
        // Honest empty output for malformed legacy rows.
    }

    const assets = value.assets && typeof value.assets === "object"
        ? value.assets as Record<string, Record<string, string>>
        : {};
    const storedScript = scriptFromStoredFields(value);
    const explicitScriptHash = typeof value.reference_script_hash === "string"
        ? value.reference_script_hash
        : null;
    const explicitScriptCbor = typeof value.reference_script_cbor === "string"
        ? value.reference_script_cbor
        : null;

    return {
        address: String(value.address ?? ""),
        amount: String(value.amount ?? "0"),
        assets,
        datumHash: typeof value.datum_hash === "string" ? value.datum_hash : null,
        inlineDatumCbor: typeof value.inline_datum === "string" ? value.inline_datum : null,
        scriptRefHash: explicitScriptHash ?? storedScript?.hash.toString() ?? null,
        scriptRefCbor: explicitScriptCbor ?? (storedScript ? toHex(storedScript.cbor) : null),
    };
}

export function storedTxOutContainsAsset(output: StoredTxOut, assetUnit: string): boolean {
    const unit = assetUnit.toLowerCase();
    if (!/^[0-9a-f]+$/i.test(unit) || unit.length < 56) return false;
    const policy = unit.slice(0, 56);
    const name = unit.slice(56);
    const names = output.assets[policy] ?? output.assets[policy.toUpperCase()];
    if (!names || typeof names !== "object") return false;
    const quantity = names[name] ?? names[name.toUpperCase()];
    try {
        return quantity != null && BigInt(String(quantity)) !== 0n;
    } catch {
        return false;
    }
}
