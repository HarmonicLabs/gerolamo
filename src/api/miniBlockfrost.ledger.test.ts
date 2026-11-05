import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withSettings } from "../config/settings";
import { handleMiniBlockfrost } from "./miniBlockfrost";

describe("Gerolamo ledger peer routes", () => {
    test("serves raw tables and meta with CORS from the configured ledger directory", async () => {
        const root = mkdtempSync(join(tmpdir(), "gerolamo-ledger-api-"));
        const ledgerDir = join(root, "ledger");
        mkdirSync(join(ledgerDir, "122735066"), { recursive: true });
        writeFileSync(join(ledgerDir, "122735066", "tables"), new Uint8Array([1, 2, 3, 4]));
        writeFileSync(join(ledgerDir, "122735066", "meta"), JSON.stringify({ backend: "utxohd-mem", tablesCodecVersion: 1 }));
        const restore = withSettings({ dbPath: join(root, "node.db"), ledgerDir });
        try {
            for (const [path, expected] of [["tables", [1, 2, 3, 4]], ["meta", 75]] as const) {
                const url = new URL(`http://node:3030/api/v0/gerolamo/ledger/122735066/${path}`);
                const res = await handleMiniBlockfrost(new Request(url), url, { network: "preview" });
                expect(res).not.toBeNull();
                expect(res!.status).toBe(200);
                expect(res!.headers.get("access-control-allow-origin")).toBe("*");
                expect(res!.headers.get("X-Gerolamo-Api")).toBe(path === "tables" ? "ledger-tables" : "ledger-meta");
                const bytes = new Uint8Array(await res!.arrayBuffer());
                if (path === "tables") expect([...bytes]).toEqual([...expected]);
                else expect(bytes.length).toBeGreaterThan(0);
            }
        } finally { restore(); }
    });
});
