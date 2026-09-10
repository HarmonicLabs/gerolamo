#!/usr/bin/env bun
/**
 * Repair reward balances of script stake accounts after bug 65 (VALIDATION_STATUS.md):
 * withdrawals from script reward accounts were typed as key accounts, so they debited a
 * 28-byte row (usually none) instead of the account's 29-byte row (01‖hash), which grew
 * without bound. Rebuilds the balances from our own history:
 *   - Σ withdrawal deltas (utxo_deltas action='withdrawal', stakeCred = 28-byte hash) per hash;
 *   - a 28-byte row with the same hash as a 29-byte row is that script account mistyped
 *     (a key hash never equals a script hash): its balance already carries those debits, so
 *     the two rows are merged into the 29-byte row;
 *   - otherwise the withdrawals are subtracted from the 29-byte row.
 * Run with the node stopped. Dry run by default; --apply writes.
 *   bun scripts/repair-script-rewards.ts --db <ledger.db> [--apply]
 */
import { Database } from "bun:sqlite";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : []).filter((x) => x.length));
const apply = args.apply === "1";
const db = apply ? new Database(args.db!) : new Database(args.db!, { readonly: true });
const maxId = Number((db.query("SELECT MAX(id) AS m FROM utxo_deltas").get() as any).m ?? 0);
const sumW = new Map<string, bigint>();
const CHUNK = 2_000_000;
let scanned = 0;
for (let lo = 0; lo <= maxId; lo += CHUNK) {
    const rows = db.query(`SELECT json_extract(utxo, '$.stakeCred') AS c, json_extract(utxo, '$.amount') AS a FROM utxo_deltas WHERE id > ? AND id <= ? AND action = 'withdrawal'`).all(lo, lo + CHUNK) as Array<{ c: string; a: string | number }>;
    for (const r of rows) { const h = String(r.c ?? "").toLowerCase(); if (h.length !== 56) continue; sumW.set(h, (sumW.get(h) ?? 0n) + BigInt(String(r.a ?? 0))); }
    scanned += rows.length;
    process.stderr.write(`\rscanned ids ≤ ${Math.min(lo + CHUNK, maxId)} (${scanned} withdrawals)`);
}
process.stderr.write("\n");
const scriptRows = db.query("SELECT rowid AS r, hex(stake_credentials) AS h, amount FROM rewards WHERE length(stake_credentials) = 29").all() as Array<{ r: number; h: string; amount: number | bigint }>;
const keyRows = new Map<string, { r: number; amount: bigint }>();
for (const k of db.query("SELECT rowid AS r, hex(stake_credentials) AS h, amount FROM rewards WHERE length(stake_credentials) = 28").all() as Array<{ r: number; h: string; amount: number | bigint }>) keyRows.set(k.h.toLowerCase(), { r: k.r, amount: BigInt(k.amount) });
let merged = 0, subtracted = 0, untouched = 0, before = 0n, after = 0n;
const plan: Array<{ rowid: number; newAmount: bigint; deleteRowid?: number }> = [];
for (const s of scriptRows) {
    const hash = s.h.slice(2).toLowerCase();
    const cur = BigInt(s.amount); before += cur;
    const twin = keyRows.get(hash);
    let next = cur;
    if (twin) { next = cur + twin.amount; merged++; plan.push({ rowid: s.r, newAmount: next, deleteRowid: twin.r }); }
    else if (sumW.has(hash)) { next = cur - sumW.get(hash)!; subtracted++; plan.push({ rowid: s.r, newAmount: next }); }
    else untouched++;
    after += next;
}
const negatives = plan.filter((p) => p.newAmount < 0n).length;
console.log(JSON.stringify({ maxId, withdrawalsScanned: scanned, hashesWithWithdrawals: sumW.size, scriptRows: scriptRows.length, merged, subtracted, untouched, negativesAfter: negatives, totalBefore: before.toString(), totalAfter: after.toString() }));
if (!apply) { console.log("dry run; pass --apply to write"); process.exit(0); }
db.exec("BEGIN");
for (const p of plan) {
    db.query("UPDATE rewards SET amount = ? WHERE rowid = ?").run(p.newAmount < 0n ? 0 : p.newAmount, p.rowid);
    if (p.deleteRowid != null) db.query("DELETE FROM rewards WHERE rowid = ?").run(p.deleteRowid);
}
db.exec("COMMIT");
console.log("applied", plan.length, "row(s); negative results clamped to 0:", negatives);
