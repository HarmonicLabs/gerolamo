import { describe, expect, test } from "bun:test";
import {
    ConwayBlock,
    MultiEraBlock,
    PoolKeyHash,
} from "@harmoniclabs/cardano-ledger-ts";
import * as filepath from "node:path/posix";
import * as fsPromises from "node:fs/promises";

import { applyBlock } from "./BlockApplication";
import { RawNewEpochState } from "../rawNES";

const BLOCKS = [
    "conway1.block",
    "conway3.block",
];

const BLOCKS_DIR = async () => {
    return await fsPromises.realpath("./blocks");
};

async function getBlock(filePath: string): Promise<MultiEraBlock> {
    return Bun.file(filePath).text().then((hex) =>
        MultiEraBlock.fromCbor(Buffer.from(hex, "hex"))
    );
}

test("Parse and apply blocks", async () => {
    let blocks = await BLOCKS_DIR().then((dir) =>
        Promise.all(
            BLOCKS.map((block) => filepath.join(dir, block)).map(getBlock),
        )
    );

    let cBlocks: ConwayBlock[] = blocks.map((block) => {
        expect(block.era).toBe(7 /*Conway-era blocks for testing*/);
        return block.block as ConwayBlock;
    });

    const state = RawNewEpochState.init();

    // Apply blocks using the proper applyBlock function
    // Note: This will fail input validation since test blocks reference UTxOs
    // from previous blocks. For a proper test, we'd need genesis blocks or
    // initialize state with the required UTxOs.
    const mockIssuer = new PoolKeyHash(
        Buffer.from("mockpoolkeyhash12345678901234567890123456789012", "hex"),
    );
    cBlocks.forEach((block) => applyBlock(block, state, mockIssuer));

    // Test blocks are valid and applied successfully
    expect(state.epochState.ledgerState.UTxOState.UTxO.length).toBeGreaterThan(
        0,
    );
    expect(state.epochState.chainAccountState.casTreasury).toBeGreaterThan(0n);
});
