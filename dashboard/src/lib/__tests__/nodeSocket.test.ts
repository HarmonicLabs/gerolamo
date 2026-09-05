import { describe, expect, test } from "bun:test";
import { parseFrame, reconnectDelayMs, wsUrlFor } from "../nodeSocket";

describe("nodeSocket", () => {
  test("wsUrlFor: same origin when the node base is empty, else the node base", () => {
    expect(wsUrlFor("", "http://127.0.0.1:3030")).toBe("ws://127.0.0.1:3030/ws/stats");
    expect(wsUrlFor("https://node.example", "http://localhost:3041")).toBe("wss://node.example/ws/stats");
    expect(wsUrlFor("http://localhost:3030/", "http://localhost:3041")).toBe("ws://localhost:3030/ws/stats");
  });
  test("parseFrame accepts typed JSON frames only", () => {
    expect(parseFrame('{"v":1,"type":"tip","data":{"slot":"1"}}')).toEqual({ v: 1, type: "tip", data: { slot: "1" } });
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame('{"data":1}')).toBeNull();
  });
  test("reconnect backs off 1 s → 10 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});
