import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedImmutableDir } from "./seed";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });

describe.skipIf(!existsSync(`${PREVIEW}/00002.chunk`))("seedImmutableDir", () => {
    test("hardlinks complete chunks, copies the last one, skips what is present, same-dir is a no-op", async () => {
        const src = await mkdtemp(join(tmpdir(), "seedsrc-")); tmp.push(src);
        const { copyFile } = await import("node:fs/promises"); // the snapshot lives on another device: copy the fixture in
        for (const n of ["00000", "00001", "00002"]) for (const e of ["chunk", "primary", "secondary"]) await copyFile(`${PREVIEW}/${n}.${e}`, join(src, `${n}.${e}`));
        const dst = await mkdtemp(join(tmpdir(), "seeddst-")); tmp.push(dst);
        const r = await seedImmutableDir(src, join(dst, "immutable"));
        expect(r).toEqual({ chunks: 3, linked: 6, copied: 3, skipped: 0, last: 2 });
        const a = await stat(join(src, "00000.chunk")), b = await stat(join(dst, "immutable", "00000.chunk")), c = await stat(join(dst, "immutable", "00002.chunk"));
        expect(b.ino).toBe(a.ino); // hardlink
        expect(c.ino).not.toBe((await stat(join(src, "00002.chunk"))).ino); // copy
        const again = await seedImmutableDir(src, join(dst, "immutable"));
        expect(again.skipped).toBe(9);
        const same = await seedImmutableDir(join(dst, "immutable"), join(dst, "immutable"));
        expect(same.chunks).toBe(3);
        expect(same.linked + same.copied).toBe(0);
    });
});
