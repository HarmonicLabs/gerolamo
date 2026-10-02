import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "./LedgerStore";
import { UtxoReads, UtxoWrites, decodeRow, encodeRow, keyRef, refKey } from "./utxoStore";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
const TX1 = "aa".repeat(32), TX2 = "bb".repeat(32), ADDR = "addr_test1vqeux7xwusdju9dvsj8h7mca9aup2k439kfmwy773xxc2hcu7zy99", SK = "cdcca01b8e958a3cca255df9581cef0ec23c90ceffe1ab9dcd9beb7a";
const row = (ref: string, amount: string, extra: Partial<ReturnType<typeof decodeRow>> = {}) => ({ utxo_ref: ref, tx_out: JSON.stringify({ address: ADDR, amount, assets: {} }), tx_hash: ref.slice(0, 64), address: ADDR, lovelace: amount, reference_script_hash: null, stake_key: SK, ...extra });

describe("UTxO over the LedgerStore", () => {
    test("record round trip; puts, spends, indexes, balances and counts across diffs and promotion", async () => {
        const r = row(`${TX1}:3`, "5000000", { reference_script_hash: "11".repeat(28) });
        const back = decodeRow(r.utxo_ref, encodeRow(r));
        expect(back).toEqual(r);
        expect(keyRef(refKey(`${TX1}:65535`))).toBe(`${TX1}:65535`);

        const dir = await mkdtemp(join(tmpdir(), "utxo-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024 });
        const w = new UtxoWrites(st), rd = new UtxoReads(st);
        st.beginBlock(h(1), null, 10);
        w.put(row(`${TX1}:0`, "1000")); w.put(row(`${TX1}:1`, "2000")); w.put(r);
        st.commitBlock();
        expect(rd.count()).toBe(3);
        expect(rd.stakeBalance(SK)).toBe(5003000n);
        expect(rd.byAddress(ADDR).map((x) => x.utxo_ref).sort()).toEqual([`${TX1}:0`, `${TX1}:1`, `${TX1}:3`]);
        expect(rd.byTxHash(TX1).map((x) => x.utxo_ref)).toEqual([`${TX1}:0`, `${TX1}:1`, `${TX1}:3`]);
        expect(rd.byReferenceScript("11".repeat(28)).map((x) => x.utxo_ref)).toEqual([`${TX1}:3`]);
        // block 2 spends two, creates one
        st.beginBlock(h(2), h(1), 20);
        const spent = w.del([`${TX1}:0`, `${TX1}:3`, `${TX2}:9`]);
        expect(spent.map((x) => x.utxo_ref)).toEqual([`${TX1}:0`, `${TX1}:3`]);
        w.put(row(`${TX2}:0`, "7000"));
        st.commitBlock();
        expect(rd.count()).toBe(2);
        expect(rd.stakeBalance(SK)).toBe(9000n);
        expect(rd.has(`${TX1}:0`)).toBe(false);
        expect(rd.byAddress(ADDR).map((x) => x.utxo_ref).sort()).toEqual([`${TX1}:1`, `${TX2}:0`]);
        expect(rd.byReferenceScript("11".repeat(28))).toEqual([]);
        // promote both; state in LMDB equals the view
        await st.promoteDeep(0);
        expect(st.anchor()!.slot).toBe(20);
        expect(st.volatileCount()).toBe(0);
        expect(rd.count()).toBe(2);
        expect(rd.stakeBalance(SK)).toBe(9000n);
        expect(rd.get(`${TX2}:0`)!.lovelace).toBe("7000");
        expect(st.env.read((t) => t.count("utxo"))).toBe(2);
        expect(st.env.read((t) => t.count("utxo_addr"))).toBe(2);
        // a fork block spending TX2:0 then dropped by rollback leaves the state intact
        st.beginBlock(h(3), h(2), 30); w.del([`${TX2}:0`]); st.commitBlock();
        expect(rd.count()).toBe(1);
        st.rollbackTo(h(2));
        expect(rd.count()).toBe(2);
        st.close();
    });
});
