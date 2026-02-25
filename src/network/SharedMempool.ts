import {
    type MempoolTxHash,
    SharedMempool,
    type TxHashAndSize,
} from "@harmoniclabs/shared-cardano-mempool-ts";
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

class GlobalSharedMempool {
    private static instance: SharedMempool | null = null;
    private static buffer: SharedArrayBuffer | null = null;

    private constructor() {}

    static getInstance(
        config: MempoolConfig = { maxTxs: 10000, validateTx: false },
    ): SharedMempool {
        if (!GlobalSharedMempool.instance) {
            const bufferSize = config.maxBytes ?? MempoolSize.kb256;
            GlobalSharedMempool.buffer = new SharedArrayBuffer(bufferSize);
            GlobalSharedMempool.instance = new SharedMempool(
                GlobalSharedMempool.buffer,
                { ...config, maxBytes: bufferSize },
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

    static getAvialbleSpace(): Promise<number> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getAvialbleSpace();
    }

    static getTxHashes(): Promise<MempoolTxHash[]> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getTxHashes();
    }

    static getTxHashesAndSizes(): Promise<TxHashAndSize[]> {
        const mempool = GlobalSharedMempool.getInstance();
        return mempool.getTxHashesAndSizes();
    }

    static async getTx(txHash: Uint8Array): Promise<Uint8Array | null> {
        const txs = await GlobalSharedMempool.getTxs([txHash]);
        return txs.length > 0 ? txs[0].cbor : null;
    }
}

export { GlobalSharedMempool, type MempoolConfig };
