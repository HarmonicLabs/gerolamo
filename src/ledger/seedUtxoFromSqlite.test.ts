import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { LedgerStore } from "./LedgerStore";
import { UtxoReads } from "./utxoStore";
import { seedUtxoFromSqlite } from "./nodeLedgerStore";

// Bug 352: the SQLite → LMDB seed read the INTEGER lovelace column as a JS number.
const root = mkdtempSync(join(tmpdir(), "gerolamo-seed-sqlite-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("seedUtxoFromSqlite", () => {
    test("a lovelace amount above 2^53 is copied exactly", async () => {
        initSql(join(root, "node.db"));
        await ensureInitialized();
        const ref = "54ca4d491ba4a269c806c7b545f74d56a8c3fbae18c3f1b25d95b73c0bc68490:0", big = "22767614730929897";
        const txOut = JSON.stringify({ address: "addr_test1vp8cprhse9pnnv7f4l3n6pj0afq2hjm6f7r2205dz0583egagfjah", amount: big, assets: { "": { "": big } } });
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace) VALUES (${ref}, ${txOut}, ${ref.slice(0, 64)}, ${"addr_test1vp8cprhse9pnnv7f4l3n6pj0afq2hjm6f7r2205dz0583egagfjah"}, ${big})`;
        expect(Number(big).toString()).not.toBe(big); // what a number read produced
        const st = LedgerStore.open(join(root, "ledger"));
        expect(await seedUtxoFromSqlite(st, { slot: 1, hash: new Uint8Array(32).fill(1) })).toBe(1);
        expect(new UtxoReads(st).get(ref)?.lovelace).toBe(big);
        expect(new UtxoReads(st).totalLovelace()).toBe(BigInt(big));
        st.close();
    });
});
