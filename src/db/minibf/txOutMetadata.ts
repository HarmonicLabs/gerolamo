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

export function extractLedgerTxOutMetadata(output: unknown): MiniBfTxOutMetadata {
    if (output == null || typeof output !== "object") return { ...EMPTY_METADATA };
    const txOut = output as { datum?: unknown; refScript?: unknown };

    let datumHash: string | null = null;
    let inlineDatumCbor: string | null = null;
    if (txOut.datum instanceof Hash32) {
        datumHash = txOut.datum.toString();
    } else if (isData(txOut.datum)) {
        inlineDatumCbor = dataToCbor(txOut.datum).toString();
    }

    let scriptRefHash: string | null = null;
    let scriptRefCbor: string | null = null;
    if (txOut.refScript instanceof Script) {
        scriptRefHash = txOut.refScript.hash.toString();
        scriptRefCbor = toHex(txOut.refScript.cbor);
    }

    return { datumHash, inlineDatumCbor, scriptRefHash, scriptRefCbor };
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
