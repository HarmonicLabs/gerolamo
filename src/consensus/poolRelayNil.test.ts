import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

/**
 * Bug 70: preview slot 98785139 registers a pool whose only relay is
 * `[0, 3001, null, null]` — a single-host-addr with a port and neither address, which the
 * CDDL allows (`port / nil, ipv4 / nil, ipv6 / nil`). ledger-ts required at least one address.
 */
describe("pool relay with port only", () => {
    test("preview block 98785139 decodes and keeps the relay", () => {
        const hex = readFileSync(new URL("./__fixtures__/preview-block-98785139.hex", import.meta.url), "utf8").trim();
        const m: any = MultiEraBlock.fromCbor(Buffer.from(hex, "hex"));
        const certs: any[] = m.block.transactionBodies[0].certs ?? [];
        const reg = certs.find((c) => c.certType === 3 || c.poolParams);
        expect(reg).toBeDefined();
        const relays = reg.poolParams.relays;
        expect(relays.length).toBe(1);
        expect(relays[0].type).toBe("ip");
        expect(Number(relays[0].port)).toBe(3001);
        expect(relays[0].ipv4).toBeUndefined();
        expect(relays[0].ipv6).toBeUndefined();
    });
});
