import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { storeEpochParams } from "../epochParams";
import { LedgerStore } from "../../ledger/LedgerStore";
import { GDB, GovReads, GovWrites } from "../../ledger/govStore";
import { configureLedgerStore, getLedgerStore, ledgerBeginBlock, ledgerCommitBlock, openNodeLedgerStore, seedGovFromSqlite } from "../../ledger/nodeLedgerStore";
import { recordCommitteeHot, recordDRepRegistration, recordProposals, recordVoteDelegation, recordVotes, seedGovernance } from "./state";
import { storePulserSnapshot } from "./govPulser";
import { credSchemaOfMarkers, legacyDRepExpiry, migrateDRepExpiryOnce, resetDRepExpiryMigrationForTests } from "./govStoreSync";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-govsync-"));
const D1 = "d1".repeat(28), SD = "d2".repeat(28), COLD = "c1".repeat(28), HOT = "c2".repeat(28), A1 = "a1".repeat(28), RET = "ff".repeat(28), TX = "45".repeat(32);
const cred = (h: string, type = 0) => ({ type, hash: { toString: () => h } });
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
/** Every governance database of a store as sorted `keyHex=valueHex` lines: the byte-for-byte view. */
function dump(st: LedgerStore): string[] {
    const out: string[] = [];
    // the governance databases (parameters and nonces are copied from SQLite, the source of truth for them, and were stored before the dual store opened here)
    for (const db of Object.values(GDB)) if (db !== GDB.epochParams && db !== GDB.pparamProps && db !== GDB.nonces) for (const [k, v] of st.range(db, new Uint8Array(0))) out.push(`${db} ${Buffer.from(k).toString("hex")}=${Buffer.from(v).toString("hex")}`);
    return out.sort();
}

beforeAll(async () => {
    setEpochNetwork("preview");
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    await storeEpochParams(646, { drep_activity: 20, protocol_major_ver: 9, drep_deposit: 500000000 }, "local");
    await storeEpochParams(964, { drep_activity: 31, protocol_major_ver: 10 }, "local");
    await storeEpochParams(1436, { drep_activity: 31, protocol_major_ver: 11, gov_action_lifetime: 30 }, "local");
});
afterAll(() => { configureLedgerStore("sqlite"); rmSync(dir, { recursive: true, force: true }); });

describe("SQLite mirror ↔ LMDB governance state (bug 246)", () => {
    test("a legacy NULL expiry is the last activity plus the drep_activity in force then, not today's", () => {
        const activity = (e: number) => (e >= 964 ? 31 : e >= 646 ? 20 : null);
        expect(legacyDRepExpiry(646, activity)).toBe(666);
        expect(legacyDRepExpiry(1178, activity)).toBe(1209);
        expect(credSchemaOfMarkers(["gov_cred_typed_v1", "gov_votes_repaired_v1"])).toBe(2);
        expect(credSchemaOfMarkers(["gov_drep_expiry_v1"])).toBe(3);
        expect(credSchemaOfMarkers([])).toBe(0);
    });

    test("a store written by the node in dual mode and a store seeded from its SQLite mirror hold the same bytes", async () => {
        // dual mode: every governance write goes to SQLite and to the LMDB diff of the open block
        await openNodeLedgerStore({ dbPath: join(dir, "t.db"), ledgerDir: join(dir, "ledger-dual"), ledgerStore: "dual" }, null);
        ledgerBeginBlock(h(1), null, 1436 * 86400 + 10);
        await seedGovernance(sql, { committee: { members: { [`scriptHash-${COLD}`]: 1720 }, threshold: { numerator: 2, denominator: 3 } }, constitution: { anchor: { dataHash: "00".repeat(32) }, script: "11".repeat(28) } }, 1436);
        await recordCommitteeHot(sql, cred(COLD, 1), cred(HOT, 1));
        await recordDRepRegistration(sql, cred(D1), 500_000_000n, 5, 1436);
        await recordDRepRegistration(sql, cred(SD, 1), 500_000_000n, 6, 1436);
        await recordVoteDelegation(sql, cred(A1), { drepType: 0, hash: { toString: () => D1 } }, 1436);
        await recordProposals(sql, TX, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 6 } }], 1436, 30);
        await recordVotes(sql, [{ voter: { kind: 2, hash: { toString: () => D1 } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 1 } }] }, { voter: { kind: 1, hash: { toString: () => HOT } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 0 } }] }], 1436 * 86400 + 10, 1436);
        await storePulserSnapshot({ epoch: 1436, boundary: { slot: 1436 * 86400 - 3, hash: "ab".repeat(32) }, source: "boundary", proposals: [{ actionId: `${TX}:0`, cc: [["01" + HOT, 0]], drep: [[D1, 1]], spo: [] }], drepDistr: [{ type: 0, hash: D1, stake: "7" }], drepStates: [{ cred: D1, expiry: 1467, deposit: "500000000", delegators: [A1] }, { cred: "01" + SD, expiry: 1467, deposit: "500000000", delegators: [] }], poolDistr: [["ee".repeat(28), "1"]] });
        // a row from before bug 102 (NULL expiry) and the migration markers, as the producer's SQLite has them
        await sql`INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch) VALUES (${"d3".repeat(28)}, 0, 500000000, 7, 646, NULL)`;
        getLedgerStore()!.put(GDB.dreps, Uint8Array.from(Buffer.from("d3".repeat(28), "hex")), new TextEncoder().encode(JSON.stringify({ isScript: 0, deposit: "500000000", registeredSlot: 7, lastActiveEpoch: 646, expiryEpoch: null })));
        for (const m of ["gov_cred_typed_v1", "gov_votes_repaired_v1"]) await sql`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${m})`;
        getLedgerStore()!.put(GDB.state, new TextEncoder().encode("state"), new TextEncoder().encode(JSON.stringify({ ...new GovReads(getLedgerStore()!).state(), credSchema: 2 })));
        // the one-time expiry migration fills the NULL in both stores (inside the block)
        resetDRepExpiryMigrationForTests(); // an earlier test file in this process may have run it
        expect(await migrateDRepExpiryOnce()).toBe(1);
        expect(((await sql`SELECT expiry_epoch FROM gov_dreps WHERE credential = ${"d3".repeat(28)}`.values()) as unknown[][])[0]![0]).toBe(666);
        ledgerCommitBlock();
        const dual = getLedgerStore()!;
        const written = dump(dual);
        expect(written.length).toBeGreaterThan(10);
        expect(new GovReads(dual).pulserSnapshot(1436)?.proposals[0]?.drep).toEqual([[D1, 1]]);
        // a fresh store seeded from the SQLite mirror alone (what a dual-mode rebuild does)
        const fresh = LedgerStore.open(join(dir, "ledger-seeded"), { mapSize: 64 * 1024 * 1024 });
        await seedGovFromSqlite(fresh, new GovWrites(fresh));
        const seeded = dump(fresh);
        const only = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
        expect({ onlyWritten: only(written, seeded), onlySeeded: only(seeded, written) }).toEqual({ onlyWritten: [], onlySeeded: [] });
        expect(new GovReads(fresh).state()?.credSchema).toBe(3);
        expect(new GovReads(fresh).pulserSnapshot(1436)).toEqual(new GovReads(dual).pulserSnapshot(1436));
        fresh.close();
        dual.close();
        configureLedgerStore("sqlite");
    });
});
