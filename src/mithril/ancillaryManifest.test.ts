import { describe, expect, test } from "bun:test";
import { ANCILLARY_VKEYS, manifestHash, parseAncillaryManifest, verifyManifestSignature } from "./ancillaryManifest";

// The preview ancillary manifest of snapshot d2bd116c… (epoch 1415, 2026-09-09), signed by the aggregator.
const MANIFEST = `{"data":{"immutable/28314.chunk":"f1a3700d0c86c09e454f1bc19fcee7bdba49b0cfcf327a87c9244edc88007073","immutable/28314.primary":"ef734a4fb7d82109ff1063a9b648451d73c58f25f0fdcffb14a0bb6cc035b308","immutable/28314.secondary":"0cfcc258205dbde80e5f0f2b9aeca905d71fa6ef4a9508c07a50d96120575886","ledger/122316253/meta":"70615191c5db875189e506b5667fe88f102d8999b72d7fc0e822c38e7650d275","ledger/122316253/state":"47b86e73fda4bc76457d2215d01dce2793e8c48c145f98fadf2adae53bdd8e8b","ledger/122316253/tables":"86615f416820320b8e3379858b23ef984f668c34ce91bf9c5ff1982c36a5ad84"},"signature":"fe5b0265d560172e518256b452624764b88cbcc95b6a2b6e95bbede25395c6fb46041dd3b4078999f4a2994a78d07b2621175457da618fdddfa50d024dd3cd0e"}`;

describe("ancillary manifest", () => {
    test("the preview aggregator's signature verifies over the manifest hash with the published key", () => {
        const m = parseAncillaryManifest(MANIFEST);
        expect(Object.keys(m.data)).toHaveLength(6);
        expect(manifestHash(m)).toHaveLength(32);
        expect(verifyManifestSignature(m, ANCILLARY_VKEYS.preview!)).toBe(true);
    });
    test("a changed file hash or another network's key fails", () => {
        const m = parseAncillaryManifest(MANIFEST);
        expect(verifyManifestSignature(m, ANCILLARY_VKEYS.mainnet!)).toBe(false);
        m.data["ledger/122316253/state"] = "00".repeat(32);
        expect(verifyManifestSignature(m, ANCILLARY_VKEYS.preview!)).toBe(false);
    });
});
