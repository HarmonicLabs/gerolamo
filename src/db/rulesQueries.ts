/** Read-only lookups the transaction rules need, batched per block. */
import { sql } from "../sql";
import { ledgerStakeReads, ledgerUtxoReads } from "../ledger/nodeLedgerStore";
import { recentOutputs, spentRowsStats } from "./recentOutputs";

export interface UtxoRow {
    utxo_ref: string;
    address: string | null;
    tx_out: string | null;
    reference_script_hash: string | null;
    /** Creating tx (as stored); apply's spend delta records it. */
    tx_hash: string | null;
}

export async function getUtxoRowsByRefs(refs: string[]): Promise<UtxoRow[]> {
    if (refs.length === 0) return [];
    const out: UtxoRow[] = [];
    // Rows of recently created outputs come from the apply-side map (same content as the
    // database row; the SQLite decode of tx_out for chained spends was 15 % of the applier).
    const fromDb: string[] = [];
    for (const ref of refs) {
        const r = recentOutputs.get(ref);
        if (r) { out.push({ utxo_ref: r.utxo_ref, address: r.address, tx_out: r.tx_out, reference_script_hash: r.reference_script_hash ?? null, tx_hash: r.tx_hash }); spentRowsStats.preread++; }
        else fromDb.push(ref);
    }
    const lr = ledgerUtxoReads();
    if (lr) {
        for (const r of lr.getMany(fromDb)) out.push({ utxo_ref: r.utxo_ref, address: r.address, tx_out: r.tx_out, reference_script_hash: r.reference_script_hash, tx_hash: r.tx_hash });
        return out;
    }
    // keep each IN list bounded (SQLite parameter limit)
    for (let i = 0; i < fromDb.length; i += 500) {
        const chunk = fromDb.slice(i, i + 500);
        const rows = (await sql`
            SELECT utxo_ref, address, tx_out, reference_script_hash, tx_hash FROM utxo WHERE utxo_ref IN ${sql(chunk)}
        `.values()) as unknown[][];
        for (const r of rows) {
            out.push({
                utxo_ref: String(r[0]),
                address: r[1] == null ? null : String(r[1]),
                tx_out: r[2] == null ? null : String(r[2]),
                reference_script_hash: r[3] == null ? null : String(r[3]),
                tx_hash: r[4] == null ? null : String(r[4]),
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
    const lr = ledgerStakeReads();
    if (lr) { for (const id of want) if (lr.pool(id)) have.add(id); return have; }
    for (const id of want) {
        const rows = (await sql`SELECT 1 FROM pool_params WHERE pool_id = ${id}`.values()) as unknown[][];
        if (rows.length) have.add(id);
    }
    return have;
}

/** Local reward balances for stake credentials (hex), only when the reward pots are being tracked. */
export async function rewardBalancesFor(credHexes: string[]): Promise<Map<string, bigint> | undefined> {
    if (credHexes.length === 0) return undefined;
    const lr = ledgerStakeReads();
    if (lr) { if (!lr.pots()) return undefined; const out = new Map<string, bigint>(); for (const c of new Set(credHexes)) out.set(c, lr.rewardBalance(c)); return out; }
    const tracked = (await sql`SELECT 1 FROM reward_pots WHERE id = 1`.values()) as unknown[][];
    if (!tracked.length) return undefined;
    const out = new Map<string, bigint>();
    for (const c of new Set(credHexes)) {
        const rows = (await sql`SELECT amount FROM rewards WHERE stake_credentials = ${Buffer.from(c, "hex")}`.values()) as unknown[][];
        out.set(c, rows.length ? BigInt(String(rows[0]![0] ?? 0)) : 0n);
    }
    return out;
}
