import { describe, expect, test } from "bun:test";
import { Cbor } from "@harmoniclabs/cbor";
import { EventEmitter } from "node:events";
import {
    BlockFetchBatchDone,
    BlockFetchBlock,
    BlockFetchNoBlocks,
    BlockFetchRequestRange,
    BlockFetchStartBatch,
    ChainPoint,
    ChainTip,
    MiniProtocol,
    blockFetchMessageFromCborObj,
    type Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { N2NBlockFetchHost } from "./N2NBlockFetchHost";
import type { RelayChainStore } from "./RelayChainStore";

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

function storeWithRange(available: boolean): RelayChainStore {
    const from = point(10n, 1);
    const to = point(21n, 3);
    return {
        async getTip() {
            return new ChainTip({ point: to, blockNo: 3n });
        },
        async findIntersect() {
            return undefined;
        },
        async getNextHeader() {
            return undefined;
        },
        async getBlockRange() {
            if (!available) return undefined;
            return [
                { point: from, blockNo: 1n, blockData: new Uint8Array([0x81, 0x01]) },
                { point: point(14n, 2), blockNo: 2n, blockData: new Uint8Array([0x81, 0x02]) },
                { point: to, blockNo: 3n, blockData: new Uint8Array([0x81, 0x03]) },
            ];
        },
    };
}

const decode = (bytes: Uint8Array) =>
    blockFetchMessageFromCborObj(Cbor.parse(bytes));

describe("N2NBlockFetchHost", () => {
    test("serves an inclusive ordered range as StartBatch, Block*, BatchDone", async () => {
        const mux = new FakeMux();
        new N2NBlockFetchHost(
            mux as unknown as Multiplexer,
            storeWithRange(true),
            { maxRangeBlocks: 16 },
        );

        mux.emit(
            MiniProtocol.BlockFetch as any,
            new BlockFetchRequestRange({
                from: point(10n, 1),
                to: point(21n, 3),
            }).toCborBytes(),
        );
        await Bun.sleep(0);

        expect(decode(mux.sent[0]!)).toBeInstanceOf(BlockFetchStartBatch);
        const blocks = mux.sent.slice(1, -1).map(decode) as BlockFetchBlock[];
        expect(blocks).toHaveLength(3);
        expect(blocks.map((b) => [...b.blockData])).toEqual([
            [0x81, 0x01],
            [0x81, 0x02],
            [0x81, 0x03],
        ]);
        expect(decode(mux.sent.at(-1)!)).toBeInstanceOf(BlockFetchBatchDone);
    });

    test("sends NoBlocks when the selected endpoints are unavailable", async () => {
        const mux = new FakeMux();
        new N2NBlockFetchHost(
            mux as unknown as Multiplexer,
            storeWithRange(false),
        );

        mux.emit(
            MiniProtocol.BlockFetch as any,
            new BlockFetchRequestRange({
                from: point(10n, 1),
                to: point(21n, 3),
            }).toCborBytes(),
        );
        await Bun.sleep(0);

        expect(mux.sent).toHaveLength(1);
        expect(decode(mux.sent[0]!)).toBeInstanceOf(BlockFetchNoBlocks);
    });
});
