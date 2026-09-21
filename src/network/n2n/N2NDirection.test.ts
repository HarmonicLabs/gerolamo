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

describe("initiatorSideMux", () => {
    test("forwards only responder-direction frames to protocol listeners; off removes the wrapped listener", async () => {
        const { initiatorSideMux } = await import("./N2NDirection");
        const listeners = new Map<any, Function[]>();
        const real: any = {
            isN2N: true,
            on(evt: any, l: Function) { listeners.set(evt, [...(listeners.get(evt) ?? []), l]); return real; },
            off(evt: any, l: Function) { listeners.set(evt, (listeners.get(evt) ?? []).filter((x) => x !== l)); return real; },
            send(payload: Uint8Array, h: any) { sent.push(h); },
        };
        const sent: any[] = [];
        const facade = initiatorSideMux(real);
        const got: string[] = [];
        const l = (p: Uint8Array, h: any) => got.push(`${p[0]}:${String(h?.hasAgency)}`);
        facade.on(2 as any, l as any);
        const errs: Error[] = [];
        const onErr = (e: Error) => errs.push(e);
        facade.on("error", onErr);
        expect(listeners.get(2)).toHaveLength(1);
        const w = listeners.get(2)![0]!;
        w(new Uint8Array([1]), { hasAgency: false }); // remote initiator → not ours
        w(new Uint8Array([2]), { hasAgency: true });  // remote responder → reply to our client
        w(new Uint8Array([3]), undefined);            // no header → pass
        expect(got).toEqual(["2:true", "3:undefined"]);
        listeners.get("error")![0]!(new Error("x"));
        expect(errs).toHaveLength(1);
        facade.off(2 as any, l as any);
        expect(listeners.get(2)).toHaveLength(0);
        facade.send(new Uint8Array([9]), { protocol: 2, hasAgency: true } as any);
        expect(sent).toHaveLength(1);
        expect(facade.isN2N).toBe(true);
    });
});
