import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    MiniProtocol,
    Multiplexer,
    TxMonitorAcquire,
    TxMonitorAcquired,
    TxMonitorDone,
    TxMonitorGetSizes,
    TxMonitorHasTx,
    TxMonitorNextTx,
    TxMonitorRelease,
    TxMonitorReplyGetSizes,
    TxMonitorReplyHasTx,
    TxMonitorReplyNextTx,
    txMonitorMessageFromCborObj,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { GlobalSharedMempool, MempoolSize } from "../SharedMempool";
import { getMaxSlot } from "../../db";
import { logger } from "../../utils/logger";

const log = logger.child("n2c.localtxmonitor");
const PROTO = MiniProtocol.LocalTxMonitor;

/**
 * N2C LocalTxMonitor server (protocol 9) over GlobalSharedMempool.
 */
export class LocalTxMonitorHost {
    readonly mplexer: Multiplexer;
    private acquired = false;
    private snapshotHashes: Uint8Array[] = [];
    private nextIdx = 0;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;

    constructor(mplexer: Multiplexer) {
        this.mplexer = mplexer;
        this.listener = (chunk) => this.onChunk(chunk);
        this.mplexer.on(PROTO, this.listener);
        GlobalSharedMempool.getInstance();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.acquired = false;
        this.snapshotHashes = [];
        this.nextIdx = 0;
        try {
            this.mplexer.off(PROTO, this.listener);
        } catch {
            /* ignore */
        }
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
                const msg = txMonitorMessageFromCborObj(parsed);
                void this.handle(msg);
            } catch (err) {
                log.error("LocalTxMonitor parse error:", err);
            }
            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handle(msg: unknown): Promise<void> {
        if (msg instanceof TxMonitorDone) {
            this.dispose();
            return;
        }
        if (msg instanceof TxMonitorRelease) {
            this.acquired = false;
            this.snapshotHashes = [];
            this.nextIdx = 0;
            return;
        }
        if (msg instanceof TxMonitorAcquire) {
            await this.acquire();
            return;
        }
        if (!this.acquired) return;

        if (msg instanceof TxMonitorNextTx) {
            await this.nextTx();
            return;
        }
        if (msg instanceof TxMonitorHasTx) {
            await this.hasTx(msg.txId);
            return;
        }
        if (msg instanceof TxMonitorGetSizes) {
            await this.getSizes();
        }
    }

    private async acquire(): Promise<void> {
        const mempool = GlobalSharedMempool.getInstance();
        const hashes = await mempool.getTxHashes();
        this.snapshotHashes = hashes.map((h) =>
            h instanceof Uint8Array ? h : new Uint8Array(h as any),
        );
        this.nextIdx = 0;
        this.acquired = true;
        let slot = 0n;
        try {
            slot = await getMaxSlot();
        } catch {
            slot = 0n;
        }
        this.send(new TxMonitorAcquired({ slotNumber: slot }));
        log.info(
            `TxMonitor acquired snapshot nTxs=${this.snapshotHashes.length} slot=${slot}`,
        );
    }

    private async nextTx(): Promise<void> {
        if (this.nextIdx >= this.snapshotHashes.length) {
            this.send(new TxMonitorReplyNextTx({}));
            return;
        }
        const hash = this.snapshotHashes[this.nextIdx++];
        try {
            const txs = await GlobalSharedMempool.getTxs([hash]);
            const bytes = txs[0]?.bytes;
            if (bytes) {
                this.send(new TxMonitorReplyNextTx({ tx: bytes }));
                return;
            }
        } catch (err) {
            log.warn("nextTx lookup failed:", err);
        }
        this.send(new TxMonitorReplyNextTx({}));
    }

    private async hasTx(txId: Uint8Array): Promise<void> {
        try {
            const hashes = await GlobalSharedMempool.getTxHashes();
            const want = toHex(txId);
            const has = hashes.some((h) => {
                const bytes = h instanceof Uint8Array ? h : new Uint8Array(h as any);
                return toHex(bytes) === want;
            });
            this.send(new TxMonitorReplyHasTx({ hasTx: has }));
        } catch {
            this.send(new TxMonitorReplyHasTx({ hasTx: false }));
        }
    }

    private async getSizes(): Promise<void> {
        try {
            const mempool = GlobalSharedMempool.getInstance();
            const nTxs = await mempool.getTxCount();
            const available = await mempool.getAvailableSpace();
            const capacity = MempoolSize.kb256;
            const mempoolSize = Math.max(0, capacity - available);
            this.send(
                new TxMonitorReplyGetSizes({
                    mempoolCapacity: capacity,
                    mempoolSize,
                    nTxs,
                }),
            );
        } catch {
            this.send(
                new TxMonitorReplyGetSizes({
                    mempoolCapacity: MempoolSize.kb256,
                    mempoolSize: 0,
                    nTxs: 0,
                }),
            );
        }
    }
}
