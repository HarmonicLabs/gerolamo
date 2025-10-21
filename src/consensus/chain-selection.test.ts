import { describe, expect, test } from "bun:test";
import { ChainTip, ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { ChainCandidate, compareChains } from "./validation/types";

describe("Chain Selection", () => {
    test("prefers longer chains", () => {
        const shortChain: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 100n,
                        hash: new Uint8Array(32).fill(1)
                    }
                }),
                blockNo: 10n
            })
        };

        const longChain: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 200n,
                        hash: new Uint8Array(32).fill(2)
                    }
                }),
                blockNo: 20n
            })
        };

        expect(compareChains(longChain, shortChain)).toBe(1);
        expect(compareChains(shortChain, longChain)).toBe(-1);
    });

    test("tie-breaks by leader stake", () => {
        const lowStake: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 100n,
                        hash: new Uint8Array(32).fill(1)
                    }
                }),
                blockNo: 10n
            }),
            leaderStake: 100n
        };

        const highStake: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 100n,
                        hash: new Uint8Array(32).fill(1)
                    }
                }),
                blockNo: 10n
            }),
            leaderStake: 200n
        };

        expect(compareChains(highStake, lowStake)).toBe(1);
        expect(compareChains(lowStake, highStake)).toBe(-1);
    });

    test("tie-breaks by hash when stakes equal", () => {
        const hash1 = new Uint8Array(32).fill(1);
        const hash2 = new Uint8Array(32).fill(2);

        const chainA: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 100n,
                        hash: hash1
                    }
                }),
                blockNo: 10n
            }),
            leaderStake: 100n
        };

        const chainB: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 100n,
                        hash: hash2
                    }
                }),
                blockNo: 10n
            }),
            leaderStake: 100n
        };

        // hash1 < hash2 lexicographically (all 1s vs all 2s)
        expect(compareChains(chainA, chainB)).toBe(1);
        expect(compareChains(chainB, chainA)).toBe(-1);
    });

    test("returns 0 for identical chains", () => {
        const chain: ChainCandidate = {
            tip: new ChainTip({
                point: new ChainPoint({
                    blockHeader: {
                        slotNumber: 100n,
                        hash: new Uint8Array(32).fill(1)
                    }
                }),
                blockNo: 10n
            }),
            leaderStake: 100n
        };

        expect(compareChains(chain, chain)).toBe(0);
    });
});