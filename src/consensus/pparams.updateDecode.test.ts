import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { updateProposalsFromBodyBytes } from "./pparams";

describe("protocol parameter update decoding from body bytes", () => {
    test("preprod epoch-5 proposal carries only d := 0 and protocol 4.0 (block at slot 518600)", async () => {
        const hex = (await Bun.file(new URL("./__fixtures__/preprod-block-518600.hex", import.meta.url)).text()).trim();
        const b: any = (MultiEraBlock.fromCbor(new Uint8Array(Buffer.from(hex, "hex"))) as any).block;
        const body = b.transactionBodies.find((t: any) => t.protocolUpdate);
        expect(body).toBeDefined();
        const decoded = updateProposalsFromBodyBytes(body.cborRef.toBuffer(), 3)!;
        expect(decoded.epoch).toBe(5);
        expect(decoded.entries.size).toBe(7);
        for (const raw of decoded.entries.values()) {
            expect(raw.decentralisation_param).toBe(0);
            expect(raw.protocol_major_ver).toBe(4);
            expect(raw.protocol_minor_ver).toBe(0);
            expect(Object.keys(raw).sort()).toEqual(["decentralisation_param", "protocol_major_ver", "protocol_minor_ver"]);
        }
    });
});

describe("Vasil hard-fork proposal (preprod block at slot 3543021)", () => {
    test("carries both Plutus cost models and the per-byte UTxO price, and survives serialisation", async () => {
        const { canonicalJson } = await import("./pparams");
        const hex = (await Bun.file(new URL("./__fixtures__/preprod-block-3543021.hex", import.meta.url)).text()).trim();
        const b: any = (MultiEraBlock.fromCbor(new Uint8Array(Buffer.from(hex, "hex"))) as any).block;
        const body = b.transactionBodies.find((t: any) => t.protocolUpdate);
        const decoded = updateProposalsFromBodyBytes(body.cborRef.toBuffer(), 7)!;
        expect(decoded.epoch).toBe(12);
        const raw: any = [...decoded.entries.values()][0];
        expect(raw.cost_models.PlutusV1.length).toBe(166);
        expect(raw.cost_models.PlutusV2.length).toBe(175);
        const back = JSON.parse(canonicalJson(raw));
        expect(back.cost_models.PlutusV2.length).toBe(175);
        expect(Object.keys(back)).toEqual(Object.keys(back).slice().sort());
    });
});
