import { describe, expect, test } from "bun:test";
import { withdrawalEntries } from "./db";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

describe("withdrawalEntries", () => {
    test("ledger-ts TxWithdrawals ({ map }) yields 28-byte credentials", async () => {
        // preprod block at slot 13072381 has no withdrawals; build one from a stake address object shape
        const hash = "ab".repeat(28);
        const w = { map: [{ rewardAccount: { credentials: { hash: { toString: () => hash } } }, amount: 5n }] };
        const e = withdrawalEntries(w);
        expect(e.length).toBe(1);
        expect(Buffer.from(e[0]!.stakeCred).toString("hex")).toBe(hash);
        expect(e[0]!.amount).toBe(5n);
    });
    test("a whole 29-byte stake address drops its header byte; arrays and empty shapes are accepted", () => {
        const bytes = new Uint8Array(29).fill(7); bytes[0] = 0xe0;
        const e = withdrawalEntries([{ rewardAccount: { toBuffer: () => bytes }, amount: 1 }]);
        expect(e[0]!.stakeCred.length).toBe(28);
        expect(withdrawalEntries(undefined)).toEqual([]);
        expect(withdrawalEntries({ map: [] })).toEqual([]);
    });
    test("real Babbage block: withdrawals decode to credentials when present", async () => {
        const hex = (await Bun.file(new URL("./consensus/__fixtures__/preprod-block-11674001.hex", import.meta.url)).text().catch(() => "")).trim();
        if (!hex) return;
        const b: any = (MultiEraBlock.fromCbor(new Uint8Array(Buffer.from(hex, "hex"))) as any).block;
        for (const tx of b.transactionBodies) for (const e of withdrawalEntries(tx.withdrawals)) expect(e.stakeCred.length).toBe(28);
    });
});
