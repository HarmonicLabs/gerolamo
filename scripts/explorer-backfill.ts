#!/usr/bin/env bun
/**
 * Rebuild the explorer projection (mb_* tables in <db>.explorer.db) for a slot range from the
 * node's block store (chunk format; the SQLite `blocks` table on a legacy node): for ranges the
 * indexer missed or paused (sync.skipIndexWhileBehind), and to add the v2 Blockfrost indexes
 * (bug 500: block rows, metadata, mint/assets, certificates, withdrawals, redeemers, scripts, datums,
 * votes, proposals) to history projected before v2.
 *
 *   bun scripts/explorer-backfill.ts --db <ledger.db> --from <slot> --to <slot> [--network preview] [--blocks <dir>] [--k 432]
 *        [--explorer <path>] [--extras] [--creds] [--port 3035] [--apply]
 *
 *   (default)  transactions, inputs, outputs, address links and the v2 rows of every block in range
 *   --extras   only the v2 rows (the transaction rows are already there)
 *   --creds    also fill payment / stake credentials and output assets of mb_tx_out rows written before v2
 *
 * Slots are exclusive bounds (from < slot < to). Dry run unless --apply. Stop the node first when
 * applying: the explorer file has one writer (the node's worker); the script refuses while a node
 * started with `--port <port>` runs. The block store is opened read-only.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { applyMbBlock, applyMbTx } from "../src/db/minibf/writer";
import { ensureMinibfOutIndexes, ensureMinibfSchema } from "../src/db/minibf/schema";
import { sqliteClient } from "../src/db/minibf/sqliteClient";
import { explorerDbPathFor } from "../src/db/minibf/explorerIndexer";
import { blockFacts } from "../src/db/minibf/blockFacts";
import { deltasOfBlock } from "../src/db/minibf/blockDeltas";
import { credentialsOfAddress } from "../src/db/minibf/cardanoIds";
import { attachReadOnlyBlockStore } from "../src/storage/nodeBlockStore";
import { selectedChain } from "../src/storage/blockReads";
import { epochForSlot, normalizeEpochNetwork, setEpochNetwork, slotInEpoch } from "../src/utils/epochFromSlotCalculations";
import { initSettings } from "../src/config/settings";

initSettings({ dbPath: ":memory:" }); // db.ts opens the shared client on first use; keep it off the ledger file

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]] : []).filter((x) => x.length));
const dbPath = String(args.db ?? ""), from = Number(args.from ?? -1), to = Number(args.to ?? Number.MAX_SAFE_INTEGER), apply = args.apply === "1";
const extrasOnly = args.extras === "1", creds = args.creds === "1";
if (!dbPath) throw new Error("usage: --db <ledger.db> [--from <slot>] [--to <slot>] [--blocks <dir>] [--k 432] [--explorer <path>] [--extras] [--creds] [--apply]");
setEpochNetwork(normalizeEpochNetwork(String(args.network ?? "preview")));
const explorerPath = String(args.explorer ?? explorerDbPathFor(dbPath));
if (apply) {
    const port = String(args.port ?? "3035");
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
        try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
            // by cmdline (`start-gerolamo ... --port <port>`); GEROLAMO_PORT in the environment for a node started before 2026-10-26
            const ours = (cmd.startsWith("bun ") && cmd.includes("start-gerolamo") && new RegExp(`--port ${port}( |$)`).test(cmd)) || readFileSync(`/proc/${pid}/environ`, "utf8").includes(`GEROLAMO_PORT=${port}\0`);
            if (ours) throw new Error(`a node on port ${port} is running (pid ${pid}); stop it first`);
        } catch (e) { if (e instanceof Error && e.message.includes("running")) throw e; }
    }
}
const explorer = apply ? new Database(explorerPath) : existsSync(explorerPath) ? new Database(explorerPath, { readonly: true }) : null;
if (apply && explorer) { explorer.run("PRAGMA journal_mode = WAL"); explorer.run("PRAGMA busy_timeout = 5000"); await ensureMinibfSchema(sqliteClient(explorer)); await ensureMinibfOutIndexes(sqliteClient(explorer)); }
const mb = apply && explorer ? sqliteClient(explorer) : null;
const outAddr = explorer ? explorer.query("SELECT address FROM mb_tx_out WHERE tx_hash = ? AND output_index = ?") : null;
const addressOf = (h: string, i: number): string | null => { const r = outAddr?.get(h, i) as any; return r?.address ?? null; };

// ---- blocks: the chunk store when there is one, else the legacy SQLite table
async function* blocks(): AsyncGenerator<{ slot: number; hash: Uint8Array; bytes: Uint8Array }> {
    const store = await attachReadOnlyBlockStore({ dbPath, blockStoreDir: args.blocks ? String(args.blocks) : undefined }, Number(args.k ?? 432)).catch(() => null);
    if (store) {
        for await (const b of selectedChain(store, from + 1, to - 1)) yield { slot: b.slot, hash: b.hash, bytes: b.bytes };
        return;
    }
    const ledger = new Database(dbPath, { readonly: true });
    for (const r of ledger.query("SELECT hash, slot, block_data FROM blocks WHERE slot > ? AND slot < ? AND is_valid = TRUE ORDER BY slot").all(from, to) as any[]) {
        yield { slot: Number(r.slot), hash: r.hash instanceof Uint8Array ? r.hash : Buffer.from(String(r.hash), "hex"), bytes: new Uint8Array(r.block_data) };
    }
}

let nBlocks = 0, nTxs = 0, failed = 0;
const t0 = performance.now();
console.log(`${extrasOnly ? "v2 rows only" : "transactions + v2 rows"} for blocks with ${from} < slot < ${to}${apply ? `; writing ${explorerPath}` : " (dry run)"}`);
if (explorer && apply) explorer.run("BEGIN");
for await (const b of blocks()) {
    let facts;
    try { facts = blockFacts(b.bytes); } catch (e) { failed++; console.warn(`slot ${b.slot}: not decodable (${(e as Error).message})`); continue; }
    const meta = { hash: b.hash, slot: b.slot, height: facts.blockNo };
    if (!extrasOnly) for (const d of await deltasOfBlock(facts, meta, addressOf)) { if (mb) await applyMbTx(mb, d); nTxs++; }
    if (mb) await applyMbBlock(mb, { kind: "block", ...meta, epoch: Number(epochForSlot(b.slot)), epochSlot: Number(slotInEpoch(b.slot)), bytes: b.bytes }, facts);
    nBlocks++;
    if (explorer && apply && nBlocks % 500 === 0) { explorer.run("COMMIT"); explorer.run("BEGIN"); console.log(`  ${nBlocks} blocks, ${nTxs} txs, slot ${b.slot}, ${Math.round((performance.now() - t0) / 1000)} s`); }
}
if (explorer && apply) explorer.run("COMMIT");
console.log(`${apply ? "wrote" : "would write"} ${nBlocks} block(s), ${nTxs} transaction(s)${failed ? `, ${failed} undecodable` : ""}`);

// ---- credentials and output assets of rows written before v2 (chunked by rowid)
if (creds && explorer) {
    const max = Number((explorer.query("SELECT COALESCE(MAX(rowid), 0) AS m FROM mb_tx_out").get() as any).m);
    const sel = explorer.query("SELECT rowid, tx_hash, output_index, address, assets_json FROM mb_tx_out WHERE rowid > ? AND rowid <= ? AND payment_cred IS NULL");
    const upd = apply ? explorer.query("UPDATE mb_tx_out SET payment_cred = ?, stake_cred = ? WHERE rowid = ?") : null;
    const ins = apply ? explorer.query("INSERT OR IGNORE INTO mb_tx_out_asset (tx_hash, output_index, unit, quantity) VALUES (?, ?, ?, ?)") : null;
    let rows = 0;
    for (let lo = 0; lo < max; lo += 50_000) {
        if (apply) explorer.run("BEGIN");
        for (const r of sel.all(lo, lo + 50_000) as any[]) {
            const c = credentialsOfAddress(String(r.address ?? ""));
            upd?.run(c.payment, c.stake, r.rowid);
            if (r.assets_json) try { for (const [p, ns] of Object.entries(JSON.parse(r.assets_json) as Record<string, Record<string, string>>)) for (const [n, q] of Object.entries(ns)) ins?.run(r.tx_hash, r.output_index, p + n, String(q)); } catch { /* malformed */ }
            rows++;
        }
        if (apply) explorer.run("COMMIT");
        if (lo % 1_000_000 === 0 && lo) console.log(`  credentials: rowid ${lo}/${max}`);
    }
    console.log(`${apply ? "filled" : "would fill"} credentials of ${rows} output row(s)`);
}
if (explorer && apply) { explorer.run("PRAGMA wal_checkpoint(TRUNCATE)"); explorer.close(); }
