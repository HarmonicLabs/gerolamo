import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { deriveNextEpochParams, recordUpdateProposal, updateToRaw } from "./pparams";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-pparams-"));
beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("protocol parameter updates", () => {
    test("updateToRaw maps ledger fields to the stored keys", () => {
        expect(updateToRaw({ txFeePerByte: 44n, maxBlockBodySize: 90112, decentralization: { num: 8n, den: 10n }, protocolVersion: { major: 5, minor: 0 }, maxTxExecutionUnits: { mem: 14000000n, cpu: 10000000000n } }))
            .toEqual({ min_fee_a: "44", max_block_size: 90112, decentralisation_param: 0.8, protocol_major_ver: 5, protocol_minor_ver: 0, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000" });
    });
    test("a change proposed by a quorum of genesis keys applies at the boundary; a minority does not", async () => {
        const keys = ["11", "22", "33", "44", "55", "66", "77"].map((k) => k.repeat(28));
        for (const k of keys.slice(0, 5)) await recordUpdateProposal(sql, [[{ genesisHash: k, changes: { maxBlockBodySize: 90112 } }], 210], 1000);
        for (const k of keys.slice(5)) await recordUpdateProposal(sql, [[{ genesisHash: k, changes: { maxBlockBodySize: 70000 } }], 210], 1000);
        const { raw, changed } = await deriveNextEpochParams({ max_block_size: 65536, min_fee_a: 44 }, 211, 5);
        expect(changed).toEqual(["max_block_size"]);
        expect(raw.max_block_size).toBe(90112);
        expect(raw.min_fee_a).toBe(44);
        const none = await deriveNextEpochParams({ max_block_size: 65536 }, 212, 5);
        expect(none.changed).toEqual([]);
    });
});
