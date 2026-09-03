import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    MiniProtocol,
    Multiplexer,
    PeerAddressIPv4,
    PeerSharingDone,
    PeerSharingRequest,
    PeerSharingResponse,
    peerSharingMessageFromCborObj,
    type MultiplexerHeader,
    type PeerAddress,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { isN2NInitiatorFrame, sendN2NResponder } from "./N2NDirection";

export interface ShareablePeer {
    host: string;
    port: number;
}

/** Supplies up to `amount` peers we are willing to advertise (IPv4 only for now). */
export type SharePeersProvider = (amount: number) => ShareablePeer[];

/** IPv4 dotted quad → the raw Word32 PeerSharing encodes (least-significant octet first, see peerManager.ipv4NumberToString). */
export function ipv4ToWord32(host: string): number | null {
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (let i = 3; i >= 0; i--) {
        const b = Number(parts[i]);
        if (!Number.isInteger(b) || b < 0 || b > 255) return null;
        n = n * 256 + b;
    }
    return n >>> 0;
}

/**
 * PeerSharing responder (network-spec §3.11). A node that advertises
 * PeerSharing in the handshake must answer MsgShareRequest; we return known
 * hot/warm/cold IPv4 addresses. Without this, peers that took our
 * advertisement at face value would hit an unhandled protocol on our side.
 */
export class N2NPeerSharingHost {
    private readonly mplexer: Multiplexer;
    private readonly provider: SharePeersProvider;
    private readonly onPayload: (payload: Uint8Array, header?: MultiplexerHeader) => void;
    private queued: Uint8Array | undefined;
    private disposed = false;

    constructor(mplexer: Multiplexer, provider: SharePeersProvider) {
        this.mplexer = mplexer;
        this.provider = provider;
        this.onPayload = (payload, header) => {
            if (isN2NInitiatorFrame(header)) this.handlePayload(payload);
        };
        this.mplexer.on(MiniProtocol.PeerSharing, this.onPayload);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.queued = undefined;
        this.mplexer.off(MiniProtocol.PeerSharing, this.onPayload);
    }

    /** Build the response for `amount` requested peers (exported for tests). */
    static buildResponse(provider: SharePeersProvider, amount: number): PeerSharingResponse {
        const want = Math.max(0, Math.min(255, Math.trunc(amount)));
        const addresses: PeerAddress[] = [];
        if (want > 0) {
            for (const p of provider(want)) {
                const word = ipv4ToWord32(p.host);
                if (word == null || !Number.isInteger(p.port) || p.port <= 0 || p.port > 65535) continue;
                addresses.push(new PeerAddressIPv4({ address: word, portNumber: p.port }));
                if (addresses.length >= want) break;
            }
        }
        return new PeerSharingResponse({ peerAddresses: addresses });
    }

    private handlePayload(payload: Uint8Array): void {
        if (this.disposed) return;
        const bytes = this.queued ? Uint8Array.from([...this.queued, ...payload]) : payload;
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
            let message;
            try {
                message = peerSharingMessageFromCborObj(parsed.parsed);
            } catch {
                continue; // unknown/garbled message: ignore rather than drop the bearer
            }
            if (message instanceof PeerSharingRequest) {
                const amount = Number((message as any).amount ?? 0);
                sendN2NResponder(
                    this.mplexer,
                    MiniProtocol.PeerSharing,
                    N2NPeerSharingHost.buildResponse(this.provider, amount).toCborBytes(),
                );
            } else if (message instanceof PeerSharingDone) {
                this.dispose();
                return;
            }
        }
        this.queued = undefined;
    }
}
