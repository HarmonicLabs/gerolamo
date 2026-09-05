import { describe, expect, test } from "bun:test";
import { ByronAddress, MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { outputAddressString, isByronTypedAddress } from "../../utils/byronAddressString";
import { parseStoredAddress } from "./requiredSigners";

// Mainnet block at slot 4493980 (first Shelley epoch): tx 10 pays to a Byron
// bootstrap address, which ledger-ts decodes as an Address of type "byron" with a
// meaningless network and a truncated body; Koios shows the output as DdzFFzCqrhtCQf3X….
describe("Byron bootstrap addresses in Shelley-era outputs", () => {
    test("serialize to their base58 form and parse back as ByronAddress", async () => {
        const hex = (await Bun.file(new URL("../__fixtures__/shelley-mainnet-4493980.hex", import.meta.url)).text()).trim();
        const m: any = MultiEraBlock.fromCbor(Buffer.from(hex, "hex"));
        const out = m.block.transactionBodies[10].outputs[1];
        expect(isByronTypedAddress(out.address)).toBe(true);
        const s = outputAddressString(out.address);
        expect(s.startsWith("DdzFFzCqrhtCQf3XGksDAf3b")).toBe(true);
        const parsed = parseStoredAddress(s);
        expect(parsed instanceof ByronAddress).toBe(true);
        expect(Buffer.from((parsed as ByronAddress).rootHash).toString("hex").startsWith("f96572d2b2210b30")).toBe(true);
        expect(outputAddressString(m.block.transactionBodies[10].outputs[0].address).startsWith("addr1")).toBe(true);
    });
});
