import {
    type MiniProtocol,
    type Multiplexer,
    type MultiplexerHeader,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";

type AnyListener = (...args: any[]) => void;

/**
 * The initiator's view of a duplex bearer: the library's protocol clients do not look at a
 * frame's direction bit, so on a connection where the remote also runs *its* initiators
 * (InitiatorAndResponder handshake) their requests would land in our client parsers. This
 * facade forwards only responder-direction frames (replies to our initiators) to the
 * listeners registered through it; "error" / "data" / "send" pass through unchanged, and
 * everything else (send, close, socket, isN2N) is the real multiplexer's.
 */
export function initiatorSideMux(real: Multiplexer): Multiplexer {
    const wrapped = new Map<AnyListener, AnyListener>();
    const isProtocolEvt = (evt: unknown) => evt !== "error" && evt !== "data" && evt !== "send";
    const wrap = (evt: unknown, listener: AnyListener): AnyListener => {
        if (!isProtocolEvt(evt)) return listener;
        let w = wrapped.get(listener);
        if (!w) {
            w = (payload: Uint8Array, header?: MultiplexerHeader) => {
                if (header === undefined || header.hasAgency === true) listener(payload, header);
            };
            wrapped.set(listener, w);
        }
        return w;
    };
    const facade = Object.create(real) as Multiplexer;
    const define = (name: string, fn: AnyListener) => Object.defineProperty(facade, name, { value: fn, writable: false, enumerable: true, configurable: false });
    for (const name of ["on", "addListener", "addEventListener", "once"] as const) {
        define(name, (evt: any, listener: AnyListener, opts?: any) => { (real as any)[name](evt, wrap(evt, listener), opts); return facade; });
    }
    for (const name of ["off", "removeListener", "removeEventListener"] as const) {
        define(name, (evt: any, listener: AnyListener) => { (real as any)[name](evt, isProtocolEvt(evt) ? (wrapped.get(listener) ?? listener) : listener); return facade; });
    }
    return facade;
}

/** Incoming requests on an accepted initiator-only bearer use the bit-clear side. */
export function isN2NInitiatorFrame(
    header: Pick<MultiplexerHeader, "hasAgency"> | undefined,
): boolean {
    return header === undefined || header.hasAgency === false;
}

/**
 * Multiplexer.send's hasAgency option is inverted relative to decoded headers:
 * false sets the 0x8000 responder-direction bit on the wire.
 */
/**
 * Largest mux segment we emit. The mux header carries a 16-bit payload length, so one segment
 * can hold at most 65 535 bytes, and `Multiplexer.send` does not split: a block over that size
 * (preview slot 2.47 M: 86 744 bytes) went out as one segment with a wrapped length and the
 * consumer lost the frame boundary ("unwrapped Multiplexer header was not a mini protocol").
 * cardano-node's default SDU is 12 288 bytes; the receiver reassembles by protocol.
 */
export const N2N_MAX_SEGMENT_BYTES = 12_288;

export function sendN2NResponder(
    mplexer: Multiplexer,
    protocol: MiniProtocol,
    payload: Uint8Array,
): void {
    if (payload.length <= N2N_MAX_SEGMENT_BYTES) {
        mplexer.send(payload, { protocol, hasAgency: false });
        return;
    }
    for (let off = 0; off < payload.length; off += N2N_MAX_SEGMENT_BYTES) {
        mplexer.send(payload.subarray(off, Math.min(payload.length, off + N2N_MAX_SEGMENT_BYTES)), { protocol, hasAgency: false });
    }
}
