/**
 * One-off migration for databases written before stake credentials were typed
 * (db/stakeCred.ts): rebuild `stake.cred_type` and `delegations.cred_type` from
 * the certificate history in the stored blocks. Registrations/deregistrations
 * type the `stake` row, delegations type the `delegations` row; the latest
 * certificate per credential hash wins. Certificates of phase-2-invalid
 * transactions are skipped (their effects were never applied).
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { logger } from "../utils/logger";
import { sql } from "../sql";
import { certStakeEffect } from "../consensus/certificateRules";
import { storedBlocksInSlotRange } from "../db";

const MARK = "stake_cred_types_rebuilt";

function credOf(cert: any): { hex: string; type: 0 | 1 } | null {
    const c = cert?.stakeCredential;
    const h = c?.hash;
    if (!h) return null;
    const hex = String(typeof h === "string" ? h : h.toString?.() ?? "").toLowerCase();
    if (!/^[0-9a-f]{56}$/.test(hex)) return null;
    return { hex, type: Number(c.type) === 1 ? 1 : 0 };
}

/** Scan stored Shelley+ blocks in [fromSlot, toSlot] and return the latest credential type per hash. */
export async function credentialTypesFromBlocks(fromSlot: number, toSlot: number): Promise<{ registered: Map<string, 0 | 1>; delegated: Map<string, 0 | 1>; blocks: number }> {
    const registered = new Map<string, 0 | 1>();
    const delegated = new Map<string, 0 | 1>();
    let blocks = 0;
    for await (const row of storedBlocksInSlotRange(fromSlot, toSlot)) {
        let m: any;
        try {
            m = MultiEraBlock.fromCbor(row.block_data);
        } catch {
            continue;
        }
        if (Number(m.era) < 2) continue;
        blocks++;
        const invalid = new Set<number>(((m.block as any)?.invalidTransactions ?? []).map((i: any) => Number(i)));
        const bodies: any[] = m.block?.transactionBodies ?? [];
        for (let i = 0; i < bodies.length; i++) {
            if (invalid.has(i)) continue;
            for (const cert of bodies[i]?.certs ?? []) {
                const fx = certStakeEffect(Number(cert.certType));
                const cred = credOf(cert);
                if (!cred) continue;
                if (fx.registers || fx.deregisters) registered.set(cred.hex, cred.type);
                if (fx.delegatesToPool) delegated.set(cred.hex, cred.type);
            }
        }
    }
    return { registered, delegated, blocks };
}

/** Type every untyped `stake` / `delegations` row from the certificate history; runs once per database. */
export async function ensureStakeCredTypes(shelleyStartSlot: number): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    const done = (await sql`SELECT 1 FROM schema_migrations WHERE name = ${MARK}`.values()) as unknown[][];
    if (done.length) return;
    const untyped = (await sql`SELECT (SELECT COUNT(*) FROM stake WHERE cred_type IS NULL), (SELECT COUNT(*) FROM delegations WHERE cred_type IS NULL)`.values()) as unknown[][];
    const nStake = Number(untyped[0]?.[0] ?? 0), nDeleg = Number(untyped[0]?.[1] ?? 0);
    if (nStake + nDeleg === 0) {
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES (${MARK})`;
        return;
    }
    const tip = (await sql`SELECT COALESCE(MAX(slot), 0) FROM blocks`.values()) as unknown[][];
    const t0 = performance.now();
    const { registered, delegated, blocks } = await credentialTypesFromBlocks(shelleyStartSlot, Number(tip[0]?.[0] ?? 0));
    let typedStake = 0, typedDeleg = 0;
    await sql.begin(async () => {
        for (const [hex, type] of registered) {
            const r: any = await sql`UPDATE stake SET cred_type = ${type} WHERE cred_type IS NULL AND stake_credentials = ${Buffer.from(hex, "hex")}`;
            typedStake += Number(r?.count ?? 0);
        }
        for (const [hex, type] of delegated) {
            const r: any = await sql`UPDATE delegations SET cred_type = ${type} WHERE cred_type IS NULL AND stake_credentials = ${Buffer.from(hex, "hex")}`;
            typedDeleg += Number(r?.count ?? 0);
        }
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES (${MARK})`;
    });
    logger.info(`stake credential types rebuilt from ${blocks} stored block(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${typedStake}/${nStake} stake row(s) and ${typedDeleg}/${nDeleg} delegation row(s) typed`);
}

// ---------------------------------------------------------------------------
// Delegation rebuild with POOLREAP semantics (one-off for databases written
// before retirements removed delegations).
// ---------------------------------------------------------------------------
import { epochForSlot } from "../utils/epochFromSlotCalculations";
import { typedCredHex } from "./stakeCred";

const MARK_DELEG = "delegations_rebuilt_poolreap";

/**
 * Replay the certificate history of the stored Shelley+ blocks: registrations,
 * deregistrations, delegations, pool registrations and retirements, retiring
 * pools at their epoch boundary (which drops their delegations). Returns the
 * delegation map as the ledger holds it at the tip.
 */
export async function delegationsFromBlocks(fromSlot: number, toSlot: number): Promise<{ delegations: Map<string, string>; blocks: number; retirements: number }> {
    const registered = new Set<string>();
    const delegations = new Map<string, string>();
    const pools = new Map<string, { retiringEpoch: number | null }>();
    let epoch = -1, blocks = 0, retirements = 0;
    const reap = (e: number) => {
        for (const [pool, st] of pools) {
            if (st.retiringEpoch != null && st.retiringEpoch <= e) {
                pools.delete(pool);
                retirements++;
                for (const [cred, p] of delegations) if (p === pool) delegations.delete(cred);
            }
        }
    };
    for await (const row of storedBlocksInSlotRange(fromSlot, toSlot)) {
        let m: any;
        try {
            m = MultiEraBlock.fromCbor(row.block_data);
        } catch {
            continue;
        }
        if (Number(m.era) < 2) continue;
        blocks++;
        const e = Number(epochForSlot(row.slot));
        if (e !== epoch) {
            if (epoch >= 0) for (let x = epoch + 1; x <= e; x++) reap(x);
            epoch = e;
        }
        const invalid = new Set<number>(((m.block as any)?.invalidTransactions ?? []).map((i: any) => Number(i)));
        const bodies: any[] = m.block?.transactionBodies ?? [];
        for (let i = 0; i < bodies.length; i++) {
            if (invalid.has(i)) continue;
            for (const cert of bodies[i]?.certs ?? []) {
                const t = Number(cert.certType);
                const fx = certStakeEffect(t);
                const cred = credOf(cert);
                const key = cred ? typedCredHex(cred.type, cred.hex) : null;
                if (t === 3) {
                    const op = String(cert.poolParams?.operator?.toString?.() ?? "").toLowerCase();
                    if (op) pools.set(op, { retiringEpoch: null });
                    continue;
                }
                if (t === 4) {
                    const op = String(cert.poolHash?.toString?.() ?? "").toLowerCase();
                    const st = pools.get(op);
                    if (st) st.retiringEpoch = Number(cert.epoch);
                    continue;
                }
                if (!key) continue;
                if (fx.registers) registered.add(key);
                if (fx.deregisters) {
                    registered.delete(key);
                    delegations.delete(key);
                }
                if (fx.delegatesToPool) {
                    const pool = String(cert.poolKeyHash?.toString?.() ?? "").toLowerCase();
                    if (pool && pools.has(pool)) delegations.set(key, pool);
                }
            }
        }
    }
    return { delegations, blocks, retirements };
}

/** Bring the `delegations` table in line with the replayed history (stale rows to retired pools removed); once per database. */
export async function ensureDelegationsReaped(shelleyStartSlot: number): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    const done = (await sql`SELECT 1 FROM schema_migrations WHERE name = ${MARK_DELEG}`.values()) as unknown[][];
    if (done.length) return;
    const tipRow = (await sql`SELECT COALESCE(MAX(slot), 0) FROM blocks`.values()) as unknown[][];
    const tip = Number(tipRow[0]?.[0] ?? 0);
    if (tip < shelleyStartSlot) {
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES (${MARK_DELEG})`;
        return;
    }
    const t0 = performance.now();
    const { delegations, blocks, retirements } = await delegationsFromBlocks(shelleyStartSlot, tip);
    const rows = (await sql`SELECT id, lower(hex(stake_credentials)), cred_type, lower(hex(pool_key_hash)) FROM delegations`.values()) as unknown[][];
    let removed = 0, mismatched = 0, missing = 0;
    await sql.begin(async () => {
        const seen = new Set<string>();
        for (const r of rows) {
            const key = typedCredHex(r[2] == null ? 0 : Number(r[2]), String(r[1]));
            const want = delegations.get(key);
            seen.add(key);
            if (!want) {
                await sql`DELETE FROM delegations WHERE id = ${Number(r[0])}`;
                removed++;
            } else if (want !== String(r[3])) {
                await sql`UPDATE delegations SET pool_key_hash = ${Buffer.from(want, "hex")} WHERE id = ${Number(r[0])}`;
                mismatched++;
            }
        }
        for (const [key, pool] of delegations) {
            if (seen.has(key)) continue;
            const type = key.length === 58 ? 1 : 0;
            await sql`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${Buffer.from(key.slice(-56), "hex")}, ${type}, ${Buffer.from(pool, "hex")})`;
            missing++;
        }
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES (${MARK_DELEG})`;
    });
    logger.info(`delegations rebuilt with retirement semantics from ${blocks} block(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s (${retirements} retirement(s)): ${removed} stale row(s) removed, ${mismatched} re-pointed, ${missing} added; ${delegations.size} delegation(s) now`);
}
