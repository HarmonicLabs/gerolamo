import assert from "node:assert/strict";
import { format, isAbsolute } from "node:path";

import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";

import { Logger } from "../utils/logger";
import { applyBlock } from "../consensus/BlockApplication";

interface RawChunkBlock {
    slotNo: bigint;
    headerHash: Uint8Array;
    blockHash: Uint8Array;
    blockCbor: Uint8Array;
    headerOffset: number;
    headerSize: number;
    crc: number;
}

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

export async function processChunk(dir: string, chunkNo: number, logger: Logger): Promise<void> {
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
    
    for (let block of blocks) {
        try {
            const meb = MultiEraBlock.fromCbor(block.blockCbor);
            
            logger.info(`Applying era ${meb.era} block: ${toHex(block.blockHash)}`);

            await applyBlock(
                meb.block,
                meb.block.header.body.slot,
                blake2b_256(meb.block.header.toCborBytes())
            );
        } catch {
            logger.info(`Skipping Byron block: ${toHex(block.blockHash)}`);
        }
    }
}
