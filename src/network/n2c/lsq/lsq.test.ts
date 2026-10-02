import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { LedgerStore } from "../../../ledger/LedgerStore";
import { u64 } from "../../../ledger/LedgerDiff";
import { CborWriter, reduced } from "./cborWriter";
import { applyTxBody, type GovFacts } from "./govIndex";
import { parseGovKey } from "./govAdapter";
import { ledgerTxOutBytes } from "./txOut";
import { normalizePoolParams } from "./queries";
import { ACQUIRE_POINT_NOT_ON_CHAIN, ACQUIRE_POINT_TOO_OLD, PointView, resolveAcquireTarget } from "./view";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });

describe("CborWriter", () => {
    test("minimal integer heads, bignum above 2^64, negative ints", () => {
        const w = new CborWriter();
        w.uint(23).uint(24).uint(255).uint(256).uint(65535).uint(65536).uint(2n ** 32n).uint(2n ** 64n).int(-1);
        expect(hex(w.finish())).toBe("17" + "1818" + "18ff" + "190100" + "19ffff" + "1a00010000" + "1b0000000100000000" + "c249010000000000000000" + "20");
    });
    test("ledger list/map rule: definite up to 23 entries, indefinite beyond; sets tagged", () => {
        const small = new CborWriter().list([1, 2], (x) => x).finish();
        expect(hex(small)).toBe("82");
        const w = new CborWriter(); w.list(Array.from({ length: 24 }, (_, i) => i), (i) => w.uint(i));
        const b = w.finish(); expect(b[0]).toBe(0x9f); expect(b[b.length - 1]).toBe(0xff);
        const m = new CborWriter(); m.mapOf(Array.from({ length: 24 }, (_, i) => [i, i] as const), (k) => m.uint(k), (v) => m.uint(v));
        expect(m.finish()[0]).toBe(0xbf);
        const s = new CborWriter(); s.set([1], (x) => s.uint(x)); expect(hex(s.finish())).toBe("d901028101");
        const d = new CborWriter(); d.setDefinite(Array.from({ length: 30 }, (_, i) => i), (i) => d.uint(i)); expect(hex(d.finish().subarray(0, 5))).toBe("d90102981e");
    });
    test("rationals reduce like Haskell's %", () => {
        expect(reduced(0n, 1000000n)).toEqual([0n, 1n]);
        expect(reduced(13492420330n, 26984840660n)).toEqual([1n, 2n]);
    });
});

describe("pool parameters as the ledger re-encodes them", () => {
    test("an unreduced margin and an indefinite relay list are normalised; the rest is verbatim", () => {
        const w = new CborWriter();
        w.array(9).hex("11".repeat(28)).hex("22".repeat(32)).uint(5_000_000_000).uint(170_000_000).rational(0n, 1_000_000n).hex("e0" + "33".repeat(28)).tag(258).array(1).hex("33".repeat(28));
        w.arrayIndef().array(4).uint(0).uint(3001).hex("3f2d2150").null().brk();
        w.null();
        const out = normalizePoolParams(w.finish());
        const e = new CborWriter();
        e.array(9).hex("11".repeat(28)).hex("22".repeat(32)).uint(5_000_000_000).uint(170_000_000).rational(0n, 1n).hex("e0" + "33".repeat(28)).tag(258).array(1).hex("33".repeat(28));
        e.array(1).array(4).uint(0).uint(3001).hex("3f2d2150").null();
        e.null();
        expect(hex(out)).toBe(hex(e.finish()));
    });
});

describe("TxOut in the ledger's compact forms", () => {
    const ADDR = "addr_test1wzq6xa0xug63xmxnx6edzpczla4vr2a2ew5a5uq7wc5cwuc7m6spp";
    test("plain output: [address, coin]; datum hash: [address, value, hash]", () => {
        expect(hex(ledgerTxOutBytes({ address: ADDR, amount: "2544777" })!).slice(0, 4)).toBe("8258");
        const dh = ledgerTxOutBytes({ address: ADDR, amount: "1", datum_hash: "ab".repeat(32) })!;
        expect(dh[0]).toBe(0x83);
    });
    test("multi-asset value: policies and names in byte order, lovelace under the empty policy ignored", () => {
        const out = ledgerTxOutBytes({ address: ADDR, amount: "5", assets: { "": { "": "5" }, bb: { "02": "1", "01": "2" }, aa: { "ff": "3" } } })!;
        expect(hex(out).endsWith("8205" + "a2" + "41aa" + "a141ff03" + "41bb" + "a2410102410201")).toBe(true);
    });
    test("inline datum or reference script: map form", () => {
        const out = ledgerTxOutBytes({ address: ADDR, amount: "1", inline_datum: "d87980", reference_script_cbor: "8200" + "41" + "00" })!;
        expect(out[0]).toBe(0xa4);
        expect(hex(out)).toContain("028201d81843d87980");
    });
});

describe("governance facts from transaction bodies", () => {
    const facts = (): GovFacts => ({ drepAnchor: new Map(), proposal: new Map(), credType: new Map(), ccResign: new Map(), stakeDeposit: new Map() });
    const cred = (w: CborWriter, t: number, h: string) => w.array(2).uint(t).hex(h);
    const anchor = (w: CborWriter, url: string) => w.array(2).text(url).hex("cd".repeat(32));
    test("DRep registration / update / retirement, committee authorisation and resignation, deposits, proposals", () => {
        const f = facts();
        const d = "d1".repeat(28), cold = "c0".repeat(28), hot = "a0".repeat(28), stake = "5a".repeat(28);
        const body = new CborWriter();
        body.map(2).uint(4).array(4);
        body.array(4).uint(16); cred(body, 0, d); body.uint(500_000_000); anchor(body, "https://a");
        body.array(3).uint(14); cred(body, 1, cold); cred(body, 0, hot);
        body.array(3).uint(7); cred(body, 1, stake); body.uint(2_000_000);
        body.array(3).uint(15); cred(body, 1, cold); body.null();
        body.uint(20).array(1).array(4).uint(1_000_000_000).hex("e0" + "11".repeat(28)).array(1).uint(6); anchor(body, "ipfs://p");
        const b1 = body.finish();
        applyTxBody(f, b1);
        expect(f.drepAnchor.get(`0:${d}`)).toBeInstanceOf(Uint8Array);
        expect(f.credType.get(cold)).toBe(1);
        expect(f.credType.get(hot)).toBe(0);
        expect(f.stakeDeposit.get("01" + stake)).toBe(2_000_000n);
        expect(f.ccResign.has(`1:${cold}`)).toBe(true);
        expect(f.ccResign.get(`1:${cold}`)).toBeNull();
        expect([...f.proposal.keys()]).toEqual([`${hex(blake2b_256(b1))}:0`]);
        // update without anchor, then retirement
        const b2 = new CborWriter(); b2.map(1).uint(4).array(2); b2.array(3).uint(18); cred(b2, 0, d); b2.null(); b2.array(3).uint(8); cred(b2, 1, stake); b2.uint(2_000_000);
        applyTxBody(f, b2.finish());
        expect(f.drepAnchor.get(`0:${d}`)).toBeNull();
        expect(f.stakeDeposit.has("01" + stake)).toBe(false);
        const b3 = new CborWriter(); b3.map(1).uint(4).array(1).array(3).uint(17); cred(b3, 0, d); b3.uint(500_000_000);
        applyTxBody(f, b3.finish());
        expect(f.drepAnchor.has(`0:${d}`)).toBe(false);
    });
    test("gov store keys: bare, typed and tagged forms", () => {
        const h = "ab".repeat(28);
        expect(parseGovKey(h, () => 1)).toEqual({ type: 1, hash: h });
        expect(parseGovKey("01" + h, () => 0)).toEqual({ type: 1, hash: h });
        expect(parseGovKey("0:" + h, () => 1)).toEqual({ type: 0, hash: h });
    });
});

describe("acquiring a point of the ledger store", () => {
    const b = (s: string) => new TextEncoder().encode(s);
    const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
    test("volatile blocks answer with their own state; older points are too old, others not on the chain", async () => {
        const dir = await mkdtemp(join(tmpdir(), "lsq-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024, persistDiffs: false });
        await st.env.write((t) => { t.put("utxo", b("a"), b("1")); t.put("stake_bal", b("k"), u64(10n)); });
        await st.setAnchor({ slot: 100, hash: h(1) });
        st.beginBlock(h(2), h(1), 110); st.put("utxo", b("b"), b("2")); st.addU64("stake_bal", b("k"), 5n); st.commitBlock(false);
        st.beginBlock(h(3), h(2), 120); st.del("utxo", b("a")); st.addU64("stake_bal", b("k"), 7n); st.commitBlock(false);
        st.beginBlock(h(9), h(2), 125); st.put("utxo", b("z"), b("9")); st.commitBlock(false); // a fork
        st.selectTip(h(3));
        const at = (slot: number, n: number) => resolveAcquireTarget(st, { kind: "point", slot: BigInt(slot), hash: hex(h(n)) });
        const past = at(110, 2);
        if ("failure" in past) throw new Error("expected block 2");
        const pv = new PointView(st, past.chain);
        expect([...pv.range("utxo", new Uint8Array(0))].map(([k]) => new TextDecoder().decode(k))).toEqual(["a", "b"]);
        expect(pv.getU64("stake_bal", b("k"))).toBe(15n);
        const tip = resolveAcquireTarget(st, { kind: "volatile" });
        if ("failure" in tip) throw new Error("expected the tip");
        const tv = new PointView(st, tip.chain);
        expect(tv.get("utxo", b("a"))).toBeUndefined();
        expect(tv.getU64("stake_bal", b("k"))).toBe(22n);
        const imm = resolveAcquireTarget(st, { kind: "immutable" });
        expect("failure" in imm ? -1 : imm.wantHex).toBe(hex(h(1)));
        expect(at(100, 1)).not.toHaveProperty("failure");
        expect(at(125, 9)).toEqual({ failure: ACQUIRE_POINT_NOT_ON_CHAIN }); // fork block
        expect(at(99, 7)).toEqual({ failure: ACQUIRE_POINT_TOO_OLD });      // below the anchor, whatever the hash
        expect(at(130, 7)).toEqual({ failure: ACQUIRE_POINT_NOT_ON_CHAIN });
        expect(resolveAcquireTarget(st, { kind: "origin" })).toEqual({ failure: ACQUIRE_POINT_TOO_OLD });
        st.close();
    });
});
