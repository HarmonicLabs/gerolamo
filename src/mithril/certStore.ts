/**
 * Mithril certificate persistence (audit trail in Gerolamo DB).
 *
 * Honesty:
 *   - Stores certificates + dual-run verdicts as facts; does NOT make
 *     pure-TS the SoT. wasm_ok / dual_match recorded as observed.
 *   - Upsert by hash; re-runs refresh verdicts, never duplicate.
 */
import { sql } from "../sql";
import { isGenesisCertificate } from "./pureTs";
import type { MithrilCertificate } from "./types";

export type MithrilCertVerdict = {
    network?: string;
    wasmOk?: boolean;
    dualMatch?: boolean;
    stagesOk?: boolean;
    source?: string;
};

let tableReady = false;

export async function ensureCertificatesTable(): Promise<void> {
    if (tableReady) return;
    await sql`
        CREATE TABLE IF NOT EXISTS mithril_certificates (
            hash TEXT PRIMARY KEY,
            previous_hash TEXT,
            epoch INTEGER,
            signed_entity_type TEXT,
            is_genesis BOOLEAN NOT NULL DEFAULT 0,
            network TEXT,
            source TEXT,
            wasm_ok BOOLEAN,
            dual_match BOOLEAN,
            stages_ok BOOLEAN,
            cert_json JSONB NOT NULL,
            inserted_at TIMESTAMP DEFAULT (strftime('%s','now')),
            updated_at TIMESTAMP DEFAULT (strftime('%s','now'))
        )
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_mithril_certs_epoch
        ON mithril_certificates(epoch)
    `;
    tableReady = true;
}

function seTypeOf(cert: Record<string, unknown>): string | null {
    const se = cert.signed_entity_type;
    if (!se || typeof se !== "object") return null;
    return Object.keys(se as object)[0] ?? null;
}

/**
 * Upsert one verified certificate + its dual-run verdict.
 */
export async function persistMithrilCertificate(
    cert: MithrilCertificate,
    verdict: MithrilCertVerdict = {},
): Promise<void> {
    await ensureCertificatesTable();
    const rec = cert as unknown as Record<string, unknown>;
    const genesis = isGenesisCertificate(rec);
    await sql`
        INSERT INTO mithril_certificates (
            hash, previous_hash, epoch, signed_entity_type, is_genesis,
            network, source, wasm_ok, dual_match, stages_ok, cert_json
        ) VALUES (
            ${cert.hash},
            ${cert.previous_hash ?? null},
            ${cert.epoch ?? null},
            ${seTypeOf(rec)},
            ${genesis},
            ${verdict.network ?? null},
            ${verdict.source ?? null},
            ${verdict.wasmOk ?? null},
            ${verdict.dualMatch ?? null},
            ${verdict.stagesOk ?? null},
            ${JSON.stringify(cert)}
        )
        ON CONFLICT(hash) DO UPDATE SET
            previous_hash = excluded.previous_hash,
            epoch = excluded.epoch,
            signed_entity_type = excluded.signed_entity_type,
            is_genesis = excluded.is_genesis,
            network = COALESCE(excluded.network, mithril_certificates.network),
            source = COALESCE(excluded.source, mithril_certificates.source),
            wasm_ok = COALESCE(excluded.wasm_ok, mithril_certificates.wasm_ok),
            dual_match = COALESCE(excluded.dual_match, mithril_certificates.dual_match),
            stages_ok = COALESCE(excluded.stages_ok, mithril_certificates.stages_ok),
            cert_json = excluded.cert_json,
            updated_at = strftime('%s','now')
    `;
}

/** Upsert many (e.g. a walked chain). Returns count written. */
export async function persistMithrilCertificates(
    certs: Array<MithrilCertificate>,
    verdict: MithrilCertVerdict = {},
): Promise<number> {
    let n = 0;
    for (const c of certs) {
        if (!c?.hash) continue;
        await persistMithrilCertificate(c, verdict);
        n++;
    }
    return n;
}

export async function countMithrilCertificates(): Promise<number> {
    await ensureCertificatesTable();
    // Bun SQL .values() → row ARRAYS ([[v]]), not objects
    const rows = await sql`SELECT COUNT(*) AS c FROM mithril_certificates`.values();
    const first = rows?.[0];
    if (!first) return 0;
    const v = Array.isArray(first)
        ? first[0]
        : (first as Record<string, unknown>)["c"];
    return Number(v ?? 0);
}
