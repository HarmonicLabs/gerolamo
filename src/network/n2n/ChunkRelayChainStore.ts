/**
 * RelayChainStore over the cardano-node-format BlockStore (docs/PLAN_CHUNK_STORE.md phase 3):
 * the selected chain the N2N server offers to peers, read from the chunk files and the volatile
 * set instead of SQLite. Same contract as SqliteRelayChainStore: tips carry the header's own
 * block number, headers are served as the ChainSync RollForward payload `[era − 1, #6.24(header)]`,
 * blocks as the `[era, block]` bytes, and a range must be a hash-linked prefix of the chain.
 *
 * The selected tip is whatever the consensus layer last adopted (`setTip`), falling back to the
 * highest volatile block that extends the immutable tip, then to the immutable tip itself.
 */
import { CborArray, CborBytes, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { ChainPoint, ChainTip } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { BlockRecord, BlockStore } from "../../storage/blockStore";
import { selectedTip as selectedTipFallback } from "../../storage/blockReads";
import { locateHeader } from "../../storage/chunkFormat";
import { blockNoOf, prevHashOf } from "../../storage/volatileStore";
import type { RelayBlock, RelayChainStore, RelayHeader, RelayIntersection } from "./RelayChainStore";

export class ChunkRelayChainStore implements RelayChainStore {
    private tipHash: Uint8Array | null = null;

    constructor(readonly store: BlockStore) {}

    /** The consensus layer's selected tip (hash); volatile forks are resolved through it. */
    setTip(hash: Uint8Array | string | null): void {
        this.tipHash = hash == null ? null : typeof hash === "string" ? Uint8Array.from(Buffer.from(hash, "hex")) : hash;
    }

    private async selectedTip(): Promise<BlockRecord | null> {
        if (this.tipHash) {
            const b = await this.store.byHash(this.tipHash);
            if (b) return b;
        }
        return selectedTipFallback(this.store); // highest volatile block whose chain reaches the immutable tip, else that tip
    }

    private static intersection(b: BlockRecord): RelayIntersection {
        return {
            point: new ChainPoint({ blockHeader: { slotNumber: BigInt(b.slot), hash: b.hash } }),
            blockNo: BigInt(blockNoOf(b.bytes) ?? b.slot),
        };
    }

    /** ChainSync RollForward payload for a Shelley-era block; Byron blocks are not served as headers. */
    static headerPayload(b: BlockRecord): CborObj | undefined {
        const h = locateHeader(b.bytes);
        if (h.eraTag < 2) return undefined;
        return new CborArray([
            new CborUInt(BigInt(h.eraTag - 1)),
            new CborTag(24n, new CborBytes(b.bytes.slice(h.headerOffset, h.headerOffset + h.headerSize))),
        ]);
    }

    async getTip(): Promise<ChainTip> {
        const tip = await this.selectedTip();
        if (!tip) return new ChainTip({ point: ChainPoint.origin, blockNo: 0n });
        return new ChainTip(ChunkRelayChainStore.intersection(tip));
    }

    /** True when the block is on the selected chain (immutable, or on the volatile path down from the tip). */
    private async onSelectedChain(b: BlockRecord): Promise<boolean> {
        if (b.immutable) return true;
        const tip = await this.selectedTip();
        if (!tip) return false;
        return this.store.volatileChain(tip.hash).some((v) => Buffer.from(v.hash).equals(Buffer.from(b.hash)));
    }

    async findIntersect(points: readonly ChainPoint[]): Promise<RelayIntersection | undefined> {
        for (const point of points) {
            if (!point.blockHeader) return { point: ChainPoint.origin, blockNo: 0n };
            const b = await this.store.byHash(point.blockHeader.hash);
            if (b && BigInt(b.slot) === BigInt(point.blockHeader.slotNumber) && (await this.onSelectedChain(b))) return ChunkRelayChainStore.intersection(b);
        }
        return undefined;
    }

    /** The selected chain's blocks with slot in (afterSlot, ∞), ascending, up to `max`. */
    private async chainAfter(afterSlot: bigint, max: number): Promise<BlockRecord[]> {
        const tip = await this.selectedTip();
        if (!tip) return [];
        const imm = await this.store.immutableTip();
        const out: BlockRecord[] = [];
        if (!imm || afterSlot < BigInt(imm.slot)) {
            for await (const b of this.store.chunks.iterate(Number(afterSlot) + 1, imm ? imm.slot : Number.MAX_SAFE_INTEGER)) {
                out.push({ slot: b.slot, hash: b.hash, bytes: b.bytes, headerOffset: b.headerOffset, headerSize: b.headerSize, immutable: true });
                if (out.length >= max) return out;
            }
        }
        const vol = this.store.volatileChain(tip.hash).reverse();
        for (const v of vol) {
            if (imm && v.slot <= imm.slot) continue;
            if (BigInt(v.slot) <= afterSlot) continue;
            out.push({ slot: v.slot, hash: v.hash, bytes: v.bytes, headerOffset: v.headerOffset, headerSize: v.headerSize, immutable: false });
            if (out.length >= max) break;
        }
        return out;
    }

    async getNextHeader(after: ChainPoint): Promise<RelayHeader | undefined> {
        const afterSlot = after.blockHeader?.slotNumber ?? -1n;
        const [next] = await this.chainAfter(BigInt(afterSlot), 1);
        if (!next) return undefined;
        const data = ChunkRelayChainStore.headerPayload(next);
        if (!data) return undefined;
        return { ...ChunkRelayChainStore.intersection(next), data };
    }

    async getBlockRange(from: ChainPoint, to: ChainPoint, maxBlocks: number): Promise<RelayBlock[] | undefined> {
        const fromSlot = from.blockHeader?.slotNumber, toSlot = to.blockHeader?.slotNumber;
        if (fromSlot === undefined || toSlot === undefined || BigInt(fromSlot) > BigInt(toSlot)) return undefined;
        const first = await this.store.byHash(from.blockHeader!.hash);
        if (!first || BigInt(first.slot) !== BigInt(fromSlot) || !(await this.onSelectedChain(first))) return undefined;
        const rest = await this.chainAfter(BigInt(fromSlot), Math.max(1, Math.trunc(maxBlocks)));
        const rows = [first, ...rest].filter((b) => BigInt(b.slot) <= BigInt(toSlot));
        if (rows.length === 0 || rows.length > maxBlocks) return undefined;
        const last = rows[rows.length - 1]!;
        if (toHex(last.hash) !== toHex(to.blockHeader!.hash)) return undefined;
        for (let i = 1; i < rows.length; i++) {
            const prev = prevHashOf(rows[i]!.bytes);
            if (!prev || toHex(prev) !== toHex(rows[i - 1]!.hash)) return undefined;
        }
        return rows.map((b) => ({ ...ChunkRelayChainStore.intersection(b), blockData: b.bytes }));
    }
}
