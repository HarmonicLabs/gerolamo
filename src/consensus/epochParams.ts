import { getShelleyGenesisConfig } from "../utils/paths";
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
        decentralisation_param: pp.decentralisationParam,
        key_deposit: pp.keyDeposit,
        pool_deposit: pp.poolDeposit,
        min_utxo: pp.minUTxOValue,
        protocol_minor_ver: (pp.protocolVersion as { minor?: number } | undefined)?.minor,
        e_max: pp.eMax,
        n_opt: pp.nOpt,
        a0: pp.a0,
        rho: pp.rho,
        tau: pp.tau,
        min_pool_cost: pp.minPoolCost,
        extra_entropy: (pp.extraEntropy as { tag?: string } | undefined)?.tag === "NeutralNonce" ? null : (pp.extraEntropy as any)?.hash ?? null,
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

/** Store a locally derived (or imported) parameter record for an epoch. */
export async function storeEpochParams(epoch: number, raw: Record<string, unknown>, source: string): Promise<void> {
    cache.delete(epoch);
    await writeDb(epoch, raw, source);
}

/** The stored raw record for an epoch, or null. */
export async function readEpochParamsRaw(epoch: number): Promise<Record<string, unknown> | null> {
    return readDb(epoch);
}

/** The `source` column of the stored record ("genesis" | "local" | "external" …), or null. */
export async function readEpochParamsSource(epoch: number): Promise<string | null> {
    await ensureTable();
    const rows = (await sql`SELECT source FROM epoch_params WHERE epoch = ${epoch}`.values()) as unknown[][];
    return rows.length ? String(rows[0]![0]) : null;
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
    depth = 0,
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

    // Local derivation: the previous epoch's record carried forward (the boundary
    // hook applies quorum updates when it writes the new epoch; this covers reads
    // that happen before that, e.g. header-stage lookups).
    try {
        // Headers can run several epochs ahead of the applier: derive from the nearest
        // stored record epoch by epoch (in memory) rather than fetching externally.
        let prev = await readDb(epoch - 1);
        if (!prev && depth < 24) prev = (await getEpochBodyParams(config, epoch - 1, depth + 1))?.raw ?? null;
        if (prev) {
            // Same derivation the boundary will do (quorum updates of the previous epoch,
            // era-genesis merges on a hard fork), so headers that arrive ahead of the
            // boundary are judged with the coming epoch's parameters (d, protocol version).
            const { deriveNextEpochParams, applyEraGenesis, eraGenesisFilesFor } = await import("./pparams");
            let quorum = 5;
            try {
                const g: any = await getShelleyGenesisConfig(config as any);
                quorum = Number(g?.updateQuorum ?? 5);
            } catch {
                /* default quorum */
            }
            const { raw } = await deriveNextEpochParams(prev, epoch, quorum);
            await applyEraGenesis(raw, Number(prev.protocol_major_ver ?? 0), eraGenesisFilesFor(config));
            raw.source = "local-carry";
            const p = epochParamsFromRecord(epoch, raw);
            cache.set(epoch, p);
            return p;
        }
    } catch {
        /* fall through */
    }
    try {
        const raw = await blockFrostFetchEpochParams(config, epoch);
        const p = epochParamsFromRecord(epoch, raw);
        cache.set(epoch, p);
        logger.warn(`epoch parameters for epoch ${epoch} taken from an external source (no local record); Phase 4 tracks them locally`);
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
/** The stored protocol-parameter record for an epoch (Blockfrost-shaped), or null when not imported. */
export async function getStoredEpochParams(epoch: number): Promise<Record<string, unknown> | null> {
    try {
        return (await readDb(epoch)) ?? null;
    } catch {
        return null;
    }
}

export function _resetEpochParamsCache(): void {
    cache.clear();
}
