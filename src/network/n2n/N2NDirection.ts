import {
    type MiniProtocol,
    type Multiplexer,
    type MultiplexerHeader,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";

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
