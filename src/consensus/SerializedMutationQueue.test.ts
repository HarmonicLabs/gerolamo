import { describe, expect, test } from "bun:test";
import { SerializedMutationQueue } from "./SerializedMutationQueue";

describe("SerializedMutationQueue", () => {
    test("orders rollback after an in-flight apply and survives task failures", async () => {
        const queue = new SerializedMutationQueue();
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));

        const apply = queue.run(async () => {
            events.push("apply:start");
            await gate;
            events.push("apply:end");
        });
        const rollback = queue.run(async () => {
            events.push("rollback");
        });

        await Bun.sleep(0);
        expect(events).toEqual(["apply:start"]);
        release();
        await Promise.all([apply, rollback]);
        expect(events).toEqual(["apply:start", "apply:end", "rollback"]);

        await expect(queue.run(async () => {
            throw new Error("expected");
        })).rejects.toThrow("expected");
        await queue.run(async () => events.push("after-error"));
        expect(events.at(-1)).toBe("after-error");
    });
});
