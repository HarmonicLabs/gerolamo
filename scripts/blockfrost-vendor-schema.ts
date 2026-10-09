#!/usr/bin/env bun
/**
 * Refresh the vendored Blockfrost response schemas the API shape tests validate against:
 * the 200 responses of every path in @blockfrost/openapi's json-schema.json (descriptions and
 * examples stripped), written to src/api/blockfrost/blockfrost-openapi.responses.json.
 *   bun scripts/blockfrost-vendor-schema.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "node_modules/@blockfrost/openapi/package.json"), "utf8"));
const all = JSON.parse(readFileSync(join(root, "node_modules/@blockfrost/openapi/json-schema.json"), "utf8"));
const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (!x || typeof x !== "object") return x;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
        if (k === "description" || k === "example" || k === "deprecated") continue;
        o[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, strip(s)])) : strip(v);
    }
    return o;
};
const paths: Record<string, unknown> = {};
for (const [p, e] of Object.entries(all as Record<string, any>)) if (e?.response?.["200"]) paths[p] = strip(e.response["200"]);
const out = join(root, "src/api/blockfrost/blockfrost-openapi.responses.json");
writeFileSync(out, JSON.stringify({ source: `@blockfrost/openapi ${pkg.version} json-schema.json (200 responses)`, paths }, null, 0) + "\n");
console.log(`${Object.keys(paths).length} paths → ${out}`);
