import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "./LedgerStore";
import { StakeWrites, u32 } from "./stakeStore";
import { UtxoWrites, encodeRow, refKey } from "./utxoStore";
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

    test("zero-stake pools are compared over the stake snapshot's window, not their own (bug 370)", async () => {
        const mk = async (name: string, zeroAt: number[]) => {
            const dir = join(root, name);
            const st = LedgerStore.open(dir);
            const w = new StakeWrites(st);
            st.applyDirectSync(() => { for (const e of [5, 6, 7]) { w.putSnapshotCred(e, "ef".repeat(28), "aa".repeat(28), 1n); } for (const e of zeroAt) w.putSnapshotPoolZero(e, "bb".repeat(28)); });
            await st.setAnchor({ slot: 1, hash: h(1) });
            st.close();
            return pin(name, dir, openReadOnly(dir), hx(1))!;
        };
        const pa = await mk("zero-all", [5, 6, 7]), pb = await mk("zero-late", [7]); // B: a snapshot import that wrote none for 5–6
        const r = compareDb("snap_pool_zero", pa, pb, { placeholders: true });
        expect([r.fromEpoch, r.same, r.onlyA, r.onlyB]).toEqual([5, 1, 2, 0]);
        pa.close(); pb.close();
    });
    test("representation-only differences compare equal; ledger differences do not (bugs 353–355)", async () => {
        const te = new TextEncoder(), j = (o: unknown) => te.encode(JSON.stringify(o));
        const ref = `${"ab".repeat(32)}:3`, row = (o: unknown, lovelace = "5000000") => encodeRow({ tx_out: JSON.stringify(o), tx_hash: "ab".repeat(32), address: "addr_test1x", lovelace, reference_script_hash: null, stake_key: null });
        const prop = (status: string) => j({ actionId: "x", status, deposit: "1" });
        const nonce = (ev: string) => j({ nonceHex: "aa", source: "local", evolvingHex: ev, candidateHex: "cc" });
        const mk = async (name: string, imported: boolean, k: { amount?: string; margin: [string, string]; evolving: string; hotTyped: boolean; sameTip?: boolean }) => {
            const dir = join(root, name);
            const st = LedgerStore.open(dir);
            st.applyDirectSync(() => {
                // utxo: the applier's ordinary form (import) vs the former collateral-return form (genesis sync)
                st.put("utxo", refKey(ref), imported ? row({ address: "addr_test1x", amount: k.amount ?? "5000000", assets: { "": { "": k.amount ?? "5000000" } } }, k.amount) : row({ address: "addr_test1x", amount: "5000000", assets: {}, collateral_return: true }));
                st.put("pool", h(7).subarray(0, 28), j({ vrf: "v", registeredSlot: imported ? 0 : 99, params: { marginNum: k.margin[0], marginDen: k.margin[1], pledge: "1" } }));
                st.put("epoch_params", u32(10), imported ? j({ params: { a: 1, b: 2 }, source: "local" }) : j({ source: "local", params: { b: 2, a: 1 } }));
                st.put("nonces", u32(9), nonce(k.evolving)); st.put("nonces", u32(10), nonce("same"));
                st.put("pots", te.encode("init_epoch"), u32(imported ? 9 : 0));
                st.put("gov_state", te.encode("state"), j({ thrNum: 2, seededEpoch: imported ? 9 : 1 }));
                const cold = "11".repeat(28), hot = "22".repeat(28);
                st.put("gov_committee", Buffer.from(imported ? cold : `01${cold}`, "hex"), j({ expiresEpoch: 30, hot: k.hotTyped ? `01${hot}` : hot, resigned: 0 }));
                if (imported) st.put("drep_stake", new Uint8Array([...u32(10), 0, ...h(5).subarray(0, 28)]), new Uint8Array(8)); // a zero-stake DRep the importer writes
                if (!imported) {
                    st.put("gov_proposals", new Uint8Array(36).fill(3), prop("expired"));      // history the import cannot hold
                    st.put("gov_votes", new Uint8Array([...new Uint8Array(36).fill(3), 0, ...h(4).subarray(0, 28)]), j({ vote: 1 }));
                    st.put("gov_enacted", new Uint8Array([...u32(5), ...new Uint8Array(36).fill(3)]), j({ kind: "Info" }));
                }
                st.put("gov_proposals", new Uint8Array(36).fill(4), prop("active"));
            });
            await st.setAnchor({ slot: 1, hash: h(1) });
            st.close();
            return pin(name, dir, openReadOnly(dir), hx(1))!;
        };
        const imp = await mk("rep-imp", true, { margin: ["0", "1"], evolving: "e1", hotTyped: false });
        const gen = await mk("rep-gen", false, { margin: ["0", "1000000"], evolving: "e2", hotTyped: true });
        const clean = (db: string) => { const r = compareDb(db, imp, gen, { placeholders: true }); return [db, r.differ, r.onlyA, r.onlyB]; };
        for (const db of ["utxo", "pool", "epoch_params", "nonces", "pots", "gov_state", "gov_committee", "drep_stake", "gov_proposals", "gov_votes", "gov_enacted"]) expect(clean(db)).toEqual([db, 0, 0, 0]);
        expect(compareDb("gov_proposals", imp, gen, { placeholders: true }).historyB).toBe(1);
        expect(compareDb("gov_enacted", imp, gen, { placeholders: true }).fromEpoch).toBe(9);
        expect(compareDb("drep_stake", imp, gen).zeros).toBe(1);
        // without --placeholders the build metadata and the history are differences
        expect(compareDb("gov_state", imp, gen).differ).toBe(1);
        expect(compareDb("gov_proposals", imp, gen).onlyB).toBe(1);
        // a real difference stays one: a different amount, a different margin, a different η0 of the newest epoch
        const imp2 = await mk("rep-imp2", true, { amount: "5000001", margin: ["1", "2"], evolving: "e1", hotTyped: false });
        expect(compareDb("utxo", imp2, gen, { placeholders: true }).differ).toBe(1);
        expect(compareDb("pool", imp2, gen, { placeholders: true }).differ).toBe(1);
        imp.close(); gen.close(); imp2.close();
    });
});
