import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "./LedgerStore";
import { StakeWrites, u32 } from "./stakeStore";
import { UtxoWrites } from "./utxoStore";
import { commonBlock, compareDb, databasesOf, openReadOnly, pin } from "./storeCompare";

const root = mkdtempSync(join(tmpdir(), "gerolamo-store-compare-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const h = (n: number) => new Uint8Array(32).fill(n);
const hx = (n: number) => Buffer.from(h(n)).toString("hex");
const rec = (i: number, lovelace: number) => ({ utxo_ref: `${"ab".repeat(31)}${i.toString(16).padStart(2, "0")}:0`, tx_out: JSON.stringify({ address: "addr_test1x", amount: String(lovelace), assets: {} }), tx_hash: null, address: "addr_test1x", lovelace: String(lovelace), reference_script_hash: null, stake_key: "cd".repeat(28) });

/**
 * The same chain of three blocks in two stores that promoted to different depths (A keeps blocks
 * 2–3 volatile, B promoted block 2): pinned at block 3 they must read the same state, counters
 * (UTxO count, stake balance, the reward account) included.
 */
async function build(name: string, promoted: number, opts: { history: number[]; extraInBlock3?: boolean }): Promise<string> {
    const dir = join(root, name);
    const st = LedgerStore.open(dir);
    const u = new UtxoWrites(st), w = new StakeWrites(st);
    st.applyDirectSync(() => {
        for (let i = 0; i < 50; i++) u.put(rec(i, 1000 + i));
        for (const e of opts.history) w.recordPotSnapshot(e, { reserves: 1n, treasury: 2n, feesCollected: 3n });
        w.creditRewards(new Map([["ef".repeat(28), 7n]]));
    });
    await st.setAnchor({ slot: 10, hash: h(1) });
    st.beginBlock(h(2), h(1), 20); u.del([rec(3, 0).utxo_ref]); u.put(rec(60, 5)); w.creditRewards(new Map([["ef".repeat(28), 3n]])); st.commitBlock();
    st.beginBlock(h(3), h(2), 30); u.put(rec(61, 6)); w.debitReward("ef".repeat(28), 2n); if (opts.extraInBlock3) u.put(rec(62, 9)); st.commitBlock();
    if (promoted >= 2) await st.promote([h(2)]);
    st.close();
    return dir;
}

describe("store-compare", () => {
    test("two stores of one chain, promoted to different depths, agree at their common block", async () => {
        const a = openReadOnly(await build("a", 1, { history: [5, 6, 7, 8] })), b = openReadOnly(await build("b", 2, { history: [7, 8] }));
        expect(commonBlock(a, b)).toEqual({ slot: 30, hash: hx(3) });
        const pa = pin("A", "a", a, hx(3))!, pb = pin("B", "b", b, hx(3))!;
        expect([pa.anchorSlot, pa.depth, pb.anchorSlot, pb.depth]).toEqual([10, 2, 20, 1]);
        const dbs = databasesOf(pa);
        expect(dbs).toEqual(expect.arrayContaining(["utxo", "utxo_addr", "stake_bal", "utxo_stats", "reward", "pot_snap", "meta"]));
        for (const db of dbs.filter((d) => d !== "meta")) {
            const r = compareDb(db, pa, pb);
            expect([db, r.differ, r.onlyA, r.onlyB]).toEqual([db, 0, 0, 0]);
        }
        const utxo = compareDb("utxo", pa, pb);
        expect(utxo.same).toBe(51); // 50 − 1 spent + 2 created
        const hist = compareDb("pot_snap", pa, pb);
        expect([hist.fromEpoch, hist.skippedA, hist.skippedB, hist.same]).toEqual([7, 2, 0, 2]); // epochs 5–6 only in A's history: not compared
        expect(compareDb("reward", pa, pb).same).toBe(1); // 7 + 3 − 2 on both sides
        pa.close(); pb.close();
    });
    test("a difference in a volatile block is found and described", async () => {
        const a = openReadOnly(await build("c", 1, { history: [] })), b = openReadOnly(await build("d", 2, { history: [], extraInBlock3: true }));
        const pa = pin("A", "c", a, hx(3))!, pb = pin("B", "d", b, hx(3))!;
        const r = compareDb("utxo", pa, pb);
        expect([r.same, r.onlyA, r.onlyB, r.differ]).toEqual([51, 0, 1, 0]);
        expect(r.samples[0]).toContain(`only in B: ${"ab".repeat(31)}3e:0 = 9 lovelace`);
        const c = compareDb("utxo_stats", pa, pb);
        expect(c.differ).toBe(1);
        expect(c.samples[0]).toContain("count = 51");
        // a block one store does not hold cannot be pinned there
        expect(pin("A", "c", a, hx(9))).toBeNull();
        pa.close(); pb.close();
    });
    test("--placeholders: the fields a snapshot import cannot know are not differences", async () => {
        const mk = async (name: string, slot: number, opSlot: number) => {
            const dir = join(root, name);
            const st = LedgerStore.open(dir);
            const w = new StakeWrites(st);
            st.applyDirectSync(() => { w.putPool("aa".repeat(28), { vrf: "bb".repeat(32), registeredSlot: slot, retiringEpoch: null, params: null }); w.putOpcert("aa".repeat(28), 4, opSlot); });
            await st.setAnchor({ slot: 1, hash: h(1) });
            st.close();
            return pin(name, dir, openReadOnly(dir), hx(1))!;
        };
        const pa = await mk("imp", 0, 500), pb = await mk("gen", 1234, 777);
        expect([compareDb("pool", pa, pb).differ, compareDb("opcert", pa, pb).differ]).toEqual([1, 1]);
        expect([compareDb("pool", pa, pb, { placeholders: true }).same, compareDb("opcert", pa, pb, { placeholders: true }).same]).toEqual([1, 1]);
        pa.close(); pb.close();
    });
    test("an epoch-prefixed key of epoch −1 (a genesis chain's first reward report) is outside every window", async () => {
        const dir = join(root, "neg");
        const st = LedgerStore.open(dir);
        st.applyDirectSync(() => { st.put("reward_epochs", u32(-1), new Uint8Array([1])); st.put("reward_epochs", u32(4), new Uint8Array([2])); });
        await st.setAnchor({ slot: 1, hash: h(1) });
        st.close();
        const dir2 = join(root, "neg2");
        const st2 = LedgerStore.open(dir2);
        st2.applyDirectSync(() => st2.put("reward_epochs", u32(4), new Uint8Array([2])));
        await st2.setAnchor({ slot: 1, hash: h(1) });
        st2.close();
        const pa = pin("A", dir, openReadOnly(dir), hx(1))!, pb = pin("B", dir2, openReadOnly(dir2), hx(1))!;
        const r = compareDb("reward_epochs", pa, pb);
        expect([r.same, r.onlyA, r.skippedA]).toEqual([1, 0, 1]);
        pa.close(); pb.close();
    });
});
