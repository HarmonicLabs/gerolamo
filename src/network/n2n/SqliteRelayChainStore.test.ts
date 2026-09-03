import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CborArray, CborUInt } from "@harmoniclabs/cbor";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ChainPoint,
    ChainSyncRollForward,
    ChainTip,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { initSql, sql } from "../../sql";
import { SqliteRelayChainStore } from "./SqliteRelayChainStore";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-relay-store-"));

const point = (slot: bigint, byte: number) => new ChainPoint({
    blockHeader: {
        slotNumber: slot,
        hash: new Uint8Array(32).fill(byte),
    },
});

const rollForward = (slot: bigint, byte: number) =>
    new ChainSyncRollForward({
        data: new CborArray([new CborUInt(slot)]),
        tip: new ChainTip({ point: point(slot, byte), blockNo: slot }),
    }).toCborBytes();

beforeAll(async () => {
    initSql(join(dir, "relay.db"));
    await sql.unsafe(`
        CREATE TABLE immutable_blocks (
            slot INTEGER PRIMARY KEY,
            block_hash BLOB NOT NULL,
            prev_hash BLOB,
            block_data BLOB,
            rollforward_header_cbor BLOB
        );
        CREATE TABLE blocks (
            slot INTEGER NOT NULL,
            hash BLOB PRIMARY KEY,
            prev_hash BLOB,
            block_data BLOB,
            is_valid BOOLEAN DEFAULT TRUE
        );
        CREATE TABLE volatile_headers (
            slot INTEGER PRIMARY KEY,
            header_hash TEXT NOT NULL,
            rollforward_header_cbor BLOB NOT NULL,
            is_valid BOOLEAN DEFAULT TRUE
        );
    `);
    await sql`INSERT INTO immutable_blocks
        (slot, block_hash, prev_hash, block_data, rollforward_header_cbor)
        VALUES (${10n}, ${new Uint8Array(32).fill(1)}, ${null}, ${new Uint8Array([0x81, 0x01])}, ${rollForward(10n, 1)})`;
    await sql`INSERT INTO blocks
        (slot, hash, prev_hash, block_data, is_valid)
        VALUES (${14n}, ${new Uint8Array(32).fill(2)}, ${new Uint8Array(32).fill(1)}, ${new Uint8Array([0x81, 0x02])}, TRUE)`;
    await sql`INSERT INTO volatile_headers
        (slot, header_hash, rollforward_header_cbor, is_valid)
        VALUES (${14n}, ${"02".repeat(32)}, ${rollForward(14n, 2)}, TRUE)`;
});

afterAll(() => {
    try {
        void (sql as any).close?.();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("SqliteRelayChainStore", () => {
    test("reads immutable and volatile rows as one sparse selected chain", async () => {
        const store = new SqliteRelayChainStore();
        const tip = await store.getTip();
        expect(tip.point.blockHeader?.slotNumber).toBe(14n);
        // Synthetic CBOR is not a ledger block, so the monotone slot fallback applies.
        expect(tip.blockNo).toBe(14n);

        const intersect = await store.findIntersect([point(10n, 1)]);
        expect(intersect?.point.blockHeader?.slotNumber).toBe(10n);

        const next = await store.getNextHeader(point(10n, 1));
        expect(next?.point.blockHeader?.slotNumber).toBe(14n);
        expect(next?.blockNo).toBe(14n);
    });

    test("returns an inclusive ordered block range only for exact endpoints", async () => {
        const store = new SqliteRelayChainStore();
        const blocks = await store.getBlockRange(
            point(10n, 1),
            point(14n, 2),
            8,
        );
        expect(blocks?.map((b) => b.point.blockHeader?.slotNumber))
            .toEqual([10n, 14n]);
        expect(blocks?.map((b) => [...b.blockData]))
            .toEqual([[0x81, 0x01], [0x81, 0x02]]);

        expect(await store.getBlockRange(
            point(10n, 1),
            point(14n, 9),
            8,
        )).toBeUndefined();
    });
});
