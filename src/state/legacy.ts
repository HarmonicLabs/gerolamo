import assert from "node:assert/strict";
import { format, isAbsolute } from "node:path";

import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";

import { Logger } from "../utils/logger";
import { sql } from "../sql";
import { applyBlock } from "../consensus/BlockApplication";
import {
    getByronTxPayloads,
    getHeaderSlot,
    getShelleyTxBodies,
    isByronBlock,
} from "../utils/eraAccessors";

interface RawChunkBlock {
    slotNo: bigint;
    headerHash: Uint8Array;
    blockHash: Uint8Array;
    blockCbor: Uint8Array;
    headerOffset: number;
    headerSize: number;
    crc: number;
}

export type ProcessChunkResult = {
    blocks: number;
    applied: number;
    errors: number;
    /** Shelley+ tx bodies + Byron payloads counted across applied blocks. */
    txs: number;
    /** Sum of input counts across applied Shelley txs (best-effort). */
    inputs: number;
    /** Sum of output counts across applied Shelley txs (best-effort). */
    outputs: number;
    firstSlot: string | null;
    lastSlot: string | null;
    /** Era histogram for applied blocks, e.g. { "6": 1000 }. */
    eras: Record<string, number>;
};

export function parseChunk(
    primaryDV: DataView,
    secondaryDV: DataView,
    chunkDV: DataView,
): RawChunkBlock[] {
    const offsets = Array.from(
        { length: (primaryDV.byteLength - 1) / 4 },
        (_, i) => primaryDV.getUint32(i * 4 + 1, false),
    );
    const filledRelSlots = offsets.flatMap((offset, i) =>
        i < offsets.length - 1 && offset !== offsets[i + 1] ? [i] : []
    );

    const blockOffs = filledRelSlots.map((relSlot) =>
        secondaryDV.getBigUint64(offsets[relSlot], false)
    );
    return filledRelSlots
        .map((relSlot, i) => {
            const secOff = offsets[relSlot];
            const headerHash = new Uint8Array(
                secondaryDV.buffer.slice(secOff + 16, secOff + 48),
            );

            const blockStartOff = Number(blockOffs[i]);
            const blockEndOff = i < filledRelSlots.length - 1
                ? Number(blockOffs[i + 1])
                : chunkDV.byteLength;
            return {
                slotNo: secondaryDV.getBigUint64(secOff + 48, false),
                headerHash,
                blockHash: headerHash,
                headerOffset: secondaryDV.getUint16(secOff + 8, false),
                headerSize: secondaryDV.getUint16(secOff + 10, false),
                crc: secondaryDV.getUint32(secOff + 12, false),
                blockCbor: new Uint8Array(
                    chunkDV.buffer.slice(blockStartOff, blockEndOff),
                ),
            };
        });
}

function countBlockBodyStats(meb: MultiEraBlock): {
    txs: number;
    inputs: number;
    outputs: number;
} {
    try {
        if (isByronBlock(meb.block as any)) {
            return {
                txs: getByronTxPayloads(meb.block as any).length,
                inputs: 0,
                outputs: 0,
            };
        }
        const bodies = getShelleyTxBodies(meb.block);
        let inputs = 0;
        let outputs = 0;
        for (const tb of bodies) {
            try {
                const ins = (tb as any)?.inputs;
                if (Array.isArray(ins)) inputs += ins.length;
            } catch { /* best effort */ }
            try {
                const outs = (tb as any)?.outputs;
                if (Array.isArray(outs)) outputs += outs.length;
            } catch { /* best effort */ }
        }
        return { txs: bodies.length, inputs, outputs };
    } catch {
        return { txs: 0, inputs: 0, outputs: 0 };
    }
}

/**
 * Apply one immutable chunk. Logging is quiet by default:
 * one optional start line (caller), per-block errors only, no per-tx spam.
 * Callers (gap-fill applier) print progress with applied/left totals.
 */
export async function processChunk(
    dir: string,
    chunkNo: number,
    logger: Logger,
    client?: import("../db").SqlClient,
): Promise<ProcessChunkResult> {
    assert(isAbsolute(dir));

    const parsedFNo = chunkNo.toString().padStart(5, "0");
    const [primaryBytes, secondaryBytes, chunkBytes] = await Promise
        .all([
            Bun.file(format({ dir, base: `${parsedFNo}.primary` }))
                .arrayBuffer(),
            Bun.file(format({ dir, base: `${parsedFNo}.secondary` }))
                .arrayBuffer(),
            Bun.file(format({ dir, base: `${parsedFNo}.chunk` }))
                .arrayBuffer(),
        ]);
    const primaryDV = new DataView(primaryBytes);
    const secondaryDV = new DataView(secondaryBytes);
    const chunkDV = new DataView(chunkBytes);

    if (primaryDV.getUint8(0) !== 1) {
        throw new Error(
            `Invalid primary version in chunk ${chunkNo}`,
        );
    }

    const blocks = parseChunk(
        primaryDV,
        secondaryDV,
        chunkDV,
    );

    let appliedCount = 0;
    let errorCount = 0;
    let txs = 0;
    let inputs = 0;
    let outputs = 0;
    let firstSlot: string | null = null;
    let lastSlot: string | null = null;
    const eras: Record<string, number> = {};

    const applyLoop = async (): Promise<void> => {
        for (const block of blocks) {
            let era: number | string = "?";
            let blockHashHex = "";
            try {
                const meb = MultiEraBlock.fromCbor(block.blockCbor);
                era = meb.era;
                blockHashHex = toHex(block.blockHash);

                const stats = countBlockBodyStats(meb);

                await applyBlock(
                    meb.block,
                    getHeaderSlot(meb.block.header),
                    blake2b_256(meb.block.header.toCborBytes()),
                    client,
                );
                appliedCount++;
                txs += stats.txs;
                inputs += stats.inputs;
                outputs += stats.outputs;
                const eraKey = String(era);
                eras[eraKey] = (eras[eraKey] ?? 0) + 1;
                const slotStr = String(block.slotNo);
                if (firstSlot === null) firstSlot = slotStr;
                lastSlot = slotStr;
            } catch (e) {
                // Honest error surface: this catch is NOT Byron-specific.
                // (Byron empty-payload blocks return normally in applyBlock and
                // never reach here.) Log the real error + era for triage.
                // Bun .begin() keeps the transaction alive when the error is
                // caught here (verified), so the chunk still commits.
                const msg = e instanceof Error ? e.message : String(e);
                logger.warn(
                    `Chunk ${chunkNo} block apply error (era ${era}, block ${blockHashHex || toHex(block.blockHash)}): ${msg}`,
                );
                errorCount++;
            }
        }
    };

    if (client) {
        // Caller manages the transaction (batch hydrate) — apply inline.
        await applyLoop();
    } else {
        // Own the connection: ONE transaction per chunk. Without this every
        // statement was its own implicit tx (fsync each) — ~100k fsyncs per
        // chunk on busy eras. Chunk-per-commit keeps halt/resume semantics:
        // a fully failed chunk commits nothing.
        await (client ?? sql).begin(applyLoop);
    }

    return {
        blocks: blocks.length,
        applied: appliedCount,
        errors: errorCount,
        txs,
        inputs,
        outputs,
        firstSlot,
        lastSlot,
        eras,
    };
}
