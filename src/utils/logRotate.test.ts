import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateIfNeeded } from "./logRotate";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-rotate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rotateIfNeeded", () => {
    test("rotates x.jsonl → x.1.jsonl … keeping `keep` generations", () => {
        const p = join(dir, "info.jsonl");
        for (let gen = 1; gen <= 4; gen++) {
            writeFileSync(p, `gen${gen}\n`.repeat(200));
            expect(rotateIfNeeded(p, 100, 3)).toBe(true);
            expect(existsSync(p)).toBe(false);
        }
        expect(readFileSync(join(dir, "info.1.jsonl"), "utf8").startsWith("gen4")).toBe(true);
        expect(readFileSync(join(dir, "info.2.jsonl"), "utf8").startsWith("gen3")).toBe(true);
        expect(readFileSync(join(dir, "info.3.jsonl"), "utf8").startsWith("gen2")).toBe(true);
        expect(existsSync(join(dir, "info.4.jsonl"))).toBe(false); // gen1 dropped
    });

    test("no-op below the threshold, for a missing file, and when disabled", () => {
        const p = join(dir, "small.jsonl");
        writeFileSync(p, "tiny\n");
        expect(rotateIfNeeded(p, 1024, 3)).toBe(false);
        expect(rotateIfNeeded(join(dir, "missing.jsonl"), 10, 3)).toBe(false);
        expect(rotateIfNeeded(p, 0, 3)).toBe(false);
        expect(existsSync(p)).toBe(true);
    });
});
