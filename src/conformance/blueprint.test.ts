/**
 * Cardano Blueprint ledger conformance vectors (2 574 transactions dumped from cardano-ledger's
 * Conway ImpSpec suite) through Gerolamo's two transaction entry points (blueprint/harness.ts): the
 * block path (validation worker job + governance + certificate sequence, with the resulting state
 * compared) and the mempool admission path (`ValidatingMempool.addTx`). Prints the pass table by
 * spec and rule family. Provenance and the pin: __vectors__/README.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { logger, LogLevel } from "../utils/logger";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readTarGz } from "./tar";
import { familyOf, runVector, runVectorMempool, vectorsOf, withImpGeometry, type BlueprintVector, type VectorOutcome } from "./blueprint/harness";

/** sha256 of cardano-blueprint 0f0c17e1 `src/ledger/conformance-test-vectors/vectors.tar.gz` (= ouroboros-mock 6bfd701 `conformance/blueprint-vectors.tar.gz`). */
const ARCHIVE_SHA256 = "574ff7a17857dfc1f0cf477f7eb9eba1c2a0f901453396a779de4b2392ef6863";

/**
 * Vectors whose verdict is known to differ, with the reason (harness limitation, a predicate this
 * node does not model, or an open bug). Empty: every vector agrees.
 */
const KNOWN: Record<string, string> = {};

const archive = readFileSync(new URL("./__vectors__/blueprint-vectors.tar.gz", import.meta.url));

describe("Cardano Blueprint ledger conformance vectors", () => {
    // the mempool and the ChainSync host log every transaction / message at info level
    let level = LogLevel.INFO;
    beforeAll(() => { level = logger.logLevel; logger.setLogLevel(LogLevel.WARN); });
    afterAll(() => logger.setLogLevel(level));

    test("the vendored archive is the pinned corpus", () => {
        expect(createHash("sha256").update(archive).digest("hex")).toBe(ARCHIVE_SHA256);
        const { vectors, pparams } = vectorsOf(readTarGz(new Uint8Array(archive)));
        expect(vectors.length).toBe(2574);
        expect(pparams.size).toBe(78);
    });

    test("every vector: accept/reject as cardano-ledger's LEDGER rule, and the same resulting UTxO set, fee and deposit pots", async () => {
        const { vectors, pparams } = vectorsOf(readTarGz(new Uint8Array(archive)));
        const results: Array<{ v: BlueprintVector; o: VectorOutcome | null; error: string | null }> = [];
        await withImpGeometry(async () => {
            for (const v of vectors) {
                try { results.push({ v, o: await runVector(v, pparams), error: null }); }
                catch (e) { results.push({ v, o: null, error: (e as Error).message }); }
            }
        });

        const table = new Map<string, { total: number; pass: number; rejects: number }>();
        const mismatches: string[] = [], stateDiffs: string[] = [], errors: string[] = [];
        let pass = 0;
        for (const { v, o, error } of results) {
            const f = familyOf(v.test);
            const key = `${f.spec}.${f.rule}`;
            const row = table.get(key) ?? { total: 0, pass: 0, rejects: 0 };
            row.total++;
            if (!v.success) row.rejects++;
            const name = `${v.test}/${v.index}`;
            if (error) errors.push(`${name}: ${error}`);
            else if (o!.accepted === v.success) { row.pass++; pass++; }
            else if (!KNOWN[name]) mismatches.push(`${name}: expected ${v.success ? "accept" : "reject"}, got ${o!.accepted ? "accept" : `reject (${o!.failures.slice(0, 2).join(" | ")})`}`);
            if (o?.stateDiffs.length) stateDiffs.push(`${name}: ${o.stateDiffs.slice(0, 2).join(" | ")}`);
            table.set(key, row);
        }
        const lines = [...table].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, r]) => `  ${k.padEnd(28)} ${String(r.pass).padStart(4)}/${String(r.total).padEnd(4)} (${r.rejects} expected rejections)`);
        console.log(`Blueprint ledger vectors: ${pass}/${results.length} verdicts agree, ${stateDiffs.length} resulting-state differences, ${errors.length} harness errors\n${lines.join("\n")}`);

        expect(errors).toEqual([]);
        expect(mismatches).toEqual([]);
        expect(stateDiffs).toEqual([]);
        // not vacuous: every expected rejection was rejected by a named rule
        const rejected = results.filter(({ v, o }) => !v.success && o && !o.accepted);
        expect(rejected.length).toBe(results.filter(({ v }) => !v.success).length);
        expect(rejected.every(({ o }) => o!.failures.length > 0 && !o!.failures.some((f) => f.startsWith("block does not decode")))).toBe(true);
    }, 300_000);

    test("every vector: the mempool admits exactly what the LEDGER rule accepts", async () => {
        const { vectors, pparams } = vectorsOf(readTarGz(new Uint8Array(archive)));
        const mismatches: string[] = [];
        let pass = 0;
        await withImpGeometry(async () => {
            for (const v of vectors) {
                const name = `${v.test}/${v.index}`;
                let accepted: boolean | null = null, why = "";
                try { const r = await runVectorMempool(v, pparams); accepted = r.accepted; why = r.reasons.slice(0, 2).join(" | "); }
                catch (e) { why = `harness error: ${(e as Error).message}`; }
                if (accepted === v.success) pass++;
                else if (!KNOWN[`mempool:${name}`]) mismatches.push(`${name}: expected ${v.success ? "accept" : "reject"}, got ${accepted === null ? why : accepted ? "accept" : `reject (${why})`}`);
            }
        });
        console.log(`Blueprint ledger vectors, mempool admission path: ${pass}/${vectors.length} verdicts agree`);
        expect(mismatches).toEqual([]);
    }, 300_000);
});
