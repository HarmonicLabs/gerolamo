import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoredEnvironment, initSettings, receiveSettings, registerSettingFlags, resolveSettings, settings, settingsMarkdown, settingsMessage, SETTINGS } from "./settings";

/** Parse a command line the way `gerolamo start-gerolamo` does. */
function parse(argv: string[]): Record<string, unknown> {
    const cmd = new Command("start-gerolamo").exitOverride();
    registerSettingFlags(cmd);
    cmd.parse(argv, { from: "user" });
    return cmd.opts();
}

afterEach(() => { initSettings({}); });

describe("settings: flag, then config.json, then default", () => {
    test("defaults when neither is given", () => {
        const { settings: s, sources } = resolveSettings(parse([]), {});
        expect(s.port).toBe(3030);
        expect(s.ledgerSqlWrites).toBe(true);
        expect(sources.port).toBe("default");
    });

    test("config.json beats the default; a flag beats config.json", () => {
        const config = { port: 3037, ledgerSqlWrites: false, consensus: { chainSelection: "praos" } };
        const a = resolveSettings(parse([]), structuredClone(config));
        expect([a.settings.port, a.settings.ledgerSqlWrites, a.settings.chainSelection]).toEqual([3037, false, "praos"]);
        expect(a.sources.port).toBe("config");
        const b = resolveSettings(parse(["--port", "4000", "--ledger-sql-writes", "--chain-selection", "shadow"]), structuredClone(config));
        expect([b.settings.port, b.settings.ledgerSqlWrites, b.settings.chainSelection]).toEqual([4000, true, "shadow"]);
        expect(b.sources.port).toBe("flag");
    });

    test("--no-x turns a boolean off; leaving both out leaves it to config.json", () => {
        expect(resolveSettings(parse(["--no-utxo-index"]), { utxoIndex: true }).settings.utxoIndex).toBe(false);
        expect(resolveSettings(parse([]), { utxoIndex: false }).settings.utxoIndex).toBe(false);
    });

    test("bad values are refused with the flag's name", () => {
        expect(() => resolveSettings(parse(["--port", "abc"]), {})).toThrow(/--?port|port must be an integer/);
        expect(() => resolveSettings(parse(["--ledger-store", "mysql"]), {})).toThrow(/ledger-store must be one of/);
        expect(() => resolveSettings(parse([]), { blockFsync: "sometimes" })).toThrow(/config.json blockFsync/);
    });

    test("--set writes any config.json key, JSON values parsed", () => {
        const { config } = resolveSettings(parse(["--set", "peerGovernor.targetHot=8", "--set", "n2n.publicAddress=1.2.3.4:3001"]), { peerGovernor: { targetHot: 6 } });
        expect((config.peerGovernor as { targetHot: number }).targetHot).toBe(8);
        expect((config.n2n as { publicAddress: string }).publicAddress).toBe("1.2.3.4:3001");
    });

    test("a secret has no plain flag: it comes from config.json or a file", () => {
        const dir = mkdtempSync(join(tmpdir(), "settings-"));
        writeFileSync(join(dir, "bf"), "previewABC\n");
        expect(resolveSettings(parse(["--blockfrost-project-id-file", join(dir, "bf")]), {}).settings.blockfrostProjectId).toBe("previewABC");
        expect(resolveSettings(parse([]), { blockfrostProjectId: "fromConfig" }).settings.blockfrostProjectId).toBe("fromConfig");
        expect(() => parse(["--blockfrost-project-id", "x"])).toThrow();
    });
});

describe("settings: no environment", () => {
    test("old variables are reported with their replacement flag, never read", () => {
        const env = { GEROLAMO_DB_PATH: "/x.db", GEROLAMO_PORT: "1", NETWORK: "preview", HOME: "/home/x" };
        expect(ignoredEnvironment(env).map((i) => `${i.name}->${i.flag}`)).toEqual(["NETWORK->--network", "GEROLAMO_DB_PATH->--db-path", "GEROLAMO_PORT->--port"]);
        expect(resolveSettings(parse([]), {}).settings.dbPath).toBe(SETTINGS.dbPath.default);
    });

    test("workers get the resolved settings in their first message", () => {
        initSettings({ dbPath: "/data/x.db", traceHeaders: true });
        const msg = structuredClone(settingsMessage());
        initSettings({});
        expect(receiveSettings({ id: 1 })).toBe(false);
        expect(receiveSettings(msg)).toBe(true);
        expect(settings().dbPath).toBe("/data/x.db");
        expect(settings().traceHeaders).toBe(true);
    });

    test("docs/CONFIG.md lists every setting", () => {
        const md = settingsMarkdown();
        for (const def of Object.values(SETTINGS)) expect(md).toContain(`--${def.flag}`);
    });
});

describe("loadConfig: the node's startup path", () => {
    test("network config, instance file, flags; N2N from the flag; no environment needed", async () => {
        const { loadConfig } = await import("../network/index");
        const dir = mkdtempSync(join(tmpdir(), "settings-"));
        const instance = join(dir, "config.json");
        writeFileSync(instance, JSON.stringify({ networkName: "preview", port: 3037, ledgerStore: "lmdb" }));
        const config = await loadConfig(parse(["--config", instance, "--db-path", join(dir, "p.db"), "--n2n-port", "4101", "--relay-store", "chunks"]));
        expect(settings().network).toBe("preview");
        expect(config.networkMagic).toBe(2);
        expect(config.port).toBe(3037);
        expect(config.dbPath).toBe(join(dir, "p.db"));
        expect((config as unknown as { ledgerStore: string }).ledgerStore).toBe("lmdb");
        expect((config as unknown as { relayStore: string }).relayStore).toBe("chunks"); // the flag, written back into the config
        expect(config.n2n).toMatchObject({ enabled: true, port: 4101 });
    });
});
