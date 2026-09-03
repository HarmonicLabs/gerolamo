import { describe, expect, test } from "bun:test";
import {
    BlockFetchBlock,
    ChainPoint,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { PeerClient } from "./PeerClient";

function point(slot: bigint, byte: number): ChainPoint {
    return new ChainPoint({
        blockHeader: {
            slotNumber: slot,
            hash: new Uint8Array(32).fill(byte),
        },
    });
}

describe("PeerClient BlockFetch ranges", () => {
    test("fetches a contiguous point list with one inclusive range request", async () => {
        const calls: Array<[ChainPoint, ChainPoint]> = [];
        const blocks = [
            new BlockFetchBlock({ blockData: new Uint8Array([0x81, 0x01]) }),
            new BlockFetchBlock({ blockData: new Uint8Array([0x81, 0x02]) }),
            new BlockFetchBlock({ blockData: new Uint8Array([0x81, 0x03]) }),
        ];
        const peer = Object.create(PeerClient.prototype) as PeerClient;
        Object.defineProperty(peer, "blockFetchClient", {
            value: {
                requestRange: async (from: ChainPoint, to: ChainPoint) => {
                    calls.push([from, to]);
                    return blocks;
                },
            },
        });
        Object.defineProperty(peer, "peerId", { value: "test-peer" });

        const points = [point(10n, 1), point(14n, 2), point(21n, 3)];
        const result = await peer.fetchBlockRange(points);

        expect(result).toEqual(blocks);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0]).toBe(points[0]);
        expect(calls[0]?.[1]).toBe(points[2]);
    });

    test("does not issue a range request for an empty point list", async () => {
        let calls = 0;
        const peer = Object.create(PeerClient.prototype) as PeerClient;
        Object.defineProperty(peer, "blockFetchClient", {
            value: {
                requestRange: async () => {
                    calls += 1;
                    return [];
                },
            },
        });
        Object.defineProperty(peer, "peerId", { value: "test-peer" });

        expect(await peer.fetchBlockRange([])).toEqual([]);
        expect(calls).toBe(0);
    });

    test("terminates the peer when a range exceeds the protocol deadline", async () => {
        let terminated = "";
        const peer = Object.assign(Object.create(PeerClient.prototype), {
            peerId: "slow-peer",
            config: { blockFetchBatch: { rangeTimeoutMs: 5 } },
            blockFetchClient: {
                requestRange: () => new Promise(() => {}),
            },
            terminate: (reason: string) => {
                terminated = reason;
            },
        }) as PeerClient;

        await expect(peer.fetchBlockRange([point(10n, 1), point(11n, 2)]))
            .rejects.toThrow("BlockFetch range slow-peer timed out");
        expect(terminated).toContain("BlockFetch range slow-peer timed out");
    });
});
