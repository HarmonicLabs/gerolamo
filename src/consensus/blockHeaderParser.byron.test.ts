import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import {
    ByronBlockHeaderBody,
    ByronEbbHead,
    MultiEraBlock,
} from "@harmoniclabs/cardano-ledger-ts";
import { BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import {
    BYRON_EBB_ERA,
    BYRON_MAIN_ERA,
    blockFetchHeaderIdentity,
    blockParser,
    byronHeaderHash,
    headerParser,
    isByronEra,
} from "./blockHeaderParser";
import { validateByronHeader } from "./ByronHeaderValidator";
import { validateHeader } from "./BlockHeaderValidator";
import { isByronBlock } from "../utils/eraAccessors";
import fixture from "./__fixtures__/byron-preprod.json";

type FixtureHeader = {
    byronType: number;
    sizeHint: number;
    hash: string;
    prevHash: string;
    rollForwardHex: string;
    headerHex: string;
};

const headers = fixture.headers as FixtureHeader[];
const blocks = fixture.blocks as string[];

// Preprod epoch-0 EBB, then the first two Byron main blocks (slots 2 and 2163).
const EXPECTED = [
    { era: BYRON_EBB_ERA, slot: 0n, isEbb: true },
    { era: BYRON_MAIN_ERA, slot: 2n, isEbb: false },
    { era: BYRON_MAIN_ERA, slot: 2163n, isEbb: false },
];

describe("Byron ChainSync header parsing", () => {
    test("fixture is what we think it is", () => {
        expect(headers.length).toBe(3);
        expect(blocks.length).toBe(3);
        expect(headers[0]!.hash).toBe(
            "9ad7ff320c9cf74e0f5ee78d22a85ce42bb0a487d0506bf60cfb5a91ea4497d2",
        );
        expect(headers[0]!.prevHash).toBe(fixture.byronGenesisHash);
    });

    test("byronHeaderHash prefixes [type, header] before blake2b-256", () => {
        for (const h of headers) {
            expect(toHex(byronHeaderHash(h.byronType, fromHex(h.headerHex))))
                .toBe(h.hash);
        }
        // Wrong type prefix must not collide with the real hash.
        const h0 = headers[0]!;
        expect(toHex(byronHeaderHash(1, fromHex(h0.headerHex)))).not.toBe(
            h0.hash,
        );
        expect(() => byronHeaderHash(2, fromHex(h0.headerHex))).toThrow();
    });

    test("headerParser decodes the [0, [[type,size], tag24]] wrapper", async () => {
        for (let i = 0; i < headers.length; i++) {
            const h = headers[i]!;
            const parsed = await headerParser(fromHex(h.rollForwardHex));
            expect(parsed).not.toBeNull();
            const p = parsed!;
            expect(p.isByron).toBe(true);
            expect(p.era).toBe(EXPECTED[i]!.era);
            expect(p.isEbb).toBe(EXPECTED[i]!.isEbb);
            expect(p.slot).toBe(EXPECTED[i]!.slot);
            expect(p.epoch).toBe(0);
            expect(toHex(p.blockHeaderHash)).toBe(h.hash);
            expect(toHex(p.rawHeaderBytes)).toBe(h.headerHex);
            expect(p.prevHashHex).toBe(h.prevHash);
            expect(p.multiEraHeader.era).toBe(EXPECTED[i]!.era);
            if (p.isEbb) {
                expect(p.multiEraHeader.header).toBeInstanceOf(ByronEbbHead);
            } else {
                expect(p.multiEraHeader.header).toBeInstanceOf(
                    ByronBlockHeaderBody,
                );
            }
        }
    });

    test("consecutive headers chain by prevBlock", async () => {
        let prevHash: string | null = null;
        for (const h of headers) {
            const p = (await headerParser(fromHex(h.rollForwardHex)))!;
            if (prevHash) expect(p.prevHashHex).toBe(prevHash);
            prevHash = toHex(p.blockHeaderHash);
        }
    });

    test("isByronEra covers exactly EBB and main", () => {
        expect(isByronEra(0)).toBe(true);
        expect(isByronEra(1)).toBe(true);
        expect(isByronEra(2)).toBe(false);
        expect(isByronEra(7)).toBe(false);
    });
});

describe("Byron BlockFetch block identity", () => {
    test("raw header hash from the block matches the ChainSync header", () => {
        for (let i = 0; i < blocks.length; i++) {
            const id = blockFetchHeaderIdentity(fromHex(blocks[i]!));
            expect(id.era).toBe(EXPECTED[i]!.era);
            expect(toHex(id.hash)).toBe(headers[i]!.hash);
            expect(toHex(id.rawHeaderBytes)).toBe(headers[i]!.headerHex);
        }
    });

    test("blockParser yields MultiEraBlock with Byron eras and slots", async () => {
        for (let i = 0; i < blocks.length; i++) {
            const msg = new BlockFetchBlock({ blockData: fromHex(blocks[i]!) });
            const parsed = await blockParser(msg);
            expect(parsed).toBeInstanceOf(MultiEraBlock);
            expect(parsed!.era).toBe(EXPECTED[i]!.era);
            expect(isByronBlock(parsed!.block)).toBe(true);
        }
    });
});

describe("Byron header validation", () => {
    test("accepts preprod headers with matching network magic", async () => {
        for (const h of headers) {
            const p = (await headerParser(fromHex(h.rollForwardHex)))!;
            expect(validateByronHeader(p.multiEraHeader, { networkMagic: 1 }))
                .toBe(true);
            // Dispatch through the generic entry point (no nonce for Byron).
            expect(
                await validateHeader(p.multiEraHeader, new Uint8Array(0), {
                    networkMagic: 1,
                }),
            ).toBe(true);
        }
    });

    test("rejects a network magic mismatch", async () => {
        for (const h of headers) {
            const p = (await headerParser(fromHex(h.rollForwardHex)))!;
            expect(validateByronHeader(p.multiEraHeader, { networkMagic: 764824073 }))
                .toBe(false);
        }
    });
});
