/**
 * Era-aware field accessors for cardano-ledger-ts ≥0.5 (Byron in MultiEra unions).
 *
 * Shelley+ headers:  header.body.slot / header.body.prevHash
 * Byron headers:     consensusData.slotId.slot / prevBlock
 * Shelley+ blocks:   transactionBodies
 * Byron blocks:      body.txPayload (not applied as Shelley txs yet)
 */

import type {
    AnyEraBlock,
    AnyEraHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";

/** Absolute slot from any era header (Byron uses epoch-local slotId). */
export function getHeaderSlot(h: AnyEraHeader): bigint {
    const any = h as any;
    if (any?.body?.slot != null) return BigInt(any.body.slot);
    if (any?.consensusData?.slotId?.slot != null) {
        return BigInt(any.consensusData.slotId.slot);
    }
    throw new Error("getHeaderSlot: unknown header shape");
}

/** Previous block hash bytes (or null). Byron uses prevBlock (Hash32). */
export function getHeaderPrevHash(h: AnyEraHeader): Uint8Array | null {
    const any = h as any;
    if (any?.body?.prevHash != null) {
        const p = any.body.prevHash;
        return typeof p?.toBuffer === "function" ? p.toBuffer() : p;
    }
    if (any?.prevBlock != null) {
        const p = any.prevBlock;
        return typeof p?.toBuffer === "function" ? p.toBuffer() : p;
    }
    return null;
}

export function getHeaderPrevHashHex(h: AnyEraHeader): string {
    const bytes = getHeaderPrevHash(h);
    return bytes ? toHex(bytes) : "";
}

/**
 * Shelley+ transaction bodies. Byron returns [] (txPayload is a different type;
 * apply path stays Shelley-only until Byron UTxO apply is implemented).
 */
export function getShelleyTxBodies(b: AnyEraBlock): any[] {
    const any = b as any;
    if (Array.isArray(any?.transactionBodies)) return any.transactionBodies;
    return [];
}
