import {
    ChainPoint,
    ChainTip,
    type IChainPoint,
    type IChainTip,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
// Not re-exported at package root.
import type {
    IChainDb,
    IExtendData,
} from "@harmoniclabs/ouroboros-miniprotocols-ts/dist/protocols/interfaces/IChainDb.js";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import {
    getBlockByHash,
    getBlockBySlot,
    getMaxSlot,
} from "../../db";
import { logger } from "../../utils/logger";

const dbLogger = logger.child("n2c.chaindb");

function asBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        return new Uint8Array(value);
    }
    if (typeof value === "string" && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
        try {
            return fromHex(value);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function hashHex(value: unknown): string | undefined {
    const bytes = asBytes(value);
    if (bytes) return toHex(bytes);
    if (typeof value === "string") return value.toLowerCase();
    return undefined;
}

function pointFromRow(row: any): ChainPoint | undefined {
    if (!row) return undefined;
    const slot = BigInt(row.slot ?? 0);
    const hash =
        asBytes(row.block_hash) ??
        asBytes(row.hash) ??
        asBytes(row.header_hash);
    if (!hash) return undefined;
    return new ChainPoint({
        blockHeader: {
            slotNumber: slot,
            hash,
        },
    });
}

function headerBytesFromRow(row: any): Uint8Array {
    return (
        asBytes(row.rollforward_header_cbor) ??
        asBytes(row.header_data) ??
        asBytes(row.block_fetch_RawCbor) ??
        asBytes(row.block_data) ??
        new Uint8Array([0xa0]) // empty CBOR map fallback
    );
}

/**
 * IChainDb adapter over Gerolamo SQLite (volatile `blocks` + `immutable_blocks`).
 *
 * Notes:
 * - blockNo is approximated by slot (Gerolamo does not store dense block index yet).
 * - extend/fork listeners are in-process; PeerClient can call notify* later.
 */
export class GerolamoChainDb implements IChainDb {
    private tip: ChainTip = new ChainTip({
        point: ChainPoint.origin,
        blockNo: 0n,
    });
    private readonly extendListeners: Array<(data: IExtendData) => any> = [];
    private readonly forkListeners: Array<(data: IExtendData) => any> = [];
    private refreshing: Promise<void> | null = null;

    constructor() {
        void this.refreshTip();
    }

    async refreshTip(): Promise<ChainTip> {
        if (this.refreshing) {
            await this.refreshing;
            return this.tip;
        }
        this.refreshing = (async () => {
            try {
                const maxSlot = await getMaxSlot();
                if (maxSlot <= 0n) {
                    this.tip = new ChainTip({
                        point: ChainPoint.origin,
                        blockNo: 0n,
                    });
                    return;
                }
                const row = await getBlockBySlot(maxSlot);
                const point = pointFromRow(row) ?? ChainPoint.origin;
                this.tip = new ChainTip({
                    point,
                    blockNo: maxSlot,
                });
            } catch (err) {
                dbLogger.error("refreshTip failed:", err);
            } finally {
                this.refreshing = null;
            }
        })();
        await this.refreshing;
        return this.tip;
    }

    async getTip(): Promise<IChainTip> {
        return this.refreshTip();
    }

    async findIntersect(
        ...points: IChainPoint[]
    ): Promise<IChainTip | undefined> {
        // Empty list: convention for "start from origin" (Lab client often sends []).
        if (points.length === 0) {
            return new ChainTip({ point: ChainPoint.origin, blockNo: 0n });
        }

        for (const point of points) {
            if (!point.blockHeader) {
                // Origin point is always a valid intersection.
                return new ChainTip({ point: ChainPoint.origin, blockNo: 0n });
            }
            const slot = BigInt(point.blockHeader.slotNumber);
            const want = toHex(point.blockHeader.hash);
            try {
                const byHash = await getBlockByHash(want);
                if (byHash) {
                    const p = pointFromRow(byHash);
                    if (p) {
                        return new ChainTip({
                            point: p,
                            blockNo: BigInt(byHash.slot ?? slot),
                        });
                    }
                }
                const bySlot = await getBlockBySlot(slot);
                const got = hashHex(bySlot?.block_hash ?? bySlot?.hash);
                if (got && got === want) {
                    const p = pointFromRow(bySlot);
                    if (p) {
                        return new ChainTip({
                            point: p,
                            blockNo: slot,
                        });
                    }
                }
            } catch (err) {
                dbLogger.warn("findIntersect point check failed:", err);
            }
        }
        return undefined;
    }

    async getBlockNo(blockIndex: bigint): Promise<Uint8Array> {
        // Approximate: treat blockIndex as slot until a dense index exists.
        try {
            const row = await getBlockBySlot(blockIndex);
            if (row) return headerBytesFromRow(row);
        } catch (err) {
            dbLogger.warn("getBlockNo failed:", err);
        }
        return new Uint8Array([0xa0]);
    }

    async getBlocksBetweenRange(
        from: IChainPoint,
        to: IChainPoint,
    ): Promise<ChainPoint[]> {
        const fromSlot = from.blockHeader
            ? BigInt(from.blockHeader.slotNumber)
            : 0n;
        const toSlot = to.blockHeader
            ? BigInt(to.blockHeader.slotNumber)
            : await getMaxSlot();
        if (toSlot < fromSlot) return [];

        const out: ChainPoint[] = [];
        // Cap range scans for safety (data-node tip clients rarely need full range).
        const maxSteps = 256n;
        const step =
            toSlot - fromSlot > maxSteps
                ? (toSlot - fromSlot) / maxSteps
                : 1n;
        for (let s = fromSlot; s <= toSlot; s += step) {
            try {
                const row = await getBlockBySlot(s);
                const p = pointFromRow(row);
                if (p) out.push(p);
            } catch {
                /* skip */
            }
        }
        return out;
    }

    on(evtName: "extend" | "fork", cb: (tip: IExtendData) => any): void {
        (evtName === "extend" ? this.extendListeners : this.forkListeners).push(
            cb,
        );
    }

    off(evtName: "extend" | "fork", cb?: (tip: IExtendData) => any): void {
        const list =
            evtName === "extend" ? this.extendListeners : this.forkListeners;
        if (!cb) {
            list.length = 0;
            return;
        }
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
    }

    async notifyExtend(intersection?: IChainTip): Promise<void> {
        const tip = await this.refreshTip();
        const data: IExtendData = {
            tip,
            intersection: intersection ?? tip,
        };
        for (const cb of this.extendListeners) {
            try {
                cb(data);
            } catch {
                /* ignore */
            }
        }
    }

    async notifyFork(intersection: IChainTip): Promise<void> {
        const tip = await this.refreshTip();
        const data: IExtendData = { tip, intersection };
        for (const cb of this.forkListeners) {
            try {
                cb(data);
            } catch {
                /* ignore */
            }
        }
    }
}

/** Process-wide chain db for N2C hosts (shared tip listeners). */
let sharedChainDb: GerolamoChainDb | undefined;

export function getSharedChainDb(): GerolamoChainDb {
    if (!sharedChainDb) sharedChainDb = new GerolamoChainDb();
    return sharedChainDb;
}
