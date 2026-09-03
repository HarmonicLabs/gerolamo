import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    BlockFetchBatchDone,
    BlockFetchBlock,
    BlockFetchClientDone,
    BlockFetchNoBlocks,
    BlockFetchRequestRange,
    BlockFetchStartBatch,
    MiniProtocol,
    Multiplexer,
    type MultiplexerHeader,
    blockFetchMessageFromCborObj,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../../utils/logger";
import { isN2NInitiatorFrame, sendN2NResponder } from "./N2NDirection";
import type { RelayChainStore } from "./RelayChainStore";

const log = logger.child("n2n.blockfetch");

export interface N2NBlockFetchHostOptions {
    maxRangeBlocks?: number;
}

export class N2NBlockFetchHost {
    private readonly mplexer: Multiplexer;
    private readonly store: RelayChainStore;
    private readonly maxRangeBlocks: number;
    private readonly listener: (
        chunk: Uint8Array,
        header?: MultiplexerHeader,
    ) => void;
    private previousBytes: Uint8Array | undefined;
    private handleChain: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(
        mplexer: Multiplexer,
        store: RelayChainStore,
        options: N2NBlockFetchHostOptions = {},
    ) {
        this.mplexer = mplexer;
        this.store = store;
        this.maxRangeBlocks = Math.min(
            4_096,
            Math.max(1, Math.trunc(options.maxRangeBlocks ?? 256)),
        );
        this.listener = (chunk, header) => {
            if (isN2NInitiatorFrame(header)) this.onChunk(chunk);
        };
        this.mplexer.on(MiniProtocol.BlockFetch, this.listener);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try {
            this.mplexer.off(MiniProtocol.BlockFetch, this.listener);
        } catch {
            /* ignore */
        }
    }

    private send(message: { toCborBytes(): Uint8Array }): void {
        if (this.disposed) return;
        sendN2NResponder(
            this.mplexer,
            MiniProtocol.BlockFetch,
            message.toCborBytes(),
        );
    }

    private onChunk(chunk: Uint8Array): void {
        let data = chunk;
        if (this.previousBytes) {
            const joined = new Uint8Array(this.previousBytes.length + chunk.length);
            joined.set(this.previousBytes);
            joined.set(chunk, this.previousBytes.length);
            data = joined;
            this.previousBytes = undefined;
        }

        while (data.length > 0) {
            let parsed: CborObj;
            let offset: number;
            try {
                const result = Cbor.parseWithOffset(data);
                parsed = result.parsed;
                offset = result.offset;
            } catch {
                this.previousBytes = Uint8Array.prototype.slice.call(data);
                return;
            }
            const message = blockFetchMessageFromCborObj(parsed);
            const run = this.handleChain.then(() => this.handleMessage(message));
            this.handleChain = run.catch((error) => {
                log.error("BlockFetch request failed:", error);
                this.send(new BlockFetchNoBlocks());
            });
            if (offset >= data.length) return;
            data = data.subarray(offset);
        }
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (message instanceof BlockFetchClientDone) {
            this.dispose();
            return;
        }
        if (!(message instanceof BlockFetchRequestRange)) return;

        const fromSlot = message.from.blockHeader?.slotNumber;
        const toSlot = message.to.blockHeader?.slotNumber;
        if (
            fromSlot === undefined ||
            toSlot === undefined ||
            BigInt(fromSlot) > BigInt(toSlot)
        ) {
            this.send(new BlockFetchNoBlocks());
            return;
        }

        const blocks = await this.store.getBlockRange(
            message.from,
            message.to,
            this.maxRangeBlocks,
        );
        if (!blocks || blocks.length === 0) {
            this.send(new BlockFetchNoBlocks());
            return;
        }

        this.send(new BlockFetchStartBatch());
        for (const block of blocks) {
            this.send(new BlockFetchBlock({ blockData: block.blockData }));
        }
        this.send(new BlockFetchBatchDone());
    }
}
