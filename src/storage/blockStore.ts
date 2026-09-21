/**
 * BlockStore: the one block API the node uses (docs/PLAN_CHUNK_STORE.md phase 3), layered over
 * cardano-node's own on-disk layout under `<db>/`:
 *
 *   immutable/   NNNNN.chunk|primary|secondary   (ChunkStore, blocks ≥ k deep on the selected chain)
 *   volatile/    blocks-N.dat                     (VolatileStore, the last k blocks and fork branches)
 *   gerolamo/    hash-index.bin                   (hash → slot for the immutable part)
 *
 * Reads answer from the volatile set first, then the chunks. `promote(tipHash, k)` walks the
 * selected chain back from its tip and moves every block more than k deep into the chunk store,
 * in slot order, then garbage-collects the volatile files that fell entirely below the new
 * immutable slot. A cardano-node can start on the same directory.
 */
import { join } from "node:path";
import { ChunkStore, type StoredBlock } from "./chunkStore";
import { VolatileStore, type VolatileBlock } from "./volatileStore";

export interface BlockStoreOptions {
    /** Security parameter k (432 preview/preprod, 2160 mainnet); chunk size is 10·k. */
    k: number;
    volatileBlocksPerFile?: number;
    /** Open a running node's directory without touching it (scripts, checkers). */
    readOnly?: boolean;
}

export interface BlockRecord {
    slot: number;
    hash: Uint8Array;
    /** `[eraTag, block]` bytes, as on the wire and on disk. */
    bytes: Uint8Array;
    headerOffset: number;
    headerSize: number;
    /** True when the block is in the chunk store. */
    immutable: boolean;
}

export class BlockStore {
    readonly dir: string;
    readonly k: number;
    readonly chunks: ChunkStore;
    readonly volatile: VolatileStore;

    private constructor(dir: string, k: number, chunks: ChunkStore, volatile: VolatileStore) {
        this.dir = dir;
        this.k = k;
        this.chunks = chunks;
        this.volatile = volatile;
    }

    static async open(dir: string, opts: BlockStoreOptions): Promise<BlockStore> {
        const chunks = await ChunkStore.open(join(dir, "immutable"), { chunkSlots: 10 * opts.k, hashIndexPath: join(dir, "gerolamo", "hash-index.bin"), readOnly: opts.readOnly });
        const volatile = await VolatileStore.open(join(dir, "volatile"), { blocksPerFile: opts.volatileBlocksPerFile, readOnly: opts.readOnly });
        return new BlockStore(dir, opts.k, chunks, volatile);
    }

    private static fromStored(b: StoredBlock): BlockRecord {
        return { slot: b.slot, hash: b.hash, bytes: b.bytes, headerOffset: b.headerOffset, headerSize: b.headerSize, immutable: true };
    }

    private static fromVolatile(b: VolatileBlock): BlockRecord {
        return { slot: b.slot, hash: b.hash, bytes: b.bytes, headerOffset: b.headerOffset, headerSize: b.headerSize, immutable: false };
    }

    /** Store a freshly adopted (or fetched) block in the volatile set. */
    async put(bytes: Uint8Array, hash?: Uint8Array): Promise<BlockRecord> {
        return BlockStore.fromVolatile(await this.volatile.put(bytes, hash));
    }

    async byHash(hash: Uint8Array): Promise<BlockRecord | null> {
        const v = this.volatile.get(hash);
        if (v) return BlockStore.fromVolatile(v);
        const c = await this.chunks.blockByHash(hash);
        return c ? BlockStore.fromStored(c) : null;
    }

    /**
     * The block at a slot. Volatile forks can hold several blocks per slot; `preferHash` picks
     * one, otherwise the first found is returned.
     */
    async bySlot(slot: number, preferHash?: Uint8Array): Promise<BlockRecord | null> {
        const vs = this.volatile.atSlot(slot);
        if (vs.length) {
            const pick = preferHash ? vs.find((b) => Buffer.from(b.hash).equals(Buffer.from(preferHash))) ?? vs[0]! : vs[0]!;
            return BlockStore.fromVolatile(pick);
        }
        const c = await this.chunks.blockAt(slot);
        return c ? BlockStore.fromStored(c) : null;
    }

    async has(hash: Uint8Array): Promise<boolean> {
        return this.volatile.has(hash) || (await this.chunks.slotOfHash(hash)) != null;
    }

    /** Immutable tip (chunk store). */
    async immutableTip(): Promise<BlockRecord | null> {
        const t = await this.chunks.tip();
        return t ? BlockStore.fromStored(t) : null;
    }

    /**
     * The chain from `tipHash` back through the volatile set, newest first, stopping at the first
     * block whose predecessor is not volatile (it is immutable or unknown).
     */
    volatileChain(tipHash: Uint8Array): VolatileBlock[] {
        const out: VolatileBlock[] = [];
        let cur = this.volatile.get(tipHash);
        const seen = new Set<string>();
        while (cur) {
            const key = Buffer.from(cur.hash).toString("hex");
            if (seen.has(key)) break;
            seen.add(key);
            out.push(cur);
            cur = cur.prevHash ? this.volatile.get(cur.prevHash) : undefined;
        }
        return out;
    }

    /**
     * Move every block more than `k` deep on the chain ending at `tipHash` into the chunk store,
     * oldest first, then drop the volatile files that are entirely at or below the new immutable
     * slot. The chain must connect to the immutable tip (or the store must be empty). Returns the
     * promoted blocks' count and the new immutable slot.
     */
    async promote(tipHash: Uint8Array, k = this.k): Promise<{ promoted: number; immutableSlot: number }> {
        const chain = this.volatileChain(tipHash); // newest first
        const oldestFirst = chain.slice().reverse();
        const toPromote = oldestFirst.slice(0, Math.max(0, oldestFirst.length - k));
        const imm = await this.chunks.tip();
        let promoted = 0;
        for (const b of toPromote) {
            if (imm && b.slot <= imm.slot && promoted === 0) continue; // already immutable (re-run after a crash)
            if (promoted === 0 && imm && b.prevHash && !Buffer.from(b.prevHash).equals(Buffer.from(imm.hash))) {
                // The first block to promote must extend the immutable tip: anything else means the
                // volatile chain does not connect and promotion would corrupt the chunk store.
                if (b.slot > imm.slot) throw new Error(`promote: block ${Buffer.from(b.hash).toString("hex").slice(0, 16)} at slot ${b.slot} does not extend the immutable tip ${Buffer.from(imm.hash).toString("hex").slice(0, 16)} (slot ${imm.slot})`);
            }
            await this.chunks.append({ slot: b.slot, hash: b.hash, bytes: b.bytes, isEbb: b.eraTag === 0 });
            promoted++;
        }
        const tip = await this.chunks.tip();
        const immutableSlot = tip ? tip.slot : -1;
        if (promoted) await this.volatile.gc(immutableSlot);
        return { promoted, immutableSlot };
    }

    /** Blocks on the chain ending at `tipHash` with slot in [fromSlot, toSlot], ascending (immutable part then volatile part). */
    async *iterate(fromSlot: number, toSlot: number, tipHash?: Uint8Array): AsyncGenerator<BlockRecord> {
        for await (const b of this.chunks.iterate(fromSlot, toSlot)) yield BlockStore.fromStored(b);
        if (!tipHash) return;
        const imm = await this.chunks.tip();
        const chain = this.volatileChain(tipHash).reverse();
        for (const b of chain) {
            if (imm && b.slot <= imm.slot) continue;
            if (b.slot < fromSlot) continue;
            if (b.slot > toSlot) return;
            yield BlockStore.fromVolatile(b);
        }
    }
}
