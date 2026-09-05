import { describe, expect, test } from "bun:test";
import { ledgerInputs } from "./resolvedUtxo";

const ref = (i: number) => ({ utxoRef: { id: "d94cc73b".padEnd(64, "0"), index: i } });

describe("ledgerInputs", () => {
    test("Babbage: repeated inputs collapse into the set the ledger decodes (preprod slot 13546618)", () => {
        expect(ledgerInputs([ref(1), ref(0), ref(1), ref(0)], 6).length).toBe(2);
    });
    test("Conway: repeats are kept so the duplicate rule rejects them", () => {
        expect(ledgerInputs([ref(1), ref(1)], 7).length).toBe(2);
    });
});
