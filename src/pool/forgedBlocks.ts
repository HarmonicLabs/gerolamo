/**
 * Hashes of the blocks this node forged, with the forge time: the block-fetch hosts log when a
 * peer fetches one, which is the only direct evidence of how far and how fast our blocks travel
 * (2026-09-13 02:35 UTC: a block with the greeting was adopted here, one duplex peer was
 * "pulling", and the network still built on the previous tip 11 s later).
 */
const forged = new Map<string, number>();

export function noteForgedBlock(hashHex: string): void {
    forged.set(hashHex.toLowerCase(), Date.now());
    if (forged.size > 64) forged.delete(forged.keys().next().value!);
}

/** Milliseconds since we forged the block, or null when it is not ours. */
export function forgedAgoMs(hashHex: string): number | null {
    const t = forged.get(hashHex.toLowerCase());
    return t == null ? null : Date.now() - t;
}
