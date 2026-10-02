import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cbor, CborArray } from "@harmoniclabs/cbor";
import { debugLedgerConfig } from "./ledgerConfig";

// DebugLedgerConfig (bug 265): the preview relay's answer (cardano-node 11.0.1, captured 2026-10-01)
// rebuilt from src/config/preview's genesis files and the network's hard-fork triggers.
describe("DebugLedgerConfig", () => {
    test("preview: byte-identical with cardano-node 11.0.1", () => {
        const ref = readFileSync(join(import.meta.dir, "__fixtures__", "debug-ledger-config-preview.cbor"));
        expect(Buffer.from(debugLedgerConfig("preview", 2)).toString("hex")).toBe(ref.toString("hex"));
    });
    test("preprod and mainnet: eight eras, protocol-version triggers, the Byron genesis in full", () => {
        for (const [net, magic] of [["preprod", 1], ["mainnet", 764824073]] as const) {
            const cfg = Cbor.parse(debugLedgerConfig(net, magic)) as CborArray;
            const [shape, perEra] = cfg.array as CborArray[];
            expect(shape!.array.length).toBe(8);
            expect(perEra!.array.length).toBe(8);
            const triggers = perEra!.array.map((e) => Buffer.from(Cbor.encode((e as CborArray).array[(e as CborArray).array.length - 1]!).toBuffer()).toString("hex"));
            expect(triggers).toEqual(["820002", "820003", "820004", "820005", "820007", "820009", "8102", "8102"]);
        }
    });
});
