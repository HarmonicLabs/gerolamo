import { describe, expect, test } from "bun:test";
import { resolveN2NConfig } from "./config";

describe("resolveN2NConfig", () => {
    test("keeps inbound N2N opt-in and lets an explicit port enable it", () => {
        expect(resolveN2NConfig(
            { enabled: false, host: "0.0.0.0", port: 3001 },
            {},
        )).toBeUndefined();

        expect(resolveN2NConfig(
            { enabled: false, host: "0.0.0.0", port: 3001 },
            { GEROLAMO_N2N_PORT: "4101" },
        )).toMatchObject({
            enabled: true,
            host: "0.0.0.0",
            port: 4101,
        });
    });

    test("the explicit disable switch wins over config and port", () => {
        expect(resolveN2NConfig(
            { enabled: true, host: "127.0.0.1", port: 3001 },
            { GEROLAMO_N2N: "0", GEROLAMO_N2N_PORT: "4101" },
        )).toBeUndefined();
    });
});
