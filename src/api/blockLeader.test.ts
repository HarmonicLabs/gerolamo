import { describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { slotLeaderOfBlock } from "./blockLeader";
import shelleyConway from "../consensus/__fixtures__/shelley-conway-preprod.json";
import byron from "../consensus/__fixtures__/byron-preprod.json";

const sc = shelleyConway.blocks as Record<string, string>;
const byronBlocks = byron.blocks as string[];

describe("slotLeaderOfBlock", () => {
    test("Shelley and Conway blocks yield a 28-byte pool key hash", () => {
        expect(slotLeaderOfBlock(fromHex(sc.shelley_86400!))).toMatch(/^[0-9a-f]{56}$/);
        expect(slotLeaderOfBlock(fromHex(sc.tip!))).toMatch(/^[0-9a-f]{56}$/);
    });
    test("Byron EBB has no leader; Byron main blocks yield the issuer key hash", () => {
        const leaders = byronBlocks.map((b) => slotLeaderOfBlock(fromHex(b)));
        expect(leaders[0]).toBeNull(); // epoch-0 EBB
        for (const l of leaders.slice(1)) expect(l).toMatch(/^[0-9a-f]{56}$/);
    });
    test("garbage never throws", () => {
        expect(slotLeaderOfBlock(new Uint8Array([1, 2, 3]))).toBeNull();
    });
});
