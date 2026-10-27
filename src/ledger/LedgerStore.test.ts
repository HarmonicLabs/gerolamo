import { withSettings } from "../config/settings";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "./LedgerStore";
import { LedgerDiff, decodeDiff, encodeDiff, u64 } from "./LedgerDiff";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array | undefined) => (u ? new TextDecoder().decode(u) : undefined);
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };

describe("LedgerStore", () => {
    test("diffs over LMDB: reads, counters, ranges, rollback, promote with before-check, snapshot", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024 });
        expect(st.anchor()).toBeNull();
        // genesis-ish immutable state written directly
        await st.env.write((t) => { t.put("utxo", b("in0"), b("out0")); t.put("utxo", b("in1"), b("out1")); t.put("stake_bal", b("credA"), u64(100n)); });
        await st.setAnchor({ slot: 0, hash: h(0) });

        // block 1 spends in0, creates in2, credits credA
        st.beginBlock(h(1), h(0), 10);
        expect(s(st.get("utxo", b("in0")))).toBe("out0");
        st.del("utxo", b("in0")); st.put("utxo", b("in2"), b("out2")); st.addU64("stake_bal", b("credA"), 50n);
        expect(st.get("utxo", b("in0"))).toBeUndefined();       // visible inside the block
        expect(s(st.get("utxo", b("in2")))).toBe("out2");
        expect(st.getU64("stake_bal", b("credA"))).toBe(150n);
        st.commitBlock();
        // block 2 on top: spends in1, creates in3; block 2' as a fork of block 1: creates in9
        st.beginBlock(h(2), h(1), 20); st.del("utxo", b("in1")); st.put("utxo", b("in3"), b("out3")); st.addU64("stake_bal", b("credA"), -30n); st.commitBlock();
        expect([...st.range("utxo", b("in"))].map(([k, v]) => s(k) + "=" + s(v))).toEqual(["in2=out2", "in3=out3"]);
        expect(st.getU64("stake_bal", b("credA"))).toBe(120n);
        st.beginBlock(h(9), h(1), 20); st.put("utxo", b("in9"), b("out9")); st.commitBlock();
        // selected tip is the last committed (the fork); switch back to block 2
        expect([...st.range("utxo", b("in"))].map(([k]) => s(k))).toEqual(["in1", "in2", "in9"]);
        st.selectTip(h(2));
        expect([...st.range("utxo", b("in"))].map(([k]) => s(k))).toEqual(["in2", "in3"]);
        // snapshot is frozen
        const view = st.snapshot();
        // abort leaves nothing
        st.beginBlock(h(3), h(2), 30); st.put("utxo", b("inX"), b("x")); st.abortBlock();
        expect(st.get("utxo", b("inX"))).toBeUndefined();
        // promote block 1 (deeper than k=1 on the chain 2→1)
        const r = await st.promoteDeep(1);
        expect(r.promoted).toBe(1);
        expect(r.anchor!.slot).toBe(10);
        expect(st.env.read((t) => t.get("utxo", b("in0")))).toBeUndefined();
        expect(s(st.env.read((t) => t.get("utxo", b("in2"))))).toBe("out2");
        expect(st.env.read((t) => t.count("stake_bal"))).toBe(1);
        expect(st.getU64("stake_bal", b("credA"))).toBe(120n); // 150 stored, −30 in block 2's diff
        expect(s(view.get("utxo", b("in3")))).toBe("out3");
        // block 9 (fork off block 1) was dropped by promotion? no: promote only forgets promoted diffs; rollbackTo cleans branches
        expect(st.hasDiff(h(9))).toBe(true);
        expect(st.rollbackTo(h(2))).toBe(1); // drops the fork
        expect(st.hasDiff(h(9))).toBe(false);
        // a diff whose before-image no longer matches LMDB is refused on promote
        await expect(st.promote([h(2)])).resolves.toMatchObject({ promoted: 1 });
        st.beginBlock(h(4), h(2), 40); st.put("utxo", b("in3"), b("changed")); st.commitBlock(); // before = out3 (now in LMDB)
        await st.env.write((t) => t.put("utxo", b("in3"), b("tampered")));                       // someone else changed the stored value
        await expect(st.promote([h(4)])).rejects.toThrow(/before-image/);
        // persistence of the anchor
        st.close();
        const again = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024 });
        expect(again.anchor()!.slot).toBe(20);
        again.close();
    });
});

describe("LedgerStore persistence", () => {
    test("volatile diffs survive a reopen; other branches and torn files are dropped; chainReachesAnchor", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-p-")); tmp.push(dir);
        let st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.env.write((t) => { t.put("utxo", b("in0"), b("out0")); });
        await st.setAnchor({ slot: 0, hash: h(0) });
        st.beginBlock(h(1), h(0), 10); st.del("utxo", b("in0")); st.put("utxo", b("in1"), b("out1")); st.addU64("stake_bal", b("c"), 7n); st.commitBlock();
        st.beginBlock(h(2), h(1), 20); st.put("utxo", b("in2"), b("out2")); st.commitBlock();
        st.beginBlock(h(9), h(1), 20); st.put("utxo", b("in9"), b("out9")); st.commitBlock(); // fork
        expect(st.chainReachesAnchor(h(2))).toBe(true);
        expect(st.chainReachesAnchor(h(9))).toBe(true);
        expect(st.chainReachesAnchor(h(5))).toBe(false);
        expect(st.chainReachesAnchor(h(0))).toBe(true); // the anchor itself
        st.close();
        // a torn file from a crash
        await Bun.write(join(dir, "diffs", "ff".repeat(32) + ".diff"), new Uint8Array([1, 2, 3]));
        st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        expect(st.loadedDiffs).toBe(3);
        expect(st.chainReachesAnchor(h(2))).toBe(true);
        st.rollbackTo(h(2)); st.selectTip(h(2));
        expect(st.hasDiff(h(9))).toBe(false);
        expect(st.get("utxo", b("in0"))).toBeUndefined();
        expect(s(st.get("utxo", b("in2")))).toBe("out2");
        expect(st.getU64("stake_bal", b("c"))).toBe(7n);
        expect((await import("node:fs")).readdirSync(join(dir, "diffs")).sort()).toEqual([Buffer.from(h(1)).toString("hex") + ".diff", Buffer.from(h(2)).toString("hex") + ".diff"]);
        // promote deletes the files, the reopened store then has no diffs and the anchor at block 2
        await st.promoteDeep(0);
        expect((await import("node:fs")).readdirSync(join(dir, "diffs"))).toEqual([]);
        st.close();
        st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        expect(st.anchor()!.slot).toBe(20);
        expect(st.loadedDiffs).toBe(0);
        expect(st.chainReachesAnchor(h(2))).toBe(true);
        expect(st.chainReachesAnchor(h(1))).toBe(false);
        st.close();
    });
});

describe("LedgerStore read overlay", () => {
    test("randomized: reads equal a reference model through commits, forks, rollbacks, promotions and reopen", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-ov-")); tmp.push(dir);
        let st = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024 });
        let seed = 12345;
        const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
        const K = (i: number) => b(`k${i}`);
        type Model = { vals: Map<number, string>; ctr: Map<number, bigint> };
        const clone = (m: Model): Model => ({ vals: new Map(m.vals), ctr: new Map(m.ctr) });
        const models = new Map<string, Model>(); // block hash hex → state after it
        const parent = new Map<string, string>();
        const hx = (u: Uint8Array) => Buffer.from(u).toString("hex");
        await st.setAnchor({ slot: 0, hash: h(0) });
        const g = h(0); models.set(hx(g), { vals: new Map(), ctr: new Map() });
        let tip: Uint8Array = g, n = 1, anchor: Uint8Array = g;
        const check = (m: Model) => {
            for (let i = 0; i < 40; i++) {
                expect(s(st.get("v", K(i)))).toBe(m.vals.get(i));
                expect(st.getU64("c", K(i))).toBe(m.ctr.get(i) ?? 0n);
            }
        };
        for (let step = 0; step < 400; step++) {
            const r = rnd(100);
            if (r < 70) { // new block on the tip (or, 15 %, on the tip's parent: a fork)
                const base = r < 60 || !parent.has(hx(tip)) ? tip : Uint8Array.from(Buffer.from(parent.get(hx(tip))!, "hex"));
                if (!models.has(hx(base))) continue;
                st.selectTip(base);
                const hash = new Uint8Array(32); new DataView(hash.buffer).setUint32(0, ++n);
                const m = clone(models.get(hx(base))!);
                st.beginBlock(hash, base, n);
                for (let j = 0; j < 6; j++) {
                    const i = rnd(40), op = rnd(4);
                    if (op === 0) { st.put("v", K(i), b(`x${n}.${j}`)); m.vals.set(i, `x${n}.${j}`); }
                    else if (op === 1) { st.del("v", K(i)); m.vals.delete(i); }
                    else { const d = BigInt(rnd(50) + 1); st.addU64("c", K(i), d); m.ctr.set(i, (m.ctr.get(i) ?? 0n) + d); }
                }
                check(m); // reads inside the open block
                st.commitBlock();
                models.set(hx(hash), m); parent.set(hx(hash), hx(base)); tip = hash;
            } else if (r < 80 && parent.has(hx(tip))) { // roll back one block
                const p = Uint8Array.from(Buffer.from(parent.get(hx(tip))!, "hex"));
                if (!st.knows(p)) continue;
                st.rollbackTo(p); st.selectTip(p); tip = p;
            } else if (r < 90) { // promote k-deep (k = 5)
                await st.promoteDeep(5);
                anchor = st.anchor()!.hash;
            } else if (r < 93) { // reopen from disk (persisted diffs)
                st.close(); st = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024 }); st.rollbackTo(tip); st.selectTip(tip);
            }
            st.selectTip(tip);
            check(models.get(hx(tip))!);
        }
        void anchor;
        st.close();
    }, 120_000);
});

/**
 * Bug 245 (2026-09-30 reboot of the preview producer): after an unclean stop the node must land on
 * the newest block that both stores hold with a complete diff chain to the anchor, and a diff file
 * that is incomplete, or belongs to a block already promoted, must not count.
 */
describe("LedgerStore crash recovery (bug 245)", () => {
    const open = (dir: string) => LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
    /** Anchor at block 0; blocks 1..n on one chain, block i at slot 10·i creating in<i> and crediting c by i. */
    async function chainOf(n: number) {
        const dir = await mkdtemp(join(tmpdir(), "ledger-r-")); tmp.push(dir);
        const st = open(dir);
        await st.env.write((t) => { t.put("utxo", b("in0"), b("out0")); t.put("stake_bal", b("c"), u64(100n)); });
        await st.setAnchor({ slot: 0, hash: h(0) });
        for (let i = 1; i <= n; i++) { st.beginBlock(h(i), h(i - 1), i * 10); st.put("utxo", b(`in${i}`), b(`out${i}`)); st.addU64("stake_bal", b("c"), BigInt(i)); st.commitBlock(); }
        await st.flushDiffs(); // every block durable, as the node leaves them after a range (bug 380)
        return { dir, st };
    }
    const file = (dir: string, i: number) => join(dir, "diffs", Buffer.from(h(i)).toString("hex") + ".diff");
    /** The block store's chain, newest first, as the caller passes it (ending with its immutable tip). */
    const blocks = (...is: number[]) => is.map((i) => ({ slot: i * 10, hash: h(i) }));

    test("encoding: the trailer rejects a truncated, zero-filled or corrupted file; a legacy LDF1 body still loads", () => {
        const d = new LedgerDiff(h(1), h(0), 10); d.set("utxo", b("k"), b("v"), undefined); d.add("stake_bal", b("c"), 5n);
        const enc = encodeDiff(d);
        const back = decodeDiff(enc);
        expect(s(back.lookup("utxo", b("k"))!.value)).toBe("v"); expect(back.addDelta("stake_bal", b("c"))).toBe(5n); expect(back.slot).toBe(10);
        expect(() => decodeDiff(enc.subarray(0, enc.length - 1))).toThrow(/truncated/);   // cut short by one byte
        expect(() => decodeDiff(enc.subarray(0, 90))).toThrow(/truncated/);
        const zeroed = enc.slice(); zeroed.fill(0, 80); expect(() => decodeDiff(zeroed)).toThrow(); // right length, tail never reached the disk
        const flipped = enc.slice(); flipped[85]! ^= 1; expect(() => decodeDiff(flipped)).toThrow(/checksum/);
        const longer = new Uint8Array(enc.length + 1); longer.set(enc); expect(() => decodeDiff(longer)).toThrow(/truncated/);
        // a file written before the trailer existed: magic LDF1, body only
        const legacy = enc.slice(0, enc.length - 8); new DataView(legacy.buffer).setUint32(0, 0x4c444631, false);
        expect(decodeDiff(legacy).addDelta("stake_bal", b("c"))).toBe(5n);
        const legacyZero = legacy.slice(); legacyZero.fill(0, 80); expect(() => decodeDiff(legacyZero)).toThrow(/past the encoded body/);
        expect(() => decodeDiff(legacy.subarray(0, legacy.length - 3))).toThrow(/truncated/);
    });

    test("a kill between the block store's commit and the diff write: recovery lands on the parent, not the tip", async () => {
        const { dir, st } = await chainOf(3);
        st.close();
        rmSync(file(dir, 3)); // block 3 is in the block store; its diff never reached the disk
        const re = open(dir);
        expect(re.loadedDiffs).toBe(2); expect(re.tornDiffs).toBe(0); expect(re.staleDiffs).toBe(0);
        expect(re.chainReachesAnchor(h(3))).toBe(false);
        expect(re.chainGap(h(3))).toMatch(/no diff for the tip/);
        expect(re.recoveryTip(blocks(3, 2, 1, 0))).toEqual({ slot: 20, hash: h(2) });
        re.rollbackTo(h(2)); re.selectTip(h(2));
        expect(re.getU64("stake_bal", b("c"))).toBe(103n);
        expect(s(re.get("utxo", b("in2")))).toBe("out2");
        re.close();
    });

    test("a truncated diff file (kill mid-write) is absent: removed at open, recovery lands below it", async () => {
        const { dir, st } = await chainOf(3);
        st.close();
        truncateSync(file(dir, 3), 100);
        writeFileSync(file(dir, 9) + ".tmp", new Uint8Array(50)); // a write that never got to its rename
        const re = open(dir);
        expect(re.tornDiffs).toBe(1); expect(re.loadedDiffs).toBe(2);
        expect(existsSync(file(dir, 3))).toBe(false);
        expect(readdirSync(join(dir, "diffs")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
        expect(re.chainReachesAnchor(h(2))).toBe(true);
        expect(re.recoveryTip(blocks(3, 2, 1, 0))).toEqual({ slot: 20, hash: h(2) });
        re.close();
    });

    test("the persisted tip ahead of the diffs: back to the newest block with a complete chain, or to the anchor", async () => {
        const { dir, st } = await chainOf(4);
        st.close();
        rmSync(file(dir, 4)); rmSync(file(dir, 3)); // the block store's tip is two blocks past the last diff
        let re = open(dir);
        expect(re.recoveryTip(blocks(4, 3, 2, 1, 0))).toEqual({ slot: 20, hash: h(2) });
        re.close();
        rmSync(file(dir, 1)); // a gap below as well: block 2's diff is there but its chain is broken
        re = open(dir);
        expect(re.hasDiff(h(2))).toBe(true);
        expect(re.chainReachesAnchor(h(2))).toBe(false);
        expect(re.chainGap(h(2))).toMatch(/no diff for 0100/);
        expect(re.recoveryTip(blocks(4, 3, 2))).toBeNull();                         // nothing volatile reaches the anchor
        expect(re.recoveryTip(blocks(4, 3, 2, 0))).toEqual({ slot: 0, hash: h(0) }); // the block store's immutable tip = the anchor
        expect(re.rollbackTo(h(0))).toBe(1); re.selectTip(h(0));
        expect(re.getU64("stake_bal", b("c"))).toBe(100n);
        expect(readdirSync(join(dir, "diffs"))).toEqual([]);
        re.close();
    });

    test("2026-09-30 incident: a promoted block's diff file survived the crash (LMDB commit durable, unlink lost)", async () => {
        const { dir, st } = await chainOf(4);
        const saved = [1, 2].map((i) => readFileSync(file(dir, i)));
        await st.promoteDeep(2); // anchor → block 2: diffs 1 and 2 applied to LMDB, their files removed
        expect(st.anchor()!.slot).toBe(20);
        st.close();
        writeFileSync(file(dir, 1), saved[0]!); writeFileSync(file(dir, 2), saved[1]!); // the unlinks never reached the disk
        const re = open(dir);
        expect(re.staleDiffs).toBe(2); expect(re.loadedDiffs).toBe(2);
        expect(existsSync(file(dir, 1))).toBe(false); expect(existsSync(file(dir, 2))).toBe(false);
        expect(re.chainReachesAnchor(h(4))).toBe(true); // the old check walked through the anchor's own diff to a parent without one
        expect(re.recoveryTip(blocks(4, 3, 2))).toEqual({ slot: 40, hash: h(4) });
        re.selectTip(h(4));
        expect(re.getU64("stake_bal", b("c"))).toBe(110n); // 100 + 1 + 2 in LMDB, + 3 + 4 volatile: nothing counted twice
        expect(s(re.get("utxo", b("in2")))).toBe("out2");
        expect([...re.range("utxo", b("in"))].map(([k]) => s(k))).toEqual(["in0", "in1", "in2", "in3", "in4"]);
        await re.promoteDeep(0); // the stale diffs are gone, so promotion extends the anchor cleanly
        expect(re.anchor()!.slot).toBe(40);
        expect(re.getU64("stake_bal", b("c"))).toBe(110n);
        re.close();
    });
});

/**
 * Bug 380: the diffs are made durable once per applied range (`flushDiffs`) instead of once per block.
 * Until its flush a block's diff exists only as `<hash>.diff.tmp`; a crash inside a batch must leave
 * the store recoverable at the newest block whose diffs reach the anchor, exactly as bug 245 requires.
 */
describe("LedgerStore batched diff durability (bug 380)", () => {
    const open = (dir: string) => LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
    const hx = (i: number) => Buffer.from(h(i)).toString("hex");
    const file = (dir: string, i: number) => join(dir, "diffs", hx(i) + ".diff");
    const blocks = (...is: number[]) => is.map((i) => ({ slot: i * 10, hash: h(i) }));
    const commit = (st: LedgerStore, i: number) => { st.beginBlock(h(i), h(i - 1), i * 10); st.put("utxo", b(`in${i}`), b(`out${i}`)); st.addU64("stake_bal", b("c"), BigInt(i)); st.commitBlock(); };
    /** Anchor at block 0 (c = 100); blocks 1..flushed committed and flushed, then flushed+1..n committed (one open batch). */
    async function batchOf(flushed: number, n: number) {
        const dir = await mkdtemp(join(tmpdir(), "ledger-b-")); tmp.push(dir);
        const st = open(dir);
        await st.env.write((t) => { t.put("utxo", b("in0"), b("out0")); t.put("stake_bal", b("c"), u64(100n)); });
        await st.setAnchor({ slot: 0, hash: h(0) });
        for (let i = 1; i <= flushed; i++) commit(st, i);
        expect(await st.flushDiffs()).toBe(flushed);
        for (let i = flushed + 1; i <= n; i++) commit(st, i);
        return { dir, st };
    }
    const files = (dir: string) => readdirSync(join(dir, "diffs")).sort();
    const sumTo = (i: number) => 100n + BigInt((i * (i + 1)) / 2);

    test("a batch is temp files until its flush; the flush renames them (each decodes) and leaves no temp file", async () => {
        const { dir, st } = await batchOf(2, 5);
        expect(st.pendingDiffs()).toBe(3);
        expect(files(dir)).toEqual([hx(1) + ".diff", hx(2) + ".diff", hx(3) + ".diff.tmp", hx(4) + ".diff.tmp", hx(5) + ".diff.tmp"].sort());
        expect(st.getU64("stake_bal", b("c"))).toBe(sumTo(5)); // reads never depend on the disk
        expect(await st.flushDiffs()).toBe(3);
        expect(await st.flushDiffs()).toBe(0);
        expect(st.pendingDiffs()).toBe(0);
        expect(files(dir)).toEqual([1, 2, 3, 4, 5].map((i) => hx(i) + ".diff").sort());
        for (let i = 1; i <= 5; i++) expect(decodeDiff(new Uint8Array(readFileSync(file(dir, i)))).slot).toBe(i * 10);
        st.close();
    });

    test("a kill inside a batch (nothing of it flushed): temp files swept, recovery lands on the last flushed block", async () => {
        const { dir, st } = await batchOf(3, 7);
        st.close({ flush: false });
        const re = open(dir);
        expect(re.loadedDiffs).toBe(3); expect(re.tornDiffs).toBe(0);
        expect(files(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
        expect(re.chainGap(h(7))).toMatch(/no diff for the tip/);
        expect(re.recoveryTip(blocks(7, 6, 5, 4, 3, 2, 1, 0))).toEqual({ slot: 30, hash: h(3) }); // the block store holds the whole batch
        re.rollbackTo(h(3)); re.selectTip(h(3));
        expect(re.getU64("stake_bal", b("c"))).toBe(sumTo(3));
        expect(re.get("utxo", b("in4"))).toBeUndefined();
        // the network re-sends the batch: it applies again on top of the recovered block
        for (let i = 4; i <= 7; i++) commit(re, i);
        await re.flushDiffs();
        expect(re.getU64("stake_bal", b("c"))).toBe(sumTo(7));
        await re.promoteDeep(2);
        expect(re.anchor()!.slot).toBe(50);
        expect(re.getU64("stake_bal", b("c"))).toBe(sumTo(7));
        re.close();
    });

    test("a kill during the flush: renames that reached the disk without their data (zeroed / truncated / empty) count as absent", async () => {
        const { dir, st } = await batchOf(2, 6);
        const enc = [3, 4, 5, 6].map((i) => readFileSync(join(dir, "diffs", hx(i) + ".diff.tmp")));
        st.close({ flush: false });
        // the directory updates (renames) of 3..6 reached the disk, the data only partly: 3 complete,
        // 4 zero-filled at its full length, 5 complete, 6 truncated; a stray temp of 6 as well
        for (const i of [3, 4, 5, 6]) rmSync(join(dir, "diffs", hx(i) + ".diff.tmp"));
        writeFileSync(file(dir, 3), enc[0]!);
        writeFileSync(file(dir, 4), new Uint8Array(enc[1]!.length));
        writeFileSync(file(dir, 5), enc[2]!);
        writeFileSync(file(dir, 6), enc[3]!.subarray(0, enc[3]!.length >> 1));
        writeFileSync(join(dir, "diffs", hx(6) + ".diff.tmp"), enc[3]!);
        let re = open(dir);
        expect(re.tornDiffs).toBe(2); expect(re.loadedDiffs).toBe(4); // 1, 2, 3, 5
        expect(re.hasDiff(h(5))).toBe(true);
        expect(re.chainReachesAnchor(h(5))).toBe(false); // 5's chain is broken at 4
        expect(re.recoveryTip(blocks(6, 5, 4, 3, 2, 1, 0))).toEqual({ slot: 30, hash: h(3) });
        re.rollbackTo(h(3)); re.selectTip(h(3));
        expect(re.getU64("stake_bal", b("c"))).toBe(sumTo(3));
        expect(files(dir)).toEqual([1, 2, 3].map((i) => hx(i) + ".diff").sort()); // 5 (a dead branch now) dropped
        re.close();
        // an empty file under the final name (rename durable, no data block allocated) — the same
        writeFileSync(file(dir, 3), new Uint8Array(0));
        re = open(dir);
        expect(re.tornDiffs).toBe(1);
        expect(re.recoveryTip(blocks(3, 2, 1, 0))).toEqual({ slot: 20, hash: h(2) });
        re.close();
    });

    test("a rename lost out of order (a later block's file on disk, an earlier one's not): recovery stops below the gap", async () => {
        const { dir, st } = await batchOf(1, 4);
        await st.flushDiffs();
        st.close();
        rmSync(file(dir, 2)); // its directory entry never reached the disk; 3 and 4 did
        const re = open(dir);
        expect(re.recoveryTip(blocks(4, 3, 2, 1, 0))).toEqual({ slot: 10, hash: h(1) });
        re.close();
    });

    test("diffs dropped before or during a flush are not resurrected; a block rewritten meanwhile stays pending", async () => {
        const { dir, st } = await batchOf(1, 6);
        const flushing = st.flushDiffs(); // in flight: its fsyncs are awaited
        expect(st.rollbackTo(h(4))).toBe(2); // 5, 6 dropped while the flush runs
        expect(st.dropDiffs([h(4)])).toBe(1); // an aborted range's block
        st.selectTip(h(3));
        await flushing;
        expect(files(dir)).toEqual([1, 2, 3].map((i) => hx(i) + ".diff").sort());
        // dropped while pending, then re-applied (a retried range): the new diff is pending again and flushes
        commit(st, 4);
        expect(st.pendingDiffs()).toBe(1);
        const f2 = st.flushDiffs();
        st.rollbackTo(h(3)); st.selectTip(h(3)); commit(st, 4); // dropped and rewritten while the flush runs
        await f2;
        expect(st.pendingDiffs()).toBe(1);
        expect(files(dir)).toContain(hx(4) + ".diff.tmp");
        await st.flushDiffs();
        expect(files(dir)).toEqual([1, 2, 3, 4].map((i) => hx(i) + ".diff").sort());
        st.close();
        const re = open(dir);
        expect(re.loadedDiffs).toBe(4);
        expect(re.recoveryTip(blocks(4, 3, 2, 1, 0))).toEqual({ slot: 40, hash: h(4) });
        re.selectTip(h(4));
        expect(re.getU64("stake_bal", b("c"))).toBe(sumTo(4));
        re.close();
    });

    test("promotion, a direct LMDB write and close flush first; promoted pending diffs leave no file", async () => {
        const { dir, st } = await batchOf(0, 4);
        expect(st.pendingDiffs()).toBe(4);
        await st.promoteDeep(2); // 1, 2 promoted; 3, 4 made durable before LMDB moved
        expect(st.pendingDiffs()).toBe(0);
        expect(files(dir)).toEqual([3, 4].map((i) => hx(i) + ".diff").sort());
        commit(st, 5);
        await st.applyDirect(() => { st.put("meta2", b("k"), b("v")); });
        expect(st.pendingDiffs()).toBe(0);
        commit(st, 6);
        st.applyDirectSync(() => { st.put("meta2", b("k2"), b("v2")); });
        expect(st.pendingDiffs()).toBe(0);
        commit(st, 7);
        st.close(); // a clean stop leaves nothing pending
        const re = open(dir);
        expect(re.loadedDiffs).toBe(5);
        expect(re.recoveryTip(blocks(7, 6, 5, 4, 3, 2))).toEqual({ slot: 70, hash: h(7) });
        re.selectTip(h(7));
        expect(re.getU64("stake_bal", b("c"))).toBe(sumTo(7));
        re.close();
    });

    test("--ledger-diff-fsync none and block write final files at once (nothing pending)", async () => {
        let restore = () => {};
        try {
            for (const v of ["none", "block"] as const) {
                restore(); restore = withSettings({ ledgerDiffFsync: v });
                const { dir, st } = await batchOf(0, 3);
                expect(st.pendingDiffs()).toBe(0);
                expect(files(dir)).toEqual([1, 2, 3].map((i) => hx(i) + ".diff").sort());
                st.close({ flush: false });
                expect(open(dir).recoveryTip(blocks(3, 2, 1, 0))).toEqual({ slot: 30, hash: h(3) });
            }
        } finally { restore(); }
    });
});

describe("LedgerStore chain cache (bug 381)", () => {
    test("chainReachesAnchor / viewAt / promoteDeep through the overlay's chain agree with a fresh walk across commits, forks, rollbacks and promotions", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ledger-cc-")); tmp.push(dir);
        let st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const fresh = () => LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024, readOnly: true });
        const c = (i: number, p: number) => { st.beginBlock(h(i), h(p), i * 10); st.addU64("stake_bal", b("c"), BigInt(i)); st.commitBlock(); };
        c(1, 0); c(2, 1); c(3, 2);
        expect(st.getU64("stake_bal", b("c"))).toBe(6n); // overlay on 3
        expect(st.chainReachesAnchor(h(3))).toBe(true);
        c(9, 2); // a fork: the overlay follows 9
        expect(st.chainReachesAnchor(h(3))).toBe(true);
        expect(st.viewAt(h(9))!.getU64("stake_bal", b("c"))).toBe(12n);
        expect(st.viewAt(h(3))!.getU64("stake_bal", b("c"))).toBe(6n);
        st.rollbackTo(h(2)); st.selectTip(h(2));
        expect(st.chainReachesAnchor(h(9))).toBe(false); // the cached chain must not keep a dropped diff
        expect(st.chainReachesAnchor(h(2))).toBe(true);
        c(4, 2); c(5, 4);
        expect(st.getU64("stake_bal", b("c"))).toBe(12n);
        await st.promoteDeep(1); // anchor → 4
        expect(st.anchor()!.slot).toBe(40);
        expect(st.chainReachesAnchor(h(5))).toBe(true);
        expect(st.chainReachesAnchor(h(2))).toBe(false); // promoted: below the anchor
        expect(st.viewAt(h(5))!.depth).toBe(1);
        expect(st.getU64("stake_bal", b("c"))).toBe(12n);
        await st.setAnchor({ slot: 50, hash: h(5) }); // an importer moving the anchor: the overlay must not survive it
        expect(st.chainReachesAnchor(h(5))).toBe(true);
        expect(st.viewAt(h(5))!.depth).toBe(0);
        st.close();
        st = fresh(); expect(st.anchor()!.slot).toBe(50); st.close();
    });
});
