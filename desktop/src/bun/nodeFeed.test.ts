import { describe, expect, test } from "bun:test";
import { feedUrlFor, pickFresh, reconnectDelayMs } from "./nodeFeed";

describe("nodeFeed", () => {
  test("feedUrlFor turns the http base into the stats socket", () => {
    expect(feedUrlFor("http://127.0.0.1:3030")).toBe("ws://127.0.0.1:3030/ws/stats");
    expect(feedUrlFor("https://node.example/")).toBe("wss://node.example/ws/stats");
  });
  test("pickFresh serves a young cache and drops a stale one", () => {
    expect(pickFresh({ a: 1 }, 1_000, 3_000, 5_000)).toEqual({ a: 1 });
    expect(pickFresh({ a: 1 }, 1_000, 7_000, 5_000)).toBeNull();
    expect(pickFresh(null, 1_000, 1_000, 5_000)).toBeNull();
  });
  test("reconnect backs off 1 s → 10 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});
