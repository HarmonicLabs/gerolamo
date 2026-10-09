import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { LedgerStore } from "./LedgerStore";
import { UtxoReads, UtxoWrites, decodeRow, keyRef } from "./utxoStore";
import { addressParts, assetPrefix, backfillUtxoIndex, credPrefix, datumPrefix, DB_IDX, IDX_DELEGATION, IDX_MARKER, IDX_PAYMENT, markUtxoIndexBuilt, setUtxoIndexEnabled, shelleyAddressBytes } from "./utxoIndex";
import { addressBech32, baseAddressBytes } from "../pool/operator";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
const un = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const PAY = "aa".repeat(28), STK = "bb".repeat(28), ENT = "cc".repeat(28), POLICY = "dd".repeat(28);
const BASE = addressBech32(baseAddressBytes(0, un(PAY), un(STK)));
const ENTERPRISE = addressBech32(Uint8Array.of(0x60, ...un(ENT)));
const BYRON = "FHnt4NL7yPXhCzCHVywZLqVsvwuG3HvwmjKXQJBrXh3h2aigv6uxkePbpzRNV8q"; // base58, no credential parts
const DATUM = "d8799f01ff";
const TX1 = "11".repeat(32), TX2 = "22".repeat(32);
const row = (ref: string, address: string, extra: Record<string, unknown> = {}) => {
    const json = JSON.stringify({ address, amount: "2000000", assets: {}, ...extra });
    return { utxo_ref: ref, tx_out: json, tx_hash: ref.slice(0, 64), address, lovelace: "2000000", reference_script_hash: null, stake_key: null };
};
const refs = (keys: Uint8Array[]) => keys.map((k) => keyRef(k)).sort();
const allIndexKeys = (st: LedgerStore) => [...st.range(DB_IDX, new Uint8Array(0))].map(([k]) => Buffer.from(k).toString("hex")).filter((k) => !k.startsWith("00")).sort();

describe("UTxO search indexes (payment, delegation, asset, datum)", () => {
    test("address parts: base, enterprise, Byron", () => {
        const base = addressParts(shelleyAddressBytes(BASE));
        expect(Buffer.from(base.payment!).toString("hex")).toBe(PAY);
        expect(Buffer.from(base.delegation!).toString("hex")).toBe(STK);
        const ent = addressParts(shelleyAddressBytes(ENTERPRISE));
        expect(Buffer.from(ent.payment!).toString("hex")).toBe(ENT);
        expect(ent.delegation).toBeNull();
        expect(shelleyAddressBytes(BYRON)).toBeNull();
    });

    test("kept with every put and spend, undone by a rollback, rebuilt identically by the backfill", async () => {
        const dir = await mkdtemp(join(tmpdir(), "utxo-idx-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 256 * 1024 * 1024 });
        const w = new UtxoWrites(st), rd = new UtxoReads(st);
        st.beginBlock(h(1), null, 10);
        w.put(row(`${TX1}:0`, BASE, { assets: { [POLICY]: { "6161": "5", "6262": "1" } } }));
        w.put(row(`${TX1}:1`, ENTERPRISE, { inline_datum: DATUM }));
        w.put(row(`${TX1}:2`, BYRON));
        w.put(row(`${TX1}:3`, ENTERPRISE, { datum_hash: "ee".repeat(32) }));
        st.commitBlock();
        await st.promoteDeep(0); // block 1 into LMDB
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(PAY))))).toEqual([`${TX1}:0`]);
        expect(refs(rd.indexRefKeys(credPrefix(IDX_DELEGATION, un(STK))))).toEqual([`${TX1}:0`]);
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(ENT))))).toEqual([`${TX1}:1`, `${TX1}:3`]);
        expect(refs(rd.indexRefKeys(assetPrefix(un(POLICY))))).toEqual([`${TX1}:0`, `${TX1}:0`]); // one key per asset
        expect(refs(rd.indexRefKeys(assetPrefix(un(POLICY), un("6262"))))).toEqual([`${TX1}:0`]);
        expect(refs(rd.indexRefKeys(datumPrefix(blake2b_256(un(DATUM)))))).toEqual([`${TX1}:1`]);
        expect(refs(rd.indexRefKeys(datumPrefix(un("ee".repeat(32)))))).toEqual([`${TX1}:3`]);

        // block 2 (volatile) spends the asset output and creates one at the base address
        st.beginBlock(h(2), h(1), 20);
        w.del([`${TX1}:0`]);
        w.put(row(`${TX2}:0`, BASE));
        st.commitBlock();
        expect(refs(rd.indexRefKeys(assetPrefix(un(POLICY))))).toEqual([]);
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(PAY))))).toEqual([`${TX2}:0`]);
        const withBlock2 = allIndexKeys(st);

        // a fork block spending TX2:0, rolled back
        st.beginBlock(h(3), h(2), 30); w.del([`${TX2}:0`]); st.commitBlock();
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(PAY))))).toEqual([]);
        st.rollbackTo(h(2));
        expect(allIndexKeys(st)).toEqual(withBlock2);

        // a store from before the indexes: drop them from LMDB and from block 2's view, then backfill
        st.env.writeSync((t) => t.clear(DB_IDX));
        st.rollbackTo(h(1)); // block 2's diff (with its index writes) leaves …
        st.beginBlock(h(2), h(1), 20); // … and comes back written "by an old binary": spend and create, no index keys
        st.put("utxo", Uint8Array.from([...un(TX2), 0, 0]), (await import("./utxoStore")).encodeRow(row(`${TX2}:0`, BASE)));
        st.del("utxo", Uint8Array.from([...un(TX1), 0, 0]));
        st.commitBlock();
        expect(allIndexKeys(st)).toEqual([]);
        const n = backfillUtxoIndex(st, (k, v) => decodeRow(keyRef(k), v), { batch: 2 });
        expect(n).toBe(5); // 4 outputs in LMDB (the spent one included: its key reads as nothing) + 1 created in the volatile block
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(PAY)))).filter((r) => rd.get(r))).toEqual([`${TX2}:0`]);
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(ENT))))).toEqual([`${TX1}:1`, `${TX1}:3`]);
        expect(st.env.read((t) => t.get(DB_IDX, IDX_MARKER))).toBeDefined();
        expect(backfillUtxoIndex(st, (k, v) => decodeRow(keyRef(k), v))).toBeNull(); // once
        // GEROLAMO_UTXO_INDEX=0: no index writes, the marker goes, a later start rebuilds what is missing
        setUtxoIndexEnabled(false);
        try {
            expect(backfillUtxoIndex(st, (k, v) => decodeRow(keyRef(k), v))).toBeNull();
            expect(st.env.read((t) => t.get(DB_IDX, IDX_MARKER))).toBeUndefined();
            st.beginBlock(h(4), h(2), 40); w.put(row(`${"44".repeat(32)}:0`, ENTERPRISE)); st.commitBlock();
            expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(ENT))))).toEqual([`${TX1}:1`, `${TX1}:3`]);
        } finally { setUtxoIndexEnabled(true); }
        expect(backfillUtxoIndex(st, (k, v) => decodeRow(keyRef(k), v))).toBe(6);
        expect(refs(rd.indexRefKeys(credPrefix(IDX_PAYMENT, un(ENT))))).toEqual([`${TX1}:1`, `${TX1}:3`, `${"44".repeat(32)}:0`]);
        st.close();
    });

    test("an import into an empty store marks the indexes complete (no backfill scan at the next start)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "utxo-idx-import-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        st.applyDirectSync(() => new UtxoWrites(st).put(row(`${TX1}:0`, ENTERPRISE)));
        markUtxoIndexBuilt(st);
        expect(backfillUtxoIndex(st, (k, v) => decodeRow(keyRef(k), v))).toBeNull();
        expect(refs(new UtxoReads(st).indexRefKeys(credPrefix(IDX_PAYMENT, un(ENT))))).toEqual([`${TX1}:0`]);
        st.close();
    });

    test("per-output cost of the index writes (10 000 outputs with an asset each)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "utxo-idx-cost-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 512 * 1024 * 1024 });
        const w = new UtxoWrites(st);
        const t0 = performance.now();
        st.beginBlock(h(1), null, 10);
        for (let i = 0; i < 10_000; i++) {
            const id = Buffer.alloc(32); id.writeUInt32BE(i, 0);
            w.put(row(`${id.toString("hex")}:0`, BASE, { assets: { [POLICY]: { "6161": "1" } } }));
        }
        st.commitBlock();
        const ms = performance.now() - t0;
        console.log(`10 000 puts with indexes: ${ms.toFixed(0)} ms (${((ms * 1000) / 10_000).toFixed(1)} µs per output)`);
        expect(ms).toBeLessThan(20_000);
        st.close();
    });
});
