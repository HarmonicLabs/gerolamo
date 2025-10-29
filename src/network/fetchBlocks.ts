import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { logger } from "../utils/logger";

export async function fetchBlock(
    peer: PeerClient,
    slot: number | bigint,
    blockHeaderHash: any,
) {
    // console.log("peer: ", peer)
    const block = await peer.fetchBlock(
        slot,
        blockHeaderHash,
    );
    return block;
}

function validateBlock(multiEraBlocks: any): boolean {
    return true;
}
