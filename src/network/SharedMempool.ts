import {
    type MempoolTx,
    type MempoolTxHash,
    type MempoolTxHashLike,
    SharedMempool,
    type TxHashAndSize,
} from "@harmoniclabs/shared-cardano-mempool-ts";
// IMempool is not re-exported from the package root; deep path is the stable type source.
import type { IMempool } from "@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/tx-submission/interfaces/IMempool.js";
import { logger } from "../utils/logger";

interface MempoolConfig {
    maxTxs: number;
    maxBytes?: SupportedMempoolSize;
    validateTx: boolean;
}
export enum MempoolSize {
    kb32 = 32768,
    kb64 = 65536,
    kb128 = 131072,
    kb256 = 262144,
}

Object.freeze(MempoolSize);

export type SupportedMempoolSize =
    | 32768 // 32KB
    | 65536 // 64KB
    | 131072 // 128KB
    | 262144; // 256KB

/**
 * Adapter around SharedMempool that satisfies ouroboros TxSubmitClient's
 * IMempool (getAvailableSpace / availableSpace) while the package itself
 * only exposes the misspelled getAviableSpace / aviableSpace.
 */
export class GerolamoMempoolAdapter implements IMempool {
    private readonly inner: SharedMempool;

    constructor(sharedMemory: SharedArrayBuffer) {
        this.inner = new SharedMempool(sharedMemory);
    }

    get config() {
        return this.inner.config as IMempool["config"];
    }

    getTxCount(): Promise<number> {
        return this.inner.getTxCount();
    }

    getAvailableSpace(): Promise<number> {
        return this.inner.getAviableSpace();
    }

    /** Package spelling (typo) — kept for internal callers. */
    getAviableSpace(): Promise<number> {
        return this.inner.getAviableSpace();
    }

    getTxHashes(): Promise<MempoolTxHash[]> {
        return this.inner.getTxHashes() as Promise<MempoolTxHash[]>;
    }

    getTxHashesAndSizes(): Promise<TxHashAndSize[]> {
        return this.inner.getTxHashesAndSizes() as Promise<TxHashAndSize[]>;
    }

    getTxs(hashes: MempoolTxHashLike[]): Promise<MempoolTx[]> {
        return this.inner.getTxs(hashes) as Promise<MempoolTx[]>;
    }

    async append(
        hash: MempoolTxHashLike,
        tx: Uint8Array,
    ): Promise<Awaited<ReturnType<IMempool["append"]>>> {
        const res = await this.inner.append(hash, tx);
        // Ouroboros IMempool expects availableSpace; package returns aviableSpace.
        return {
            status: res.status as Awaited<
                ReturnType<IMempool["append"]>
            >["status"],
            nTxs: res.nTxs,
            availableSpace: res.aviableSpace,
        };
    }

    drop(hashes: MempoolTxHashLike[]): Promise<void> {
        return this.inner.drop(hashes);
    }
}

/** Alias used by PeerClient / TxSubmitClient. */
export type GerolamoMempool = GerolamoMempoolAdapter;

class GlobalSharedMempool {
    private static instance: GerolamoMempoolAdapter | null = null;
    private static buffer: SharedArrayBuffer | null = null;

    private constructor() {}

    static getInstance(
        config: MempoolConfig = { maxTxs: 10000, validateTx: false },
    ): GerolamoMempoolAdapter {
        if (!GlobalSharedMempool.instance) {
            const bufferSize = config.maxBytes ?? MempoolSize.kb256;
            GlobalSharedMempool.buffer = new SharedArrayBuffer(bufferSize);
            // SharedMempoolArgs is empty in current package types; size comes from buffer.
            GlobalSharedMempool.instance = new GerolamoMempoolAdapter(
                GlobalSharedMempool.buffer,
            );
            logger.mempool(
                "Global SharedMempool initialized with size",
                bufferSize,
            );
        }
        return GlobalSharedMempool.instance;
    }

    static async append(txHash: Uint8Array, txCbor: Uint8Array): Promise<void> {
        const mempool = GlobalSharedMempool.getInstance();
        await mempool.append(txHash, txCbor);
        logger.mempool("Tx appended to global mempool", {
            txHash: Array.from(txHash).slice(0, 8),
        });
    }

    static getTxCount(): Promise<number> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getTxCount();
    }

    /** Package spelling (typo). Prefer getAvailableSpace for ouroboros IMempool. */
    static getAviableSpace(): Promise<number> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getAviableSpace();
    }

    static getAvailableSpace(): Promise<number> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getAvailableSpace();
    }

    static getTxHashes(): Promise<MempoolTxHash[]> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getTxHashes();
    }

    static getTxHashesAndSizes(): Promise<TxHashAndSize[]> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getTxHashesAndSizes();
    }

    static async getTxs(hashes: MempoolTxHashLike[]): Promise<MempoolTx[]> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getTxs(hashes);
    }

    static async getTx(txHash: Uint8Array): Promise<Uint8Array | null> {
        const txs = await GlobalSharedMempool.getTxs([txHash]);
        return txs.length > 0 ? txs[0].bytes : null;
    }
}

export { GlobalSharedMempool, type MempoolConfig };
