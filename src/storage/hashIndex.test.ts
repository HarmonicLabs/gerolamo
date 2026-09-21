import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HASH_INDEX_RECORD, HashIndex } from "./hashIndex";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const h = (seed: number) => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(0, seed); b[31] = seed & 255; return b; };

describe("HashIndex", () => {
    test("add, lookup, persist, reload, grow, torn record", async () => {
        const dir = await mkdtemp(join(tmpdir(), "hashindex-")); tmp.push(dir);
        const path = join(dir, "sub", "hash-index.bin");
        const ix = await HashIndex.open(path, 16);
        for (let i = 0; i < 5000; i++) await (i % 2 ? ix.add(h(i), i * 7) : ix.addMany([{ hash: h(i), slot: i * 7 }]));
        expect(ix.size).toBe(5000);
        expect(ix.lookup(h(1234))).toEqual([1234 * 7]);
        expect(ix.lookup(h(99999))).toEqual([]);
        expect(ix.maxSlot).toBe(4999 * 7);
        expect((await stat(path)).size).toBe(5000 * HASH_INDEX_RECORD);
        // prefix collision: same first 8 bytes, different tail → both candidates returned
        const twin = h(1234); twin[31] ^= 0xff;
        await ix.add(twin, 42);
        expect(ix.lookup(h(1234)).sort()).toEqual([42, 1234 * 7].sort());
        // torn trailing record survives a reload
        await Bun.write(path, new Uint8Array([...(await Bun.file(path).bytes()), 1, 2, 3]));
        const again = await HashIndex.open(path, 16);
        expect(again.size).toBe(5001);
        expect(again.lookup(h(4321))).toEqual([4321 * 7]);
        expect((await stat(path)).size).toBe(5001 * HASH_INDEX_RECORD);
    }, 60_000); // 5 000 single-record appends: disk-bound, slow while another process vacuums
});
