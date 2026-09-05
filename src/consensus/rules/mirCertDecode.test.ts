import { describe, expect, test } from "bun:test";
import { ShelleyTx } from "@harmoniclabs/cardano-ledger-ts";

// Mainnet tx 35d2728e… (slot 4563840, first Shelley epoch): 200 stake registrations
// and 200 MIR entries from the reserves. The ledger-ts certificate dispatcher hands
// the whole `[6, [source, destination]]` array to the Conway MIR decoder, which
// expected only the inner pair; the vendored patch accepts both forms.
describe("MIR certificate decoding", () => {
    test("a Shelley transaction with reserve MIR certificates decodes", async () => {
        const hex = (await Bun.file(new URL("../__fixtures__/shelley-mainnet-mir-tx-35d2728e.hex", import.meta.url)).text()).trim();
        const tx: any = ShelleyTx.fromCbor(Buffer.from(hex, "hex"));
        const certs: any[] = tx.body.certs ?? [];
        const mir = certs.filter((c) => Number(c.certType) === 6);
        expect(mir.length).toBe(1);
        expect(mir[0].destination.length).toBe(200);
        expect(Number(mir[0].source)).toBe(0);
        expect(Array.isArray(mir[0].destination)).toBe(true);
        expect(mir[0].destination.length).toBeGreaterThan(0);
        expect(typeof mir[0].destination[0].amount === "bigint" || typeof mir[0].destination[0].amount === "number").toBe(true);
    });
});
