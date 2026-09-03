import { afterAll, describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { ValidationPool, resolveWorkerCount } from "./ValidationPool";
import { runHeaderValidationJob } from "./validationJob";
import fixture from "../__fixtures__/byron-preprod.json";

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
