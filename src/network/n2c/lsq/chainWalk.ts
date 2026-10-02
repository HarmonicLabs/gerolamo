/**
 * The selected chain's blocks from a slot up to an acquired block, oldest first: chunk-store
 * blocks below the volatile part, then the volatile chain down from the block. Works for a past
 * point too (the volatile walk starts at that block, not at the node's tip).
 */
import type { BlockStore } from "../../../storage/blockStore";

export interface WalkedBlock { slot: number; hash: Uint8Array; bytes: Uint8Array }

export async function* chainBlocks(bs: BlockStore, fromSlot: number, toHashHex: string, toSlot: number): AsyncGenerator<WalkedBlock> {
    const vol = bs.volatileChain(Uint8Array.from(Buffer.from(toHashHex, "hex"))).filter((v) => v.slot >= fromSlot).reverse();
    const firstVol = vol.length ? vol[0]!.slot : toSlot + 1;
    if (firstVol > fromSlot) for await (const b of bs.chunks.iterate(fromSlot, Math.min(toSlot, firstVol - 1))) yield { slot: b.slot, hash: b.hash, bytes: b.bytes };
    for (const v of vol) yield { slot: v.slot, hash: v.hash, bytes: v.bytes };
}
