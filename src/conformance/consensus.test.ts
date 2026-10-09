/**
 * ouroboros-mock consensus scenarios (captured from cardano-node peers) through Gerolamo's Praos
 * chain selection (ChainSelDriver) and its N2N ChainSync server (consensus/replay.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { logger, LogLevel } from "../utils/logger";
import { readdirSync, readFileSync } from "node:fs";
import { runConsensusVector, type ConsensusVector } from "./consensus/replay";

const dir = new URL("./__vectors__/consensus/", import.meta.url);
const vectors = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ name: f.replace(/\.json$/, ""), v: JSON.parse(readFileSync(new URL(f, dir), "utf8")) as ConsensusVector }));

/**
 * Scenarios whose oracle final tip is a block no peer served a header for (the capture stopped one
 * or more headers before the tip the oracle node held). A node selecting among received headers
 * cannot end there; these must pass every other check (tip = the last served header, same served
 * downstream messages apart from the advertised tip).
 */
const UNSERVED_FINAL_TIP = new Set(["intersect_origin_one_rollforward", "intersect_non_origin_v1"]);

describe("ouroboros-mock consensus conformance scenarios", () => {
    // the mempool and the ChainSync host log every transaction / message at info level
    let level = LogLevel.INFO;
    beforeAll(() => { level = logger.logLevel; logger.setLogLevel(LogLevel.WARN); });
    afterAll(() => logger.setLogLevel(level));

    test("the pinned corpus: seven scenarios", () => {
        expect(vectors.map((x) => x.name)).toEqual([
            "exceeds_k_no_switch_v1", "fork_and_select_v1", "intersect_non_origin_v1", "intersect_origin_one_rollforward",
            "slot_battle_v1", "within_k_fork_v1", "within_k_fork_winner_first_v1",
        ]);
    });

    for (const { name, v } of vectors) {
        test(name, async () => {
            const r = await runConsensusVector(v);
            expect(r.replay.headersFed).toBeGreaterThan(0); // not vacuous
            if (UNSERVED_FINAL_TIP.has(name)) {
                expect(r.unservedFinalTip).not.toBeNull();
                expect(r.tipAgnosticErrors).toEqual([]);
                expect(r.errors.every((e) => e.startsWith("final_tip:") || e.startsWith("downstream ChainSync message 0:"))).toBe(true);
            } else {
                expect(r.unservedFinalTip).toBeNull();
                expect(r.errors).toEqual([]);
            }
            if (v.capture.expected_output.expected_rollback) expect(r.replay.switches.length).toBeGreaterThan(0);
        });
    }

    test("k is applied: the exceeds-k scenario switches when k is large enough", async () => {
        const v = vectors.find((x) => x.name === "exceeds_k_no_switch_v1")!.v;
        const loose: ConsensusVector = { ...v, capture: { ...v.capture, security_param: 100 } };
        const r = await runConsensusVector(loose);
        expect(r.replay.switches.length).toBe(1);
        expect(r.errors.some((e) => e.startsWith("final_tip:"))).toBe(true);
    });
});
