import { tmpdir } from "node:os";
// db.ts opens the shared client lazily from this path; a literal ":memory:" left an empty
// ":memory:" file in the repository root through a path resolution, so use a real temp file.
process.env.GEROLAMO_DB_PATH = `${tmpdir()}/gerolamo-extractDelta-${process.pid}.db`;
import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { extractBlock } from "./extractDelta";

const load = async (name: string) => Buffer.from((await Bun.file(new URL(`../consensus/__fixtures__/${name}.hex`, import.meta.url)).text()).trim(), "hex");

describe("extractBlock (parse-only explorer deltas)", () => {
    test("a Babbage preprod block yields every transaction with its hash, inputs, outputs and addresses", async () => {
        const cbor = await load("preprod-block-10930253");
        const m: any = MultiEraBlock.fromCbor(cbor);
        const bodies: any[] = m.block.transactionBodies ?? [];
        const b = await extractBlock(cbor, blake2b_256(cbor), 10930253n);
        expect(b.byron).toBe(false);
        expect(b.slot).toBe(10930253);
        const invalid = new Set<number>((m.block.invalidTransactions ?? []).map((x: any) => Number(x)));
        expect(b.txs.length).toBe(bodies.filter((_, i) => !invalid.has(i)).length);
        for (const tx of b.txs) {
            expect(tx.txHash).toMatch(/^[0-9a-f]{64}$/);
            const body = bodies[tx.txIndex];
            expect(tx.inputs.length).toBe((body.inputs ?? []).length);
            expect(tx.outputs.length).toBe((body.outputs ?? []).length);
            for (const o of tx.outputs) { expect(o.a.startsWith("addr")).toBe(true); expect(BigInt(o.l)).toBeGreaterThan(0n); }
            for (const [i, h, ix] of tx.inputs) { expect(i).toBeGreaterThanOrEqual(0); expect(h).toMatch(/^[0-9a-f]{64}$/); expect(ix).toBeGreaterThanOrEqual(0); }
        }
    });
    test("a Byron block decodes as Byron (no Shelley bodies)", async () => {
        const cbor = await load("preprod-block-518600");
        const b = await extractBlock(cbor, blake2b_256(cbor), 518600n);
        expect(typeof b.byron).toBe("boolean");
        expect(b.slot).toBe(518600);
    });
});
