import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    ChainPoint,
    ChainSyncAwaitReply,
    ChainSyncFindIntersect,
    ChainSyncIntersectFound,
    ChainSyncIntersectNotFound,
    ChainSyncMessageDone,
    ChainSyncRequestNext,
    ChainSyncRollBackwards,
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

/** First messages of each session are traced at info level (env GEROLAMO_N2N_TRACE=0 disables). */
const TRACE_MESSAGES = process.env.GEROLAMO_N2N_TRACE === "0" ? 0 : 12;

export interface N2NChainSyncHostOptions {
    /** Peer label for the trace lines. */
    peer?: string;
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
    /**
     * The intersection just agreed: the first reply to the next MsgRequestNext is a
     * MsgRollBackward to it (network spec §3.7; the library server and our own client do it).
     * Skipping it made strict peers drop us two seconds into every session (2026-09-14
     * 01:30 UTC: 65.108.41.222 reconnected dozens of times, ran chain-sync, never fetched).
     */
    private pendingRollback: ChainPoint | null = null;
    private readonly peer: string;
    private traced = 0;
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
        this.peer = options.peer ?? "peer";
        this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);
        this.listener = (chunk, header) => {
            if (isN2NInitiatorFrame(header)) this.onChunk(chunk);
        };
        this.mplexer.on(MiniProtocol.ChainSync, this.listener);
    }

    /** Slot the client has been served up to (null while it has not found an intersection). */
    cursorSlot(): number | null {
        const s = this.cursor?.blockHeader?.slotNumber;
        return s == null ? null : Number(s);
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

    private trace(direction: "←" | "→", what: string): void {
        if (this.traced >= TRACE_MESSAGES) return;
        this.traced++;
        log.info(`ChainSync host ${this.peer} ${direction} ${what}`);
    }

    private send(message: { toCborBytes(): Uint8Array }): void {
        if (this.disposed) return;
        this.trace("→", describe(message));
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
            this.trace("←", describe(message));
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
            this.pendingRollback = found.point;
            this.send(new ChainSyncIntersectFound({ point: found.point, tip }));
            return;
        }
        if (message instanceof ChainSyncRequestNext) {
            if (this.pendingRollback) {
                const point = this.pendingRollback;
                this.pendingRollback = null;
                this.send(new ChainSyncRollBackwards({ point, tip: await this.store.getTip() }));
                return;
            }
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

function pointStr(p: any): string {
    const h = p?.blockHeader;
    return h ? `${String(h.slotNumber)}:${Buffer.from(h.hash ?? new Uint8Array()).toString("hex").slice(0, 8)}` : "origin";
}
function describe(m: any): string {
    if (m instanceof ChainSyncFindIntersect) return `FindIntersect ${m.points.length} point(s) [${m.points.slice(0, 3).map(pointStr).join(", ")}${m.points.length > 3 ? ", …" : ""}]`;
    if (m instanceof ChainSyncIntersectFound) return `IntersectFound ${pointStr(m.point)} tip ${pointStr(m.tip?.point)}#${String(m.tip?.blockNo)}`;
    if (m instanceof ChainSyncIntersectNotFound) return `IntersectNotFound tip ${pointStr(m.tip?.point)}`;
    if (m instanceof ChainSyncRequestNext) return "RequestNext";
    if (m instanceof ChainSyncRollBackwards) return `RollBackward ${pointStr(m.point)} tip ${pointStr(m.tip?.point)}#${String(m.tip?.blockNo)}`;
    if (m instanceof ChainSyncRollForward) return `RollForward tip ${pointStr(m.tip?.point)}#${String(m.tip?.blockNo)}`;
    if (m instanceof ChainSyncAwaitReply) return "AwaitReply";
    if (m instanceof ChainSyncMessageDone) return "Done";
    return String(m?.constructor?.name ?? m);
}

