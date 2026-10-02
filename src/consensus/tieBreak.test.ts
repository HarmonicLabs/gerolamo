import { describe, expect, test } from "bun:test";
import { blake2b_256 } from "@harmoniclabs/crypto";
import fixture from "./__fixtures__/slot-battle-123773790.json";
import race from "./__fixtures__/restricted-vrf-race-123973034.json";
import { CONWAY_RESTRICTED_VRF, UNRESTRICTED_VRF, comparePraos, preferByTieBreak, tieBreakInfoOf, vrfFlavorForEra } from "./tieBreak";

const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("Praos tie-break", () => {
    test("real preview slot battle (slot 123 773 790): picks the block the network kept", () => {
        const w = bytes(fixture.winner.header), l = bytes(fixture.loser.header);
        // the fixture headers are the real ones: their hashes are the block hashes
        expect(Buffer.from(blake2b_256(w)).toString("hex")).toBe(fixture.winner.hash);
        expect(Buffer.from(blake2b_256(l)).toString("hex")).toBe(fixture.loser.hash);
        const a = tieBreakInfoOf(w)!, b = tieBreakInfoOf(l)!;
        expect(a.vrfOutput.length).toBe(64);
        expect(a.issuer).not.toBe(b.issuer);
        expect(preferByTieBreak(a, b)).toBe("a");
        expect(preferByTieBreak(b, a)).toBe("b");
    });

    test("same pool: the higher operational certificate counter wins regardless of VRF", () => {
        const base = { issuer: "aa", vrfOutput: new Uint8Array(64).fill(1) };
        expect(preferByTieBreak({ ...base, opcertCounter: 3n }, { ...base, opcertCounter: 2n, vrfOutput: new Uint8Array(64) })).toBe("a");
        expect(preferByTieBreak({ ...base, opcertCounter: 2n }, { ...base, opcertCounter: 2n })).toBe("equal");
    });

    test("non-Shelley or malformed headers give no tie-break information", () => {
        expect(tieBreakInfoOf(new Uint8Array([0x80]))).toBeNull();
        expect(tieBreakInfoOf(new Uint8Array([0xff]))).toBeNull();
    });

    test("the fixture headers carry their slot and block number", () => {
        const a = tieBreakInfoOf(bytes(fixture.winner.header))!, b = tieBreakInfoOf(bytes(fixture.loser.header))!;
        expect(a.slot).toBe(123773790n);
        expect(b.slot).toBe(123773790n);
        expect(a.blockNo).toBe(b.blockNo!);
    });

    test("same issuer in different slots: the opcert rule is not armed (consensus 3.0 issueNoArmed)", () => {
        const lowVrf = new Uint8Array(64), highVrf = new Uint8Array(64).fill(9);
        const ours = { issuer: "aa", opcertCounter: 7n, vrfOutput: highVrf, slot: 100n };
        const cand = { issuer: "aa", opcertCounter: 3n, vrfOutput: lowVrf, slot: 101n };
        expect(comparePraos(UNRESTRICTED_VRF, ours, cand).switch).toBe(true); // VRF decides
        expect(comparePraos(UNRESTRICTED_VRF, { ...ours, slot: 101n }, cand)).toEqual({ switch: false, ord: 1 }); // same slot: opcert decides
    });

    test("restricted VRF tie-breaker (Conway): only within 5 slots", () => {
        const lowVrf = new Uint8Array(64), highVrf = new Uint8Array(64).fill(9);
        const ours = { issuer: "aa", opcertCounter: 1n, vrfOutput: highVrf, slot: 1000n };
        for (const [d, sw] of [[0n, true], [5n, true], [6n, false], [-5n, true], [-6n, false]] as const) {
            expect(comparePraos(CONWAY_RESTRICTED_VRF, ours, { issuer: "bb", opcertCounter: 1n, vrfOutput: lowVrf, slot: 1000n + d }).switch).toBe(sw);
        }
        expect(vrfFlavorForEra(0)).toBeNull();
        expect(vrfFlavorForEra(5)).toEqual(UNRESTRICTED_VRF);
        expect(vrfFlavorForEra(6)).toEqual(CONWAY_RESTRICTED_VRF);
        // symmetric wrapper: 6 slots apart in Conway → no preference, ours kept
        expect(preferByTieBreak(ours, { issuer: "bb", opcertCounter: 1n, vrfOutput: lowVrf, slot: 1006n }, CONWAY_RESTRICTED_VRF)).toBe("equal");
    });

    test("real Conway race 40 slots apart (preview 123 973 034 / 123 973 074): restricted VRF gives no preference — the unrestricted rule would have picked the block the network dropped", () => {
        const kept = { ...tieBreakInfoOf(bytes(race.kept.header))!, slot: BigInt(race.kept.slot) };
        const dead = { ...tieBreakInfoOf(bytes(race.dead.header))!, slot: BigInt(race.dead.slot) };
        expect(Buffer.from(blake2b_256(bytes(race.kept.header))).toString("hex")).toBe(race.kept.hash);
        expect(race.kept.prevHash).toBe(race.dead.prevHash);
        expect(comparePraos(CONWAY_RESTRICTED_VRF, dead, kept)).toEqual({ switch: false, ord: 0 }); // holding the dead block: no reason to switch
        expect(comparePraos(CONWAY_RESTRICTED_VRF, kept, dead)).toEqual({ switch: false, ord: 0 }); // holding the kept block: keep it
        expect(comparePraos(UNRESTRICTED_VRF, kept, dead).switch).toBe(true); // what the pre-Conway rule (and our old code) would do
    });
});
