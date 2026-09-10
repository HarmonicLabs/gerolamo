/**
 * Outputs created by recently applied transactions, by ref (insertion-bounded). The rules stage
 * pre-reads a block's inputs; an input created by an earlier in-flight block or earlier in the
 * same block is not in the database yet, and one created a little earlier is there but costs a
 * SQLite row decode — two thirds of preview spends are chained dApp transactions. Apply is
 * sequential, so this map always agrees with the database; a rollback clears it. A row leaves
 * the map when its output is spent (served to apply either from here or from the pre-read).
 */
import { BoundedMap } from "../utils/boundedMap";

export type KnownUtxoRow = { utxo_ref: string; tx_out: string | null; tx_hash: string | null; address: string | null; reference_script_hash?: string | null };

export const recentOutputs = new BoundedMap<string, KnownUtxoRow>(60_000);
export function rememberRecentOutput(row: KnownUtxoRow): void {
    recentOutputs.set(row.utxo_ref, row);
}
export function resetRecentOutputs(): void { recentOutputs.clear(); }
/** Where spends were served from (diagnostic: `/metrics` and the sync profile). `preread`: rows the rules pre-read took from this map instead of SQLite. */
export const spentRowsStats = { known: 0, recent: 0, db: 0, preread: 0 };
