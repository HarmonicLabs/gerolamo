import { sql } from "../sql";
import { logger } from "../utils/logger";
import { blockFrostFetchEpochParams } from "../utils/blockFrostFetchEra";
import type { GerolamoConfig } from "../network/peerManager";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

/**
 * Per-epoch protocol parameters for body validation.
 *
 * Body rules (min fee, max tx size, collateral, …) change by governance, so
 * validating a historical block against today's parameters, or against
 * Shelley genesis, produces false failures. Source of truth while syncing
 * from genesis: Blockfrost-shaped `/epochs/{n}/parameters` (onchainapps
 * mirror by default), cached in SQLite `epoch_params` so a re-sync is offline.
 *
 * Only the fields the body validator uses are typed here; the raw record is
 * kept for future rules.
 */
export interface EpochBodyParams {
    epoch: number;
    minFeeA: bigint;
    minFeeB: bigint;
    maxTxSize: number;
    maxBlockSize: number;
    maxBlockHeaderSize: number;
    /** Alonzo+ (null before). */
    collateralPercent: number | null;
    maxCollateralInputs: number | null;
    maxValSize: number | null;
    protocolMajor: number | null;
    raw: Record<string, unknown>;
}

const cache = new Map<number, EpochBodyParams>();
let tableReady: Promise<void> | null = null;

function num(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function big(v: unknown, fallback: bigint): bigint {
    if (v == null) return fallback;
    try {
        return BigInt(String(v));
    } catch {
        return fallback;
    }
}

export function epochParamsFromRecord(epoch: number, raw: Record<string, unknown>): EpochBodyParams {
    return {
        epoch,
        minFeeA: big(raw.min_fee_a, 0n),
        minFeeB: big(raw.min_fee_b, 0n),
        maxTxSize: num(raw.max_tx_size) ?? 16384,
        maxBlockSize: num(raw.max_block_size) ?? 65536,
        maxBlockHeaderSize: num(raw.max_block_header_size) ?? 1100,
        collateralPercent: num(raw.collateral_percent),
        maxCollateralInputs: num(raw.max_collateral_inputs),
        maxValSize: num(raw.max_val_size),
        protocolMajor: num(raw.protocol_major_ver),
        raw,
    };
}

/** Shelley genesis fallback (correct for the first Shelley epoch, approximate later). */
export function epochParamsFromGenesis(epoch: number, genesis: ShelleyGenesisConfig): EpochBodyParams {
    const pp = (genesis as unknown as { protocolParams?: Record<string, unknown> }).protocolParams ?? {};
    return epochParamsFromRecord(epoch, {
        min_fee_a: pp.minFeeA,
        min_fee_b: pp.minFeeB,
        max_tx_size: pp.maxTxSize,
        max_block_size: pp.maxBlockBodySize,
        max_block_header_size: pp.maxBlockHeaderSize,
        protocol_major_ver: (pp.protocolVersion as { major?: number } | undefined)?.major,
        source: "shelley-genesis",
    });
}

async function ensureTable(): Promise<void> {
    if (!tableReady) {
        tableReady = (async () => {
            await sql`CREATE TABLE IF NOT EXISTS epoch_params (
                epoch INTEGER PRIMARY KEY,
                params TEXT NOT NULL,
                source TEXT,
                fetched_at INTEGER DEFAULT (strftime('%s','now'))
            )`;
        })().catch((err) => {
            tableReady = null;
            throw err;
        });
    }
    return tableReady;
}

async function readDb(epoch: number): Promise<Record<string, unknown> | null> {
    await ensureTable();
    const rows = (await sql`SELECT params FROM epoch_params WHERE epoch = ${epoch}`) as any[];
    const row = rows?.[0];
    const text = Array.isArray(row) ? row[0] : row?.params;
    if (typeof text !== "string") return null;
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }
}

async function writeDb(epoch: number, raw: Record<string, unknown>, source: string): Promise<void> {
    await ensureTable();
    await sql`INSERT OR REPLACE INTO epoch_params (epoch, params, source) VALUES (${epoch}, ${JSON.stringify(raw)}, ${source})`;
}

/**
 * Resolve body-validation parameters for `epoch`: memory → SQLite → network.
 * Returns null when nothing is available (caller decides soft/strict).
 */
export async function getEpochBodyParams(
    config: GerolamoConfig,
    epoch: number,
): Promise<EpochBodyParams | null> {
    const hit = cache.get(epoch);
    if (hit) return hit;

    try {
        const stored = await readDb(epoch);
        if (stored) {
            const p = epochParamsFromRecord(epoch, stored);
            cache.set(epoch, p);
            return p;
        }
    } catch (err) {
        logger.warn(`epoch_params read failed for epoch ${epoch}:`, err);
    }

    try {
        const raw = await blockFrostFetchEpochParams(config, epoch);
        const p = epochParamsFromRecord(epoch, raw);
        cache.set(epoch, p);
        try {
            await writeDb(epoch, raw, "external");
        } catch (err) {
            logger.warn(`epoch_params persist failed for epoch ${epoch}:`, err);
        }
        return p;
    } catch (err) {
        logger.warn(`epoch parameters unavailable for epoch ${epoch}:`, err instanceof Error ? err.message : err);
        return null;
    }
}

/** Test hook. */
export function _resetEpochParamsCache(): void {
    cache.clear();
}
