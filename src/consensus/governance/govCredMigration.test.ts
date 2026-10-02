import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { migrateGovCredentials, noteGovGenesisConfig, resetGovCredMigrationForTests } from "./govCredMigration";
import { loadCommitteeView, loadDReps } from "./govLedgerView";
import { genesisCred, parseGenesisDRep, recordCommitteeHot, seedGovernance } from "./state";
import { configureLedgerStore, getLedgerStore, ledgerBeginBlock, ledgerCommitBlock, ledgerGov, openNodeLedgerStore } from "../../ledger/nodeLedgerStore";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-govmig-"));
const SCRIPT_DREP = "5d".repeat(28), KEY_DREP = "6d".repeat(28), GEN_COLD = "7c".repeat(28), OTHER_COLD = "8c".repeat(28), HOT_S = "9e".repeat(28), HOT_K = "ae".repeat(28);
const cred = (h: string, type = 0) => ({ type, hash: { toString: () => h } });

beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    writeFileSync(join(dir, "conway-genesis.json"), JSON.stringify({ committee: { members: { [`scriptHash-${GEN_COLD}`]: 900 }, threshold: { numerator: 2, denominator: 3 } } }));
    noteGovGenesisConfig({ conwayGenesisFile: join(dir, "conway-genesis.json") });
});
afterAll(() => { configureLedgerStore("sqlite"); rmSync(dir, { recursive: true, force: true }); });

describe("typed governance credentials: migration of stored rows (bug 153)", () => {
    test("SQLite: script DReps move to their typed key, committee types come from the genesis and the committee's votes", async () => {
        // rows as a build before the fix wrote them: bare hashes
        await sql`INSERT INTO gov_state (id, committee_threshold_num, committee_threshold_den, no_confidence, seeded_epoch) VALUES (1, 2, 3, 0, 100)`;
        await sql`INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch) VALUES (${SCRIPT_DREP}, 1, 500, 1, 100, 120), (${KEY_DREP}, 0, 500, 1, 100, 121)`;
        await sql`INSERT INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (${GEN_COLD}, 900, ${HOT_S}, 0), (${OTHER_COLD}, 800, ${HOT_K}, 0)`;
        await sql`INSERT INTO gov_committee_auth (cold_credential, hot_credential, resigned) VALUES (${GEN_COLD}, ${HOT_S}, 0), (${OTHER_COLD}, ${HOT_K}, 0)`;
        await sql`INSERT INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES (${"01".repeat(32) + ":0"}, 1, ${HOT_S}, 1, 5), (${"01".repeat(32) + ":0"}, 0, ${HOT_K}, 1, 5)`;
        // before: the readers already see the right DRep types (is_script decides) and both readings of an untyped member
        const before = await loadDReps();
        expect(before.has("01" + SCRIPT_DREP)).toBe(true);
        expect(before.has(KEY_DREP)).toBe(true);
        const r = await migrateGovCredentials();
        expect(r).toEqual({ dreps: 1, committee: 4 });
        const keys = ((await sql`SELECT credential FROM gov_dreps ORDER BY credential`.values()) as unknown[][]).map((x) => String(x[0]));
        expect(keys).toEqual(["01" + SCRIPT_DREP, KEY_DREP]);
        const cc = ((await sql`SELECT cold_credential, hot_credential FROM gov_committee ORDER BY cold_credential`.values()) as unknown[][]).map((x) => `${x[0]}>${x[1]}`);
        // the genesis names GEN_COLD a script; OTHER_COLD's type is unknown (stays bare), its hot key voted as a key credential
        expect(cc).toEqual([`01${GEN_COLD}>01${HOT_S}`, `${OTHER_COLD}>00${HOT_K}`]);
        const v = await loadCommitteeView();
        expect(v.members!.get("01" + GEN_COLD)).toBe(900);
        expect(v.members!.has(GEN_COLD)).toBe(false);
        expect(v.members!.get(OTHER_COLD)).toBe(800); // untyped: both readings
        expect(v.members!.get("01" + OTHER_COLD)).toBe(800);
        expect(v.creds.get("01" + GEN_COLD)!.hot).toBe("01" + HOT_S);
        expect(await migrateGovCredentials()).toBeNull(); // once
        // a certificate names OTHER_COLD's type: the row moves to the typed key
        await recordCommitteeHot(sql, cred(OTHER_COLD, 1), cred(HOT_K));
        const after = ((await sql`SELECT cold_credential FROM gov_committee_auth ORDER BY cold_credential`.values()) as unknown[][]).map((x) => String(x[0]));
        expect(after).toEqual(["01" + GEN_COLD, "01" + OTHER_COLD]);
        expect(((await sql`SELECT cold_credential FROM gov_committee WHERE cold_credential = ${"01" + OTHER_COLD}`.values()) as unknown[][]).length).toBe(1);
    });

    test("LMDB: the same migration inside a block diff", async () => {
        resetGovCredMigrationForTests();
        await openNodeLedgerStore({ dbPath: join(dir, "t.db"), ledgerDir: join(dir, "ledger"), ledgerStore: "lmdb" }, null);
        const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
        ledgerBeginBlock(h(1), null, 10);
        const g = ledgerGov()!;
        g.putState({ thrNum: 2, thrDen: 3, constitutionHash: null, constitutionScript: null, noConfidence: 0, prevPP: null, prevHF: null, prevCC: null, prevCons: null, seededEpoch: 100, dormantEpochs: 0, pending: null });
        g.putDRep(SCRIPT_DREP, { isScript: 1, deposit: "500", registeredSlot: 1, lastActiveEpoch: 100, expiryEpoch: 120 });
        g.putCommittee(GEN_COLD, { expiresEpoch: 900, hot: HOT_S, resigned: 0 });
        g.putCommitteeAuth(GEN_COLD, { hot: HOT_S, resigned: 0 });
        g.putProposal({ actionId: "01".repeat(32) + ":0", seq: 1, kind: "Info", prevActionId: null, deposit: "1", returnAccount: "aa".repeat(28), payload: "{}", proposedEpoch: 100, expiresEpoch: 106, status: "active", decidedEpoch: null });
        g.putVote({ actionId: "01".repeat(32) + ":0", voterKind: 1, voterHash: HOT_S, vote: 1, slot: 5 });
        ledgerCommitBlock();
        ledgerBeginBlock(h(2), h(1), 20);
        const r = await migrateGovCredentials();
        expect(r?.dreps).toBe(1);
        const gw = ledgerGov()!;
        expect(gw.reads.drep("01" + SCRIPT_DREP)?.isScript).toBe(1);
        expect(gw.reads.drep(SCRIPT_DREP)).toBeNull();
        expect(gw.reads.committee().get("01" + GEN_COLD)?.hot).toBe("01" + HOT_S);
        expect(gw.reads.state()?.credSchema).toBe(3); // the hook chain: typed credentials (1), the votes repair (needs a block store: skipped), the expiry migration (3)
        ledgerCommitBlock();
        getLedgerStore()?.close();
        configureLedgerStore("sqlite");
    });
});

describe("Conway genesis seeding (bug 157)", () => {
    test("genesis credentials and DReps parse as cardano-ledger writes them", () => {
        expect(genesisCred(`scriptHash-${GEN_COLD}`)).toBe("01" + GEN_COLD);
        expect(genesisCred(`keyHash-${GEN_COLD}`)).toBe(GEN_COLD);
        expect(parseGenesisDRep("drep-alwaysAbstain")).toEqual({ type: 2, hash: null });
        expect(parseGenesisDRep("drep-alwaysNoConfidence")).toEqual({ type: 3, hash: null });
        expect(parseGenesisDRep(`drep-scriptHash-${KEY_DREP}`)).toEqual({ type: 1, hash: KEY_DREP });
        expect(parseGenesisDRep("bogus")).toBeNull();
    });
    test("initialDReps and delegs are seeded only for a chain that starts in Conway, and delegations only for registered credentials", async () => {
        const REG = "bb".repeat(28), UNREG = "cc".repeat(28), GD = "dd".repeat(28);
        const g = { committee: { members: { [`keyHash-${GEN_COLD}`]: 50 }, threshold: { numerator: 1, denominator: 2 } }, constitution: { anchor: { dataHash: "00".repeat(32) } }, dRepActivity: 20,
            initialDReps: { [`keyHash-${GD}`]: { expiry: 30, deposit: 500000000 } },
            delegs: { [`keyHash-${REG}`]: { dRep: `drep-keyHash-${GD}` }, [`keyHash-${UNREG}`]: { dRep: "drep-alwaysAbstain" } } };
        await sql`DELETE FROM gov_state`; await sql`DELETE FROM gov_dreps`; await sql`DELETE FROM gov_committee`; await sql`DELETE FROM gov_drep_delegations`;
        await seedGovernance(sql, g, 0, { chainStartsInConway: false });
        expect(((await sql`SELECT COUNT(*) FROM gov_dreps`.values()) as unknown[][])[0]![0]).toBe(0);
        expect(((await sql`SELECT cold_credential FROM gov_committee`.values()) as unknown[][]).map((r) => String(r[0]))).toEqual(["00" + GEN_COLD]);
        await sql`DELETE FROM gov_state`;
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${Buffer.from(REG, "hex")}, 0, 0)`;
        await seedGovernance(sql, g, 0, { chainStartsInConway: true });
        expect(((await sql`SELECT credential, expiry_epoch, deposit FROM gov_dreps`.values()) as unknown[][]).map((r) => `${r[0]}:${r[1]}:${r[2]}`)).toEqual([`${GD}:30:500000000`]);
        expect(((await sql`SELECT stake_key, drep_type, drep_hash FROM gov_drep_delegations`.values()) as unknown[][]).map((r) => `${r[0]}:${r[1]}:${r[2]}`)).toEqual([`${REG}:0:${GD}`]);
        await sql`DELETE FROM gov_state`; await sql`DELETE FROM gov_dreps`; await sql`DELETE FROM gov_drep_delegations`;
        await seedGovernance(sql, g, 0, { chainStartsInConway: true, mainnet: true });
        expect(((await sql`SELECT COUNT(*) FROM gov_dreps`.values()) as unknown[][])[0]![0]).toBe(0); // never on mainnet
    });
});
