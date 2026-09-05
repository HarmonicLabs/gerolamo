import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { recordPoolRegistration, seedGenesisDelegs, setOpcertCounter, takeStakeSnapshot } from "../../db/leaderState";
import { LeaderChecker, STRICT_LEADER_CHECKS } from "./leaderCheck";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-leader-"));
const GK = "11".repeat(28), DELEGATE = "22".repeat(28), GVRF = "33".repeat(32);
const POOL = "44".repeat(28), PVRF = "55".repeat(32), STAKE = "66".repeat(28);
// preprod: epoch 4 starts at slot 86400; genesis d = 1 → every slot is overlay, every 20th active
const config = { network: "preprod", shelleyGenesisFile: "./src/config/preprod/shelley-genesis.json" };
const genesis = { activeSlotsCoeff: 0.05, protocolParams: { decentralisationParam: 1 } };
const genesisD0 = { activeSlotsCoeff: 0.05, protocolParams: { decentralisationParam: 0 } };

beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    await seedGenesisDelegs({ [GK]: { delegate: DELEGATE, vrf: GVRF } });
    await recordPoolRegistration(sql, POOL, PVRF, 86400);
    // one delegated UTxO of 1 ADA and a snapshot for epoch 5 (taken at the start of epoch 4)
    await sql`INSERT INTO delegations (stake_credentials, pool_key_hash) VALUES (${Buffer.from(STAKE, "hex")}, ${Buffer.from(POOL, "hex")})`;
    await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, stake_key) VALUES ('aa:0', '{}', 'aa', 'addr_test1x', 1000000, ${STAKE})`;
    await takeStakeSnapshot(sql, 4);
    await setOpcertCounter(sql, POOL, 5, 86400);
    // Epoch parameters are read from the DB first; pin d per epoch so the test never reaches a network source.
    await sql`CREATE TABLE IF NOT EXISTS epoch_params (epoch INTEGER PRIMARY KEY, params TEXT NOT NULL, source TEXT, fetched_at INTEGER DEFAULT (strftime('%s','now')))`;
    await sql`INSERT OR REPLACE INTO epoch_params (epoch, params, source) VALUES (4, ${JSON.stringify({ decentralisation_param: "1" })}, 'test')`;
    await sql`INSERT OR REPLACE INTO epoch_params (epoch, params, source) VALUES (5, ${JSON.stringify({ decentralisation_param: "0" })}, 'test')`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const facts = (over: Partial<Parameters<LeaderChecker["check"]>[0]>) => ({
    era: 2, slot: 86400n, epoch: 4, issuerHash: DELEGATE, vrfKeyHash: GVRF, leaderValue: new Uint8Array(64), opcertCounter: 0, ...over,
});

describe("LeaderChecker", () => {
    test("overlay (d = 1): the scheduled genesis delegate with its VRF key passes; another issuer fails; inactive slots fail", async () => {
        const c = new LeaderChecker(config, genesis);
        expect((await c.check(facts({}))).ok).toBe(true);
        const wrongIssuer = await c.check(facts({ issuerHash: POOL, vrfKeyHash: PVRF }));
        expect(wrongIssuer.ok).toBe(false);
        expect(wrongIssuer.reason).toContain("belongs to genesis delegate");
        const wrongVrf = await c.check(facts({ vrfKeyHash: PVRF }));
        expect(wrongVrf.ok).toBe(false);
        const inactive = await c.check(facts({ slot: 86401n }));
        expect(inactive.ok).toBe(false);
        expect(inactive.reason).toContain("inactive overlay slot");
    });
    test("praos (d = 0): registered pool with matching VRF passes; unknown pool or wrong VRF fails; σ threshold reports", async () => {
        const c = new LeaderChecker(config, genesisD0);
        const ok = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, leaderValue: new Uint8Array(64), opcertCounter: 6 }));
        expect(ok.ok).toBe(true);
        expect(ok.reports).toEqual([]);
        const unknown = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: "77".repeat(28), vrfKeyHash: PVRF }));
        expect(unknown.ok).toBe(!STRICT_LEADER_CHECKS.poolRegistered);
        const wrongVrf = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: GVRF }));
        expect(wrongVrf.ok).toBe(false);
        const loses = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, leaderValue: new Uint8Array(64).fill(0xff) }));
        expect(loses.reports.some((r) => r.includes("threshold"))).toBe(true);
    });
    test("operational certificate counter going backwards is reported", async () => {
        const c = new LeaderChecker(config, genesisD0);
        const v = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, opcertCounter: 3 }));
        expect(v.reports.some((r) => r.includes("counter 3 below"))).toBe(true);
    });
});
