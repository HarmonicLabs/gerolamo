/**
 * Re-derive the nonce evolver's state for an epoch from the headers stored in
 * the `blocks` table: bootstrap with the epoch's η0 and ηh, then UPDN every
 * applied header of the epoch in slot order. Used after a restart or a rollback
 * (the stored ηv/ηc are only valid for the exact chain they were computed on)
 * and by scripts/verify-nonces.ts to check whole epochs against a reference.
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { NonceEvolver, type TicknResult } from "./nonceEvolver";
import { getFirstSlotOfEpoch } from "./epochFromSlotCalculations";

export interface StoredHeaderRow {
    slot: number;
    block_data: Uint8Array;
    /** Header hash (hex or bytes) — only used for reporting. */
    hash?: string | Uint8Array;
}

/** Slot, block nonce and previous-hash of a stored block, or null for Byron / unparsable. */
export function nonceFactsOf(row: StoredHeaderRow): { slot: bigint; bnonce: Uint8Array; prevHash: Uint8Array | null } | null {
    try {
        const m: any = MultiEraBlock.fromCbor(row.block_data);
        if (Number(m.era) < 2) return null;
        const header = m.block?.header;
        const bnonce = NonceEvolver.extractBlockNonce(header);
        if (!bnonce) return null;
        const body = header?.body ?? header;
        const prev: any = body?.prevHash;
        const prevBytes: Uint8Array | null = prev == null ? null : prev instanceof Uint8Array ? prev : typeof prev.toBuffer === "function" ? prev.toBuffer() : Buffer.from(String(prev), "hex");
        return { slot: BigInt(body?.slot ?? row.slot), bnonce, prevHash: prevBytes };
    } catch {
        return null;
    }
}

export interface ReplayResult {
    evolver: NonceEvolver;
    ticks: TicknResult[];
    blocks: number;
}

/**
 * Replay `rows` (ascending slot) starting from `startEpoch` with η0 = `eta0Hex`.
 * `etaHHex` is needed only when the replay starts mid-way (it is what TICKN
 * mixes in at the first boundary); when the rows cover the previous epoch it
 * is derived from them.
 */
export function replayNonces(genesis: any, startEpoch: number, eta0Hex: string, rows: Iterable<StoredHeaderRow>, opts: { etaHHex?: string | null; etaVHex?: string; etaCHex?: string; stopAfterSlot?: bigint } = {}): ReplayResult {
    const ev = new NonceEvolver(genesis);
    ev.bootstrap(startEpoch, eta0Hex, { etaHHex: opts.etaHHex ?? null, etaVHex: opts.etaVHex, etaCHex: opts.etaCHex });
    const ticks: TicknResult[] = [];
    let blocks = 0;
    const first = BigInt(getFirstSlotOfEpoch(startEpoch, genesis));
    for (const row of rows) {
        const f = nonceFactsOf(row);
        if (!f || f.slot < first) continue;
        if (opts.stopAfterSlot != null && f.slot > opts.stopAfterSlot) break;
        ticks.push(...ev.processBlock(f.slot, f.bnonce, f.prevHash));
        blocks++;
    }
    return { evolver: ev, ticks, blocks };
}

export function ticknEpochNonceHex(t: TicknResult): string {
    const anyT: any = t;
    const v = anyT.eta0Hex ?? anyT.epochNonceHex ?? anyT.nonceHex ?? anyT.eta0;
    return typeof v === "string" ? v : v instanceof Uint8Array ? toHex(v) : String(v);
}
