import { describe, expect, test } from "bun:test";
import { allTopics, defaultTopics, isWsTopic, wsSubscriberCount } from "./wsHub";

describe("wsHub topics", () => {
    test("block and mempool are subscribable topics; unknown names are not", () => {
        expect(isWsTopic("block")).toBe(true);
        expect(isWsTopic("mempool")).toBe(true);
        expect(isWsTopic("tip")).toBe(true);
        expect(isWsTopic("blocks")).toBe(false);
        expect(isWsTopic(42)).toBe(false);
        expect(allTopics()).toEqual(["tip", "block", "peers", "metrics", "governor", "mempool"]);
    });
    test("new clients start on tip/peers/metrics only; block and mempool are opt-in", () => {
        const d = defaultTopics();
        expect(d.has("block")).toBe(false);
        expect(d.has("mempool")).toBe(false);
        expect(d.has("metrics")).toBe(true);
    });
    test("subscriber count is 0 without an attached server (publishers skip work)", () => {
        expect(wsSubscriberCount("block")).toBe(0);
    });
});
