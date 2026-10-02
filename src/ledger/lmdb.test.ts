import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LmdbEnv } from "./lmdb";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array) => new TextDecoder().decode(u);

describe("LmdbEnv", () => {
    test("put/get/del, count, range with prefix and reverse, abort on throw, persistence, read-only reopen", async () => {
        const dir = await mkdtemp(join(tmpdir(), "lmdb-")); tmp.push(dir);
        const env = LmdbEnv.open(dir, { mapSize: 256 * 1024 * 1024, maxDbs: 8 });
        await env.write((t) => { t.put("utxo", b("a1"), b("v1")); t.put("utxo", b("a2"), b("v2")); t.put("utxo", b("b1"), b("v3")); t.put("stake", b("k"), b("s")); });
        expect(s(env.read((t) => t.get("utxo", b("a2")))!)).toBe("v2");
        expect(env.read((t) => t.get("utxo", b("zz")))).toBeUndefined();
        expect(env.read((t) => t.get("missing-db", b("x")))).toBeUndefined();
        expect(env.read((t) => t.count("utxo"))).toBe(3);
        expect(env.read((t) => [...t.range("utxo", { prefix: b("a") })].map(([k, v]) => s(k) + "=" + s(v)))).toEqual(["a1=v1", "a2=v2"]);
        expect(env.read((t) => [...t.range("utxo", { from: b("a2") })].map(([k]) => s(k)))).toEqual(["a2", "b1"]);
        expect(env.read((t) => [...t.range("utxo", { reverse: true, limit: 2 })].map(([k]) => s(k)))).toEqual(["b1", "a2"]);
        // abort on throw leaves the previous state
        await expect(env.write((t) => { t.put("utxo", b("c1"), b("x")); throw new Error("boom"); })).rejects.toThrow("boom");
        expect(env.read((t) => t.count("utxo"))).toBe(3);
        // serialised writers
        await Promise.all([env.write((t) => t.put("utxo", b("d1"), b("1"))), env.write((t) => t.put("utxo", b("d2"), b("2")))]);
        expect(env.read((t) => t.count("utxo"))).toBe(5);
        expect(await env.write((t) => t.del("utxo", b("d1")))).toBe(true);
        expect(await env.write((t) => t.del("utxo", b("d1")))).toBe(false);
        // values are copies: mutating a returned buffer does not touch the store
        const v = env.read((t) => t.get("utxo", b("a1")))!; v[0] = 0x58;
        expect(s(env.read((t) => t.get("utxo", b("a1")))!)).toBe("v1");
        env.close();
        const ro = LmdbEnv.open(dir, { readOnly: true, maxDbs: 8 });
        expect(ro.read((t) => t.count("utxo"))).toBe(4);
        expect(s(ro.read((t) => t.get("stake", b("k")))!)).toBe("s");
        await expect(ro.write(() => {})).rejects.toThrow(/read-only/);
        ro.close();
    });

    test("100k entries in one transaction, prefix scan and random gets", async () => {
        const dir = await mkdtemp(join(tmpdir(), "lmdb2-")); tmp.push(dir);
        const env = LmdbEnv.open(dir, { mapSize: 1024 * 1024 * 1024, maxDbs: 4 });
        const t0 = performance.now();
        await env.write((t) => {
            const key = new Uint8Array(34), val = new Uint8Array(120);
            for (let i = 0; i < 100_000; i++) {
                new DataView(key.buffer).setUint32(0, (i * 2654435761) >>> 0, false); new DataView(key.buffer).setUint16(32, i & 0xffff, false);
                val[0] = i & 255;
                t.put("utxo", key, val);
            }
        });
        const tw = performance.now() - t0;
        expect(env.read((t) => t.count("utxo"))).toBe(100_000);
        const t1 = performance.now();
        let hits = 0;
        env.read((t) => { const key = new Uint8Array(34); for (let i = 0; i < 20_000; i++) { new DataView(key.buffer).setUint32(0, (i * 2654435761) >>> 0, false); new DataView(key.buffer).setUint16(32, i & 0xffff, false); if (t.get("utxo", key)) hits++; } });
        const tr = performance.now() - t1;
        expect(hits).toBe(20_000);
        console.log(`lmdb: 100k puts ${tw.toFixed(0)} ms (${(tw / 100).toFixed(1)} µs/put incl. commit), 20k gets ${tr.toFixed(0)} ms (${(tr / 20).toFixed(1)} µs/get)`);
        expect(tr / 20_000).toBeLessThan(0.05); // < 50 µs per get
        env.close();
    }, 60_000);
});
