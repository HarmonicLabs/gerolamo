/**
 * tx-submission2 responder for inbound node-to-node connections: the peer that connected to us
 * announces its transactions; we ask for the ids, fetch the bodies we do not hold, check that
 * each body hashes to its announced id, and append it to the shared mempool — that is how a
 * block producer's mempool fills from the network. Wire format per `txSubmissionCodec.ts`
 * (verified against cardano-node 11.0.1). The protocol logic lives in `TxSubmissionResponder`,
 * which takes bytes and returns bytes so it can be tested without sockets.
 */
import { MiniProtocol, Multiplexer, type MultiplexerHeader } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { Tx } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../../utils/logger";
import { encodeRequestTxIds, encodeRequestTxs, hashBytes, hfcEraIndexNow, parseTxSubmissionClientMessages, type HfcEraIndex, type TxIdAnnouncement } from "../txSubmissionCodec";
import { isN2NInitiatorFrame, sendN2NResponder } from "./N2NDirection";

const log = logger.child("n2n");

/** What the responder needs from the mempool. */
export interface TxSubmissionMempool {
    /** Hashes we already hold (any typed-array view of 32 bytes). */
    getTxHashes(): Promise<ArrayLike<unknown>[]>;
    append(hash: Uint8Array, tx: Uint8Array): Promise<unknown>;
}

export interface TxSubmissionResponderOptions {
    mempool: TxSubmissionMempool;
    era?: () => HfcEraIndex;
    /** Ids requested per round (cardano-node asks for 3 in its first request; 10 keeps the window small). */
    window?: number;
    /** Largest transaction accepted (bytes); the protocol parameter is 16 384 on every public network. */
    maxTxBytes?: number;
    /** Reject a body before it reaches the mempool (light check: hash matches the announced id). */
    validate?: (bytes: Uint8Array) => Promise<{ ok: true; hash: Uint8Array } | { ok: false; reason: string }>;
    peer?: string;
}

/** Pure protocol core: feed it the peer's bytes, send what it returns. */
export class TxSubmissionResponder {
    private started = false;
    private done = false;
    private announced: TxIdAnnouncement[] = []; // ids announced and not yet acknowledged, in order
    private fetching: Uint8Array[] = [];         // ids of the outstanding MsgRequestTxs
    private readonly window: number;
    private readonly maxTxBytes: number;
    readonly stats = { announced: 0, fetched: 0, accepted: 0, rejected: 0 };

    constructor(private readonly opts: TxSubmissionResponderOptions) {
        this.window = Math.max(1, Math.min(255, opts.window ?? 10));
        this.maxTxBytes = opts.maxTxBytes ?? 16_384;
    }

    /** Process one chunk from the peer; returns the frames to send back, in order. */
    async receive(chunk: Uint8Array): Promise<Uint8Array[]> {
        const out: Uint8Array[] = [];
        if (this.done) return out;
        for (const m of parseTxSubmissionClientMessages(chunk)) {
            if (m.kind === "init") {
                if (this.started) continue;
                this.started = true;
                out.push(encodeRequestTxIds(true, 0, this.window)); // blocking: the peer answers when it has something
            } else if (m.kind === "replyTxIds") {
                this.stats.announced += m.ids.length;
                this.announced.push(...m.ids);
                const known = await this.knownHashes();
                const want = m.ids.filter((id) => id.size <= this.maxTxBytes && !known.has(toHex(id.hash))).map((id) => id.hash);
                if (want.length) {
                    this.fetching = want;
                    out.push(encodeRequestTxs((this.opts.era ?? hfcEraIndexNow)(), want));
                } else {
                    out.push(this.nextIdRequest());
                }
            } else if (m.kind === "replyTxs") {
                this.stats.fetched += m.txs.length;
                for (const bytes of m.txs) await this.accept(bytes);
                this.fetching = [];
                out.push(this.nextIdRequest());
            } else if (m.kind === "done") {
                this.done = true;
            }
        }
        return out;
    }

    /** Acknowledge everything announced so far and ask for the next window. */
    private nextIdRequest(): Uint8Array {
        const ack = this.announced.length;
        this.announced = [];
        return encodeRequestTxIds(true, ack, this.window);
    }

    private async knownHashes(): Promise<Set<string>> {
        const set = new Set<string>();
        try { for (const h of await this.opts.mempool.getTxHashes()) set.add(toHex(hashBytes(h))); } catch { /* empty mempool */ }
        return set;
    }

    private async accept(bytes: Uint8Array): Promise<void> {
        if (bytes.length > this.maxTxBytes) { this.stats.rejected++; return; }
        const v = await (this.opts.validate ?? defaultValidate)(bytes);
        if (!v.ok) { this.stats.rejected++; log.debug(`tx-submission ${this.opts.peer ?? ""}: rejected transaction: ${v.reason}`); return; }
        const wanted = this.fetching.some((h) => toHex(h) === toHex(v.hash));
        if (!wanted) { this.stats.rejected++; log.debug(`tx-submission ${this.opts.peer ?? ""}: unrequested transaction ${toHex(v.hash).slice(0, 12)}…`); return; }
        try {
            await this.opts.mempool.append(v.hash, bytes);
            this.stats.accepted++;
        } catch (err) {
            this.stats.rejected++;
            log.warn(`tx-submission ${this.opts.peer ?? ""}: mempool append failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/** The body must parse as a transaction; its id is the body hash. */
export async function defaultValidate(bytes: Uint8Array): Promise<{ ok: true; hash: Uint8Array } | { ok: false; reason: string }> {
    try {
        const tx = Tx.fromCbor(bytes);
        return { ok: true, hash: tx.body.hash.toBuffer() };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/** Binds a responder to an inbound multiplexer. */
export class N2NTxSubmissionHost {
    private readonly responder: TxSubmissionResponder;
    private readonly onPayload: (payload: Uint8Array, header?: MultiplexerHeader) => void;
    private queue: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(private readonly mplexer: Multiplexer, opts: TxSubmissionResponderOptions) {
        this.responder = new TxSubmissionResponder(opts);
        this.onPayload = (payload, header) => {
            if (!isN2NInitiatorFrame(header) || this.disposed) return;
            this.queue = this.queue.then(async () => {
                const frames = await this.responder.receive(payload);
                if (this.disposed) return;
                for (const f of frames) sendN2NResponder(this.mplexer, MiniProtocol.TxSubmission, f);
            }).catch((err) => log.warn(`tx-submission host error: ${err instanceof Error ? err.message : String(err)}`));
        };
        this.mplexer.on(MiniProtocol.TxSubmission, this.onPayload);
    }

    get stats() { return this.responder.stats; }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.mplexer.off(MiniProtocol.TxSubmission, this.onPayload);
    }
}
