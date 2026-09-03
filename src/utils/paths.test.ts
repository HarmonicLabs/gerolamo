import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GerolamoConfig } from "../network/peerManager";
import { getShelleyGenesisConfig } from "./paths";

let fixtureDir: string | undefined;

afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
});

describe("getShelleyGenesisConfig", () => {
    test("loads each genesis path once and reuses the process-lifetime object", async () => {
        fixtureDir = mkdtempSync(join(tmpdir(), "gerolamo-genesis-"));
        const genesisPath = join(fixtureDir, "shelley-genesis.json");
        writeFileSync(genesisPath, JSON.stringify({ networkMagic: 1, slotsPerKESPeriod: 129600 }));
        const config = { shelleyGenesisFile: genesisPath } as GerolamoConfig;

        const [first, concurrent] = await Promise.all([
            getShelleyGenesisConfig(config),
            getShelleyGenesisConfig(config),
        ]);
        writeFileSync(genesisPath, JSON.stringify({ networkMagic: 999 }));
        const reused = await getShelleyGenesisConfig(config);

        expect(concurrent).toBe(first);
        expect(reused).toBe(first);
        expect(reused.networkMagic).toBe(1);
    });
});
