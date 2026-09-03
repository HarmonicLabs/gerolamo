import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { MiniProtocol, Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";

/**
 * Pins the vendored-patch fix in ouroboros-miniprotocols-ts's Multiplexer: a TCP
 * chunk that ends inside an 8-byte segment header must not lose framing. Upstream
 * dropped the partial header, so the next chunk was parsed from mid-header and the
 * peer was terminated with "unwrapped Multiplexer header was not a mini protocol"
 * (seen every minute or two on mainnet with 128-block BlockFetch ranges).
 */
class FakeSocket extends EventEmitter {
    destroyed = false;
    connecting = false;
    pending = false;
    write(): boolean {
        return true;
    }
    end(): void {}
    address(): { address: string; port: number } {
        return { address: "127.0.0.1", port: 3001 };
    }
}

function segment(protocol: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x01020304, false);
    v.setUint16(4, 0x8000 | protocol, false); // server-side agency bit + protocol id
    v.setUint16(6, payload.length, false);
    out.set(payload, 8);
    return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
}

function harness() {
    const sock = new FakeSocket();
    const mplexer = new Multiplexer({ connect: () => sock as any, protocolType: "node-to-node" });
    const got: Array<{ protocol: number; payload: Uint8Array }> = [];
    const errors: unknown[] = [];
    mplexer.on(MiniProtocol.ChainSync, (payload: Uint8Array) => got.push({ protocol: MiniProtocol.ChainSync, payload }));
    mplexer.on(MiniProtocol.BlockFetch, (payload: Uint8Array) => got.push({ protocol: MiniProtocol.BlockFetch, payload }));
    mplexer.on("error", (e: unknown) => errors.push(e));
    return { sock, got, errors };
}

const a = new Uint8Array([1, 2, 3, 4, 5]);
const b = new Uint8Array(300).map((_, i) => i & 0xff);
const c = new Uint8Array([9, 9]);
const stream = concat(segment(MiniProtocol.ChainSync, a), segment(MiniProtocol.BlockFetch, b), segment(MiniProtocol.ChainSync, c));

describe("Multiplexer framing across TCP chunk boundaries", () => {
    test("one chunk: all three segments dispatch", () => {
        const h = harness();
        h.sock.emit("data", stream);
        expect(h.errors).toEqual([]);
        expect(h.got.map((g) => g.protocol)).toEqual([MiniProtocol.ChainSync, MiniProtocol.BlockFetch, MiniProtocol.ChainSync]);
        expect(Array.from(h.got[1]!.payload)).toEqual(Array.from(b));
    });

    test("chunk boundary inside the second header (3 of 8 header bytes) keeps framing", () => {
        const h = harness();
        const cut = 8 + a.length + 3;
        h.sock.emit("data", stream.slice(0, cut));
        h.sock.emit("data", stream.slice(cut));
        expect(h.errors).toEqual([]);
        expect(h.got.map((g) => g.protocol)).toEqual([MiniProtocol.ChainSync, MiniProtocol.BlockFetch, MiniProtocol.ChainSync]);
        expect(Array.from(h.got[1]!.payload)).toEqual(Array.from(b));
        expect(Array.from(h.got[2]!.payload)).toEqual(Array.from(c));
    });

    test("every possible split point of the stream yields the same three segments", () => {
        for (let cut = 1; cut < stream.length; cut++) {
            const h = harness();
            h.sock.emit("data", stream.slice(0, cut));
            h.sock.emit("data", stream.slice(cut));
            expect(h.errors).toEqual([]);
            expect(h.got.length).toBe(3);
            expect(Array.from(h.got[1]!.payload)).toEqual(Array.from(b));
        }
    });

    test("byte-by-byte delivery", () => {
        const h = harness();
        for (let i = 0; i < stream.length; i++) h.sock.emit("data", stream.slice(i, i + 1));
        expect(h.errors).toEqual([]);
        expect(h.got.map((g) => g.protocol)).toEqual([MiniProtocol.ChainSync, MiniProtocol.BlockFetch, MiniProtocol.ChainSync]);
    });
});
