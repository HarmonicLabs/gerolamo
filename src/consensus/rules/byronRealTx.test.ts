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
        await applyByronTxPayload(aux, new Uint8Array(32), undefined, { slot: 4456014, txIndex: 0, blockHeight: 220000 });
        const rows = (await sql`SELECT utxo_ref, address FROM utxo`.values()) as unknown[][];
        expect(rows.map((r) => String(r[0]))).toEqual([`${toHex(txHash)}:0`]);
        const address = String(rows[0]![1]);
        expect(ByronAddress.isValid(address)).toBe(true);
        expect(ByronAddress.fromBase58(address).rootHash.length).toBe(28);
        // the Byron transaction is in the explorer projection (explorer tx counts, /txs/{hash});
        // the legacy thin tables (tx_index / block_tx) are no longer written since the projection
        // moved to its own worker and file (2026-09-06) — in tests, without the worker, mb_* land here.
        const id = toHex(txHash);
        expect(((await sql`SELECT tx_hash FROM mb_tx WHERE tx_hash = ${id}`.values()) as unknown[][]).length).toBe(1);
        expect(((await sql`SELECT slot FROM mb_tx WHERE tx_hash = ${id}`.values()) as unknown[][]).map((r) => Number(r[0]))).toEqual([4456014]);
        expect(((await sql`SELECT output_index, lovelace FROM mb_tx_out WHERE tx_hash = ${id}`.values()) as unknown[][]).length).toBeGreaterThan(0);
    });
});
