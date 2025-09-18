import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { logger } from "../utils/logger";
import { peerManager } from "../cli";
export async function fetchBlock(
    peerId: string,
    slot: number | bigint,
    blockHeaderHash: any,
) {
    // const peers = peerManager.getAllPeers();
    //logger.debug("peers: ", peers);
    // const peer = allPeers.get(peerId);
    // if (!peer) throw new Error("Peer not found");
    // console.log("peer: ", peer)
    const block = await peer.fetchBlock(
        slot,
        blockHeaderHash,
    );
    return block;
}

function validateBlock(multiEraBlocks: any): boolean {
    // logger.log("Validating block", block );
    multiEraBlocks.map((b: MultiEraBlock) => {
        logger.log("\nBlock item:", b.toCbor().toString());
    });
    return true;
}