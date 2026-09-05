/**
 * Alonzo+ `script_data_hash` (cardano-ledger `hashScriptIntegrity`):
 *
 *   blake2b_256( redeemers ‖ datums ‖ language_views )
 *
 * with the redeemers and datums taken byte-for-byte from the witness set, and
 * the language views built from the cost models of the languages the
 * transaction uses. No redeemers but datums: `80 ‖ datums ‖ A0` through Babbage
 * (redeemers were a list), `A0 ‖ datums ‖ A0` from Conway on (a map).
 */
import { Cbor, CborBytes, CborMap, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { costModelsToLanguageViewCbor, toCostModelArrV2, toCostModelArrV3 } from "@harmoniclabs/cardano-costmodels-ts";

export type PlutusLanguage = 1 | 2 | 3;

/** Cost model arrays per language from a stored parameter record (Blockfrost `cost_models_raw`, `cost_models` objects, genesis objects). */
export function costModelArrays(raw: Record<string, any> | null | undefined): Partial<Record<PlutusLanguage, (number | bigint)[]>> {
    const out: Partial<Record<PlutusLanguage, (number | bigint)[]>> = {};
    const rawArrays = raw?.cost_models_raw;
    const models = raw?.cost_models ?? raw?.costModels;
    for (const lang of [1, 2, 3] as PlutusLanguage[]) {
        const names = [`PlutusV${lang}`, `PlutusScriptV${lang}`, `plutusV${lang}`, `plutus:v${lang}`];
        let v: any = undefined;
        for (const n of names) if (rawArrays?.[n] != null) { v = rawArrays[n]; break; }
        if (v == null) for (const n of names) if (models?.[n] != null) { v = models[n]; break; }
        if (v == null) continue;
        if (Array.isArray(v)) out[lang] = v.map((x) => (typeof x === "bigint" ? x : Number(x)));
        else if (typeof v === "object") {
            try {
                if (lang === 1) {
                    // V1 language views list the parameters in alphabetical name order
                    // (the Alonzo names and their later renamings sort identically).
                    out[1] = Object.keys(v).sort().map((k) => Number(v[k]));
                } else if (lang === 2) out[2] = toCostModelArrV2(v).map((x: any) => (typeof x === "bigint" ? x : Number(x)));
                else out[3] = toCostModelArrV3(v).map((x: any) => (typeof x === "bigint" ? x : Number(x)));
            } catch {
                /* unknown naming: language unavailable */
            }
        }
    }
    return out;
}

/** Canonical language-views map for the given languages, or null when a cost model is missing. */
export function languageViews(models: Partial<Record<PlutusLanguage, (number | bigint)[]>>, langs: Set<PlutusLanguage>): Uint8Array | null {
    if (langs.size === 0) return Cbor.encode(new CborMap([])).toBuffer();
    for (const l of langs) if (!models[l]) return null;
    // One entry per language from the library, then the map in canonical CBOR key order
    // (shorter encoded key first, then bytewise): V2's key `01` sorts before V1's `4100`,
    // so a transaction with both V1 and V2 scripts hashes V2 first (preview slot
    // 11663879); the library emits V1 first.
    const entries: Array<{ k: any; v: any; keyBytes: Uint8Array }> = [];
    for (const l of [1, 2, 3] as PlutusLanguage[]) {
        if (!langs.has(l)) continue;
        const single = costModelsToLanguageViewCbor(
            { PlutusScriptV1: l === 1 ? (models[1] as any) : undefined, PlutusScriptV2: l === 2 ? (models[2] as any) : undefined, PlutusScriptV3: l === 3 ? (models[3] as any) : undefined },
            { mustHaveV1: l === 1, mustHaveV2: l === 2, mustHaveV3: l === 3 },
        );
        const parsed = Cbor.parse(single) as CborMap;
        for (const e of parsed.map) entries.push({ k: e.k, v: e.v, keyBytes: Cbor.encode(e.k).toBuffer() });
    }
    entries.sort((a, b) => a.keyBytes.length - b.keyBytes.length || Buffer.compare(Buffer.from(a.keyBytes), Buffer.from(b.keyBytes)));
    return Cbor.encode(new CborMap(entries.map(({ k, v }) => ({ k, v })))).toBuffer();
}

/** The witness-set map entries for redeemers (key 5) and datums (key 4), as original bytes. */
export function witnessSlices(witnessSetBytes: Uint8Array): { redeemers: Uint8Array | null; datums: Uint8Array | null } {
    const root = Cbor.parse(witnessSetBytes, { keepRef: true } as any);
    if (!(root instanceof CborMap)) return { redeemers: null, datums: null };
    let redeemers: Uint8Array | null = null, datums: Uint8Array | null = null;
    for (const { k, v } of root.map) {
        if (!(k instanceof CborUInt)) continue;
        const key = Number(k.num);
        if (key !== 4 && key !== 5) continue;
        const ref: any = (v as any).subCborRef ?? (v as any).cborRef;
        const bytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(v).toBuffer();
        if (key === 5) redeemers = bytes;
        else datums = bytes;
    }
    return { redeemers, datums };
}

export interface ScriptDataHashInput {
    witnessSetBytes: Uint8Array;
    languages: Set<PlutusLanguage>;
    models: Partial<Record<PlutusLanguage, (number | bigint)[]>>;
    /** Alonzo–Babbage (era ≤ 6) encode "no redeemers" as `80`; Conway+ as `A0`. */
    alonzoForm?: boolean;
}

/**
 * An encoded CBOR array/map with no elements: definite (`80` / `A0`) or
 * indefinite (`9F FF` / `BF FF`). The ledger's `nullDats`/`Map.null` look at
 * the decoded collection, so an empty indefinite-length datum list needs no
 * script_data_hash either (preview block 31023089 carries `04 9F FF`).
 */
function encodesEmpty(bytes: Uint8Array | null): boolean {
    if (!bytes || bytes.length === 0) return true;
    if (bytes.length === 1) return bytes[0] === 0x80 || bytes[0] === 0xa0;
    if (bytes.length === 2) return (bytes[0] === 0x9f || bytes[0] === 0xbf) && bytes[1] === 0xff;
    return false;
}

/** Expected `script_data_hash` (hex), null when the transaction needs none, or a reason it cannot be computed. */
export function expectedScriptDataHash(input: ScriptDataHashInput): { hash: string | null; reason?: string } {
    const { redeemers, datums } = witnessSlices(input.witnessSetBytes);
    // The ledger looks at the *contents*: an empty redeemer or datum collection counts as absent.
    const noRedeemers = encodesEmpty(redeemers), noDatums = encodesEmpty(datums);
    if (noRedeemers && noDatums) return { hash: null };
    const views = languageViews(input.models, input.languages);
    if (!views) return { hash: null, reason: `cost model missing for ${[...input.languages].map((l) => `PlutusV${l}`).join(", ")}` };
    let data: Uint8Array;
    if (noRedeemers) {
        const empty = input.alonzoForm ? 0x80 : 0xa0;
        data = new Uint8Array([empty, ...datums!, 0xa0]);
    } else {
        const r = redeemers!;
        const d = noDatums ? new Uint8Array(0) : datums!;
        data = new Uint8Array(r.length + d.length + views.length);
        data.set(r, 0);
        data.set(d, r.length);
        data.set(views, r.length + d.length);
    }
    return { hash: toHex(blake2b_256(data)) };
}

/** Plutus language of a script wrapper `[tag, bytes]` (CBOR hex), or null for native scripts / unknown. */
export function scriptLanguageOfCbor(hexOrBytes: string | Uint8Array): PlutusLanguage | null {
    try {
        const bytes = typeof hexOrBytes === "string" ? Buffer.from(hexOrBytes, "hex") : hexOrBytes;
        const obj: any = Cbor.parse(bytes);
        const tag = Number(obj?.array?.[0]?.num ?? NaN);
        return tag === 1 || tag === 2 || tag === 3 ? (tag as PlutusLanguage) : null;
    } catch {
        return null;
    }
}

/** Original bytes of each witness-set datum (key 4), or null when the set carries none / cannot be sliced. */
export function witnessDatumBytes(witnessSetBytes: Uint8Array): Uint8Array[] | null {
    try {
        const root = Cbor.parse(witnessSetBytes, { keepRef: true } as any);
        if (!(root instanceof CborMap)) return null;
        for (const { k, v } of root.map) {
            if (!(k instanceof CborUInt) || Number(k.num) !== 4) continue;
            const items: any[] = (v as any).array ?? [];
            return items.map((el) => {
                const ref: any = el.subCborRef ?? el.cborRef;
                return ref?.toBuffer ? ref.toBuffer() : Cbor.encode(el).toBuffer();
            });
        }
        return [];
    } catch {
        return null;
    }
}

/**
 * Original bytes of each output of a transaction body (key 1), by index, or
 * null when the body cannot be sliced. Used where the decoder kept no
 * per-output slice (legacy array-form outputs) and the size matters (min UTxO).
 */
export function bodyOutputBytes(bodyBytes: Uint8Array): Uint8Array[] | null {
    try {
        const root = Cbor.parse(bodyBytes, { keepRef: true } as any);
        if (!(root instanceof CborMap)) return null;
        for (const { k, v } of root.map) {
            if (!(k instanceof CborUInt) || Number(k.num) !== 1) continue;
            const items: any[] = (v as any).array ?? [];
            return items.map((el) => {
                const ref: any = el.subCborRef ?? el.cborRef;
                return ref?.toBuffer ? ref.toBuffer() : Cbor.encode(el).toBuffer();
            });
        }
        return [];
    } catch {
        return null;
    }
}

export interface WitnessScript {
    kind: "native" | "plutus";
    language: PlutusLanguage | null;
    /** The script bytes exactly as carried by the witness set (Plutus: the bytestring content, however many CBOR wraps it has). */
    bytes: Uint8Array;
}

/**
 * Script hashes from the witness set's original bytes: blake2b_224(tag ‖ bytes)
 * with tag 0 (native script CBOR), 1/2/3 (Plutus V1/V2/V3 bytestring content).
 * The ledger hashes the bytes as given, so a script that was CBOR-wrapped twice
 * by its author hashes over both wraps — decoders that normalise the wrapping
 * (ledger-ts) then compute a hash the address does not have.
 */
export function witnessScriptHashes(witnessSetBytes: Uint8Array): Map<string, WitnessScript> {
    const out = new Map<string, WitnessScript>();
    let root: any;
    try {
        root = Cbor.parse(witnessSetBytes, { keepRef: true } as any);
    } catch {
        return out;
    }
    if (!(root instanceof CborMap)) return out;
    const keyLang: Record<number, { kind: "native" | "plutus"; language: PlutusLanguage | null; tag: number }> = {
        1: { kind: "native", language: null, tag: 0 },
        3: { kind: "plutus", language: 1, tag: 1 },
        6: { kind: "plutus", language: 2, tag: 2 },
        7: { kind: "plutus", language: 3, tag: 3 },
    };
    for (const { k, v } of root.map) {
        if (!(k instanceof CborUInt)) continue;
        const spec = keyLang[Number(k.num)];
        if (!spec) continue;
        const items: any[] = (v as any).array ?? [];
        for (const el of items) {
            let bytes: Uint8Array;
            if (spec.kind === "native") {
                const ref: any = el.subCborRef ?? el.cborRef;
                bytes = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(el).toBuffer();
            } else {
                if (!(el instanceof CborBytes)) continue;
                bytes = el.bytes;
            }
            const pre = new Uint8Array(1 + bytes.length);
            pre[0] = spec.tag;
            pre.set(bytes, 1);
            out.set(toHex(blake2b_224(pre)), { kind: spec.kind, language: spec.language, bytes });
        }
    }
    return out;
}
