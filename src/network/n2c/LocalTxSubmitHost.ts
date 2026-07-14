import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    LocalTxSubmitAccept,
    LocalTxSubmitDone,
    LocalTxSubmitReject,
    LocalTxSubmitSubmit,
    MiniProtocol,
    Multiplexer,
    localTxSubmitMessageFromCborObj,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { GlobalSharedMempool } from "../SharedMempool";
import { logger } from "../../utils/logger";

/** Mirrors MempoolAppendStatus without importing the tgz package path (Bun-safe). */
const MEMPOOL_OK = 0;
const MEMPOOL_ALREADY_PRESENT = 1;

const log = logger.child("n2c.localtxsubmit");
const PROTO = MiniProtocol.LocalTxSubmission;

/**
 * N2C LocalTxSubmission server (protocol 6).
 * Accepts raw tx bytes into the process mempool (light validation).
 */
export class LocalTxSubmitHost {
    readonly mplexer: Multiplexer;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;

    constructor(mplexer: Multiplexer) {
        this.mplexer = mplexer;
        this.listener = (chunk) => this.onChunk(chunk);
        this.mplexer.on(PROTO, this.listener);
        // Ensure mempool exists even if peer manager not started yet.
        GlobalSharedMempool.getInstance();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
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
                const msg = localTxSubmitMessageFromCborObj(parsed);
                void this.handle(msg);
            } catch (err) {
                log.error("LocalTxSubmit parse error:", err);
                this.send(new LocalTxSubmitReject({ reason: 1 }));
            }
            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handle(msg: unknown): Promise<void> {
        if (msg instanceof LocalTxSubmitDone) {
            this.dispose();
            return;
        }
        if (!(msg instanceof LocalTxSubmitSubmit)) return;

        const tx = msg.tx;
        if (!(tx instanceof Uint8Array) || tx.length === 0) {
            this.send(new LocalTxSubmitReject({ reason: 1 }));
            return;
        }
        try {
            const hash = blake2b_256(tx);
            const res = await GlobalSharedMempool.getInstance().append(hash, tx);
            const status = Number((res as { status: number }).status);
            if (status === MEMPOOL_OK || status === MEMPOOL_ALREADY_PRESENT) {
                log.info(`LocalTxSubmit accept ${tx.length} bytes`);
                this.send(new LocalTxSubmitAccept());
            } else {
                log.info(`LocalTxSubmit reject status=${status}`);
                this.send(new LocalTxSubmitReject({ reason: 2 }));
            }
        } catch (err) {
            log.error("LocalTxSubmit append failed:", err);
            this.send(new LocalTxSubmitReject({ reason: 3 }));
        }
    }
}
