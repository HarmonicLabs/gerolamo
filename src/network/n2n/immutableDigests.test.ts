import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImmutableDigests } from "./immutableDigests";

/** A node directory with db/immutable holding `n` complete chunk trios plus the open chunk being written. */
function nodeDir(n: number) {
    const root = mkdtempSync(join(tmpdir(), "digests-"));
    const imm = join(root, "db", "immutable");
    mkdirSync(imm, { recursive: true });
    for (let i = 0; i <= n; i++) for (const ext of ["chunk", "primary", "secondary"]) writeFileSync(join(imm, `${String(i).padStart(5, "0")}.${ext}`), `${i}.${ext}`);
    return { root, imm };
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("Mithril digests of the node's immutable files (light query request 10)", () => {
    test("a page holds every file of the range, in Mithril order, with its SHA-256; the open chunk is never served", async () => {
        const { root, imm } = nodeDir(5); dirs.push(root);
        const d = new ImmutableDigests(imm);
        expect(d.lastComplete()).toBe(4); // 00005.* is still being written
        const p = (await d.page(0, 99))!;
        expect(p.to).toBe(4);
        expect(p.entries.map((e) => e.name).slice(0, 4)).toEqual(["00000.chunk", "00000.primary", "00000.secondary", "00001.chunk"]);
        expect(p.entries).toHaveLength(15);
        expect(p.entries[3]!.digest).toBe(sha("1.chunk"));
        expect(await d.page(5, 9)).toBeNull();
    });

    test("a cold store answers 'not ready' and warms up in the background; the cache file survives a restart", async () => {
        const { root, imm } = nodeDir(40); dirs.push(root);
        const d = new ImmutableDigests(imm);
        expect(await d.page(0, 39)).toBeNull(); // 120 files to hash: more than one request hashes inline
        await d.warm();
        expect((await d.page(0, 39))!.entries).toHaveLength(120);
        expect(await Bun.file(join(root, "digest-cache-immutable.json")).exists()).toBe(true);
        const again = new ImmutableDigests(imm);
        expect((await again.page(0, 39))!.entries[0]!.digest).toBe(sha("0.chunk"));
    });
});
