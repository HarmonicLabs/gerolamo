import { describe, expect, test } from "bun:test";
import { withTimeout } from "./withTimeout";

describe("withTimeout", () => {
    test("runs cleanup before rejecting a timed-out peer operation", async () => {
        let cleaned = 0;
        const never = new Promise<never>(() => {});

        await expect(
            withTimeout(never, 5, "handshake peer.example:3001", () => {
                cleaned += 1;
            }),
        ).rejects.toThrow("handshake peer.example:3001 timed out after 5ms");
        expect(cleaned).toBe(1);
    });
});
