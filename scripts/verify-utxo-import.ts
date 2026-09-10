#!/usr/bin/env bun
/**
 * Compare a UTxO set imported from a Mithril ancillary snapshot (`import-utxo`) with a
 * genesis-replayed ledger database, reconstructed at the snapshot slot: reference rows still
 * unspent at the tip minus those created after the slot, plus those spent after the slot
 * (their rows come from the spend deltas). Every row must match in tx_out JSON, address,
 * lovelace, reference script hash and typed stake key.
 *
 *   bun scripts/verify-utxo-import.ts --import <import.db> --ref <replay.db> --slot <S>
 */
import { Database } from "bun:sqlite";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const S = Number(args.slot);
const imp = new Database(String(args.import), { readonly: true });
const ref = new Database(String(args.ref), { readonly: true });
ref.exec("PRAGMA busy_timeout = 10000");
const t0 = performance.now();
// Blocks after the snapshot slot, and their deltas.
const blocksAfter = ref.query("SELECT hash, slot FROM blocks WHERE slot > ? AND is_valid = TRUE ORDER BY slot").all(S) as Array<{ hash: Uint8Array; slot: number }>;
const deltasOf = ref.query("SELECT action, json_extract(utxo, '$.utxo_ref') AS ref, json_extract(utxo, '$.tx_out') AS tx_out FROM utxo_deltas WHERE block_hash = ? AND action IN ('create', 'spend')");
const createdAfter = new Set<string>();
const spentAfter = new Map<string, string>(); // ref → tx_out JSON as the applier stored it
for (const b of blocksAfter) {
    const blobHash = typeof b.hash === "string" ? Buffer.from(b.hash, "hex") : b.hash; // blocks.hash is hex text, utxo_deltas.block_hash a blob
    for (const d of deltasOf.all(blobHash) as Array<{ action: string; ref: string; tx_out: string | null }>) {
        if (d.action === "create") createdAfter.add(d.ref);
        else if (d.action === "spend" && !createdAfter.has(d.ref)) spentAfter.set(d.ref, d.tx_out ?? "");
    }
}
console.log(`${blocksAfter.length} block(s) after slot ${S}: ${createdAfter.size} output(s) created after, ${spentAfter.size} spent after (and existing at the slot)`);
const refRow = ref.query("SELECT tx_out, address, lovelace, reference_script_hash, stake_key FROM utxo WHERE utxo_ref = ?");
const refCount = (ref.query("SELECT COUNT(*) c FROM utxo").get() as any).c as number;
const expected = refCount - [...createdAfter].filter((r) => (ref.query("SELECT 1 FROM utxo WHERE utxo_ref = ?").get(r))).length + spentAfter.size;
const impCount = (imp.query("SELECT COUNT(*) c FROM utxo").get() as any).c as number;
console.log(`rows: imported ${impCount}, reference at the slot ${expected} (tip ${refCount})`);
let ok = 0, mismatch = 0, missingInRef = 0;
const shown: string[] = [];
const cmp = (r: string, a: any, b: any) => {
    const fields: Array<[string, any, any]> = [["tx_out", a.tx_out, b.tx_out], ["address", a.address, b.address], ["lovelace", String(a.lovelace), String(b.lovelace)], ["ref_script", a.reference_script_hash ?? null, b.reference_script_hash ?? null], ["stake_key", a.stake_key ?? null, b.stake_key ?? null]];
    const bad = fields.filter(([, x, y]) => x !== y);
    if (bad.length === 0) ok++;
    else { mismatch++; if (shown.length < 8) shown.push(`${r.slice(0, 20)}: ${bad.map(([f, x, y]) => `${f} imp=${String(x).slice(0, 60)} ref=${String(y).slice(0, 60)}`).join(" | ")}`); }
};
const seen = new Set<string>();
for (const row of imp.query("SELECT utxo_ref, tx_out, address, lovelace, reference_script_hash, stake_key FROM utxo").iterate() as Iterable<any>) {
    seen.add(row.utxo_ref);
    const r = refRow.get(row.utxo_ref) as any;
    if (r && !createdAfter.has(row.utxo_ref)) { cmp(row.utxo_ref, row, r); continue; }
    const spent = spentAfter.get(row.utxo_ref);
    if (spent != null) {
        // the spend delta carries the applier's tx_out JSON; side columns derive from it
        let j: any = {}; try { j = JSON.parse(spent); } catch { /* keep */ }
        cmp(row.utxo_ref, row, { tx_out: spent, address: j.address ?? null, lovelace: j.amount ?? null, reference_script_hash: j.reference_script_hash ?? null, stake_key: row.stake_key });
        continue;
    }
    missingInRef++;
    if (shown.length < 8) shown.push(`${row.utxo_ref.slice(0, 20)}: not in the reference at the slot`);
}
let missingInImport = 0;
for (const row of ref.query("SELECT utxo_ref FROM utxo").iterate() as Iterable<any>) if (!seen.has(row.utxo_ref) && !createdAfter.has(row.utxo_ref)) { missingInImport++; if (shown.length < 8) shown.push(`${row.utxo_ref.slice(0, 20)}: in the reference, not imported`); }
for (const r of spentAfter.keys()) if (!seen.has(r)) { missingInImport++; if (shown.length < 8) shown.push(`${r.slice(0, 20)}: spent after the slot, not imported`); }
for (const s of shown) console.log("  " + s);
console.log(`match ${ok}, mismatch ${mismatch}, imported-but-absent ${missingInRef}, reference-but-missing ${missingInImport} in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
process.exit(mismatch || missingInRef || missingInImport ? 1 : 0);
