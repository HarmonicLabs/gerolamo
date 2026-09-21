/**
 * Seed a block store's immutable directory from another immutable directory (a Mithril download
 * or another node's db): complete chunks are hardlinked (cardano-node never rewrites a complete
 * chunk, so sharing the inode is safe), the open (last) chunk's three files are copied.
 */
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chunkFileName } from "./chunkFormat";

export async function seedImmutableDir(src: string, dstImmutable: string): Promise<{ chunks: number; linked: number; copied: number; skipped: number; last: number | null }> {
    await mkdir(dstImmutable, { recursive: true });
    if (resolve(src) === resolve(dstImmutable)) {
        const n = (await readdir(src)).filter((f) => /^\d{5}\.chunk$/.test(f)).length;
        return { chunks: n, linked: 0, copied: 0, skipped: n * 3, last: null };
    }
    const nos = (await readdir(src)).filter((f) => /^\d{5}\.chunk$/.test(f)).map((f) => Number(f.slice(0, 5))).sort((a, b) => a - b);
    const last = nos[nos.length - 1] ?? null;
    let linked = 0, copied = 0, skipped = 0;
    for (const n of nos) {
        for (const ext of ["chunk", "primary", "secondary"] as const) {
            const name = chunkFileName(n, ext);
            const from = join(src, name), to = join(dstImmutable, name);
            if (existsSync(to)) { skipped++; continue; }
            if (!existsSync(from)) continue;
            if (n === last) { await copyFile(from, to); copied++; } else {
                try { await link(from, to); linked++; } catch { await copyFile(from, to); copied++; } // cross-device: copy
            }
        }
    }
    return { chunks: nos.length, linked, copied, skipped, last };
}
