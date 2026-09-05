#!/usr/bin/env bun
/** Recompute script_data_hash for every Plutus transaction in stored blocks and count matches. */
import { Database } from "bun:sqlite";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { costModelArrays, expectedScriptDataHash, type PlutusLanguage } from "../src/consensus/rules/scriptDataHash";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const db = new Database(args.db!, { readonly: true });
const from = Number(args.from ?? 0), to = Number(args.to ?? 1e12), limit = Number(args.limit ?? 2000);
const paramsRow = db.query("SELECT params FROM epoch_params WHERE epoch = ?").get(Number(args.epoch)) as any;
const models = costModelArrays(JSON.parse(paramsRow.params));
console.log("models", Object.entries(models).map(([k, v]) => `V${k}:${v!.length}`).join(" "));
const rows = db.query("SELECT slot, block_data FROM blocks WHERE slot BETWEEN ? AND ? ORDER BY slot").all(from, to) as any[];
let txs = 0, match = 0, mismatch = 0, skipped = 0, refSkipped = 0;
const byLang = new Map<string, [number, number]>();
for (const row of rows) {
    if (txs >= limit) break;
    let blk: any;
    try { blk = (MultiEraBlock.fromCbor(new Uint8Array(row.block_data)) as any); } catch { continue; }
    const era = blk.era, b = blk.block;
    for (let i = 0; i < (b.transactionBodies?.length ?? 0); i++) {
        const body = b.transactionBodies[i], ws = b.transactionWitnessSets[i];
        if (!(ws?.redeemers?.length || ws?.datums?.length) && !body.scriptDataHash) continue;
        txs++;
        if ((body.refInputs?.length ?? 0) > 0) { refSkipped++; continue; }
        const langs = new Set<PlutusLanguage>();
        if (ws.plutusV1Scripts?.length) langs.add(1);
        if (ws.plutusV2Scripts?.length) langs.add(2);
        if (ws.plutusV3Scripts?.length) langs.add(3);
        const bytes = ws.cborRef?.toBuffer?.();
        if (!bytes) { skipped++; continue; }
        const exp = expectedScriptDataHash({ witnessSetBytes: bytes, languages: langs, models, alonzoForm: era === 5 });
        if (exp.reason || !exp.hash) { skipped++; continue; }
        const actual = String(body.scriptDataHash ?? "").toLowerCase();
        const key = `era${era}/${[...langs].map((l) => `V${l}`).join("+") || "none"}`;
        const e = byLang.get(key) ?? [0, 0];
        if (exp.hash === actual) { match++; e[0]++; } else { mismatch++; e[1]++; if (mismatch <= 3) console.log("mismatch slot", row.slot, "tx", i, key, "actual", actual.slice(0, 16), "expected", exp.hash.slice(0, 16)); }
        byLang.set(key, e);
    }
}
console.log({ blocks: rows.length, txs, match, mismatch, skipped, refSkipped });
for (const [k, [m, x]] of byLang) console.log(k, "match", m, "mismatch", x);
