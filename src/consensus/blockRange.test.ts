import { describe, expect, test } from "bun:test";
import { assertBlockRangeMatches } from "./blockRange";

const h = (byte: string) => byte.repeat(64);

describe("BlockFetch range correspondence", () => {
    test("accepts blocks with the advertised slots and hashes in order", () => {
        expect(() =>
            assertBlockRangeMatches(
                [
                    { slot: 10n, hash: h("a") },
                    { slot: 14n, hash: h("b") },
                ],
                [
                    { slot: 10n, hash: h("a") },
                    { slot: 14n, hash: h("b") },
                ],
            )
        ).not.toThrow();
    });

    test("rejects missing, reordered, or wrong-hash bodies", () => {
        const expected = [
            { slot: 10n, hash: h("a") },
            { slot: 14n, hash: h("b") },
        ];

        expect(() => assertBlockRangeMatches(expected, [expected[0]!]))
            .toThrow("expected 2 blocks, received 1");
        expect(() => assertBlockRangeMatches(expected, [...expected].reverse()))
            .toThrow("range block 0 does not match advertised header");
        expect(() =>
            assertBlockRangeMatches(expected, [
                expected[0]!,
                { slot: 14n, hash: h("c") },
            ])
        ).toThrow("range block 1 does not match advertised header");
    });
});
