import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { recordPoolRegistration, seedGenesisDelegs, setOpcertCounter, takeStakeSnapshot } from "../../db/leaderState";
import { LeaderChecker, opcertCounterVerdict, STRICT_LEADER_CHECKS } from "./leaderCheck";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";

// The fixtures assume preprod's slot geometry; other test files in the same run pin preview.
setEpochNetwork("preprod");

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
        const loses = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, leaderValue: new Uint8Array(64).fill(0xff), opcertCounter: 5 }));
        expect(loses.reports.some((r) => r.includes("threshold"))).toBe(true);
    });
    test("operational certificate counter going backwards fails the header (CounterTooSmallOCERT)", async () => {
        const c = new LeaderChecker(config, genesisD0);
        const v = await c.check(facts({ epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, opcertCounter: 3 }));
        expect(v.ok).toBe(!STRICT_LEADER_CHECKS.opcertCounter);
        expect(`${v.reason ?? ""} ${v.reports.join(" ")}`).toContain("counter 3 below");
        // a header at or before the slot that set the stored counter is not "after" it
        const old = await c.check(facts({ epoch: 4, slot: 86400n, issuerHash: POOL, vrfKeyHash: PVRF, opcertCounter: 3 }));
        expect(old.reason ?? "").not.toContain("counter");
    });
    test("Praos: a counter more than one above the last is reported (CounterOverIncrementedOCERT)", async () => {
        const c = new LeaderChecker(config, genesisD0);
        const v = await c.check(facts({ era: 6, epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, leaderValue: new Uint8Array(32), opcertCounter: 7 }));
        expect(v.reports.some((r) => r.includes("more than one above"))).toBe(true);
    });
    test("σ: strict when the snapshot is exact, reported with the reason otherwise (bug 275)", async () => {
        const h = facts({ era: 6, epoch: 5, slot: 86400n + 432000n, issuerHash: POOL, vrfKeyHash: PVRF, leaderValue: new Uint8Array(32).fill(0xff), opcertCounter: 5 });
        const strict = await new LeaderChecker(config, genesisD0, { stateExact: () => ({ exact: true, why: "" }) }).check(h);
        expect(strict.ok).toBe(false);
        expect(strict.reason).toContain("fails the threshold for σ=1000000/1000000");
        const lax = await new LeaderChecker(config, genesisD0, { stateExact: () => ({ exact: false, why: "ledger store mode sqlite" }) }).check(h);
        expect(lax.ok).toBe(true);
        expect(lax.reports.some((r) => r.includes("threshold") && r.includes("report-only: ledger store mode sqlite"))).toBe(true);
        // a winning leader value passes either way
        expect((await new LeaderChecker(config, genesisD0, { stateExact: () => ({ exact: true, why: "" }) }).check({ ...h, leaderValue: new Uint8Array(32) })).ok).toBe(true);
    });
    test("CounterOverIncrementedOCERT: judged by the counters as of the header's parent (bug 276)", async () => {
        // the store holds the tip T (POOL's counter 5); headers validated on top of it are not applied
        const T = "a0".repeat(32), H1 = "a1".repeat(32), H2 = "a2".repeat(32), H3 = "a3".repeat(32), F = "af".repeat(32), X = "ee".repeat(32);
        const counters = { holds: (b: string) => b === T, counterAt: (_b: string, p: string) => (p === POOL ? { counter: 5, slot: 86400 } : null) };
        const c = new LeaderChecker(config, genesisD0, { counters, stateExact: () => ({ exact: true, why: "" }) });
        const h = (hash: string, prevHash: string, n: number, slot: bigint) => facts({ era: 6, epoch: 5, slot, issuerHash: POOL, vrfKeyHash: PVRF, leaderValue: new Uint8Array(32), opcertCounter: n, hash, prevHash });
        const base = 86400n + 432000n;
        expect((await c.check(h(H1, T, 6, base + 1n))).ok).toBe(true);           // m = 5 (the store at T)
        expect((await c.check(h(H2, H1, 7, base + 2n))).ok).toBe(true);          // m = 6: H1 rotated on the way, though nothing was applied
        const over = await c.check(h(H3, H2, 9, base + 3n));                    // m = 7: 9 > 8
        expect(over.ok).toBe(false);
        expect(over.reason).toContain("CounterOverIncrementedOCERT");
        expect((await c.check(h(F, T, 7, base + 2n))).ok).toBe(false);           // a fork from T: m = 5 on that chain
        // a parent neither held nor validated: the tip's counters (SQLite here: 5), an over-increment only reported
        const unknown = await c.check(h(X, "bb".repeat(32), 7, base + 4n));
        expect(unknown.ok).toBe(true);
        expect(unknown.reports.some((r) => r.includes("more than one above 5") && r.includes("report-only"))).toBe(true);
        // a header recorded without a check (VRF deferred) still carries its counter to its children
        c.noteHeader("d1".repeat(32), T, POOL, 6, base + 5n);
        expect((await c.check(h("d2".repeat(32), "d1".repeat(32), 7, base + 6n))).ok).toBe(true);
        // CounterTooSmall along the header's own chain
        expect((await c.check(h("d3".repeat(32), H2, 6, base + 7n))).ok).toBe(false);
        // a store that is not exact (seeded from SQLite: stale counters) only reports the over-increment
        const lax = new LeaderChecker(config, genesisD0, { counters, stateExact: () => ({ exact: false, why: "ledger store seeded from SQLite" }) });
        const r = await lax.check(h("e1".repeat(32), T, 7, base + 8n));
        expect(r.ok).toBe(true);
        expect(r.reports.some((x) => x.includes("CounterOverIncrementedOCERT") && x.includes("report-only: ledger store seeded from SQLite"))).toBe(true);
    });
    test("OCERT verdict: m ≤ n always, n ≤ m + 1 from Praos, m = 0 for a pool never seen", () => {
        expect(opcertCounterVerdict(6, 5, 5)).toEqual({ m: 5, tooSmall: false, overIncremented: false });
        expect(opcertCounterVerdict(6, 5, 6).overIncremented).toBe(false);
        expect(opcertCounterVerdict(6, 5, 7).overIncremented).toBe(true);
        expect(opcertCounterVerdict(5, 5, 7).overIncremented).toBe(false); // TPraos: no upper bound
        expect(opcertCounterVerdict(7, 5, 4).tooSmall).toBe(true);
        expect(opcertCounterVerdict(7, null, 1)).toEqual({ m: 0, tooSmall: false, overIncremented: false });
        expect(opcertCounterVerdict(7, null, 2).overIncremented).toBe(true);
    });
});
