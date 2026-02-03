import type { TxSubmitMessage } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import {
    Multiplexer,
    txSubmitMessageFromCborObj,
    TxSubmitRequestIds,
    TxSubmitRequestTxs,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import type { CborObj } from "@harmoniclabs/cbor";
import { Cbor } from "@harmoniclabs/cbor";
import { MiniProtocol } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import {
    TxSubmitReplyIds,
    TxSubmitReplyTxs,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../utils/logger";
import { GlobalSharedMempool } from "./SharedMempool";

export class GerolamoTxSubmitServer {
    readonly mplexer: Multiplexer;
    private prevBytes: Uint8Array | undefined = undefined;
    private queue: TxSubmitMessage[] = [];

    constructor(mplexer: Multiplexer) {
        this.mplexer = mplexer;
        this.mplexer.on(
            MiniProtocol.TxSubmission,
            (chunk) => this.handleChunk(chunk),
        );
    }

    private async handleChunk(chunk: Uint8Array) {
        if (this.prevBytes) {
            const tmp = new Uint8Array(this.prevBytes.length + chunk.length);
            tmp.set(this.prevBytes, 0);
            tmp.set(chunk, this.prevBytes.length);
            chunk = tmp;
            this.prevBytes = undefined;
        }

        let offset = -1;
        let thing: { parsed: CborObj; offset: number };

        while (true) {
            try {
                thing = Cbor.parseWithOffset(chunk);
            } catch {
                this.prevBytes = chunk.slice();
                break;
            }

            offset = thing.offset;
            const msg = txSubmitMessageFromCborObj(thing.parsed);
            this.queue.unshift(msg);

            if (offset < chunk.length) {
                chunk = chunk.subarray(offset);
                continue;
            } else {
                break;
            }
        }

        let msg: TxSubmitMessage;
        while (msg = this.queue.pop()!) {
            await this.handleMessage(msg);
        }
    }

    private async handleMessage(msg: TxSubmitMessage) {
        if (msg instanceof TxSubmitRequestIds) {
            await this.handleRequestIds(msg);
        } else if (msg instanceof TxSubmitRequestTxs) {
            await this.handleRequestTxs(msg);
        }
        // Ignore other messages
    }

    private async handleRequestIds(req: TxSubmitRequestIds) {
        const all = await GlobalSharedMempool.getTxHashesAndSizes();
        const ack = req.knownTxCount;
        const reqCount = req.requestedTxCount;
        const slice = all.slice(ack, ack + reqCount);
        const sliceMapped = slice.map((hs) => ({
            txId: hs.hash as unknown as Uint8Array,
            txSize: hs.size,
        }));
        const reply = new TxSubmitReplyIds({ response: sliceMapped });
        this.mplexer.send(reply.toCbor().toBuffer(), {
            hasAgency: false,
            protocol: MiniProtocol.TxSubmission,
        });
        logger.mempool(
            `TxSubmitServer sent replyIds to peer: ack=${ack}, req=${reqCount}, sent=${slice.length}`,
        );
    }

    private async handleRequestTxs(req: TxSubmitRequestTxs) {
        const txHashes = req.ids;
        const txs: Uint8Array[] = [];
        for (const hash of txHashes) {
            const tx = await GlobalSharedMempool.getTx(hash);
            if (tx) txs.push(tx);
        }
        const reply = new TxSubmitReplyTxs({ txs });
        this.mplexer.send(reply.toCbor().toBuffer(), {
            hasAgency: false,
            protocol: MiniProtocol.TxSubmission,
        });
        logger.mempool(
            `TxSubmitServer sent replyTxs to peer: requested=${txHashes.length}, sent=${txs.length}`,
        );
    }
}
