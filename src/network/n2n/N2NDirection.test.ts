import { describe, expect, test } from "bun:test";
import {
    MiniProtocol,
    type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import {
    isN2NInitiatorFrame,
    sendN2NResponder,
} from "./N2NDirection";

class FakeMux {
    sent: Array<{ payload: Uint8Array; header: any }> = [];
    send(payload: Uint8Array, header: any): void {
        this.sent.push({ payload, header });
    }
}

describe("inbound N2N MUX direction", () => {
    test("accepts initiator-direction requests and emits responder-direction frames", () => {
        expect(isN2NInitiatorFrame({ hasAgency: false } as any)).toBe(true);
        expect(isN2NInitiatorFrame({ hasAgency: true } as any)).toBe(false);

        const mux = new FakeMux();
        sendN2NResponder(
            mux as unknown as Multiplexer,
            MiniProtocol.ChainSync,
            new Uint8Array([0x81, 0x00]),
        );

        expect(mux.sent).toHaveLength(1);
        expect(mux.sent[0]!.header).toEqual({
            protocol: MiniProtocol.ChainSync,
            hasAgency: false,
        });
    });
});
