import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    KeepAliveDone,
    KeepAliveRequest,
    KeepAliveResponse,
    MiniProtocol,
    Multiplexer,
    type MultiplexerHeader,
    keepAliveMessageFromCborObj,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { isN2NInitiatorFrame, sendN2NResponder } from "./N2NDirection";

/** Minimal keep-alive responder required by long-lived inbound N2N bearers. */
export class N2NKeepAliveHost {
    private readonly mplexer: Multiplexer;
    private readonly onPayload: (
        payload: Uint8Array,
        header?: MultiplexerHeader,
    ) => void;
    private queued: Uint8Array | undefined;
    private disposed = false;

    constructor(mplexer: Multiplexer) {
        this.mplexer = mplexer;
        this.onPayload = (payload, header) => {
            if (isN2NInitiatorFrame(header)) this.handlePayload(payload);
        };
        this.mplexer.on(MiniProtocol.KeepAlive, this.onPayload);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.queued = undefined;
        this.mplexer.off(MiniProtocol.KeepAlive, this.onPayload);
    }

    private handlePayload(payload: Uint8Array): void {
        if (this.disposed) return;
        const bytes = this.queued
            ? Uint8Array.from([...this.queued, ...payload])
            : payload;
        let offset = 0;
        while (offset < bytes.length) {
            let parsed: { parsed: CborObj; offset: number };
            try {
                parsed = Cbor.parseWithOffset(bytes.subarray(offset));
            } catch {
                this.queued = bytes.subarray(offset).slice();
                return;
            }
            offset += parsed.offset;
            const message = keepAliveMessageFromCborObj(parsed.parsed);
            if (message instanceof KeepAliveRequest) {
                sendN2NResponder(
                    this.mplexer,
                    MiniProtocol.KeepAlive,
                    new KeepAliveResponse({ cookie: message.cookie }).toCborBytes(),
                );
            } else if (message instanceof KeepAliveDone) {
                this.dispose();
                return;
            }
        }
        this.queued = undefined;
    }
}
