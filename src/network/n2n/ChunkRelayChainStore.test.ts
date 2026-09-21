import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CborArray, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { BlockStore } from "../../storage/blockStore";
import { ChunkStore } from "../../storage/chunkStore";
import { ChunkRelayChainStore } from "./ChunkRelayChainStore";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const point = (b: { slot: number; hash: Uint8Array }) => new ChainPoint({ blockHeader: { slotNumber: BigInt(b.slot), hash: b.hash } });

describe.skipIf(!existsSync(`${PREVIEW}/28001.primary`))("ChunkRelayChainStore", () => {
    test("tip, intersect, next header and ranges across the immutable/volatile boundary", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const dir = await mkdtemp(join(tmpdir(), "relaystore-")); tmp.push(dir);
        const store = await BlockStore.open(dir, { k: 432 });
        const imm: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28001 * 4320 - 1)) imm.push(b);
        for (const b of imm) await store.chunks.append({ slot: b.slot, hash: b.hash, bytes: b.bytes });
        const vol: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28001 * 4320, 28001 * 4320 + 1500)) vol.push(b);
        for (const b of vol) await store.put(b.bytes, b.hash);
        const relay = new ChunkRelayChainStore(store);

        // tip without an explicit selected tip: highest volatile block that chains to the immutable tip
        const tip = await relay.getTip();
        expect(tip.point.blockHeader!.slotNumber).toBe(BigInt(vol[vol.length - 1]!.slot));
        expect(Number(tip.blockNo)).toBeGreaterThan(4_600_000); // header block number, not the slot
        relay.setTip(vol[vol.length - 1]!.hash);

        // intersect: an immutable point, a volatile point, an unknown point, origin
        const i1 = await relay.findIntersect([point(imm[10]!)]);
        expect(i1!.point.blockHeader!.slotNumber).toBe(BigInt(imm[10]!.slot));
        const i2 = await relay.findIntersect([point({ slot: 1, hash: new Uint8Array(32) }), point(vol[3]!)]);
        expect(i2!.point.blockHeader!.slotNumber).toBe(BigInt(vol[3]!.slot));
        expect(await relay.findIntersect([point({ slot: imm[10]!.slot, hash: new Uint8Array(32) })])).toBeUndefined();
        expect((await relay.findIntersect([ChainPoint.origin]))!.blockNo).toBe(0n);

        // next header: from the last immutable block into the first volatile one, payload [era-1, #6.24(header)]
        const h = await relay.getNextHeader(point(imm[imm.length - 1]!));
        expect(h!.point.blockHeader!.slotNumber).toBe(BigInt(vol[0]!.slot));
        const data = h!.data as CborArray;
        expect(Number((data.array[0] as CborUInt).num)).toBe(6); // Conway wire tag 7 → header era index 6
        expect((data.array[1] as CborTag).tag).toBe(24n);
        // next header from origin is the first immutable block; from the tip there is none
        expect((await relay.getNextHeader(ChainPoint.origin))!.point.blockHeader!.slotNumber).toBe(BigInt(imm[0]!.slot));
        expect(await relay.getNextHeader(point(vol[vol.length - 1]!))).toBeUndefined();

        // block range spanning the boundary, hash-linked; a wrong end hash or too many blocks is refused
        const range = await relay.getBlockRange(point(imm[imm.length - 3]!), point(vol[4]!), 100);
        expect(range!.length).toBe(8);
        expect(range![0]!.blockData).toEqual(imm[imm.length - 3]!.bytes);
        expect(range![7]!.blockData).toEqual(vol[4]!.bytes);
        expect(await relay.getBlockRange(point(imm[imm.length - 3]!), point({ slot: vol[4]!.slot, hash: new Uint8Array(32) }), 100)).toBeUndefined();
        expect(await relay.getBlockRange(point(imm[imm.length - 3]!), point(vol[4]!), 3)).toBeUndefined();

        // a fork block that does not chain to the tip is not on the selected chain
        const stray = (await src.iterate(28002 * 4320).next()).value!;
        await store.put(stray.bytes, stray.hash);
        expect(await relay.findIntersect([point(stray)])).toBeUndefined();
    });
});
