/** Read-only lookups the transaction rules need, batched per block. */
import { sql } from "../sql";

export interface UtxoRow {
    utxo_ref: string;
    address: string | null;
    tx_out: string | null;
    reference_script_hash: string | null;
}

export async function getUtxoRowsByRefs(refs: string[]): Promise<UtxoRow[]> {
    if (refs.length === 0) return [];
    const out: UtxoRow[] = [];
    // keep each IN list bounded (SQLite parameter limit)
    for (let i = 0; i < refs.length; i += 500) {
        const chunk = refs.slice(i, i + 500);
        const rows = (await sql`
            SELECT utxo_ref, address, tx_out, reference_script_hash FROM utxo WHERE utxo_ref IN ${sql(chunk)}
        `.values()) as unknown[][];
        for (const r of rows) {
            out.push({
                utxo_ref: String(r[0]),
                address: r[1] == null ? null : String(r[1]),
                tx_out: r[2] == null ? null : String(r[2]),
                reference_script_hash: r[3] == null ? null : String(r[3]),
            });
        }
    }
    return out;
}

/** Which of the given pool ids (hex) are currently registered. */
export async function registeredPools(poolHexes: string[]): Promise<Set<string>> {
    const want = [...new Set(poolHexes.map((p) => p.toLowerCase()))];
    if (want.length === 0) return new Set();
    // Local pool state as applied: a row exists from registration until the
    // boundary that retires it (`retirePoolsAtEpoch`). A pending retirement still
    // counts as registered, as in the ledger's `psStakePoolParams`.
    const have = new Set<string>();
    for (const id of want) {
        const rows = (await sql`SELECT 1 FROM pool_params WHERE pool_id = ${id}`.values()) as unknown[][];
        if (rows.length) have.add(id);
    }
    return have;
}

/** Local reward balances for stake credentials (hex), only when the reward pots are being tracked. */
export async function rewardBalancesFor(credHexes: string[]): Promise<Map<string, bigint> | undefined> {
    if (credHexes.length === 0) return undefined;
    const tracked = (await sql`SELECT 1 FROM reward_pots WHERE id = 1`.values()) as unknown[][];
    if (!tracked.length) return undefined;
    const out = new Map<string, bigint>();
    for (const c of new Set(credHexes)) {
        const rows = (await sql`SELECT amount FROM rewards WHERE stake_credentials = ${Buffer.from(c, "hex")}`.values()) as unknown[][];
        out.set(c, rows.length ? BigInt(String(rows[0]![0] ?? 0)) : 0n);
    }
    return out;
}
