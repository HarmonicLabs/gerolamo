import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborUInt } from "@harmoniclabs/cbor";
import { EventEmitter } from "node:events";
import {
    ChainPoint,
    ChainSyncFindIntersect,
    ChainSyncIntersectFound,
    ChainSyncRequestNext,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    ChainTip,
    MiniProtocol,
    chainSyncMessageFromCborObj,
    type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { N2NChainSyncHost } from "./N2NChainSyncHost";
import type { RelayChainStore, RelayHeader } from "./RelayChainStore";

class FakeMux extends EventEmitter {
    sent: Uint8Array[] = [];
    send(payload: Uint8Array): void {
        this.sent.push(payload);
    }
}

const point = (slot: bigint, byte: number) => new ChainPoint({
    blockHeader: {
        slotNumber: slot,
        hash: new Uint8Array(32).fill(byte),
    },
});

class FakeStore implements RelayChainStore {
    readonly headers: RelayHeader[] = [
        { point: point(10n, 1), blockNo: 1n, data: new CborArray([new CborUInt(10)]) },
        { point: point(14n, 2), blockNo: 2n, data: new CborArray([new CborUInt(14)]) },
        { point: point(21n, 3), blockNo: 3n, data: new CborArray([new CborUInt(21)]) },
    ];
    async getTip() {
        return new ChainTip({ point: this.headers[2]!.point, blockNo: 3n });
    }
    async findIntersect(points: readonly ChainPoint[]) {
        for (const candidate of points) {
            const found = this.headers.find((h) => ChainPoint.eq(h.point, candidate));
            if (found) return { point: found.point, blockNo: found.blockNo };
        }
        if (points.some((p) => !p.blockHeader)) {
            return { point: ChainPoint.origin, blockNo: 0n };
        }
        return undefined;
    }
    async getNextHeader(after: ChainPoint) {
        const slot = after.blockHeader?.slotNumber ?? -1n;
        return this.headers.find((h) => h.point.blockHeader!.slotNumber > slot);
    }
    async getBlockRange() {
        return undefined;
    }
}

function decode(bytes: Uint8Array) {
    return chainSyncMessageFromCborObj(Cbor.parse(bytes));
}

describe("N2NChainSyncHost", () => {
    test("serves sparse-slot headers after the selected intersection without duplication", async () => {
        const mux = new FakeMux();
        const store = new FakeStore();
        new N2NChainSyncHost(mux as unknown as Multiplexer, store, {
            pollIntervalMs: 1_000,
        });

        mux.emit(
            MiniProtocol.ChainSync as any,
            new ChainSyncFindIntersect({ points: [store.headers[0]!.point] })
                .toCborBytes(),
        );
        await Bun.sleep(0);
        expect(decode(mux.sent[0]!)).toBeInstanceOf(ChainSyncIntersectFound);

        mux.emit(MiniProtocol.ChainSync as any, new ChainSyncRequestNext().toCborBytes());
        await Bun.sleep(0);
        mux.emit(MiniProtocol.ChainSync as any, new ChainSyncRequestNext().toCborBytes());
        await Bun.sleep(0);
        mux.emit(MiniProtocol.ChainSync as any, new ChainSyncRequestNext().toCborBytes());
        await Bun.sleep(0);

        // spec §3.7: the first reply after the intersection rolls the client back to it
        const rollback = decode(mux.sent[1]!) as ChainSyncRollBackwards;
        expect(rollback).toBeInstanceOf(ChainSyncRollBackwards);
        expect(String(rollback.point.blockHeader?.slotNumber)).toBe(String(store.headers[0]!.point.blockHeader?.slotNumber));
        const first = decode(mux.sent[2]!) as ChainSyncRollForward;
        const second = decode(mux.sent[3]!) as ChainSyncRollForward;
        expect(first).toBeInstanceOf(ChainSyncRollForward);
        expect(second).toBeInstanceOf(ChainSyncRollForward);
        expect(first.data).toEqual(store.headers[1]!.data);
        expect(second.data).toEqual(store.headers[2]!.data);
    });
});

describe("N2NChainSyncHost: our chain switches branches under a client (bug 287)", () => {
    const hash = (b: number) => new Uint8Array(32).fill(b);
    class ForkStore extends FakeStore {
        chain: RelayHeader[] = [
            { point: point(10n, 1), blockNo: 1n, data: new CborArray([new CborUInt(10)]), prevHash: hash(0) },
            { point: point(14n, 2), blockNo: 2n, data: new CborArray([new CborUInt(14)]), prevHash: hash(1) },
            { point: point(21n, 3), blockNo: 3n, data: new CborArray([new CborUInt(21)]), prevHash: hash(2) }, // L
        ];
        override async getTip() { const t = this.chain[this.chain.length - 1]!; return new ChainTip({ point: t.point, blockNo: t.blockNo }); }
        override async findIntersect(points: readonly ChainPoint[]) {
            for (const c of points) { const f = this.chain.find((h) => ChainPoint.eq(h.point, c)); if (f) return { point: f.point, blockNo: f.blockNo }; }
            return undefined;
        }
        override async getNextHeader(after: ChainPoint) {
            const slot = after.blockHeader?.slotNumber ?? -1n;
            return this.chain.find((h) => h.point.blockHeader!.slotNumber > slot);
        }
    }

    test("the client on the abandoned block gets MsgRollBackward to the common block, then the new branch", async () => {
        const mux = new FakeMux();
        const store = new ForkStore();
        new N2NChainSyncHost(mux as unknown as Multiplexer, store, { pollIntervalMs: 1_000 });
        const send = async (m: { toCborBytes(): Uint8Array }) => { mux.emit(MiniProtocol.ChainSync as any, m.toCborBytes()); await Bun.sleep(0); };
        await send(new ChainSyncFindIntersect({ points: [store.chain[0]!.point] }));
        await send(new ChainSyncRequestNext()); // rollback to the intersection
        await send(new ChainSyncRequestNext()); // 14
        await send(new ChainSyncRequestNext()); // 21 (L)
        expect(decode(mux.sent[3]!)).toBeInstanceOf(ChainSyncRollForward);
        // our chain drops L for N (same parent, same slot) and grows N2
        store.chain = [store.chain[0]!, store.chain[1]!,
            { point: point(21n, 4), blockNo: 3n, data: new CborArray([new CborUInt(2104)]), prevHash: hash(2) },
            { point: point(26n, 5), blockNo: 4n, data: new CborArray([new CborUInt(26)]), prevHash: hash(4) }];
        await send(new ChainSyncRequestNext());
        const back = decode(mux.sent[4]!) as ChainSyncRollBackwards;
        expect(back).toBeInstanceOf(ChainSyncRollBackwards); // was: N2 straight after L → UnexpectedPrevHash at the client
        expect(String(back.point.blockHeader?.slotNumber)).toBe("14");
        await send(new ChainSyncRequestNext());
        await send(new ChainSyncRequestNext());
        const enc = (o: any) => Buffer.from(Cbor.encode(o).toBuffer()).toString("hex");
        expect(enc((decode(mux.sent[5]!) as ChainSyncRollForward).data)).toBe(enc(new CborArray([new CborUInt(2104)])));
        expect(enc((decode(mux.sent[6]!) as ChainSyncRollForward).data)).toBe(enc(new CborArray([new CborUInt(26)])));
    });

    test("a header whose parent is not the client's position, the position still on our chain (a store gap): served, no rollback loop", async () => {
        const mux = new FakeMux();
        const store = new ForkStore();
        store.chain[2] = { ...store.chain[2]!, prevHash: hash(9) };
        new N2NChainSyncHost(mux as unknown as Multiplexer, store, { pollIntervalMs: 1_000 });
        const send = async (m: { toCborBytes(): Uint8Array }) => { mux.emit(MiniProtocol.ChainSync as any, m.toCborBytes()); await Bun.sleep(0); };
        await send(new ChainSyncFindIntersect({ points: [store.chain[0]!.point] }));
        for (let i = 0; i < 3; i++) await send(new ChainSyncRequestNext());
        expect(decode(mux.sent[3]!)).toBeInstanceOf(ChainSyncRollForward);
    });
});
