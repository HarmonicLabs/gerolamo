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
export function sendN2NResponder(
    mplexer: Multiplexer,
    protocol: MiniProtocol,
    payload: Uint8Array,
): void {
    mplexer.send(payload, { protocol, hasAgency: false });
}
