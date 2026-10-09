import { describe, expect, test } from "bun:test";
import { applyDijkstraTransaction } from "../BlockApplication";

/** Bug 429: the ledger effects of a Dijkstra transaction, in order. */
describe("applying a Dijkstra transaction", () => {
    test("sub-transactions first (with their donations and direct deposits), then the transaction, then its direct deposits", async () => {
        const calls: string[] = [];
        const deps = {
            applyTransaction: (async (b: any) => { calls.push(`tx ${b.id}`); }) as any,
            applyDirectDeposits: (async (d: any) => { calls.push(`deposit ${d.id}`); }) as any,
        };
        const ctx: any = { slot: 1, txIndex: 0, feeAcc: { total: 0n, donations: 0n } };
        const top = { id: "top", directDeposits: { id: "top-dd" }, subTransactions: [{ body: { id: "s1", donation: 5n } }, { body: { id: "s2", directDeposits: { id: "s2-dd" } } }] };
        await applyDijkstraTransaction(top, new Uint8Array(32), undefined, ctx, deps);
        expect(calls).toEqual(["tx s1", "tx s2", "deposit s2-dd", "tx top", "deposit top-dd"]);
        expect(ctx.feeAcc.donations).toBe(5n);
    });
    test("a transaction without Dijkstra fields applies exactly like before", async () => {
        const calls: string[] = [];
        const deps = { applyTransaction: (async (b: any) => { calls.push(b.id); }) as any, applyDirectDeposits: (async () => { calls.push("dd"); }) as any };
        await applyDijkstraTransaction({ id: "plain" }, new Uint8Array(32), undefined, { slot: 1, txIndex: 0 } as any, deps);
        expect(calls).toEqual(["plain"]);
    });
});
