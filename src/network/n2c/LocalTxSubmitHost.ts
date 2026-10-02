import { Cbor, CborArray, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { MiniProtocol, Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { GlobalSharedMempool } from "../SharedMempool";
import { logger } from "../../utils/logger";
import { getMempool } from "../../mempool";
import { ACCEPT_MESSAGE, CONWAY_ERA_INDEX, LedgerF, rejectMessageBytes } from "../../mempool/applyTxErr";
import { parseMempoolTx, unwrapHfcTx } from "../../mempool/mempoolTx";

const log = logger.child("n2c.localtxsubmit");
const PROTO = MiniProtocol.LocalTxSubmission;

/**
 * N2C LocalTxSubmission server (protocol 6), cardano-node wire format:
 *   MsgSubmitTx [0, [eraIndex, #6.24(tx)]]  →  MsgAcceptTx [1]  |  MsgRejectTx [2, HardForkApplyTxErr]
 *   MsgDone [3]
 * The transaction goes through the validating mempool (ledger rules at the tip, after the
 * transactions already queued); a rejection carries the Conway ApplyTxErr cardano-node would
 * send (byte-identical for the classes `scripts/tx-reject-oracle.ts` checks). Bare tx bytes
 * (the ouroboros-miniprotocols-ts client's form) are accepted too.
 */
export class LocalTxSubmitHost {
    readonly mplexer: Multiplexer;
    private disposed = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (chunk: Uint8Array) => void;
    /** Requests are answered in order (the protocol has one outstanding submission at a time). */
    private queue: Promise<void> = Promise.resolve();

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

    private sendBytes(bytes: Uint8Array): void {
        if (this.disposed) return;
        this.mplexer.send(bytes, {
            hasAgency: false, // responder direction (the 0x8000 bit on the wire): a client rejects replies on its own initiator side (cardano-cli, 2026-09-14)
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
            this.queue = this.queue.then(() => this.handle(parsed)).catch((err) => log.error("LocalTxSubmit handler failed:", err));
            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private async handle(msg: CborObj): Promise<void> {
        if (!(msg instanceof CborArray) || !(msg.array[0] instanceof CborUInt)) {
            this.sendBytes(rejectMessageBytes([LedgerF.mempoolFailure("malformed LocalTxSubmission message")]));
            return;
        }
        const tag = Number((msg.array[0] as CborUInt).num);
        if (tag === 3) { this.dispose(); return; }
        if (tag !== 0 || !msg.array[1]) return;
        const tx = unwrapHfcTx(msg.array[1]);
        if (!tx || tx.bytes.length === 0) {
            this.sendBytes(rejectMessageBytes([LedgerF.mempoolFailure("MsgSubmitTx without a transaction")]));
            return;
        }
        if (tx.era != null && tx.era !== CONWAY_ERA_INDEX) {
            this.sendBytes(rejectMessageBytes([LedgerF.mempoolFailure(`transactions of era ${tx.era} are not accepted in the current era`)]));
            return;
        }
        const mempool = getMempool();
        if (!mempool) {
            this.sendBytes(await appendUnvalidated(tx.bytes));
            return;
        }
        try {
            const r = await mempool.addTx(tx.bytes, "n2c");
            this.sendBytes(r.ok ? ACCEPT_MESSAGE : rejectMessageBytes(r.failures));
        } catch (err) {
            log.error("LocalTxSubmit validation failed:", err);
            this.sendBytes(rejectMessageBytes([LedgerF.mempoolFailure(`validation error: ${err instanceof Error ? err.message : String(err)}`)]));
        }
    }
}

/**
 * No validating mempool in this process (embedded use, tests): parse, key by the *body* hash
 * (the tx id; the whole-transaction hash used before was nobody's id), store.
 */
export async function appendUnvalidated(bytes: Uint8Array): Promise<Uint8Array> {
    try {
        const tx = parseMempoolTx(bytes);
        const res: any = await GlobalSharedMempool.getInstance().append(tx.txIdBytes, bytes);
        const status = Number(res?.status);
        if (status === 0 || status === 1) return ACCEPT_MESSAGE;
        return rejectMessageBytes([LedgerF.mempoolFailure(status === 2 ? "mempool is full" : `mempool append status ${status}`)]);
    } catch (err) {
        return rejectMessageBytes([LedgerF.mempoolFailure(`transaction does not decode: ${err instanceof Error ? err.message : String(err)}`)]);
    }
}
