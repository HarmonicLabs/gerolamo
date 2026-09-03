import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
    HandshakeAcceptVersion,
    HandshakeProposeVersion,
    HandshakeRefuse,
    MiniProtocol,
    VersionData,
    type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { N2NHandshakeResponder } from "./N2NHandshakeResponder";

class FakeMux extends EventEmitter {
    sent: Array<{ payload: Uint8Array; header: any }> = [];
    send(payload: Uint8Array, header: any): void {
        this.sent.push({ payload, header });
    }
}

function proposal(networkMagic: number, versions = [14, 15]): Uint8Array {
    const table: Record<number, VersionData> = {};
    for (const version of versions) {
        table[version] = new VersionData(
            {
                networkMagic,
                initiatorOnlyDiffusionMode: false,
                peerSharing: true,
                query: false,
            },
            { includePeerSharing: true, includeQuery: true },
        );
    }
    return new HandshakeProposeVersion({ versionTable: table }, true)
        .toCborBytes();
}

describe("N2NHandshakeResponder", () => {
    test("accepts the highest mutual N2N version on matching network magic", () => {
        const mux = new FakeMux();
        let accepted: number | undefined;
        new N2NHandshakeResponder(mux as unknown as Multiplexer, {
            networkMagic: 1,
            onAccepted: ({ versionNumber }) => (accepted = versionNumber),
        });

        mux.emit(
            MiniProtocol.Handshake as any,
            proposal(1),
            { hasAgency: false },
        );

        expect(mux.sent).toHaveLength(1);
        const reply = HandshakeAcceptVersion.fromCbor(mux.sent[0]!.payload);
        expect(reply.versionNumber).toBe(15);
        expect(reply.versionData.networkMagic).toBe(1);
        expect(reply.versionData.initiatorOnlyDiffusionMode).toBe(true);
        expect(mux.sent[0]!.header.hasAgency).toBe(false);
        expect(accepted).toBe(15);
    });

    test("refuses a mismatched network magic", () => {
        const mux = new FakeMux();
        let refused = "";
        new N2NHandshakeResponder(mux as unknown as Multiplexer, {
            networkMagic: 1,
            onRefused: (reason) => (refused = reason),
        });

        mux.emit(
            MiniProtocol.Handshake as any,
            proposal(764824073),
            { hasAgency: false },
        );

        expect(mux.sent).toHaveLength(1);
        expect(HandshakeRefuse.fromCbor(mux.sent[0]!.payload))
            .toBeInstanceOf(HandshakeRefuse);
        expect(refused).toContain("networkMagic mismatch");
    });

    test("ignores responder-direction proposals on an accepted bearer", () => {
        const mux = new FakeMux();
        new N2NHandshakeResponder(mux as unknown as Multiplexer, {
            networkMagic: 1,
        });

        mux.emit(
            MiniProtocol.Handshake as any,
            proposal(1),
            { hasAgency: true },
        );

        expect(mux.sent).toHaveLength(0);
    });
});
