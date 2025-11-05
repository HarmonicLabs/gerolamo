import { PeerClient } from "./PeerClient";

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
