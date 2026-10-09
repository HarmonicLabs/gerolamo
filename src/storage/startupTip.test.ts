// Bug 387: the persisted selected tip fell behind during catch-up (a debounce restarted by every block never
// fired) and the next start refused primary mode. The write is throttled now, and startup falls back to the
// newest stored block both stores hold.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql } from "../sql";
import { ChunkStore } from "./chunkStore";
import { BlockStore } from "./blockStore";
import { persistSelectedTipTo, setSelectedTipHash } from "./blockReads";
import { resolveStartupTip, selectedTipPathFor } from "./nodeBlockStore";

const SRC = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const CHUNK_SLOTS = 4320;
const root = mkdtempSync(join(tmpdir(), "startup-tip-"));
afterAll(() => { persistSelectedTipTo(null); setSelectedTipHash(null); rmSync(root, { recursive: true, force: true }); });
initSql(join(root, "t.db"));

const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe.skipIf(!existsSync(`${SRC}/01000.primary`))("startup tip (bug 387)", () => {
    async function sample(n: number) {
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true, hashIndexPath: false });
        const out: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(1000 * CHUNK_SLOTS, 1000 * CHUNK_SLOTS + 4000)) { out.push(b); if (out.length >= n) break; }
        return out;
    }

    test("the persisted tip is written while the tip keeps moving faster than 200 ms", async () => {
        const dir = join(root, "throttle");
        mkdirSync(join(dir, "gerolamo"), { recursive: true });
        const p = selectedTipPathFor(dir);
        persistSelectedTipTo(p);
        const blocks = await sample(40);
        const t0 = Date.now();
        let i = 0;
        while (Date.now() - t0 < 700) { setSelectedTipHash(blocks[i++ % blocks.length]!.hash); await Bun.sleep(5); }
        expect(existsSync(p)).toBe(true);
        await Bun.sleep(250);
        expect(readFileSync(p, "utf8")).toBe(hx(blocks[(i - 1) % blocks.length]!.hash)); // the newest one, after the last tick
        persistSelectedTipTo(null);
    });

    test("a stale persisted tip falls back to the newest block with a flushed ledger diff", async () => {
        const blocks = await sample(80);
        const dir = join(root, "fallback");
        const bs = await BlockStore.open(dir, { k: 20 });
        await bs.chunks.appendMany([blocks[0]!]);
        for (const b of blocks.slice(1)) await bs.put(b.bytes, b.hash);
        await bs.promote(blocks[60]!.hash, 20); // immutable tip: block 40
        mkdirSync(join(dir, "gerolamo"), { recursive: true });
        writeFileSync(selectedTipPathFor(dir), hx(blocks[10]!.hash)); // stale: below the immutable tip
        const diffs = join(dir, "ledger-diffs");
        mkdirSync(diffs, { recursive: true });
        for (let i = 41; i <= 60; i++) writeFileSync(join(diffs, `${hx(blocks[i]!.hash)}.diff`), "x");
        writeFileSync(join(diffs, `${hx(blocks[61]!.hash)}.diff.tmp`), "x"); // not flushed: not a candidate
        expect(await resolveStartupTip(bs, dir)).toBeNull(); // without the ledger's diffs: refused, as before
        const r = await resolveStartupTip(bs, dir, diffs);
        expect(r?.source).toBe("newest block with a ledger diff");
        expect(hx(r!.hash)).toBe(hx(blocks[60]!.hash));
    });
});
