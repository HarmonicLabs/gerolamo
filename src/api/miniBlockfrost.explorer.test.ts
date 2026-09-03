import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { initSql } from "../sql";
import { backfillBlockHeights, ensureInitialized, insertBlockVolatile } from "../db";
import { handleMiniBlockfrost } from "./miniBlockfrost";
import shelleyConway from "../consensus/__fixtures__/shelley-conway-preprod.json";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-explorer-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sc = shelleyConway.blocks as Record<string, string>;
const payload = (era: number, n: number) => new Uint8Array([0x82, era, ...new Array(n).fill(0xaa)]);
const h = (i: number) => i.toString(16).padStart(64, "0");
const get = async (path: string) => {
    const url = new URL("http://127.0.0.1:3030/api/v0" + path);
    const res = await handleMiniBlockfrost(new Request(url), url, { network: "preprod" });
    return { status: res!.status, body: (await res!.json()) as any };
};

describe("explorer endpoints", () => {
    beforeAll(async () => {
        initSql(join(dir, "api.db"));
        await ensureInitialized();
        // preprod: Byron EBB + main at slot 0, mains at 1..3, EBB+main at 21600, the real first Shelley block at 86400 (era 2)
        const rows: Array<[number, Uint8Array]> = [[0, payload(0, 10)], [0, payload(1, 20)], [1, payload(1, 20)], [2, payload(1, 20)], [3, payload(1, 20)], [21600, payload(0, 10)], [21600, payload(1, 20)], [86400, fromHex(sc.shelley_86400!)]];
        let i = 1;
        for (const [slot, data] of rows) {
            await insertBlockVolatile({ slot: BigInt(slot), blockHash: h(i), prevHash: h(i - 1), blockNo: null, headerData: new Uint8Array([1]), blockData: data });
            i++;
        }
        await backfillBlockHeights();
    });

    test("GET /blocks lists newest first with height, time, epoch and cursor paging", async () => {
        const { status, body } = await get("/blocks?limit=3");
        expect(status).toBe(200);
        expect(body.map((b: any) => [b.slot, b.height])).toEqual([[86400, 6], [21600, 5], [21600, null]]);
        expect(body[0].time).toBe(1_655_769_600 + 86_400 * 20);
        expect(body[0].epoch).toBe(4);
        expect(body[0].epoch_slot).toBe(0);
        expect(body[0].slot_leader).toMatch(/^[0-9a-f]{56}$/);
        expect(body[0].confirmations).toBe(0);
        expect(body[1].confirmations).toBe(1);
        expect(body[2].ebb).toBe(true);
        const page2 = await get(`/blocks?limit=10&before=${body[2].hash}`);
        expect(page2.body.map((b: any) => [b.slot, b.height])).toEqual([[3, 4], [2, 3], [1, 2], [0, 1], [0, null]]);
    });

    test("GET /blocks/latest, /blocks/{slot}, /blocks/height/{n}, previous and next", async () => {
        const latest = await get("/blocks/latest");
        expect(latest.body.height).toBe(6);
        expect(latest.body.previous_block).toBe(h(7));
        expect(latest.body.next_block).toBeNull();
        const bySlot = await get("/blocks/0");
        expect(bySlot.body.height).toBe(1); // the main block, not the EBB
        const byHeight = await get("/blocks/height/3");
        expect(byHeight.body.slot).toBe(2);
        const prev = await get(`/blocks/${h(8)}/previous?count=2`);
        expect(prev.body.map((b: any) => b.height)).toEqual([5, null]);
        const next = await get(`/blocks/${h(6)}/next?count=3`); // the EBB at 21600 → its main block, then the Shelley block
        expect(next.body.map((b: any) => b.height)).toEqual([5, 6]);
        expect((await get("/blocks/height/99")).status).toBe(404);
        expect((await get("/blocks/not-a-block")).status).toBe(400);
    });

    test("GET /epochs/{n} from geometry and stored blocks", async () => {
        const e0 = await get("/epochs/0");
        expect(e0.body).toMatchObject({ epoch: 0, start_time: 1_655_769_600, block_count: 5, first_slot: 0, last_slot: 21599, synced: "complete" });
        expect(e0.body.first_block).toBe(h(1));
        expect(e0.body.last_block).toBe(h(5));
        const e4 = await get("/epochs/4");
        expect(e4.body.block_count).toBe(1);
        expect(e4.body.synced).toBe("partial");
        const blocks = await get("/epochs/1/blocks");
        expect(blocks.body).toEqual([h(6), h(7)]);
        const prev = await get("/epochs/1/previous?count=3");
        expect(prev.body.map((e: any) => e.epoch)).toEqual([0]);
        expect((await get("/epochs/0/parameters")).status).toBe(404);
    });

    test("GET /search resolves hashes, heights, slots and address shapes", async () => {
        expect((await get(`/search?q=${h(8)}`)).body).toEqual({ kind: "block", id: h(8) });
        expect((await get("/search?q=3")).body).toMatchObject({ kind: "block", id: h(4), height: 3 });
        expect((await get("/search?q=86400")).body).toMatchObject({ kind: "block", id: h(8), slot: 86400 });
        expect((await get("/search?q=addr_test1vq")).body).toEqual({ kind: "address", id: "addr_test1vq" });
        expect((await get(`/search?q=${"ff".repeat(32)}`)).body.kind).toBe("unknown");
        expect((await get("/search?q=")).status).toBe(400);
    });
});
