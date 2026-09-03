import {
    CborArray,
    CborBytes,
    CborTag,
    CborUInt,
    type CborObj,
} from "@harmoniclabs/cbor";
import {
    ChainPoint,
    ChainSyncRollForward,
    ChainTip,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { sql } from "../../sql";
import type {
    RelayBlock,
    RelayChainStore,
    RelayHeader,
    RelayIntersection,
} from "./RelayChainStore";

type ChainRow = {
    slot: bigint | number | string;
    block_hash: unknown;
    prev_hash: unknown;
    block_data: unknown;
    rollforward_header_cbor: unknown;
    block_no?: bigint | number | string;
    priority?: number;
};

function asBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        return new Uint8Array(value);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value) && value.every((n) => Number.isInteger(n))) {
        return Uint8Array.from(value);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
            try {
                return fromHex(trimmed);
            } catch {
                /* try JSON */
            }
        }
        try {
            return asBytes(JSON.parse(trimmed));
        } catch {
            return undefined;
        }
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.data)) return asBytes(record.data);
        const numeric = Object.keys(record)
            .filter((key) => /^\d+$/.test(key))
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => record[key]);
        if (numeric.length > 0) return asBytes(numeric);
    }
    return undefined;
}

function rowPoint(row: ChainRow): ChainPoint | undefined {
    const hash = asBytes(row.block_hash);
    if (!hash) return undefined;
    return new ChainPoint({
        blockHeader: {
            slotNumber: BigInt(row.slot),
            hash,
        },
    });
}

function rowIntersection(row: ChainRow): RelayIntersection | undefined {
    const point = rowPoint(row);
    if (!point) return undefined;
    return { point, blockNo: blockNumber(row) };
}

function blockNumber(row: ChainRow): bigint {
    const block = parseBlock(row);
    if (block) {
        const header = block.block.header as any;
        const number =
            header?.body?.blockNumber ??
            header?.consensusData?.difficulty?.[0] ??
            header?.consensusData?.difficulty;
        if (number !== undefined && number !== null) return BigInt(number);
    }
    return BigInt(row.block_no ?? row.slot);
}

function headerData(row: ChainRow): CborObj | undefined {
    const bytes = asBytes(row.rollforward_header_cbor);
    if (bytes) {
        try {
            return ChainSyncRollForward.fromCbor(bytes).data;
        } catch {
            /* derive from the stored block below */
        }
    }
    const block = parseBlock(row);
    if (!block || Number(block.era) < 2) return undefined;
    const header = block.block.header as any;
    if (typeof header?.toCborBytes !== "function") return undefined;
    return new CborArray([
        new CborUInt(BigInt(Number(block.era) - 1)),
        new CborTag(24n, new CborBytes(header.toCborBytes())),
    ]);
}

/** `block_data` is the BlockFetch payload `[era, block]` as received: served as-is. */
function blockData(row: ChainRow): Uint8Array | undefined {
    return asBytes(row.block_data);
}

function parseBlock(row: ChainRow): MultiEraBlock | undefined {
    const direct = asBytes(row.block_data);
    if (!direct) return undefined;
    try {
        return MultiEraBlock.fromCbor(direct);
    } catch {
        return undefined;
    }
}

function hashEquals(point: ChainPoint, row: ChainRow): boolean {
    const want = point.blockHeader?.hash;
    const got = asBytes(row.block_hash);
    return !!want && !!got && toHex(want) === toHex(got);
}

function chooseBySlot(
    rows: readonly (ChainRow | undefined)[],
    direction: "min" | "max",
): ChainRow | undefined {
    return rows.filter((row): row is ChainRow => !!row).sort((a, b) => {
        const aa = BigInt(a.slot);
        const bb = BigInt(b.slot);
        if (aa === bb) return Number(b.priority ?? 0) - Number(a.priority ?? 0);
        if (direction === "min") return aa < bb ? -1 : 1;
        return aa > bb ? -1 : 1;
    })[0];
}

/** Read-only selected-chain view spanning immutable and volatile SQLite rows. */
export class SqliteRelayChainStore implements RelayChainStore {
    async getTip(): Promise<ChainTip> {
        const [volatileRows, immutableRows] = await Promise.all([
            sql`
                SELECT b.slot, b.hash AS block_hash, b.prev_hash, b.block_data,
                       h.rollforward_header_cbor,
                       b.slot AS block_no, 1 AS priority
                FROM blocks b
                LEFT JOIN volatile_headers h ON h.slot = b.slot
                WHERE b.is_valid = TRUE AND (h.is_valid = TRUE OR h.is_valid IS NULL)
                ORDER BY b.slot DESC LIMIT 1
            `,
            sql`
                SELECT slot, block_hash, prev_hash, block_data,
                       rollforward_header_cbor,
                       slot AS block_no, 0 AS priority
                FROM immutable_blocks ORDER BY slot DESC LIMIT 1
            `,
        ]);
        const row = chooseBySlot([
            (volatileRows as ChainRow[])[0],
            (immutableRows as ChainRow[])[0],
        ], "max");
        if (!row) {
            return new ChainTip({ point: ChainPoint.origin, blockNo: 0n });
        }
        const found = rowIntersection(row);
        if (!found || !headerData(row) || !blockData(row)) {
            return new ChainTip({ point: ChainPoint.origin, blockNo: 0n });
        }
        return new ChainTip(found);
    }

    async findIntersect(
        points: readonly ChainPoint[],
    ): Promise<RelayIntersection | undefined> {
        for (const point of points) {
            if (!point.blockHeader) {
                return { point: ChainPoint.origin, blockNo: 0n };
            }
            const row = await this.rowAtSlot(BigInt(point.blockHeader.slotNumber));
            if (
                row &&
                hashEquals(point, row) &&
                headerData(row) &&
                blockData(row)
            ) return rowIntersection(row);
        }
        return undefined;
    }

    async getNextHeader(after: ChainPoint): Promise<RelayHeader | undefined> {
        const afterSlot = after.blockHeader?.slotNumber ?? -1n;
        const [volatileRows, immutableRows] = await Promise.all([
            sql`
                SELECT b.slot, b.hash AS block_hash, b.prev_hash, b.block_data,
                       h.rollforward_header_cbor,
                       b.slot AS block_no, 1 AS priority
                FROM blocks b
                LEFT JOIN volatile_headers h ON h.slot = b.slot
                WHERE b.is_valid = TRUE
                  AND (h.is_valid = TRUE OR h.is_valid IS NULL)
                  AND b.slot > ${BigInt(afterSlot)}
                ORDER BY b.slot ASC LIMIT 1
            `,
            sql`
                SELECT slot, block_hash, prev_hash, block_data,
                       rollforward_header_cbor,
                       slot AS block_no, 0 AS priority
                FROM immutable_blocks WHERE slot > ${BigInt(afterSlot)}
                ORDER BY slot ASC LIMIT 1
            `,
        ]);
        const row = chooseBySlot([
            (volatileRows as ChainRow[])[0],
            (immutableRows as ChainRow[])[0],
        ], "min");
        if (!row) return undefined;
        const intersection = rowIntersection(row);
        const data = headerData(row);
        if (!intersection || !data) return undefined;
        return { ...intersection, data };
    }

    async getBlockRange(
        from: ChainPoint,
        to: ChainPoint,
        maxBlocks: number,
    ): Promise<RelayBlock[] | undefined> {
        const fromSlot = from.blockHeader?.slotNumber;
        const toSlot = to.blockHeader?.slotNumber;
        if (
            fromSlot === undefined ||
            toSlot === undefined ||
            BigInt(fromSlot) > BigInt(toSlot)
        ) return undefined;
        const limit = Math.max(1, Math.trunc(maxBlocks)) + 1;
        const [volatileRows, immutableRows] = await Promise.all([
            sql`
                SELECT b.slot, b.hash AS block_hash, b.prev_hash, b.block_data,
                       h.rollforward_header_cbor,
                       b.slot AS block_no, 1 AS priority
                FROM blocks b
                LEFT JOIN volatile_headers h ON h.slot = b.slot
                WHERE b.is_valid = TRUE
                  AND (h.is_valid = TRUE OR h.is_valid IS NULL)
                  AND b.slot >= ${BigInt(fromSlot)}
                  AND b.slot <= ${BigInt(toSlot)}
                ORDER BY b.slot ASC LIMIT ${limit}
            `,
            sql`
                SELECT slot, block_hash, prev_hash, block_data,
                       rollforward_header_cbor,
                       slot AS block_no, 0 AS priority
                FROM immutable_blocks
                WHERE slot >= ${BigInt(fromSlot)} AND slot <= ${BigInt(toSlot)}
                ORDER BY slot ASC LIMIT ${limit}
            `,
        ]);
        const bySlot = new Map<string, ChainRow>();
        for (const row of [
            ...(immutableRows as ChainRow[]),
            ...(volatileRows as ChainRow[]),
        ]) {
            const key = BigInt(row.slot).toString();
            const previous = bySlot.get(key);
            if (!previous || Number(row.priority ?? 0) >= Number(previous.priority ?? 0)) {
                bySlot.set(key, row);
            }
        }
        const chainRows = [...bySlot.values()].sort((a, b) =>
            BigInt(a.slot) < BigInt(b.slot) ? -1 : 1
        );
        if (
            chainRows.length === 0 ||
            chainRows.length > maxBlocks ||
            !hashEquals(from, chainRows[0]!) ||
            !hashEquals(to, chainRows[chainRows.length - 1]!)
        ) return undefined;

        for (let i = 1; i < chainRows.length; i++) {
            const previousHash = asBytes(chainRows[i - 1]!.block_hash);
            const nextPrevHash = asBytes(chainRows[i]!.prev_hash);
            if (
                !previousHash ||
                !nextPrevHash ||
                toHex(previousHash) !== toHex(nextPrevHash)
            ) return undefined;
        }

        const blocks: RelayBlock[] = [];
        for (const row of chainRows) {
            const intersection = rowIntersection(row);
            const data = blockData(row);
            if (!intersection || !data) return undefined;
            blocks.push({ ...intersection, blockData: data });
        }
        return blocks;
    }

    private async rowAtSlot(slot: bigint): Promise<ChainRow | undefined> {
        const volatileRows = await sql`
            SELECT b.slot, b.hash AS block_hash, b.prev_hash, b.block_data,
                   h.rollforward_header_cbor,
                   b.slot AS block_no, 1 AS priority
            FROM blocks b
            LEFT JOIN volatile_headers h ON h.slot = b.slot
            WHERE b.is_valid = TRUE
              AND (h.is_valid = TRUE OR h.is_valid IS NULL)
              AND b.slot = ${slot}
            LIMIT 1
        `;
        const volatile = (volatileRows as ChainRow[])[0];
        if (volatile) return volatile;
        const immutableRows = await sql`
            SELECT slot, block_hash, prev_hash, block_data,
                   rollforward_header_cbor,
                   slot AS block_no, 0 AS priority
            FROM immutable_blocks WHERE slot = ${slot} LIMIT 1
        `;
        return (immutableRows as ChainRow[])[0];
    }
}
