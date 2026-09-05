import { describe, expect, test } from "bun:test";
import { feeSizeBytes } from "./blockRules";

describe("feeSizeBytes", () => {
    test("preprod Alonzo tx cb9a4cdc…: 1151 serialised bytes, 1150 for the fee (isValid byte excluded)", () => {
        expect(feeSizeBytes(337, 811, 1)).toBe(1150);
        expect(44 * feeSizeBytes(337, 811, 1) + 155381).toBe(205981);
    });
});
