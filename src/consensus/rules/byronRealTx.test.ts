/**
 * The first mainnet transaction (slot 3313): its witness must verify under the
 * Byron signing message, and the apply path must store its output under the
 * real tx id (it used to store `String(tx.hash)` — the method's source text).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByronAddress, MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { getByronTxPayloads } from "../../utils/eraAccessors";
import { runWitnessVerifyJob } from "../workers/witnessJob";
import { byronSignedMessage } from "./witnesses";
import { initSql, sql } from "../../sql";
import { applyByronTxPayload, ensureInitialized } from "../../db";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "../__fixtures__/byron-mainnet-first-tx.json"), "utf8")) as { block: string };
const MAINNET_MAGIC = 764824073;
const dir = mkdtempSync(join(tmpdir(), "gerolamo-byron-tx-"));

beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("first mainnet Byron transaction", () => {
    const block = MultiEraBlock.fromCbor(fromHex(fx.block));
    const entries = getByronTxPayloads(block.block as any);
    const aux: any = entries[0];
    const txHash = blake2b_256(aux.tx.toCborBytes());

    test("its witness signature verifies under `tag ‖ cbor(magic) ‖ cbor(txid)`", () => {
        expect(entries.length).toBe(1);
        const w = aux.witnesses[0];
        const tag = Number(w.type) === 2 ? 2 : 1;
        const r = runWitnessVerifyJob({ kind: "witnesses", items: [{ publicKey: w.pubkey.subarray(0, 32), signature: w.signature, message: byronSignedMessage(tag, MAINNET_MAGIC, txHash) }] });
        expect(r.ok).toEqual([true]);
        const wrong = runWitnessVerifyJob({ kind: "witnesses", items: [{ publicKey: w.pubkey.subarray(0, 32), signature: w.signature, message: byronSignedMessage(tag, 1, txHash) }] });
        expect(wrong.ok).toEqual([false]);
    });

    test("apply stores the output under the real tx id", async () => {
        await applyByronTxPayload(aux, new Uint8Array(32));
        const rows = (await sql`SELECT utxo_ref, address FROM utxo`.values()) as unknown[][];
        expect(rows.map((r) => String(r[0]))).toEqual([`${toHex(txHash)}:0`]);
        const address = String(rows[0]![1]);
        expect(ByronAddress.isValid(address)).toBe(true);
        expect(ByronAddress.fromBase58(address).rootHash.length).toBe(28);
    });
});
