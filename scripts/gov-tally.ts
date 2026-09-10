#!/usr/bin/env bun
/** Recompute one proposal's tally at a boundary: bun scripts/gov-tally.ts --db <ledger.db> --action <txid:ix> --epoch <E> [--taken-at <snapshot epoch>] [--votes-until-epoch <e>] */
import { initSql, sql, withReadOnlyConnection } from "../src/sql";
import { tallyProposal } from "../src/consensus/governance/state";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
initSql(args.db!); // queries below run on the read-only connection (the node may be the writer)
const epoch = Number(args.epoch);
if (process.env.GOV_TALLY_DEBUG) console.log("args", args);
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
const show = (x: any) => x == null ? "none" : `${x.num}/${x.den}`;
const pct = (a: bigint, b: bigint) => b === 0n ? "n/a" : (Number(a * 10000n / b) / 100).toFixed(2) + "%";
const poolTotal = r.pt.yes + r.pt.no + r.pt.unvoted + r.pt.abstain;
console.log(`epoch ${epoch} snapshot ${takenAt} votes≤epoch ${args["votes-until-epoch"] ?? "all"}: ratified=${r.ratified} cc=${r.ccOk} (${r.ct.yes}/${r.ct.active}) drep=${r.drepOk} (yes ${pct(r.dt.yes, r.dt.yes + r.dt.no + r.dt.unvoted)}) pool=${r.poolOk} (yes ${pct(r.pt.yes, poolTotal - r.pt.abstain - r.pt.unvotedAbstain)} of non-abstaining; yes ${r.pt.yes} no ${r.pt.no} unvoted ${r.pt.unvoted} abstain ${r.pt.abstain} unvotedAbstain ${r.pt.unvotedAbstain} unvotedNoConf ${r.pt.unvotedNoConfidence}) thr pool=${show(r.thr.pool)} drep=${show(r.thr.drep)}`);
