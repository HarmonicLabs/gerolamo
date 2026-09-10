/**
 * Withdrawals must debit the reward account with its credential *type*: a script stake
 * address (header 0xf0/0xf1) keys the `rewards` row as 01‖hash. Typing it as a key account
 * left script balances growing forever (preview pot drift, PLAN_LEDGER_INTEGRITY.md B).
 */
import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { withdrawalEntries } from "./db";

describe("withdrawalEntries", () => {
    test("a script reward account (preview block 61206431, tx 1) is typed 01‖hash", async () => {
        const blk = Buffer.from((await Bun.file(new URL("./consensus/__fixtures__/preview-block-61206431.hex", import.meta.url)).text()).trim(), "hex");
        const m: any = MultiEraBlock.fromCbor(blk);
        const body = m.block.transactionBodies[1];
        const entries = withdrawalEntries(body.withdrawals);
        expect(entries.length).toBe(1);
        expect(entries[0]!.stakeCred.length).toBe(29);
        expect(toHex(entries[0]!.stakeCred).startsWith("01e37db487fb")).toBe(true);
    });
    test("a key reward account stays a bare 28-byte hash", () => {
        const hash = new Uint8Array(28).fill(7);
        const entries = withdrawalEntries([{ rewardAccount: { type: "stakeKey", credentials: { hash } }, amount: 5n }]);
        expect(entries.length).toBe(1);
        expect(entries[0]!.stakeCred.length).toBe(28);
        expect(entries[0]!.amount).toBe(5n);
    });
});
