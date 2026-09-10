/**
 * Mithril chunk importer ↔ block store.
 *
 * After a Mithril bootstrap the node resumes ChainSync from the newest row in
 * `blocks` (PeerClient), replays recent headers from `header_data`, serves peers
 * from `block_data` and numbers the explorer from `block_no`. The importer must
 * therefore write the same rows live sync writes, in the current schema.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { initSql, sql } from "../sql";
import { ensureInitialized, getBlockBySlot, getMaxBlockNo, getMaxSlot } from "../db";
import { Logger, LogLevel } from "../utils/logger";
import { processChunk } from "./legacy";

type FixtureBlock = { bytes: Uint8Array; hash: Uint8Array; slot: bigint };

const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "../consensus/__fixtures__/byron-preprod.json"), "utf8"),
) as { headers: Array<{ hash: string; prevHash: string }>; blocks: string[] };

const dir = mkdtempSync(join(tmpdir(), "gerolamo-chunk-import-"));
const logger = new Logger({ logLevel: LogLevel.ERROR, logToFile: false });

/** Write an ImmutableDB chunk triple (primary/secondary/chunk) in the layout parseChunk reads. */
function writeChunk(chunkNo: number, blocks: FixtureBlock[]): void {
    const name = String(chunkNo).padStart(5, "0");
    const primary = new Uint8Array(1 + 4 * (blocks.length + 1));
    const pdv = new DataView(primary.buffer);
    primary[0] = 1; // version
    for (let i = 0; i <= blocks.length; i++) pdv.setUint32(1 + i * 4, i * 56, false);

    const secondary = new Uint8Array(56 * blocks.length);
    const sdv = new DataView(secondary.buffer);
    let off = 0n;
    blocks.forEach((b, i) => {
        const base = i * 56;
        sdv.setBigUint64(base, off, false); // block offset in .chunk
        sdv.setUint16(base + 8, 0, false); // header offset
        sdv.setUint16(base + 10, 0, false); // header size
        sdv.setUint32(base + 12, 0, false); // crc
        secondary.set(b.hash, base + 16);
        sdv.setBigUint64(base + 48, b.slot, false);
        off += BigInt(b.bytes.length);
    });

    const chunk = new Uint8Array(Number(off));
    let pos = 0;
    for (const b of blocks) {
        chunk.set(b.bytes, pos);
        pos += b.bytes.length;
    }
    writeFileSync(join(dir, `${name}.primary`), primary);
    writeFileSync(join(dir, `${name}.secondary`), secondary);
    writeFileSync(join(dir, `${name}.chunk`), chunk);
}

const blocks: FixtureBlock[] = fixture.blocks.map((hex, i) => ({
    bytes: fromHex(hex),
    hash: fromHex(fixture.headers[i]!.hash),
    slot: BigInt(i),
}));

beforeAll(async () => {
    initSql(join(dir, "test.db"));
    await ensureInitialized();
    writeChunk(0, blocks.slice(0, 2)); // EBB + first main block
    writeChunk(1, blocks.slice(2, 3)); // second main block
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

type Row = { hash: string; slot: number; prev_hash: string; block_no: number | null; block_data: Uint8Array; header_data: Uint8Array };

describe("Mithril chunk import writes block rows in the current schema", () => {
    test("chunk 0: EBB unnumbered, first main block is height 1, bytes stored as received", async () => {
        const r = await processChunk(dir, 0, logger);
        expect(r.blocks).toBe(2);
        expect(r.applied).toBe(2);
        expect(r.errors).toBe(0);

        const rows = (await sql`SELECT hash, slot, prev_hash, block_no, block_data, header_data FROM blocks ORDER BY rowid`) as Row[];
        expect(rows).toHaveLength(2);
        const [ebb, b1] = rows as [Row, Row];
        expect(ebb.hash).toBe(fixture.headers[0]!.hash);
        expect(ebb.block_no).toBeNull();
        expect(b1.hash).toBe(fixture.headers[1]!.hash);
        expect(b1.block_no).toBe(1);
        expect(b1.prev_hash).toBe(fixture.headers[0]!.hash);
        expect(toHex(new Uint8Array(b1.block_data))).toBe(fixture.blocks[1]);
        expect(b1.header_data.length).toBeGreaterThan(0);
        expect(toHex(new Uint8Array(b1.block_data)).startsWith("8201")).toBe(true); // [era=1, block]
    });

    test("chunk 1 continues the height sequence and becomes the ChainSync resume point", async () => {
        const r = await processChunk(dir, 1, logger);
        expect(r.applied).toBe(1);
        expect(await getMaxBlockNo()).toBe(2);

        const tipSlot = await getMaxSlot();
        expect(tipSlot).toBeGreaterThan(0n);
        const row = await getBlockBySlot(tipSlot);
        const rawHash = Array.isArray(row) ? row[3] : (row as any)?.block_hash ?? (row as any)?.hash;
        const hashHex = typeof rawHash === "string" ? rawHash.toLowerCase() : toHex(new Uint8Array(rawHash));
        expect(hashHex).toBe(fixture.headers[2]!.hash);
    });
});

describe("blocks-only import (local relay block store)", () => {
    test("writes the block row and numbers it, without applying the ledger", async () => {
        const before = Number(((await sql`SELECT COUNT(*) AS c FROM utxo_deltas`) as any[])[0]?.c ?? 0);
        const hash = fixture.headers[2]!.hash;
        await sql`DELETE FROM blocks WHERE hash = ${hash}`;
        const heightBefore = await getMaxBlockNo();
        const r = await processChunk(dir, 1, logger, undefined, { blocksOnly: true });
        expect(r.applied).toBe(1);
        expect(r.errors).toBe(0);
        expect(r.txs).toBe(0);
        const row = ((await sql`SELECT hash, block_no, block_data FROM blocks WHERE hash = ${hash}`) as Row[])[0]!;
        expect(row.hash).toBe(hash);
        expect(row.block_no).toBe(heightBefore + 1);
        expect(toHex(row.block_data)).toBe(fixture.blocks[2]!);
        expect(Number(((await sql`SELECT COUNT(*) AS c FROM utxo_deltas`) as any[])[0]?.c ?? 0)).toBe(before);
    });
});
