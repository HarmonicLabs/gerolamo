#!/usr/bin/env bun
/**
 * Compare two LMDB ledger stores key by key (src/ledger/storeCompare.ts), e.g. a node synced from
 * genesis against one imported from a Mithril snapshot, or two nodes of the same network. Both are
 * opened READ-ONLY (safe beside the running nodes) and pinned to the same block: the newest block
 * both hold a complete state for (their anchor or a volatile block whose diffs reach it), or
 * `--at <hash>`. Every named database is streamed in key order from both and merged; per database
 * the counts, same / differing / one-sided keys and the first differences are printed. Epoch-
 * prefixed history is compared from the newest of the two stores' oldest epochs (retention and
 * history start are not differences). `meta` is printed apart (it describes the store).
 *
 *   bun scripts/store-compare.ts <ledgerDirA> <ledgerDirB> [--at <blockHash>] [--db utxo,stake,…]
 *       [--skip utxo_addr,…] [--samples 5] [--names A,B] [--placeholders] [--json out.json]
 *
 * `--placeholders`: a snapshot-imported store against one synced from genesis — ignore the fields
 * the importer cannot know (pool / DRep registration slots, DRep activity epochs, vote slots,
 * proposal order, op-cert slots; storeCompare.PLACEHOLDER_FIELDS).
 *
 * Exit 0 when every ledger database matches, 1 when any differs, 2 on a usage/pinning error.
 */
import { commonBlock, compareDb, databasesOf, INFORMATIONAL, openReadOnly, pin, type DbReport, type Pinned } from "../src/ledger/storeCompare";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (dirs.length !== 2) { console.error("usage: bun scripts/store-compare.ts <ledgerDirA> <ledgerDirB> [--at <blockHash>] [--db a,b] [--skip a,b] [--samples N] [--names A,B] [--placeholders] [--json file]"); process.exit(2); }
const [nameA, nameB] = (opt("names") ?? "A,B").split(",");
const only = opt("db")?.split(",").filter(Boolean);
const skip = new Set(opt("skip")?.split(",").filter(Boolean) ?? []);
const samples = Number(opt("samples") ?? 5);
const placeholders = argv.includes("--placeholders");

function pinBoth(): [Pinned, Pinned] {
    for (let attempt = 1; attempt <= 10; attempt++) {
        const sa = openReadOnly(dirs[0]!), sb = openReadOnly(dirs[1]!);
        const at = opt("at")?.toLowerCase() ?? commonBlock(sa, sb)?.hash;
        if (!at) {
            const ha = sa.heldBlocks(), hb = sb.heldBlocks();
            console.error(`no block both stores hold: ${nameA} ${ha.length ? `slots ${ha[0]!.slot}..${ha[ha.length - 1]!.slot}` : "none"} (anchor ${sa.anchor()?.slot ?? "origin"}), ${nameB} ${hb.length ? `slots ${hb[0]!.slot}..${hb[hb.length - 1]!.slot}` : "none"} (anchor ${sb.anchor()?.slot ?? "origin"})`);
            process.exit(2);
        }
        try {
            const a = pin(nameA!, dirs[0]!, sa, at), b = pin(nameB!, dirs[1]!, sb, at);
            if (!a || !b) { console.error(`block ${at} is not held by ${!a ? nameA : nameB}`); process.exit(2); }
            return [a, b];
        } catch (err) {
            if ((err as Error).message !== "moved") throw err;
            sa.close(); sb.close(); // a node promoted between loading its diffs and the read transaction
        }
    }
    console.error("could not pin both stores (a node kept promoting); try again"); process.exit(2);
}

const t0 = performance.now();
const [a, b] = pinBoth();
console.log(`store-compare at block ${a.at.hash} (slot ${a.at.slot})`);
for (const p of [a, b]) console.log(`  ${p.name}: ${p.dir} — anchor ${p.anchorSlot ?? "origin"}, ${p.depth} volatile block(s) above it`);
const dbs = [...new Set([...databasesOf(a), ...databasesOf(b)])].filter((d) => (!only || only.includes(d)) && !skip.has(d)).sort();
const reports: DbReport[] = [];
let differing = 0;
const pad = (s: string | number, n: number) => String(s).padStart(n);
for (const db of dbs) {
    const r = compareDb(db, a, b, { maxSamples: samples, placeholders });
    reports.push(r);
    const bad = r.differ + r.onlyA + r.onlyB > 0;
    if (bad && !INFORMATIONAL.has(db)) differing++;
    const hist = r.fromEpoch !== undefined ? `  (from epoch ${r.fromEpoch}; below it ${r.skippedA} / ${r.skippedB} not compared)` : "";
    console.log(`${bad ? (INFORMATIONAL.has(db) ? "info" : "DIFF") : "ok  "} ${db.padEnd(22)} ${nameA} ${pad(r.countA, 9)}  ${nameB} ${pad(r.countB, 9)}  same ${pad(r.same, 9)}  differ ${pad(r.differ, 7)}  only ${nameA} ${pad(r.onlyA, 7)}  only ${nameB} ${pad(r.onlyB, 7)}  ${r.seconds.toFixed(1)} s${hist}`);
    for (const s of r.samples) console.log(`       ${s}`);
}
a.close(); b.close();
const out = opt("json");
if (out) await Bun.write(out, JSON.stringify({ at: a.at, stores: [a, b].map((p) => ({ name: p.name, dir: p.dir, anchorSlot: p.anchorSlot, depth: p.depth })), reports }, null, 1));
console.log(`${dbs.length} database(s) in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${differing ? `${differing} ledger database(s) DIFFER` : "every ledger database matches"}`);
process.exit(differing ? 1 : 0);
