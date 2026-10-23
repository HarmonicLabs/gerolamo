import { afterEach, describe, expect, test } from "bun:test";
import { CborArray, CborUInt } from "@harmoniclabs/cbor";
import { connect } from "node:net";
import {
    BlockFetchClient,
    ChainPoint,
    ChainSyncClient,
    ChainSyncIntersectFound,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    ChainTip,
    HandshakeAcceptVersion,
    HandshakeClient,
    KeepAliveClient,
    Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { startN2NServer, type N2NServerHandle , N2N_WS_SUBPROTOCOL, N2N_WS_SUBPROTOCOL_LIGHTQUERY, selectN2NSubprotocol } from "./N2NServer";
import type { RelayChainStore, RelayHeader } from "./RelayChainStore";

const point = (slot: bigint, byte: number) => new ChainPoint({
    blockHeader: {
        slotNumber: slot,
        hash: new Uint8Array(32).fill(byte),
    },
});

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([
        promise,
        Bun.sleep(500).then(() => {
            throw new Error(`${label} timed out`);
        }),
    ]);
}

class FakeStore implements RelayChainStore {
    readonly headers: RelayHeader[] = [
        { point: point(10n, 1), blockNo: 1n, data: new CborArray([new CborUInt(10)]) },
        { point: point(14n, 2), blockNo: 2n, data: new CborArray([new CborUInt(14)]) },
    ];
    async getTip() {
        return new ChainTip({ point: this.headers[1]!.point, blockNo: 2n });
    }
    async findIntersect(points: readonly ChainPoint[]) {
        for (const candidate of points) {
            const found = this.headers.find((h) => ChainPoint.eq(h.point, candidate));
            if (found) return { point: found.point, blockNo: found.blockNo };
        }
        return undefined;
    }
    async getNextHeader(after: ChainPoint) {
        const slot = after.blockHeader?.slotNumber ?? -1n;
        return this.headers.find((h) => h.point.blockHeader!.slotNumber > slot);
    }
    async getBlockRange(from: ChainPoint, to: ChainPoint) {
        if (!ChainPoint.eq(from, this.headers[0]!.point)) return undefined;
        if (!ChainPoint.eq(to, this.headers[1]!.point)) return undefined;
        return [
            { point: this.headers[0]!.point, blockNo: 1n, blockData: new Uint8Array([0x81, 0x01]) },
            { point: this.headers[1]!.point, blockNo: 2n, blockData: new Uint8Array([0x81, 0x02]) },
        ];
    }
}

let handle: N2NServerHandle | undefined;
let clientMux: Multiplexer | undefined;

afterEach(async () => {
    try {
        clientMux?.close({ closeSocket: true });
    } catch {
        /* ignore */
    }
    clientMux = undefined;
    await handle?.stop();
    handle = undefined;
});

describe("N2NServer loopback interoperability", () => {
    test("handshakes, keeps alive, serves ChainSync, and serves BlockFetch", async () => {
        const store = new FakeStore();
        handle = await startN2NServer({
            host: "127.0.0.1",
            port: 0,
            networkMagic: 1,
            store,
            maxConnections: 4,
            handshakeTimeoutMs: 2_000,
            idleTimeoutMs: 5_000,
        });
        clientMux = new Multiplexer({
            protocolType: "node-to-node",
            connect: () => connect({
                host: handle!.host,
                port: handle!.port,
            }) as any,
        });

        const handshake = new HandshakeClient(clientMux);
        const accepted = await handshake.propose({ networkMagic: 1, query: false });
        expect(accepted).toBeInstanceOf(HandshakeAcceptVersion);

        const keepAlive = new KeepAliveClient(clientMux);
        const pong = await within(keepAlive.request(42), "keepalive");
        expect(pong.cookie).toBe(42);

        const chainSync = new ChainSyncClient(clientMux);
        const intersection = await chainSync.findIntersect([store.headers[0]!.point]);
        expect(intersection).toBeInstanceOf(ChainSyncIntersectFound);
        // spec §3.7: the first reply after the intersection rolls the client back to it
        const rollback = await chainSync.requestNext();
        expect(rollback).toBeInstanceOf(ChainSyncRollBackwards);
        const next = await chainSync.requestNext();
        expect(next).toBeInstanceOf(ChainSyncRollForward);
        expect((next as ChainSyncRollForward).data).toEqual(store.headers[1]!.data);

        const blockFetch = new BlockFetchClient(clientMux);
        const blocks = await blockFetch.requestRange(
            store.headers[0]!.point,
            store.headers[1]!.point,
        );
        expect(Array.isArray(blocks)).toBe(true);
        expect(Array.isArray(blocks) ? blocks.map((b) => [...b.blockData]) : [])
            .toEqual([[0x81, 0x01], [0x81, 0x02]]);
        expect(handle.clientCount()).toBe(1);
    });
});

describe("N2N over WebSocket", () => {
    // Gerolamino (the browser-extension node) connects at `${base}/relay`; the canonical path is /n2n
    test("handshakes and serves ChainSync on /n2n, /relay and /; other paths get 404", async () => {
        const store = new FakeStore();
        handle = await startN2NServer({
            host: "127.0.0.1",
            port: 0,
            networkMagic: 2,
            store,
            maxConnections: 8,
            handshakeTimeoutMs: 2_000,
            idleTimeoutMs: 5_000,
            ws: { host: "127.0.0.1", port: 0 },
        });
        const wsPort = handle.wsPort!;
        expect(wsPort).toBeGreaterThan(0);
        for (const path of ["/n2n", "/relay", "/", "/relay/"]) {
            const ws = await new Promise<WebSocket>((resolve, reject) => {
                const s = new WebSocket(`ws://127.0.0.1:${wsPort}${path}`);
                s.binaryType = "arraybuffer";
                s.addEventListener("open", () => resolve(s), { once: true });
                s.addEventListener("error", () => reject(new Error(`cannot open ${path}`)), { once: true });
            });
            const mux = new Multiplexer({ protocolType: "node-to-node", connect: () => ws as any });
            const accepted = await within(new HandshakeClient(mux).propose({ networkMagic: 2, query: false }), `handshake ${path}`);
            expect(accepted).toBeInstanceOf(HandshakeAcceptVersion);
            const chainSync = new ChainSyncClient(mux);
            const intersection = await within(chainSync.findIntersect([store.headers[0]!.point]), `intersect ${path}`);
            expect(intersection).toBeInstanceOf(ChainSyncIntersectFound);
            mux.close();
            ws.close();
        }
        const res = await fetch(`http://127.0.0.1:${wsPort}/elsewhere`);
        expect(res.status).toBe(404);
    });

    test("announces its services as a WebSocket subprotocol (richest offered), none when none is offered", async () => {
        const open = (port: number, protocols?: string[]) => new Promise<WebSocket>((resolve, reject) => {
            const s = protocols ? new WebSocket(`ws://127.0.0.1:${port}/n2n`, protocols) : new WebSocket(`ws://127.0.0.1:${port}/n2n`);
            s.addEventListener("open", () => resolve(s), { once: true });
            s.addEventListener("error", () => reject(new Error("cannot open")), { once: true });
        });
        const both = [N2N_WS_SUBPROTOCOL_LIGHTQUERY, N2N_WS_SUBPROTOCOL];
        for (const [lightQuery, expected] of [[true, N2N_WS_SUBPROTOCOL_LIGHTQUERY], [false, N2N_WS_SUBPROTOCOL]] as const) {
            const h = await startN2NServer({
                host: "127.0.0.1", port: 0, networkMagic: 2, store: new FakeStore(), maxConnections: 8,
                handshakeTimeoutMs: 2_000, idleTimeoutMs: 5_000, ws: { host: "127.0.0.1", port: 0 },
                ...(lightQuery ? { lightQuery: { networkMagic: 2, activeSlotsCoeff: 0.05 } } : {}),
            });
            try {
                const a = await open(h.wsPort!, both);
                expect(a.protocol).toBe(expected);
                a.close();
                const legacy = await open(h.wsPort!);
                expect(legacy.protocol).toBe("");
                legacy.close();
            } finally { await h.stop(); }
        }
        expect(selectN2NSubprotocol("cardano-n2n.v1+lightquery, cardano-n2n.v1", true)).toBe("cardano-n2n.v1+lightquery");
        expect(selectN2NSubprotocol("cardano-n2n.v1+lightquery", false)).toBeNull();
        expect(selectN2NSubprotocol(null, true)).toBeNull();
    });
});
