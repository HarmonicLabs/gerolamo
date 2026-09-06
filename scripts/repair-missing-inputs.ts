/**
 * Repair UTxOs a rollback failed to restore (2026-09-05: rollbackChainTo queued the
 * restored rows and never flushed them — fixed — leaving spent-then-rolled-back
 * outputs missing). For every input / collateral of a block, if the output is
 * missing from `utxo`, was created by a transaction in a kept block of OUR chain
 * and no kept block spends it, rebuild the row from the creating transaction's
 * output exactly as applyTransaction would have written it.
 *
 *   bun scripts/repair-missing-inputs.ts --db <ledger.db> --hex logs/failed-block-<slot>.hex [--apply]
 *
 * Stop the node (and its supervisor) first: this writes to the ledger DB.
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { initSql, sql } from "../src/sql";
import { buildUtxoRowForOutput, ensureInitialized, getBlockByHash } from "../src/db";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1]!.startsWith("--") ? all[i + 1] : "true"] : [])).filter((x) => x.length));
if (!args.db || !args.hex) { console.error("usage: --db <ledger.db> --hex <failed-block.hex> [--apply]"); process.exit(2); }
initSql(String(args.db));
await ensureInitialized();
const apply = args.apply === "true";

const hex = (await Bun.file(String(args.hex)).text()).trim();
const meb: any = MultiEraBlock.fromCbor(Uint8Array.from(Buffer.from(hex, "hex")));
const blk: any = meb.block;
const slot = String(blk.header.body.slot);
const refs: Array<{ ref: string; tx: string; ix: number; kind: string }> = [];
for (const [ti, t] of (blk.transactionBodies as any[]).entries()) {
    for (const inp of t.inputs ?? []) refs.push({ ref: `${inp.utxoRef.id.toString()}:${inp.utxoRef.index}`, tx: inp.utxoRef.id.toString(), ix: Number(inp.utxoRef.index), kind: `tx[${ti}] input` });
    for (const c of t.collateralInputs ?? []) refs.push({ ref: `${c.utxoRef.id.toString()}:${c.utxoRef.index}`, tx: c.utxoRef.id.toString(), ix: Number(c.utxoRef.index), kind: `tx[${ti}] collateral` });
}
const tip = Number(((await sql`SELECT MAX(slot) AS s FROM blocks`.values()) as unknown[][])[0]![0]);
console.log(`block slot ${slot}, ${blk.transactionBodies.length} tx, ${refs.length} input refs; DB tip ${tip}`);
let repaired = 0, missingUnrepairable = 0;
const seen = new Set<string>();
for (const r of refs) {
    if (seen.has(r.ref)) continue; seen.add(r.ref);
    const present = (await sql`SELECT 1 FROM utxo WHERE utxo_ref = ${r.ref}`.values()) as unknown[][];
    if (present.length) continue;
    const creator = (await sql`SELECT lower(hex(block_hash)) AS h, slot FROM mb_tx WHERE tx_hash = ${r.tx.toLowerCase()}`.values()) as unknown[][];
    if (!creator.length) { console.log(`MISSING ${r.ref} (${r.kind}): creating tx not in our index — cannot rebuild`); missingUnrepairable++; continue; }
    const [h, cslot] = [String(creator[0]![0]), Number(creator[0]![1])];
    if (cslot > tip) { console.log(`MISSING ${r.ref}: creator at slot ${cslot} is beyond the tip ${tip}`); missingUnrepairable++; continue; }
    const spender = (await sql`SELECT i.tx_hash, t.slot FROM mb_tx_in i JOIN mb_tx t ON t.tx_hash = i.tx_hash WHERE i.prev_tx_hash = ${r.tx.toLowerCase()} AND i.prev_output_index = ${r.ix}`.values()) as unknown[][];
    if (spender.length && Number(spender[0]![1]) <= tip) { console.log(`MISSING ${r.ref}: spent by ${String(spender[0]![0]).slice(0, 16)}… at slot ${spender[0]![1]} on our chain — genuinely spent, not restoring`); missingUnrepairable++; continue; }
    const row = await getBlockByHash(h); // .values() row: [id, chunk_id, slot, hash, prev_hash, header_data, block_data, …]
    const raw = Array.isArray(row) ? row[6] : row?.block_data;
    const data: Uint8Array | null = raw ? new Uint8Array(raw as any) : null;
    if (!data) { console.log(`MISSING ${r.ref}: creating block ${h.slice(0, 16)}… (slot ${cslot}) has no stored bytes`); missingUnrepairable++; continue; }
    const cb: any = MultiEraBlock.fromCbor(data).block;
    const ctx = (cb.transactionBodies as any[]).find((t) => String(t.hash.toString()).toLowerCase() === r.tx.toLowerCase());
    if (!ctx || !ctx.outputs?.[r.ix]) { console.log(`MISSING ${r.ref}: output not found in creating block`); missingUnrepairable++; continue; }
    const built = buildUtxoRowForOutput(r.tx.toLowerCase(), r.ix, ctx.outputs[r.ix]);
    console.log(`${apply ? "RESTORE" : "would restore"} ${r.ref} (${r.kind}) from slot ${cslot}: ${built.lovelace} lovelace, ${built.address.slice(0, 24)}…`);
    if (apply) {
        await sql`INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key)
            VALUES (${built.utxoRef}, ${built.txOutJson}, ${r.tx.toLowerCase()}, ${built.cols.address}, ${built.cols.lovelace}, ${built.cols.referenceScriptHash}, ${built.cols.stakeKey})`;
        repaired++;
    }
}
console.log(`${apply ? "restored" : "restorable"}: ${apply ? repaired : refs.length - missingUnrepairable - seen.size + [...seen].length} · unrepairable: ${missingUnrepairable}`);
process.exit(0);
