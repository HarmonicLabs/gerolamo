/**
 * Era-aware field accessors for cardano-ledger-ts ≥0.5 (Byron in MultiEra unions).
 *
 * Shelley+ headers:  header.body.slot / header.body.prevHash
 * Byron headers:     consensusData.slotId.slot / prevBlock
 * Shelley+ blocks:   transactionBodies
 * Byron blocks:      body.txPayload
 */

import type {
    AnyEraBlock,
    AnyEraHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";

/** Byron epoch length in slots (mainnet/preprod Byron: 21600 slots × 20s). */
const BYRON_SLOTS_PER_EPOCH = 21600n;

/**
 * Absolute slot from any era header (Byron uses epoch-local slotId).
 * Byron EBBs (Genesis/epoch-boundary, `ByronEbbHead`) carry no slotId —
 * consensusData is `{epoch, difficulty}` only. Anchor them to their
 * epoch-start slot (epoch × 21600), which preserves ordering: preprod
 * chunk 0 epoch-0 EBB = slot 0, epoch 1 starts at slot 21600 (verified).
 */
export function getHeaderSlot(h: AnyEraHeader): bigint {
    const any = h as any;
    if (any?.body?.slot != null) return BigInt(any.body.slot);
    if (any?.consensusData?.slotId?.slot != null) {
        return BigInt(any.consensusData.slotId.slot);
    }
    if (
        any?.constructor?.name === "ByronEbbHead" ||
        (any?.consensusData?.epoch != null &&
            any?.consensusData?.slotId == null)
    ) {
        return BigInt(any.consensusData.epoch) * BYRON_SLOTS_PER_EPOCH;
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
 * Shelley+ transaction bodies. Byron returns [] (use getByronTxPayloads).
 */
export function getShelleyTxBodies(b: AnyEraBlock): any[] {
    const any = b as any;
    if (Array.isArray(any?.transactionBodies)) return any.transactionBodies;
    return [];
}

/** True when block is Byron (era 0/1 or has txPayload, no Shelley bodies). */
export function isByronBlock(b: AnyEraBlock): boolean {
    const any = b as any;
    if (Array.isArray(any?.transactionBodies)) return false;
    if (Array.isArray(any?.body?.txPayload)) return true;
    // Header-only Byron epochs (empty payload) still count as Byron
    if (any?.consensusData?.slotId != null || any?.prevBlock != null) {
        return true;
    }
    return false;
}

/**
 * Byron body.txPayload entries (may be empty on preprod early chunks).
 * Each entry is ledger-ts Byron ATxAux-shaped; shape varies by version.
 */
export function getByronTxPayloads(b: AnyEraBlock): any[] {
    const any = b as any;
    const payload = any?.body?.txPayload;
    return Array.isArray(payload) ? payload : [];
}
