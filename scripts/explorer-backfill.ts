#!/usr/bin/env bun
/**
 * Rebuild the explorer projection (mb_* tables in <db>.explorer.db) for a slot range from
 * the ledger's stored blocks and utxo_deltas — for ranges the indexer missed (2026-09-06:
 * the first explorer worker build died and ~7 700 preview blocks were applied without it).
 * Stop the node first when applying: the explorer file has one writer (the node's worker).
 *   bun scripts/explorer-backfill.ts --db <ledger.db> --from <slot> --to <slot> [--explorer <path>] [--port 3035] [--apply]
 * Slots are exclusive bounds: blocks with from < slot < to are rebuilt.
 */
process.env.GEROLAMO_DB_PATH = ":memory:"; // db.ts opens the shared client at import; keep it off the ledger file
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { applyMbTx, type MbTxDelta, type MbTxIn, type MbTxOut } from "../src/db/minibf/writer";
import { ensureMinibfSchema } from "../src/db/minibf/schema";
import { sqliteClient } from "../src/db/minibf/sqliteClient";
import { explorerDbPathFor } from "../src/db/minibf/explorerIndexer";
const { buildUtxoRowForOutput } = await import("../src/db");

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]] : []).filter((x) => x.length));
const dbPath = String(args.db ?? ""), from = Number(args.from), to = Number(args.to), apply = args.apply === "1";
if (!dbPath || !Number.isFinite(from) || !Number.isFinite(to)) throw new Error("usage: --db <ledger.db> --from <slot> --to <slot> [--explorer <path>] [--apply]");
const explorerPath = String(args.explorer ?? explorerDbPathFor(dbPath));
if (apply) {
    const port = String(args.port ?? "3035");
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
        try { if (readFileSync(`/proc/${pid}/environ`, "utf8").includes(`GEROLAMO_PORT=${port}\0`)) throw new Error(`a node with GEROLAMO_PORT=${port} is running (pid ${pid}); stop it first`); } catch (e) { if (e instanceof Error && e.message.includes("running")) throw e; }
    }
}
const ledger = new Database(dbPath, { readonly: true });
const explorer = apply ? new Database(explorerPath) : null;
if (explorer) { explorer.run("PRAGMA journal_mode = WAL"); explorer.run("PRAGMA busy_timeout = 5000"); await ensureMinibfSchema(sqliteClient(explorer)); }
const mb = explorer ? sqliteClient(explorer) : null;

const blocksStmt = ledger.query("SELECT hash, slot, block_no, block_data FROM blocks WHERE slot > ? AND slot < ? AND is_valid = TRUE ORDER BY slot");
const spendsStmt = ledger.query("SELECT json(utxo) AS u FROM utxo_deltas WHERE block_hash = ? AND action = 'spend'");
const addressOf = (txOutJson: string): string => { try { return String(JSON.parse(txOutJson)?.address ?? ""); } catch { return ""; } };

let blocks = 0, txs = 0;
const rows = blocksStmt.all(from, to) as any[];
console.log(`${rows.length} block(s) with ${from} < slot < ${to} in ${dbPath}${apply ? `; writing ${explorerPath}` : " (dry run)"}`);
if (explorer) explorer.run("BEGIN");
for (const r of rows) {
    const blockHash: Uint8Array = r.hash instanceof Uint8Array ? r.hash : Buffer.from(String(r.hash), "hex");
    const block = MultiEraBlock.fromCbor(new Uint8Array(r.block_data));
    const spentAddr = new Map<string, string>();
    for (const s of spendsStmt.all(blockHash) as any[]) {
        try { const u = JSON.parse(String(s.u)); spentAddr.set(String(u.utxo_ref), addressOf(String(u.tx_out ?? ""))); } catch { /* skip */ }
    }
    const bodies: any[] = (block.block as any).transactionBodies ?? [];
    // phase-2-invalid transactions are not indexed by the applier either (only their collateral moves)
    const invalid = new Set<number>(((block.block as any)?.invalidTransactions ?? []).map((x: any) => Number(x)));
    for (let ti = 0; ti < bodies.length; ti++) {
        if (invalid.has(ti)) continue;
        const body = bodies[ti];
        let txId = "";
        try { txId = toHex(body.hash instanceof Uint8Array ? body.hash : body.hash.toBuffer()).toLowerCase(); } catch { continue; }
        const addrDirs = new Map<string, "in" | "out" | "both">();
        const inputs: MbTxIn[] = [];
        for (let i = 0; i < (body.inputs ?? []).length; i++) {
            const input = body.inputs[i];
            const prevHash = String(input.utxoRef.id.toString()).toLowerCase(), prevIdx = Number(input.utxoRef.index);
            inputs.push({ inputIndex: i, prevTxHash: prevHash, prevOutputIndex: prevIdx });
            const a = spentAddr.get(`${prevHash}:${prevIdx}`);
            if (a && a.length > 8) { const prev = addrDirs.get(a); addrDirs.set(a, prev === "in" || prev === "both" ? "both" : "out"); }
        }
        const outputs: MbTxOut[] = (body.outputs ?? []).map((output: any, i: number) => {
            const row = buildUtxoRowForOutput(txId, i, output);
            if (row.address && row.address.length > 8) { const prev = addrDirs.get(row.address); addrDirs.set(row.address, prev === "out" || prev === "both" ? "both" : "in"); }
            return { outputIndex: i, address: row.address, lovelace: row.lovelace, assetsJson: row.assetsJson, datumHash: row.metadata.datumHash, inlineDatumCbor: row.metadata.inlineDatumCbor, scriptRefHash: row.metadata.scriptRefHash };
        });
        let size: number | null = null; try { size = body.toCborBytes().length; } catch { /* */ }
        const delta: MbTxDelta = {
            txHash: txId, blockHash, slot: Number(r.slot), txIndex: ti, blockHeight: r.block_no == null ? null : Number(r.block_no),
            fee: body.fee != null ? String(body.fee) : null, size,
            invalidBefore: body.validityIntervalStart != null ? String(body.validityIntervalStart) : null,
            invalidHereafter: body.ttl != null ? String(body.ttl) : null,
            addresses: addrDirs, inputs, outputs,
        };
        if (mb) await applyMbTx(mb, delta);
        txs++;
    }
    blocks++;
    if (explorer && blocks % 200 === 0) { explorer.run("COMMIT"); explorer.run("BEGIN"); console.log(`  ${blocks} blocks, ${txs} txs`); }
}
if (explorer) { explorer.run("COMMIT"); explorer.run("PRAGMA wal_checkpoint(TRUNCATE)"); explorer.close(); }
console.log(`${apply ? "wrote" : "would write"} ${txs} transaction(s) from ${blocks} block(s)`);
