/**
 * The Byron block rules read the adopted parameters (ByronLedger's ticked state) when the applier
 * passes them, the genesis file's otherwise; transaction sizes are the on-chain `ATxAux` slices.
 * Fixture: the first mainnet transaction (slot 3313).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { splitEraBlock } from "../bodyHash";
import { byronBlockTxs, byronGenesisParamsFor, byronTxAuxSizes, evaluateByronBlockWithInputs } from "./blockRules";
import type { ResolvedUtxo } from "./resolvedUtxo";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "../__fixtures__/byron-mainnet-first-tx.json"), "utf8")) as { block: string };
const bytes = fromHex(fx.block);
const genesisFile = join(import.meta.dir, "../../config/mainnet/byron-genesis.json");
const config = { networkMagic: 764824073, byronGenesisFile: genesisFile };
const allOk = { verifyWitnesses: async (job: { items: unknown[] }) => ({ ok: job.items.map(() => true) }) } as any;

/** The genesis output it spends (from byronGenesisUtxos over the mainnet genesis; deriving all 14.5 k AVVM addresses takes seconds). */
const SPENT = { ref: "a12a839c25a01fa5d118167db5acdbd9e38172ae8f00e5ac0a4997ef792a2007:0", address: "Ae2tdPwUPEZ3DdaWu8jn553npu6jwEPAJiahruj3xQjPXxgoxfYDWusJz7x", lovelace: 1_000_000n };
function resolvedFor(block: MultiEraBlock): Map<string, ResolvedUtxo> {
    expect([...byronBlockTxs(block).refs]).toEqual([SPENT.ref]);
    return new Map([[SPENT.ref, { ref: SPENT.ref, address: SPENT.address, value: new Map([["lovelace", SPENT.lovelace]]), referenceScriptHash: null, hasDatum: false }]]);
}

describe("Byron block rules with the adopted parameters", () => {
    const block = MultiEraBlock.fromCbor(bytes);
    test("ATxAux sizes are the raw `[tx, witnesses]` slices of the body's tx payload", () => {
        const sizes = byronTxAuxSizes(bytes)!;
        const { rawBlock } = splitEraBlock(bytes);
        const body = Cbor.parseLazy((Cbor.parseLazy(rawBlock) as LazyCborArray).array[1]!) as LazyCborArray;
        expect(sizes).toEqual((Cbor.parseLazy(body.array[0]!) as LazyCborArray).array.map((a) => a.length));
        expect(sizes.length).toBe(1);
        expect(byronTxAuxSizes(null)).toBeNull();
    });

    test("genesis parameters by default; the adopted maxTxSize when given", async () => {
        const ctx = { config, pool: allOk, params: null, genesis: null, slot: 3313n, phase: "rules" as const };
        const genesisParams = byronGenesisParamsFor(config)!;
        expect(genesisParams.maxTxSize).toBe(4096n);
        const ok = await evaluateByronBlockWithInputs(block, { ...ctx, rawBlock: bytes }, resolvedFor(block));
        expect(ok.failures).toEqual([]);
        const size = byronTxAuxSizes(bytes)![0]!;
        const tight = await evaluateByronBlockWithInputs(block, { ...ctx, rawBlock: bytes, byronParams: { ...genesisParams, maxTxSize: BigInt(size - 1) } }, resolvedFor(block));
        expect(tight.failures.some((f) => f.includes(`TxValidationTxTooLarge ${size} > maxTxSize ${size - 1}`))).toBe(true);
        // without the raw block: reported, size unchecked
        const noRaw = await evaluateByronBlockWithInputs(block, { ...ctx, byronParams: { ...genesisParams, maxTxSize: 1n } }, resolvedFor(block));
        expect(noRaw.failures).toEqual([]);
        expect(noRaw.reports.some((r) => r.includes("size limit unchecked"))).toBe(true);
    });
});
