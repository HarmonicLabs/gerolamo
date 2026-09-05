import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborSimple, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { computeShelleyBodyHash, shelleyHeaderBodyHash, splitEraBlock } from "../consensus/bodyHash";
import { bodyCommitment } from "./forge";
import { assembleBody, splitTx } from "./bodyAssembly";

// Rebuild preview block 11663879 (30 txs, 5 with auxiliary data) from its transactions and
// compare our column-wise segments with the block's own: same bytes, same body hash.
async function fixtureBlock() {
    const hex = (await Bun.file(new URL("../consensus/__fixtures__/preview-block-11663879.hex", import.meta.url)).text()).trim();
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

function txsOfBlock(blockFetch: Uint8Array): { txs: Uint8Array[]; segments: Uint8Array[] } {
    const { rawBlock } = splitEraBlock(blockFetch);
    const lazy = Cbor.parseLazy(rawBlock) as LazyCborArray;
    const [, bodiesRaw, witsRaw, auxRaw, invalidRaw] = lazy.array;
    const bodies = (Cbor.parseLazy(bodiesRaw!) as LazyCborArray).array;
    const wits = (Cbor.parseLazy(witsRaw!) as LazyCborArray).array;
    const aux = Cbor.parse(auxRaw!) as any; // map index → aux
    const auxByIx = new Map<number, Uint8Array>();
    for (const e of aux.map) auxByIx.set(Number(e.k.num), Cbor.encode(e.v).toBuffer());
    const invalid = new Set(((Cbor.parse(invalidRaw!) as CborArray).array as any[]).map((x) => Number(x.num)));
    const txs = bodies.map((b, i) => {
        const auxBytes = auxByIx.get(i) ?? new Uint8Array([0xf6]);
        const valid = Cbor.encode(new CborSimple(!invalid.has(i))).toBuffer();
        const parts = [b, wits[i]!, valid, auxBytes];
        const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0)); out[0] = 0x84;
        let o = 1; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    });
    return { txs, segments: [bodiesRaw!, witsRaw!, auxRaw!, invalidRaw!] };
}

describe("block body assembly", () => {
    test("re-assembling a real block's transactions reproduces its segments and body hash", async () => {
        const blk = await fixtureBlock();
        const { txs, segments } = txsOfBlock(blk);
        expect(txs.length).toBe(30);
        const parts = txs.map((t) => splitTx(new Uint8Array(blake2b_256(t)), t));
        expect(parts.filter((p) => p.auxiliaryData).length).toBe(5);
        const body = assembleBody(parts, 90_112);
        expect(body.included.length).toBe(30);
        const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
        // the real block re-encodes its aux values (tag 259 maps) as we sliced them, so bytes must agree
        expect(hex(body.segments.txBodies)).toBe(hex(segments[0]!));
        expect(hex(body.segments.witnessSets)).toBe(hex(segments[1]!));
        expect(hex(body.segments.auxiliaryData)).toBe(hex(segments[2]!));
        expect(hex(body.segments.invalidTransactions)).toBe(hex(segments[3]!));
        const { era, rawBlock } = splitEraBlock(blk);
        const header = (Cbor.parseLazy(rawBlock) as LazyCborArray).array[0]!;
        expect(hex(bodyCommitment(body.segments).hash)).toBe(hex(shelleyHeaderBodyHash(era, header)));
        expect(hex(bodyCommitment(body.segments).hash)).toBe(hex(computeShelleyBodyHash(era, rawBlock)));
        expect(bodyCommitment(body.segments).size).toBe(body.size);
    });

    test("size cap skips transactions that do not fit and keeps arrival order", async () => {
        const blk = await fixtureBlock();
        const { txs } = txsOfBlock(blk);
        const parts = txs.map((t) => splitTx(new Uint8Array(blake2b_256(t)), t));
        const full = assembleBody(parts, 1 << 20).size;
        const half = assembleBody(parts, Math.floor(full / 2));
        expect(half.included.length).toBeGreaterThan(0);
        expect(half.included.length).toBeLessThan(30);
        expect(half.size).toBeLessThanOrEqual(Math.floor(full / 2));
        const order = half.included.map((p) => parts.indexOf(p));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(assembleBody(parts, 10).included).toEqual([]);
        expect(assembleBody([], 1000).size).toBe(4); // 80 80 a0 80
    });

    test("a phase-2 invalid transaction lands in invalid_transactions", async () => {
        const blk = await fixtureBlock();
        const { txs } = txsOfBlock(blk);
        const t = Uint8Array.from(txs[0]!);
        // flip is_valid (third element) from f5 to f4: locate via lazy parse
        const lazy = Cbor.parseLazy(t) as LazyCborArray;
        const off = t.length - lazy.array[3]!.length - 1;
        expect(t[off]).toBe(0xf5); t[off] = 0xf4;
        const p = splitTx(new Uint8Array(32), t);
        expect(p.isValid).toBe(false);
        const body = assembleBody([p], 1 << 20);
        expect(Buffer.from(body.segments.invalidTransactions).toString("hex")).toBe("8100");
    });
});
