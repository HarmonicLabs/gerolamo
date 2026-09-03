import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";

/**
 * Size-based rotation for append-only log files: `x.log` → `x.1.log` → … →
 * `x.<keep>.log`, oldest dropped. Called before appending; cheap (one stat).
 * Without it the node's info.jsonl reached 3.7 GB on preprod.
 */
export function rotateIfNeeded(filePath: string, maxBytes: number, keep: number): boolean {
    if (!(maxBytes > 0) || !(keep >= 1)) return false;
    let size = 0;
    try {
        size = statSync(filePath).size;
    } catch {
        return false; // no file yet
    }
    if (size < maxBytes) return false;
    const dot = filePath.lastIndexOf(".");
    const slash = filePath.lastIndexOf("/");
    const base = dot > slash ? filePath.slice(0, dot) : filePath;
    const ext = dot > slash ? filePath.slice(dot) : "";
    const nth = (i: number) => `${base}.${i}${ext}`;
    try {
        if (existsSync(nth(keep))) unlinkSync(nth(keep));
        for (let i = keep - 1; i >= 1; i--) {
            if (existsSync(nth(i))) renameSync(nth(i), nth(i + 1));
        }
        renameSync(filePath, nth(1));
        return true;
    } catch {
        return false;
    }
}
