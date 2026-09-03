import { afterAll, describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { ValidationPool, resolveWorkerCount } from "./ValidationPool";
import { runHeaderValidationJob } from "./validationJob";
import fixture from "../__fixtures__/byron-preprod.json";
import shelleyConway from "../__fixtures__/shelley-conway-preprod.json";
import { blockFetchHeaderIdentity } from "../blockHeaderParser";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { runRangeVerifyJob } from "./validationJob";

type FixtureHeader = { byronType: number; hash: string; rollForwardHex: string };
const headers = fixture.headers as FixtureHeader[];
const config = { networkMagic: 1, shelleyGenesisFile: "./src/config/preprod/shelley-genesis.json", network: "preprod" };

const pool = new ValidationPool(2);
afterAll(() => pool.close());

describe("resolveWorkerCount", () => {
    test("auto = all cores, numbers clamp, 0 means inline", () => {
        expect(resolveWorkerCount("auto")).toBeGreaterThanOrEqual(1);
        expect(resolveWorkerCount(undefined)).toBe(resolveWorkerCount("auto"));
        expect(resolveWorkerCount(0)).toBe(0);
        expect(resolveWorkerCount(3)).toBe(3);
        expect(resolveWorkerCount(999)).toBe(64);
        expect(resolveWorkerCount(-2)).toBe(0);
    });
});

describe("ValidationPool", () => {
    test("worker results match inline results for Byron headers", async () => {
        expect(pool.workerCount).toBe(2);
        const jobs = headers.map((h) => ({ rollForward: fromHex(h.rollForwardHex), nonceHex: "", config }));
        const viaWorkers = await pool.validateAll(jobs);
        const inline = await Promise.all(jobs.map((j) => runHeaderValidationJob(j)));
        for (let i = 0; i < headers.length; i++) {
            expect(viaWorkers[i]!.ok).toBe(true);
            expect(viaWorkers[i]!.hashHex).toBe(headers[i]!.hash);
            expect(viaWorkers[i]!.era).toBe(headers[i]!.byronType);
            expect(viaWorkers[i]!.slot).toBe(inline[i]!.slot);
            expect(viaWorkers[i]!.isByron).toBe(true);
            expect(viaWorkers[i]!.rawHeader.length).toBe(inline[i]!.rawHeader.length);
        }
    });

    test("caller's bytes are untouched after transfer", async () => {
        const bytes = fromHex(headers[0]!.rollForwardHex);
        const len = bytes.length;
        await pool.validate({ rollForward: bytes, nonceHex: "", config });
        expect(bytes.length).toBe(len);
    });

    test("garbage input yields an error result, not a crash", async () => {
        const r = pool.validate({ rollForward: new Uint8Array([0xff, 0x00]), nonceHex: "", config });
        await expect(r).rejects.toThrow();
        // pool still alive
        const ok = await pool.validate({ rollForward: fromHex(headers[1]!.rollForwardHex), nonceHex: "", config });
        expect(ok.ok).toBe(true);
    });

    test("inline pool (0 workers) works", async () => {
        const inlinePool = new ValidationPool(0);
        const r = await inlinePool.validate({ rollForward: fromHex(headers[2]!.rollForwardHex), nonceHex: "", config });
        expect(r.ok).toBe(true);
        expect(inlinePool.workerCount).toBe(0);
        inlinePool.close();
    });
});

describe("ValidationPool.verifyRange", () => {
    const blocks = shelleyConway.blocks as Record<string, string>;
    const bytes = [fromHex(blocks.shelley_86400!), fromHex(blocks.tip!)];
    const expected = bytes.map((b) => toHex(blockFetchHeaderIdentity(b).hash));

    test("worker result matches inline for honest blocks and returns identities", async () => {
        const viaWorker = await pool.verifyRange({ kind: "range", blocks: bytes, expectedHashes: expected });
        const inline = runRangeVerifyJob({ kind: "range", blocks: bytes, expectedHashes: expected });
        expect(viaWorker.ok).toBe(true);
        expect(inline.ok).toBe(true);
        expect(viaWorker.identities.map((i) => i.hashHex)).toEqual(expected);
        expect(viaWorker.identities.map((i) => i.era)).toEqual(inline.identities.map((i) => i.era));
        expect(toHex(viaWorker.identities[0]!.rawHeader)).toBe(toHex(blockFetchHeaderIdentity(bytes[0]!).rawHeaderBytes));
        // The caller's bytes were copied, not detached.
        expect(bytes[0]!.byteLength).toBeGreaterThan(0);
    });

    test("a wrong advertised hash is reported with its index", async () => {
        const r = await pool.verifyRange({ kind: "range", blocks: bytes, expectedHashes: [expected[0]!, "00".repeat(32)] });
        expect(r.ok).toBe(false);
        expect(r.index).toBe(1);
        expect(r.reason).toContain("advertised");
    });

    test("a tampered body fails the body-hash check", async () => {
        const tampered = new Uint8Array(bytes[0]!);
        tampered[tampered.length - 1] ^= 0x01;
        const r = await pool.verifyRange({ kind: "range", blocks: [tampered], expectedHashes: [expected[0]!] });
        expect(r.ok).toBe(false);
        expect(r.index).toBe(0);
        expect(r.reason).toMatch(/body hash|undecodable/);
    });

    test("garbage bytes are an undecodable block, not a crash", async () => {
        const r = await pool.verifyRange({ kind: "range", blocks: [new Uint8Array([0xff, 0x00])], expectedHashes: ["00".repeat(32)] });
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("undecodable");
    });
});

describe("ValidationPool Byron signatures", () => {
    test("byronProtocolMagic makes the worker verify Byron main-block signatures and return key hashes", async () => {
        const mains = headers.filter((h) => h.byronType === 1);
        expect(mains.length).toBeGreaterThan(0);
        const results = await pool.validateAll(mains.map((h) => ({ rollForward: fromHex(h.rollForwardHex), nonceHex: "", config, byronProtocolMagic: 1 })));
        for (const r of results) {
            expect(r.ok).toBe(true);
            expect(r.byron?.ok).toBe(true);
            expect(r.byron?.issuerKeyHash).toMatch(/^[0-9a-f]{56}$/);
            expect(r.byron?.signerKeyHash).toMatch(/^[0-9a-f]{56}$/);
        }
        // EBBs carry no signature: no byron verdict, still ok.
        const ebbs = headers.filter((h) => h.byronType === 0);
        for (const h of ebbs) {
            const r = await pool.validate({ rollForward: fromHex(h.rollForwardHex), nonceHex: "", config, byronProtocolMagic: 1 });
            expect(r.ok).toBe(true);
            expect(r.byron).toBeUndefined();
        }
        // Wrong protocol magic: the signature domain tag differs, so the check fails closed.
        const bad = await pool.validate({ rollForward: fromHex(mains[0]!.rollForwardHex), nonceHex: "", config, byronProtocolMagic: 2 });
        expect(bad.ok).toBe(false);
        expect(bad.reason).toContain("Byron block signature");
    });
});
