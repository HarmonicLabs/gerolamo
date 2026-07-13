import { Cbor, type CborObj } from "@harmoniclabs/cbor";
import {
    HandshakeAcceptVersion,
    HandshakeProposeVersion,
    HandshakeRefuse,
    MiniProtocol,
    Multiplexer,
    RefuseReasonVersionMismatch,
    VersionData,
    type VersionNumber,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "../../utils/logger";

const n2cLogger = logger.child("n2c.handshake");

/** N2C versions offered by Gerolamo (matches HandshakeClient N2C table). */
export const GEROLAMO_N2C_VERSIONS: readonly VersionNumber[] = [16, 17, 18, 19];

const handshakeHeader = Object.freeze({
    hasAgency: true,
    protocol: MiniProtocol.Handshake,
});

export interface HandshakeResponderOptions {
    networkMagic: number;
    /** Called once after Accept is sent. */
    onAccepted?: (info: {
        versionNumber: VersionNumber;
        versionData: VersionData;
    }) => void;
    onRefused?: (reason: string) => void;
}

/**
 * Thin N2C Handshake *server* (library only ships HandshakeClient).
 *
 * Listens on MiniProtocol.Handshake, parses Propose with n2n=false,
 * picks max mutual version among GEROLAMO_N2C_VERSIONS, replies Accept or Refuse.
 */
export class HandshakeResponder {
    readonly mplexer: Multiplexer;
    readonly networkMagic: number;

    private done = false;
    private prevBytes: Uint8Array | undefined;
    private readonly onAccepted?: HandshakeResponderOptions["onAccepted"];
    private readonly onRefused?: HandshakeResponderOptions["onRefused"];
    private readonly listener: (chunk: Uint8Array) => void;

    constructor(mplexer: Multiplexer, opts: HandshakeResponderOptions) {
        this.mplexer = mplexer;
        this.networkMagic = opts.networkMagic;
        this.onAccepted = opts.onAccepted;
        this.onRefused = opts.onRefused;

        this.listener = (chunk: Uint8Array) => this.onHandshakeChunk(chunk);
        this.mplexer.on(MiniProtocol.Handshake, this.listener);
    }

    dispose(): void {
        try {
            this.mplexer.off(MiniProtocol.Handshake, this.listener);
        } catch {
            /* ignore */
        }
    }

    private onHandshakeChunk(chunk: Uint8Array): void {
        if (this.done) return;

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
                // Incomplete CBOR frame — wait for more bytes.
                this.prevBytes = Uint8Array.prototype.slice.call(data);
                return;
            }

            try {
                this.handleCborMessage(parsed);
            } catch (err) {
                n2cLogger.error("handshake parse/handle error:", err);
                this.refuseVersions("decode error");
                return;
            }

            if (offset >= data.length) break;
            data = data.subarray(offset);
        }
    }

    private handleCborMessage(cObj: CborObj): void {
        // Do NOT use handshakeMessageFromCborObj — it defaults Propose to n2n=true
        // and mis-parses N2C VersionData ([networkMagic, query]).
        if (
            !(
                cObj &&
                typeof cObj === "object" &&
                "array" in cObj &&
                Array.isArray((cObj as any).array) &&
                (cObj as any).array.length >= 1 &&
                (cObj as any).array[0] instanceof Object &&
                "num" in (cObj as any).array[0]
            )
        ) {
            throw new Error("invalid CBOR for HandshakeMessage");
        }

        const idx = Number((cObj as any).array[0].num);
        if (idx !== 0) {
            n2cLogger.warn(
                `unexpected handshake msg index ${idx} (expected Propose=0)`,
            );
            return;
        }

        const propose = HandshakeProposeVersion.fromCborObj(cObj, false);
        this.handlePropose(propose);
    }

    private handlePropose(propose: HandshakeProposeVersion): void {
        if (this.done) return;

        const clientVersions = Object.keys(propose.versionTable)
            .map((k) => Number(k))
            .filter((n) => Number.isFinite(n));

        const mutual = clientVersions.filter((v) =>
            GEROLAMO_N2C_VERSIONS.includes(v as VersionNumber),
        );

        if (mutual.length === 0) {
            n2cLogger.info(
                `no mutual N2C versions; client offered [${clientVersions.join(", ")}]`,
            );
            this.refuseVersions("no mutual version");
            return;
        }

        // Prefer highest mutual version.
        const chosen = Math.max(...mutual) as VersionNumber;
        const clientData = propose.versionTable[chosen];
        const clientMagic = clientData?.networkMagic;

        if (
            typeof clientMagic === "number" &&
            clientMagic !== this.networkMagic
        ) {
            n2cLogger.info(
                `networkMagic mismatch: client=${clientMagic} server=${this.networkMagic}`,
            );
            this.refuseVersions(
                `networkMagic mismatch (client ${clientMagic}, server ${this.networkMagic})`,
            );
            return;
        }

        // N2C VersionData CBOR: [networkMagic, query]
        const query = clientData?.query ?? false;
        const versionData = new VersionData(
            {
                networkMagic: this.networkMagic,
                query,
            },
            {
                includePeerSharing: false,
                includeQuery: true,
            },
        );

        const accept = new HandshakeAcceptVersion(
            {
                versionNumber: chosen,
                versionData,
            },
            false, // N2C wire encoding
        );

        this.mplexer.send(accept.toCbor().toBuffer(), handshakeHeader);
        this.done = true;
        n2cLogger.info(
            `Handshake Accept version=${chosen} networkMagic=${this.networkMagic} query=${query}`,
        );
        this.onAccepted?.({ versionNumber: chosen, versionData });
    }

    private refuseVersions(reason: string): void {
        if (this.done) return;
        const refuse = new HandshakeRefuse(
            {
                reason: new RefuseReasonVersionMismatch(
                    [...GEROLAMO_N2C_VERSIONS],
                    false,
                ),
            },
            false,
        );
        this.mplexer.send(refuse.toCbor().toBuffer(), handshakeHeader);
        this.done = true;
        n2cLogger.info(`Handshake Refuse: ${reason}`);
        this.onRefused?.(reason);
    }
}
