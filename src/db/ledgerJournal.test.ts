/**
 * Rollback journal for non-UTxO ledger state: writes made while a block is being
 * applied are undone exactly (inserts removed, updates reverted, deletes restored),
 * newest block first; writes outside a block or with journaling off are not journaled.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { JOURNALED_TABLES, pruneLedgerJournal, setApplyBlock, undoLedgerJournal, withJournalingOff } from "./ledgerJournal";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-journal-"));
const A = Buffer.alloc(32, 0xa1), B = Buffer.alloc(32, 0xb2);
const CRED = Buffer.from("60225f7274685e821d6a8ba899a921c86d74c6d4a634a90b915d0a39", "hex");
const BIG = 9449412006605253n; // beyond 2^53: must round-trip exactly

async function snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of JOURNALED_TABLES) {
        const rows = (await sql.unsafe(`SELECT rowid, * FROM "${t}" ORDER BY rowid`).values()) as unknown[][];
        out[t] = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
    }
    return out;
}

beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    await sql`INSERT INTO reward_pots (id, reserves, treasury, fee_pot, initialized_epoch) VALUES (1, ${BIG}, 5, 0, 0)`;
    await sql`INSERT INTO rewards (stake_credentials, amount) VALUES (${Buffer.alloc(28, 7)}, 1000)`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ledger journal", () => {
    test("writes outside a block are not journaled", async () => {
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${Buffer.alloc(28, 1)}, 0, 0)`;
        const n = (await sql`SELECT COUNT(*) FROM ledger_journal`.values()) as unknown[][];
        expect(Number(n[0]![0])).toBe(0);
    });

    test("two blocks of certificate, pot and governance writes are undone exactly, newest first", async () => {
        const before = await snapshot();
        await setApplyBlock(sql as any, A);
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${CRED}, 1, 0)`; // registration
        await sql`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${CRED}, 1, ${Buffer.alloc(28, 9)})`;
        await sql`UPDATE reward_pots SET reserves = reserves - 2000000, treasury = treasury + 2000000 WHERE id = 1`; // deposit-like move
        await sql`INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch) VALUES ('aa', 0, 500000000, 100, 5)`;
        await setApplyBlock(sql as any, B);
        await sql`DELETE FROM rewards WHERE amount = 1000`; // withdrawal emptied and row dropped
        await sql`UPDATE gov_dreps SET last_active_epoch = 9 WHERE credential = 'aa'`;
        await sql`INSERT INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES ('t:0', 2, 'bb', 1, 200)`;
        await setApplyBlock(sql as any, null);
        const mid = await snapshot();
        expect(mid).not.toEqual(before);
        const rows = (await sql`SELECT tbl, op FROM ledger_journal ORDER BY id`.values()) as unknown[][];
        expect(rows.map((r) => `${r[0]}:${r[1]}`)).toEqual(["stake:I", "delegations:I", "reward_pots:U", "gov_dreps:I", "rewards:D", "gov_dreps:U", "gov_votes:I"]);

        // undo B only: A's writes stay
        const cb = await undoLedgerJournal(sql as any, [B]);
        expect(cb).toEqual({ inserted: 1, updated: 1, deleted: 1, rows: 3 });
        const afterB = await snapshot();
        expect(afterB.rewards).toBe(before.rewards); // the deleted row is back with its rowid
        expect(afterB.gov_votes).toBe(before.gov_votes);
        expect(afterB.stake).toBe(mid.stake);
        // undo A: back to the pre-apply state, including the >2^53 reserves value
        await undoLedgerJournal(sql as any, [A]);
        expect(await snapshot()).toEqual(before);
        const left = (await sql`SELECT COUNT(*) FROM ledger_journal`.values()) as unknown[][];
        expect(Number(left[0]![0])).toBe(0);
    });

    test("a rolled-back block's leader count and op-cert counter are undone (bug 104)", async () => {
        const C = Buffer.alloc(32, 0xc3);
        await sql`INSERT OR REPLACE INTO blocks_made_by_epoch (epoch, pool_id, blocks) VALUES (77, 'p1', 3)`;
        await sql`INSERT OR REPLACE INTO opcert_counters (pool_id, counter, slot) VALUES ('p1', 4, 1000)`;
        const before = await snapshot();
        await setApplyBlock(sql as any, C);
        await sql`INSERT INTO blocks_made_by_epoch (epoch, pool_id, blocks) VALUES (77, 'p1', 4) ON CONFLICT(epoch, pool_id) DO UPDATE SET blocks = blocks + 1`;
        await sql`INSERT INTO blocks_made_by_epoch (epoch, pool_id, blocks) VALUES (77, 'p2', 1)`;
        await sql`UPDATE opcert_counters SET counter = 5, slot = 1010 WHERE pool_id = 'p1'`;
        await setApplyBlock(sql as any, null);
        expect((await sql`SELECT blocks FROM blocks_made_by_epoch WHERE epoch = 77 AND pool_id = 'p1'`.values())[0]![0]).toBe(4);
        await undoLedgerJournal(sql as any, [C]);
        expect(await snapshot()).toEqual(before);
        expect((await sql`SELECT blocks FROM blocks_made_by_epoch WHERE epoch = 77 AND pool_id = 'p1'`.values())[0]![0]).toBe(3);
        expect((await sql`SELECT counter FROM opcert_counters WHERE pool_id = 'p1'`.values())[0]![0]).toBe(4);
        expect((await sql`SELECT COUNT(*) FROM blocks_made_by_epoch WHERE pool_id = 'p2'`.values())[0]![0]).toBe(0);
    });

    test("journaling off (epoch boundary) leaves no rows; undo statements do not journal themselves", async () => {
        await setApplyBlock(sql as any, A);
        await withJournalingOff(sql as any, async () => { await sql`UPDATE reward_pots SET fee_pot = 77 WHERE id = 1`; });
        await sql`UPDATE reward_pots SET fee_pot = 78 WHERE id = 1`;
        await setApplyBlock(sql as any, null);
        const rows = (await sql`SELECT op, before FROM ledger_journal`.values()) as unknown[][];
        expect(rows.length).toBe(1);
        expect(JSON.parse(String(rows[0]![1])).fee_pot).toBe("77");
        await undoLedgerJournal(sql as any, [A]);
        const v = (await sql`SELECT fee_pot FROM reward_pots WHERE id = 1`.values()) as unknown[][];
        expect(Number(v[0]![0])).toBe(77);
        expect(Number(((await sql`SELECT COUNT(*) FROM ledger_journal`.values()) as unknown[][])[0]![0])).toBe(0);
    });

    test("prune drops rows of blocks far behind the tip only", async () => {
        await sql`INSERT INTO blocks (hash, slot, block_no) VALUES (${A.toString("hex")}, 1000, 1), (${B.toString("hex")}, 200000, 2)`;
        await setApplyBlock(sql as any, A);
        await sql`INSERT INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES ('old:0', 2, 'cc', 1, 1000)`;
        await setApplyBlock(sql as any, B);
        await sql`INSERT INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES ('new:0', 2, 'dd', 1, 200000)`;
        await setApplyBlock(sql as any, null);
        const pruned = await pruneLedgerJournal(sql as any, 100);
        expect(pruned).toBe(1);
        const left = (await sql`SELECT hex(block_hash) FROM ledger_journal`.values()) as unknown[][];
        expect(left.map((r) => String(r[0]).toLowerCase())).toEqual([B.toString("hex")]);
    });
});
