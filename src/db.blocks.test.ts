import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";
import {
    backfillBlockHeights,
    countBlocksInSlotRange,
    ensureInitialized,
    getBlockListRowByHeight,
    getBlockListRowBySlot,
    getMaxBlockNo,
    insertBlockVolatile,
    listBlocksDesc,
    listBlocksInSlotRange,
} from "./db";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-blocks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Synthetic BlockFetch payload: `[era, ...]` — byte 2 is the era (0 = Byron EBB). */
const payload = (era: number, n: number) => new Uint8Array([0x82, era, ...new Array(n).fill(0xaa)]);
const h = (i: number) => i.toString(16).padStart(64, "0");

describe("block heights and explorer listing", () => {
    beforeAll(async () => {
        initSql(join(dir, "blocks.db"));
        await ensureInitialized();
        // Byron: EBB + first main block share slot 0; slots 1..3 main; EBB at 21600 with its main block; then Shelley-era blocks.
        const rows: Array<[number, number, number]> = [[0, 0, 100], [0, 1, 200], [1, 1, 200], [2, 1, 200], [3, 1, 200], [21600, 0, 100], [21600, 1, 200], [90000, 2, 300], [90020, 2, 300]];
        let i = 1;
        for (const [slot, era, size] of rows) {
            await insertBlockVolatile({ slot: BigInt(slot), blockHash: h(i), prevHash: h(i - 1), blockNo: null, headerData: new Uint8Array([1]), blockData: payload(era, size) });
            i++;
        }
    });

    test("backfill numbers main blocks from 1 and leaves EBBs null; idempotent", async () => {
        const r = await backfillBlockHeights();
        expect(r.numbered).toBe(7);
        expect(await getMaxBlockNo()).toBe(7);
        expect((await getBlockListRowByHeight(1))!.hash).toBe(h(2)); // first main block at slot 0
        expect((await getBlockListRowByHeight(5))!.slot).toBe(21600);
        expect((await getBlockListRowByHeight(7))!.slot).toBe(90020);
        const ebb = (await sql`SELECT block_no FROM blocks WHERE hash = ${h(1)}`.values()) as unknown[][];
        expect(ebb[0]![0]).toBeNull();
        expect((await backfillBlockHeights()).numbered).toBe(0);
    });

    test("newest-first listing, EBB after the main block of its slot, cursor paging without gaps or repeats", async () => {
        const page1 = await listBlocksDesc({ limit: 3 });
        expect(page1.map((b) => [b.slot, b.blockNo])).toEqual([[90020, 7], [90000, 6], [21600, 5]]);
        const last = page1[page1.length - 1]!;
        const page2 = await listBlocksDesc({ limit: 3, beforeSlot: last.slot, beforeIsEbb: last.blockNo == null });
        expect(page2.map((b) => [b.slot, b.blockNo])).toEqual([[21600, null], [3, 4], [2, 3]]);
        const last2 = page2[page2.length - 1]!;
        const page3 = await listBlocksDesc({ limit: 10, beforeSlot: last2.slot, beforeIsEbb: last2.blockNo == null });
        expect(page3.map((b) => [b.slot, b.blockNo])).toEqual([[1, 2], [0, 1], [0, null]]);
        expect(page1.length + page2.length + page3.length).toBe(9);
        expect(page1[0]!.size).toBe(302);
    });

    test("slot lookup prefers the main block; epoch ranges count and page oldest first", async () => {
        expect((await getBlockListRowBySlot(0))!.blockNo).toBe(1);
        expect(await countBlocksInSlotRange(0, 21600)).toBe(5);
        const epoch1 = await listBlocksInSlotRange(21600, 43200, 10);
        expect(epoch1.map((b) => b.blockNo)).toEqual([null, 5]);
    });
});
