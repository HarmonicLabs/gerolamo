#!/usr/bin/env bun
/** Recompute one proposal's tally at a boundary: bun scripts/gov-tally.ts --db <ledger.db> --action <txid:ix> --epoch <E> [--taken-at <snapshot epoch>] [--votes-until-epoch <e>] [--debug] */
import { initSql, sql, withReadOnlyConnection } from "../src/sql";
import { tallyProposal } from "../src/consensus/governance/state";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
initSql(args.db!); // queries below run on the read-only connection (the node may be the writer)
const epoch = Number(args.epoch);
if ("debug" in args) console.log("args", args);
const takenAt = args["taken-at"] ? Number(args["taken-at"]) : epoch - 1;
const untilSlot = args["votes-until-epoch"] ? (Number(args["votes-until-epoch"]) + 1) * 86400 - 1 : Number.MAX_SAFE_INTEGER;
const r = await withReadOnlyConnection(async () => {
    // the pulser's thresholds are the epoch's own parameters (bug 82); retry once around a checkpoint
    let rows: unknown[][] = [];
    for (let attempt = 0; attempt < 3 && rows.length === 0; attempt++) {
        rows = (await sql`SELECT params FROM epoch_params WHERE epoch = ${epoch}`.values()) as unknown[][];
        if (rows.length === 0) await new Promise((res) => setTimeout(res, 300));
    }
    if (rows.length === 0) throw new Error(`no epoch_params row for epoch ${epoch}`);
    const raw = JSON.parse(String(rows[0]![0]));
    return tallyProposal(sql as any, epoch, args.action!, raw, takenAt, untilSlot);
});
console.log(`epoch ${epoch} snapshot ${takenAt} votes≤epoch ${args["votes-until-epoch"] ?? "all"}: ${r.kind} ${r.id} ratified=${r.ratified} (${r.reason}) cc ${r.cc}; drep ${r.drep}; spo ${r.spo}`);
