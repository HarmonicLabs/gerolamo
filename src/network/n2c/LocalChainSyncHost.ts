import { Cbor, CborBytes, CborTag, type CborObj } from "@harmoniclabs/cbor";
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
    ChainTip,
    MiniProtocol,
    Multiplexer,
    chainSyncMessageFromCborObj,
    type IChainPoint,
    type IChainTip,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
// Not re-exported at package root.
import type {
    IChainDb,
    IExtendData,
} from "@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/interfaces/IChainDb.js";
import { logger } from "../../utils/logger";

const log = logger.child("n2c.localchainsync");

const PROTO = MiniProtocol.LocalChainSync;

/**
 * N2C LocalChainSync server (mini-protocol 5).
 *
 * Library ChainSyncServer is hard-coded to N2N protocol 2; this host mirrors
 * its logic but listens/sends on LocalChainSync.
 */
export class LocalChainSyncHost {
    readonly mplexer: Multiplexer;
    readonly chainDb: IChainDb;

    private clientIndex = 0n;
    private tip: ChainTip = new ChainTip({
        point: ChainPoint.origin,
        blockNo: 0n,
    });
    private prevIntersectPoint: ChainPoint | undefined;
    private synced = false;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;
    private awaitingExtend = false;

    constructor(mplexer: Multiplexer, chainDb: IChainDb) {
        this.mplexer = mplexer;
        this.chainDb = chainDb;

        void this.chainDb.getTip().then((t) => {
            this.tip = new ChainTip(t);
        });

        this.listener = (chunk) => this.onChunk(chunk);
        this.mplexer.on(PROTO, this.listener);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try {
            this.mplexer.off(PROTO, this.listener);
        } catch {
            /* ignore */
        }
        this.chainDb.off("extend");
        this.chainDb.off("fork");
    }

    private send(msg: { toCbor: () => { toBuffer: () => Uint8Array } }): void {
        this.mplexer.send(msg.toCbor().toBuffer(), {
            hasAgency: true,
            protocol: PROTO,
        });
    }

    private onChunk(chunk: Uint8Array): void {
        if (this.disposed) return;

        let data = chunk;
        if (this.prevBytes) {
            const tmp = new Uint8Array(this.prevBytes.length + chunk.length);
            tmp.set(this.prevBytes, 0);
            tmp.set(chunk, this.prevBytes.length);
            data = tmp;
            this.prevBytes = undefined;
        }

        while (data.length > 0) {
            let parsed: CborObj;
            let offset: number;
            try {
                const thing = Cbor.parseWithOffset(data);
                parsed = thing.parsed;
                offset = thing.offset;
            } catch {
                this.prevBytes = Uint8Array.prototype.slice.call(data);
                return;
            }

            try {
                const msg = chainSyncMessageFromCborObj(parsed);
                void this.handleMessage(msg);
            } catch (err) {
                log.error("LocalChainSync parse/handle error:", err);
            }

            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handleMessage(msg: unknown): Promise<void> {
        if (msg instanceof ChainSyncFindIntersect) {
            await this.handleFindIntersect([...msg.points]);
            return;
        }
        if (msg instanceof ChainSyncRequestNext) {
            await this.handleRequestNext();
            return;
        }
        if (msg instanceof ChainSyncMessageDone) {
            this.dispose();
        }
    }

    private async handleFindIntersect(points: IChainPoint[]): Promise<void> {
        const intersection = await this.chainDb.findIntersect(...points);
        const tip = await this.chainDb.getTip();
        this.tip = new ChainTip(tip);

        if (!intersection) {
            this.send(new ChainSyncIntersectNotFound({ tip }));
            return;
        }

        const found = new ChainTip(intersection);
        this.clientIndex = BigInt(found.blockNo);
        this.prevIntersectPoint = found.point;
        this.synced = false;
        this.send(
            new ChainSyncIntersectFound({
                point: found.point,
                tip,
            }),
        );
        log.info(
            `intersect found blockNo=${found.blockNo} tip.blockNo=${tip.blockNo}`,
        );
    }

    private async handleRequestNext(): Promise<void> {
        const tip = await this.chainDb.getTip();
        this.tip = new ChainTip(tip);

        if (this.prevIntersectPoint !== undefined) {
            const point = this.prevIntersectPoint;
            this.prevIntersectPoint = undefined;
            this.send(
                new ChainSyncRollBackwards({
                    point,
                    tip,
                }),
            );
            return;
        }

        // If tip advanced/forked relative to last known tip point — simplified:
        // when client is caught up, await extend; else roll forward by blockNo/slot.
        if (this.synced || this.clientIndex >= BigInt(this.tip.blockNo)) {
            this.synced = true;
            this.awaitNextTip(tip);
            return;
        }

        this.clientIndex += 1n;
        const headerBytes = await this.chainDb.getBlockNo(this.clientIndex);
        this.sendRollForward(headerBytes, tip);
    }

    private awaitNextTip(tip: IChainTip): void {
        if (this.awaitingExtend) {
            this.send(new ChainSyncAwaitReply());
            return;
        }
        this.awaitingExtend = true;

        const onExtend = async (data: IExtendData) => {
            if (!this.awaitingExtend) return;
            this.awaitingExtend = false;
            this.chainDb.off("extend", onExtend);
            this.chainDb.off("fork", onFork);
            this.tip = new ChainTip(data.tip);
            this.clientIndex = BigInt(this.tip.blockNo);
            const headerBytes = await this.chainDb.getBlockNo(this.clientIndex);
            this.sendRollForward(headerBytes, data.tip);
        };
        const onFork = async (data: IExtendData) => {
            if (!this.awaitingExtend) return;
            this.awaitingExtend = false;
            this.chainDb.off("extend", onExtend);
            this.chainDb.off("fork", onFork);
            this.tip = new ChainTip(data.tip);
            this.synced = false;
            this.clientIndex = BigInt(data.intersection.blockNo);
            this.send(
                new ChainSyncRollBackwards({
                    point: data.intersection.point,
                    tip: data.tip,
                }),
            );
        };

        this.chainDb.on("extend", onExtend);
        this.chainDb.on("fork", onFork);
        this.send(new ChainSyncAwaitReply());
        // Also re-check tip shortly in case events are not wired yet.
        void this.pollTipWhileAwaiting(tip);
    }

    private async pollTipWhileAwaiting(prev: IChainTip): Promise<void> {
        for (let i = 0; i < 3 && this.awaitingExtend; i++) {
            await new Promise((r) => setTimeout(r, 250));
            if (!this.awaitingExtend) return;
            const tip = await this.chainDb.getTip();
            if (BigInt(tip.blockNo) > BigInt(prev.blockNo)) {
                this.awaitingExtend = false;
                this.chainDb.off("extend");
                this.chainDb.off("fork");
                this.tip = new ChainTip(tip);
                this.clientIndex = BigInt(tip.blockNo);
                const headerBytes = await this.chainDb.getBlockNo(
                    this.clientIndex,
                );
                this.sendRollForward(headerBytes, tip);
                return;
            }
        }
    }

    private sendRollForward(data: Uint8Array, tip: IChainTip): void {
        if (this.clientIndex >= BigInt(this.tip.blockNo)) {
            this.synced = true;
        }
        this.send(
            new ChainSyncRollForward({
                data: new CborTag(24, new CborBytes(data)),
                tip,
            }),
        );
    }
}
