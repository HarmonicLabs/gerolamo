import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../ledger/LedgerStore";
import { u64 } from "../ledger/LedgerDiff";

// Bug 231: a Praos node must roll back up to k blocks across an epoch boundary. In lmdb mode the
// boundary work (reward update, snapshot, pool reaping, governance) is written into the epoch's
// first block's diff, so dropping that diff reverts it exactly.
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const b = (s: string) => new TextEncoder().encode(s);
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };

describe("LMDB ledger store: rollback across an epoch boundary", () => {
    test("the boundary block's diff carries the epoch transition; rolling back past it restores the pre-boundary state", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-epoch-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.env.write((t) => { t.put("reward", b("acctA"), u64(10n)); t.put("pots", b("reserves"), u64(1000n)); });
        await st.setAnchor({ slot: 0, hash: h(0) });
        // last block of epoch 7
        st.beginBlock(h(1), h(0), 86_399); st.addU64("reward", b("acctA"), 1n); st.commitBlock();
        // first block of epoch 8: the boundary (rewards paid, snapshot taken, a pool reaped) + the block itself
        st.beginBlock(h(2), h(1), 86_450);
        st.addU64("reward", b("acctA"), 500n); st.addU64("pots", b("reserves"), -500n);
        st.put("snap_pool", b("8|poolX"), u64(123n)); st.del("pool", b("poolRetiring"));
        st.put("utxo", b("tx8:0"), b("out"));
        st.commitBlock();
        st.beginBlock(h(3), h(2), 86_470); st.put("utxo", b("tx8b:0"), b("out")); st.commitBlock();
        expect(st.getU64("reward", b("acctA"))).toBe(511n);
        // the network's chain forks at the last block of epoch 7: roll back across the boundary
        const r = st.rollbackToSlot(86_399);
        st.selectTip(r.tip);
        expect(r.dropped).toBe(2);
        expect(st.getU64("reward", b("acctA"))).toBe(11n);
        expect(st.getU64("pots", b("reserves"))).toBe(1000n);
        expect(st.get("snap_pool", b("8|poolX"))).toBeUndefined();
        expect(st.get("utxo", b("tx8:0"))).toBeUndefined();
        // the other branch's boundary applies once, on top of the restored state
        st.beginBlock(h(12), h(1), 86_460); st.addU64("reward", b("acctA"), 500n); st.addU64("pots", b("reserves"), -500n); st.commitBlock();
        expect(st.getU64("reward", b("acctA"))).toBe(511n);
        expect(st.getU64("pots", b("reserves"))).toBe(500n);
        st.close();
    });

    test("below the anchor (deeper than k, already promoted) the store refuses", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-epoch-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 100, hash: h(0) });
        expect(() => st.rollbackToSlot(50)).toThrow(/below the anchor/);
        st.close();
    });
});
