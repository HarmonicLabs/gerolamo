import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    ChainPoint,
    ChainSyncAwaitReply,
    ChainSyncFindIntersect,
    ChainSyncIntersectFound,
    ChainSyncIntersectNotFound,
    ChainSyncMessageDone,
    ChainSyncRequestNext,
    ChainSyncRollForward,
    MiniProtocol,
    Multiplexer,
    type MultiplexerHeader,
    chainSyncMessageFromCborObj,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../../utils/logger";
import { isN2NInitiatorFrame, sendN2NResponder } from "./N2NDirection";
import type { RelayChainStore, RelayHeader } from "./RelayChainStore";

const log = logger.child("n2n.chainsync");

export interface N2NChainSyncHostOptions {
    pollIntervalMs?: number;
}

export class N2NChainSyncHost {
    private readonly mplexer: Multiplexer;
    private readonly store: RelayChainStore;
    private readonly pollIntervalMs: number;
    private readonly listener: (
        chunk: Uint8Array,
        header?: MultiplexerHeader,
    ) => void;
    private cursor: ChainPoint = ChainPoint.origin;
    private previousBytes: Uint8Array | undefined;
    private handleChain: Promise<void> = Promise.resolve();
    private pollTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(
        mplexer: Multiplexer,
        store: RelayChainStore,
        options: N2NChainSyncHostOptions = {},
    ) {
        this.mplexer = mplexer;
        this.store = store;
        this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);
        this.listener = (chunk, header) => {
            if (isN2NInitiatorFrame(header)) this.onChunk(chunk);
        };
        this.mplexer.on(MiniProtocol.ChainSync, this.listener);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
        try {
            this.mplexer.off(MiniProtocol.ChainSync, this.listener);
        } catch {
            /* ignore */
        }
    }

    private send(message: { toCborBytes(): Uint8Array }): void {
        if (this.disposed) return;
        sendN2NResponder(
            this.mplexer,
            MiniProtocol.ChainSync,
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
            const message = chainSyncMessageFromCborObj(parsed);
            const run = this.handleChain.then(() => this.handleMessage(message));
            this.handleChain = run.catch((error) => {
                log.error("ChainSync request failed:", error);
                this.dispose();
            });
            if (offset >= data.length) return;
            data = data.subarray(offset);
        }
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (message instanceof ChainSyncFindIntersect) {
            const tip = await this.store.getTip();
            const found = await this.store.findIntersect([...message.points]);
            if (!found) {
                this.send(new ChainSyncIntersectNotFound({ tip }));
                return;
            }
            this.cursor = found.point;
            this.send(new ChainSyncIntersectFound({ point: found.point, tip }));
            return;
        }
        if (message instanceof ChainSyncRequestNext) {
            await this.sendNextOrAwait();
            return;
        }
        if (message instanceof ChainSyncMessageDone) this.dispose();
    }

    private async sendNextOrAwait(): Promise<void> {
        const next = await this.store.getNextHeader(this.cursor);
        if (next) {
            await this.sendHeader(next);
            return;
        }
        this.send(new ChainSyncAwaitReply());
        this.schedulePoll();
    }

    private async sendHeader(header: RelayHeader): Promise<void> {
        const tip = await this.store.getTip();
        this.cursor = header.point;
        this.send(new ChainSyncRollForward({ data: header.data, tip }));
    }

    private schedulePoll(): void {
        if (this.pollTimer || this.disposed) return;
        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            void this.pollForNext();
        }, this.pollIntervalMs);
    }

    private async pollForNext(): Promise<void> {
        if (this.disposed) return;
        try {
            const next = await this.store.getNextHeader(this.cursor);
            if (next) {
                await this.sendHeader(next);
                return;
            }
        } catch (error) {
            log.warn("tip poll failed:", error);
        }
        this.schedulePoll();
    }
}
