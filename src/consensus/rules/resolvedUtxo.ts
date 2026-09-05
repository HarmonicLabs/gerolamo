/** An input the block spends, resolved from the UTxO set. */
import { unitsFromStoredTxOut, type UnitMap } from "./value";

export interface ResolvedUtxo {
    ref: string;
    /** Address as stored (bech32 `addr…`, or Byron base58). */
    address: string;
    value: UnitMap;
    referenceScriptHash: string | null;
    /** Datum hash / inline datum presence, for Alonzo+ rules. */
    hasDatum: boolean;
    /** Datum hash (hex) when the output carries one. */
    datumHash?: string | null;
    /** Inline datum CBOR (hex) when the output carries one (Babbage+). */
    inlineDatumCbor?: string | null;
    /** Reference script CBOR (hex) when the output carries one (Babbage+). */
    referenceScriptCbor?: string | null;
}

export function resolvedFromRow(row: { utxo_ref: string; address: string | null; tx_out: string | null; reference_script_hash?: string | null }): ResolvedUtxo {
    let json: any = null;
    try {
        json = row.tx_out ? JSON.parse(row.tx_out) : null;
    } catch {
        json = null;
    }
    const address = (row.address && row.address.length > 8 ? row.address : json?.address) ?? "";
    return {
        ref: row.utxo_ref,
        address: String(address),
        value: unitsFromStoredTxOut(json),
        referenceScriptHash: (row.reference_script_hash ?? json?.reference_script_hash ?? null)?.toString().toLowerCase() ?? null,
        hasDatum: !!(json?.data_hash || json?.inline_datum || json?.datum_hash || json?.inlineDatum),
        datumHash: (json?.datum_hash ?? json?.data_hash ?? null)?.toString().toLowerCase() ?? null,
        inlineDatumCbor: (json?.inline_datum ?? json?.inlineDatum ?? null)?.toString().toLowerCase() ?? null,
        referenceScriptCbor: (json?.reference_script_cbor ?? null)?.toString().toLowerCase() ?? null,
    };
}

/** `txid:index` for a Shelley+ input (`utxoRef`) or a Byron input (`txId`/`index`), lowercase hex. */
export function utxoRefOf(input: any): string | null {
    try {
        const id = input?.utxoRef?.id ?? input?.txId ?? input?.id;
        const index = input?.utxoRef?.index ?? input?.index ?? input?.outputIndex;
        if (id == null || index == null) return null;
        const idHex = id instanceof Uint8Array ? Buffer.from(id).toString("hex") : String(id.toString());
        return `${idHex.toLowerCase()}:${Number(index)}`;
    } catch {
        return null;
    }
}

/**
 * Transaction inputs as the ledger sees them. Up to Babbage the field decodes
 * into a *set*, so a body that repeats an input (seen on preprod) is valid and
 * the repeats collapse; from Conway (protocol 9) repeated set elements are a
 * decoding error, so they are left in place for the duplicate rule to reject.
 */
export function ledgerInputs<T>(inputs: readonly T[] | undefined | null, era: number): T[] {
    const list = [...(inputs ?? [])];
    if (era >= 7) return list;
    const seen = new Set<string>();
    const out: T[] = [];
    for (const i of list) {
        const ref = utxoRefOf(i) ?? JSON.stringify(i);
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push(i);
    }
    return out;
}
