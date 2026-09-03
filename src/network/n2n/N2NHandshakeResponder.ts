import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    HandshakeAcceptVersion,
    HandshakeProposeVersion,
    HandshakeRefuse,
    MiniProtocol,
    Multiplexer,
    type MultiplexerHeader,
    RefuseReasonVersionMismatch,
    VersionData,
    type VersionNumber,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../../utils/logger";
import { isN2NInitiatorFrame, sendN2NResponder } from "./N2NDirection";

const log = logger.child("n2n.handshake");

export const GEROLAMO_N2N_VERSIONS: readonly VersionNumber[] = [
    14, 15,
];

export interface N2NHandshakeResponderOptions {
    networkMagic: number;
    onAccepted?: (info: {
        versionNumber: VersionNumber;
        versionData: VersionData;
    }) => void;
    onRefused?: (reason: string) => void;
}

export class N2NHandshakeResponder {
    readonly mplexer: Multiplexer;
    readonly networkMagic: number;

    private done = false;
    private prevBytes: Uint8Array | undefined;
    private readonly listener: (
        chunk: Uint8Array,
        header?: MultiplexerHeader,
    ) => void;
    private readonly onAccepted?: N2NHandshakeResponderOptions["onAccepted"];
    private readonly onRefused?: N2NHandshakeResponderOptions["onRefused"];

    constructor(
        mplexer: Multiplexer,
        options: N2NHandshakeResponderOptions,
    ) {
        this.mplexer = mplexer;
        this.networkMagic = options.networkMagic;
        this.onAccepted = options.onAccepted;
        this.onRefused = options.onRefused;
        this.listener = (chunk, header) => {
            if (isN2NInitiatorFrame(header)) this.onChunk(chunk);
        };
        this.mplexer.on(MiniProtocol.Handshake, this.listener);
    }

    dispose(): void {
        try {
            this.mplexer.off(MiniProtocol.Handshake, this.listener);
        } catch {
            /* ignore */
        }
    }

    private onChunk(chunk: Uint8Array): void {
        if (this.done) return;
        let data = chunk;
        if (this.prevBytes) {
            const joined = new Uint8Array(this.prevBytes.length + chunk.length);
            joined.set(this.prevBytes);
            joined.set(chunk, this.prevBytes.length);
            data = joined;
            this.prevBytes = undefined;
        }

        while (data.length > 0) {
            let parsed: CborObj;
            let offset: number;
            try {
                const result = Cbor.parseWithOffset(data);
                parsed = result.parsed;
                offset = result.offset;
            } catch {
                this.prevBytes = Uint8Array.prototype.slice.call(data);
                return;
            }

            try {
                const propose = HandshakeProposeVersion.fromCborObj(
                    parsed,
                    true,
                );
                this.handlePropose(propose);
            } catch (error) {
                log.warn("invalid N2N handshake proposal:", error);
                this.refuse("decode error");
                return;
            }

            if (offset >= data.length) return;
            data = data.subarray(offset);
        }
    }

    private handlePropose(propose: HandshakeProposeVersion): void {
        if (this.done) return;
        const offered = Object.keys(propose.versionTable)
            .map(Number)
            .filter(Number.isFinite);
        const mutual = offered.filter((version) =>
            GEROLAMO_N2N_VERSIONS.includes(version)
        );
        if (mutual.length === 0) {
            this.refuse("no mutual version");
            return;
        }

        const versionNumber = Math.max(...mutual) as VersionNumber;
        const remote = propose.versionTable[versionNumber];
        if (Number(remote?.networkMagic) !== this.networkMagic) {
            this.refuse(
                `networkMagic mismatch (client ${String(remote?.networkMagic)}, server ${this.networkMagic})`,
            );
            return;
        }

        const versionData = new VersionData(
            {
                networkMagic: this.networkMagic,
                initiatorOnlyDiffusionMode: true,
                peerSharing: true,
                query: false,
            },
            { includePeerSharing: true, includeQuery: true },
        );
        const accept = new HandshakeAcceptVersion(
            { versionNumber, versionData },
            true,
        );
        sendN2NResponder(
            this.mplexer,
            MiniProtocol.Handshake,
            accept.toCborBytes(),
        );
        this.done = true;
        log.info(
            `Handshake Accept version=${versionNumber} networkMagic=${this.networkMagic}`,
        );
        this.onAccepted?.({ versionNumber, versionData });
    }

    private refuse(reason: string): void {
        if (this.done) return;
        const refuse = new HandshakeRefuse(
            {
                reason: new RefuseReasonVersionMismatch(
                    [...GEROLAMO_N2N_VERSIONS],
                    true,
                ),
            },
            true,
        );
        sendN2NResponder(
            this.mplexer,
            MiniProtocol.Handshake,
            refuse.toCborBytes(),
        );
        this.done = true;
        log.info(`Handshake Refuse: ${reason}`);
        this.onRefused?.(reason);
    }
}
