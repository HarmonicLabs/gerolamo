import { describe, expect, test } from "bun:test";
import { isSlotLeader } from "./leaderMath";

const bytes = (fill: number, len = 32) => new Uint8Array(len).fill(fill);

describe("isSlotLeader", () => {
    test("no stake never leads; full stake with a tiny value leads", () => {
        expect(isSlotLeader(bytes(0x00), { num: 0n, den: 1n }, 0.05)).toBe(false);
        expect(isSlotLeader(bytes(0x00), { num: 1n, den: 1n }, 0.05)).toBe(true);
    });
    test("threshold follows σ: a value that is not below 1−(1−f)^σ fails", () => {
        // σ = 1, f = 0.05 → threshold p < 0.05; value 0x0c.. ≈ 0.047 leads, 0x0e.. ≈ 0.055 does not
        expect(isSlotLeader(bytes(0x0c), { num: 1n, den: 1n }, 0.05)).toBe(true);
        expect(isSlotLeader(bytes(0x0e), { num: 1n, den: 1n }, 0.05)).toBe(false);
        // σ = 0.01 → threshold ≈ 0.000513; 0x00,0x20.. ≈ 0.00049 leads, 0x00,0x22.. ≈ 0.00052 does not
        const lo = new Uint8Array(32); lo[1] = 0x20;
        const hi = new Uint8Array(32); hi[1] = 0x22;
        expect(isSlotLeader(lo, { num: 1n, den: 100n }, 0.05)).toBe(true);
        expect(isSlotLeader(hi, { num: 1n, den: 100n }, 0.05)).toBe(false);
    });
    test("64-byte TPraos values use a 2^512 bound", () => {
        expect(isSlotLeader(bytes(0x0c, 64), { num: 1n, den: 1n }, 0.05)).toBe(true);
        expect(isSlotLeader(bytes(0x0e, 64), { num: 1n, den: 1n }, 0.05)).toBe(false);
    });
});
