import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../ledger/LedgerStore";
import { UtxoReads, UtxoWrites } from "../ledger/utxoStore";
import { dropPointerStakeLmdb } from "./conwayTranslation";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
const tx = (n: number) => n.toString(16).padStart(64, "0");

describe("Babbage → Conway translation in the LMDB ledger store (bug 236)", () => {
    test("pointer-address outputs lose their stake credential; stake_bal follows; other outputs untouched; the boundary diff reverts it", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-ptr-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const w = new UtxoWrites(st), r = new UtxoReads(st);
        const cred = "0c90492b" + "00".repeat(24);
        st.beginBlock(h(1), h(0), 10);
        w.put({ utxo_ref: `${tx(1)}:0`, tx_out: "{}", tx_hash: tx(1), address: "addr_test1gz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5ph3wczvf2", lovelace: "35553328331", reference_script_hash: null, stake_key: cred });
        w.put({ utxo_ref: `${tx(2)}:0`, tx_out: "{}", tx_hash: tx(2), address: "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae", lovelace: "5000000", reference_script_hash: null, stake_key: cred });
        st.commitBlock();
        expect(r.stakeBalance(cred)).toBe(35558328331n);
        // the Conway boundary block
        st.beginBlock(h(2), h(1), 20);
        const d = dropPointerStakeLmdb(st, (rec) => w.put(rec));
        st.commitBlock();
        expect(d).toEqual({ outputs: 1, lovelace: 35553328331n });
        expect(r.stakeBalance(cred)).toBe(5000000n);
        expect(r.get(`${tx(1)}:0`)?.stake_key).toBeNull();
        expect(r.get(`${tx(1)}:0`)?.lovelace).toBe("35553328331"); // the UTxO itself is kept
        expect(r.get(`${tx(2)}:0`)?.stake_key).toBe(cred);
        // idempotent
        st.beginBlock(h(3), h(2), 30);
        expect(dropPointerStakeLmdb(st, (rec) => w.put(rec))).toEqual({ outputs: 0, lovelace: 0n });
        st.commitBlock();
        // a rollback across the boundary restores the Babbage view
        st.selectTip(st.rollbackToSlot(10).tip);
        expect(r.stakeBalance(cred)).toBe(35558328331n);
        st.close();
    });
});
