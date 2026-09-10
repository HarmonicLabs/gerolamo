import { describe, expect, test } from "bun:test";
import {
    MiniProtocol,
    type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import {
    isN2NInitiatorFrame,
    N2N_MAX_SEGMENT_BYTES,
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

describe("responder payloads larger than one mux segment", () => {
    test("an 86 744-byte block is split into ≤ 12 288-byte segments that reassemble to the payload", () => {
        // preview slot ≈ 2.47 M: one segment with a 16-bit length wrapped around desynced the consumer
        const payload = new Uint8Array(86_744);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        const mux = new FakeMux();
        sendN2NResponder(mux as unknown as Multiplexer, MiniProtocol.BlockFetch, payload);
        expect(mux.sent.length).toBe(Math.ceil(payload.length / N2N_MAX_SEGMENT_BYTES));
        for (const s of mux.sent) {
            expect(s.payload.length).toBeLessThanOrEqual(N2N_MAX_SEGMENT_BYTES);
            expect(s.payload.length).toBeLessThanOrEqual(0xffff);
            expect(s.header).toEqual({ protocol: MiniProtocol.BlockFetch, hasAgency: false });
        }
        const joined = new Uint8Array(payload.length);
        let off = 0;
        for (const s of mux.sent) { joined.set(s.payload, off); off += s.payload.length; }
        expect(joined).toEqual(payload);
    });
    test("a small payload still goes out as a single segment", () => {
        const mux = new FakeMux();
        sendN2NResponder(mux as unknown as Multiplexer, MiniProtocol.KeepAlive, new Uint8Array(100));
        expect(mux.sent).toHaveLength(1);
    });
});
