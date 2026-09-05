import { describe, expect, test } from "bun:test";
import { vrf03Verify } from "../consensus/fastVrf";
import { praosVrfInput } from "../consensus/vrfInputs";
import { praosLeaderValue } from "../consensus/workers/validationJob";
import { isSlotLeader } from "../consensus/rules/leaderMath";
import { generateVrfKey } from "./keystore";
import { expectedLeaderSlots, leaderSlotsForEpoch, leadsSlot } from "./leaderSchedule";

const vrf = generateVrfKey(new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff));
const nonceHex = "aa72206c1e2884c06e32970f7d383c59f28b2046434c5bb456c105f344ca154c"; // preview epoch 333 η0

describe("leader schedule", () => {
    test("every claimed slot passes the header-side leader check with the proof's output; σ = 0 never leads", () => {
        // (fast prover; the BigInt reference took 37 ms per slot)
        const first = 333n * 86400n;
        const window = 2000n;
        const t0 = performance.now();
        const slots = leaderSlotsForEpoch({ epoch: 333, nonceHex, sigma: { num: 1n, den: 4n }, activeSlotsCoeff: 0.05, vrf, network: "preview", fromSlot: first, toSlot: first + window });
        const ms = performance.now() - t0;
        console.log(`  ${window} slots in ${ms.toFixed(0)} ms (${(ms / Number(window)).toFixed(2)} ms/slot), ${slots.length} leader slots, expected ≈ ${expectedLeaderSlots({ num: 1n, den: 4n }, 0.05, window).toFixed(1)}`);
        // f·σ·n = 25 ± noise: accept a wide band, but not zero and not all
        expect(slots.length).toBeGreaterThan(5);
        expect(slots.length).toBeLessThan(60);
        const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
        for (const s of slots) {
            expect(s.slot >= first && s.slot < first + window).toBe(true);
            expect(s.slotInEpoch).toBe(s.slot - first);
            // regenerate the proof and verify it as the header validator would
            const { output } = leadsSlot(vrf, s.slot, nonce, { num: 1n, den: 4n }, 0.05);
            expect(Buffer.from(output).toString("hex")).toBe(s.vrfOutputHex);
            expect(isSlotLeader(praosLeaderValue(output), { num: 1n, den: 4n }, 0.05)).toBe(true);
        }
        // a slot we did not claim must fail the same check
        const claimed = new Set(slots.map((s) => s.slot.toString()));
        let checked = 0;
        for (let slot = first; slot < first + 200n && checked < 50; slot++) {
            if (claimed.has(slot.toString())) continue;
            const { leads } = leadsSlot(vrf, slot, nonce, { num: 1n, den: 4n }, 0.05);
            expect(leads).toBe(false);
            checked++;
        }
        // σ = 0 (no stake) leads nothing; σ = 1 (whole stake) leads ≈ f of the slots and is a superset
        expect(leaderSlotsForEpoch({ epoch: 333, nonceHex, sigma: { num: 0n, den: 1n }, activeSlotsCoeff: 0.05, vrf, network: "preview", fromSlot: first, toSlot: first + 300n })).toEqual([]);
        const full = leaderSlotsForEpoch({ epoch: 333, nonceHex, sigma: { num: 1n, den: 1n }, activeSlotsCoeff: 0.05, vrf, network: "preview", fromSlot: first, toSlot: first + window });
        expect(full.length).toBeGreaterThanOrEqual(slots.length);
        for (const s of slots) expect(claimedIn(full, s.slot)).toBe(true);
        // the time column follows preview geometry (1 s slots from 2022-10-25T00:00:00Z)
        expect(slots[0]!.time).toBe(new Date((1666656000 + Number(slots[0]!.slot)) * 1000).toISOString());
    }, 120_000);

    test("the proof the schedule is built from verifies with the fast verifier", () => {
        const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
        const slot = 333n * 86400n + 17n;
        const { output } = leadsSlot(vrf, slot, nonce, { num: 1n, den: 2n }, 0.05);
        const { VrfProof03 } = require("@harmoniclabs/crypto");
        const proof = VrfProof03.generate(vrf.skey.subarray(0, 32), vrf.vkey, praosVrfInput(slot, nonce));
        const verified = vrf03Verify(vrf.vkey, praosVrfInput(slot, nonce), proof.toBytes());
        expect(verified).not.toBeNull();
        expect(Buffer.from(verified!).toString("hex")).toBe(Buffer.from(output).toString("hex"));
    });

    test("rejects ranges outside the epoch and bad nonces", () => {
        expect(() => leaderSlotsForEpoch({ epoch: 333, nonceHex, sigma: { num: 1n, den: 1n }, activeSlotsCoeff: 0.05, vrf, network: "preview", fromSlot: 0n, toSlot: 10n })).toThrow(/outside epoch/);
        expect(() => leaderSlotsForEpoch({ epoch: 333, nonceHex: "zz", sigma: { num: 1n, den: 1n }, activeSlotsCoeff: 0.05, vrf, network: "preview" })).toThrow(/32 bytes hex/);
    });
});

function claimedIn(list: { slot: bigint }[], slot: bigint): boolean {
    return list.some((s) => s.slot === slot);
}
