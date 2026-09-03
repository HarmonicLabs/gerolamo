import { describe, expect, test } from "bun:test";
import { startHotSyncWithTimeout } from "./peerManager";

describe("hot peer promotion deadline", () => {
    test("terminates a peer whose ChainSync intersection never answers", async () => {
        const reasons: string[] = [];
        const client = {
            startSyncLoop: () => new Promise<void>(() => {}),
            terminate: (reason?: string) => reasons.push(reason ?? ""),
        };

        await expect(
            startHotSyncWithTimeout(client, "45.77.188.253:3001", 5),
        ).rejects.toThrow("hot sync 45.77.188.253:3001 timed out after 5ms");
        expect(reasons).toEqual([
            "hot sync 45.77.188.253:3001 timed out after 5ms",
        ]);
    });
});
