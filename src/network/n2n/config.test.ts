import { describe, expect, test } from "bun:test";
import { resolveN2NConfig } from "./config";

describe("resolveN2NConfig", () => {
    test("off unless enabled; defaults for the rest", () => {
        expect(resolveN2NConfig({ enabled: false, host: "0.0.0.0", port: 3001 })).toBeUndefined();
        expect(resolveN2NConfig(undefined)).toBeUndefined();
        expect(resolveN2NConfig({ enabled: true, port: 4101 })).toMatchObject({ enabled: true, host: "0.0.0.0", port: 4101, maxConnections: 64 });
    });

    test("the WebSocket bearer only when its own switch is on; bad ports throw", () => {
        expect(resolveN2NConfig({ enabled: true, port: 3001, ws: { enabled: false, port: 3004 } })!.ws).toBeUndefined();
        expect(resolveN2NConfig({ enabled: true, port: 3001, ws: { enabled: true, port: 3004 } })!.ws).toEqual({ host: "0.0.0.0", port: 3004 });
        expect(() => resolveN2NConfig({ enabled: true, port: 70_000 })).toThrow();
    });
});
