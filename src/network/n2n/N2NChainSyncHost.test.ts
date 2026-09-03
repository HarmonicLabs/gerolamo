import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborUInt } from "@harmoniclabs/cbor";
import { EventEmitter } from "node:events";
import {
    ChainPoint,
    ChainSyncFindIntersect,
    ChainSyncIntersectFound,
    ChainSyncRequestNext,
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

        const first = decode(mux.sent[1]!) as ChainSyncRollForward;
        const second = decode(mux.sent[2]!) as ChainSyncRollForward;
        expect(first).toBeInstanceOf(ChainSyncRollForward);
        expect(second).toBeInstanceOf(ChainSyncRollForward);
        expect(first.data).toEqual(store.headers[1]!.data);
        expect(second.data).toEqual(store.headers[2]!.data);
    });
});
