import { describe, expect, test } from "bun:test";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { NonceEvolver } from "./nonceEvolver";
import { prevHashToNonce, ticknNewEpochNonce } from "./calcEpochNonce";
import { setEpochNetwork, firstSlotOfEpoch } from "./epochFromSlotCalculations";

const genesis: any = { securityParam: 2160, activeSlotsCoeff: 0.05, epochLength: 432000, network: "preprod" };
const bytes = (seed: number): Uint8Array => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 17) & 0xff;
    return out;
};
const hex = (b: Uint8Array) => toHex(b);

describe("NonceEvolver lab nonce", () => {
    setEpochNetwork("preprod");
    const epoch = 6;
    const first = Number(firstSlotOfEpoch(epoch));
    const eta0 = bytes(1);

    test("TICKN uses the carried lab nonce, then stores the closing parent for the next boundary", () => {
        const carried = prevHashToNonce(bytes(3));
        const lastPrev = bytes(42);
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(epoch, hex(eta0), { etaHHex: hex(carried) });
        ev.processBlock(first + 20, bytes(2), bytes(4));
        ev.processBlock(first + 40, bytes(5), lastPrev);

        // Praos: the nonce for this boundary uses the CARRIED lastEpochBlockNonce.
        expect(ev.snapshot().etaHHex).toBe(hex(carried));
        const expected = hex(ticknNewEpochNonce(
            Uint8Array.from(Buffer.from(ev.snapshot().etaCHex, "hex")),
            carried,
        ));
        expect(ev.tickn().eta0Hex).toBe(expected);

        // The stored lab for the NEXT boundary is the closing epoch's parent hash.
        expect(ev.snapshot().etaHHex).toBe(hex(prevHashToNonce(lastPrev)));
    });

    test("two chains with the same blocks but different carried labs produce different epoch nonces", () => {
        const run = (carried: Uint8Array): string => {
            const ev = new NonceEvolver(genesis);
            ev.bootstrap(epoch, hex(eta0), { etaHHex: hex(carried) });
            ev.processBlock(first + 20, bytes(2), bytes(4));
            ev.processBlock(first + 40, bytes(5), bytes(6));
            return ev.tickn().eta0Hex;
        };
        expect(run(prevHashToNonce(bytes(42)))).not.toBe(run(prevHashToNonce(bytes(43))));
    });

    test("the first Shelley epoch TICKN uses NeutralNonce for the lab", () => {
        const firstShelley = Number(firstSlotOfEpoch(4));
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(4, hex(eta0));
        ev.processBlock(firstShelley + 20, bytes(2), bytes(3));
        ev.processBlock(firstShelley + 40, bytes(4), bytes(5));
        expect(ev.tickn().eta0Hex).toBe(ev.snapshot().etaCHex);
        expect(ev.snapshot().etaHHex).toBe(hex(prevHashToNonce(bytes(5))));
    });

    test("a mid-epoch restore keeps the carried lab and advances it only at TICKN", () => {
        const carried = prevHashToNonce(bytes(7));
        const lastPrev = bytes(8);
        const source = new NonceEvolver(genesis);
        source.bootstrap(epoch, hex(eta0), { etaHHex: hex(carried) });
        source.processBlock(first + 20, bytes(2), bytes(9));
        source.processBlock(first + 40, bytes(3), lastPrev);
        const snap = source.snapshot();

        const restored = new NonceEvolver(genesis);
        restored.bootstrap(epoch, hex(eta0), { etaVHex: snap.etaVHex, etaCHex: snap.etaCHex, etaHHex: snap.etaHHex, atSlot: first + 40 });
        expect(restored.snapshot().etaHHex).toBe(hex(carried));
        restored.processBlock(first + 60, bytes(10), bytes(11));
        expect(restored.snapshot().etaHHex).toBe(hex(carried));
        const beforeTickn = restored.snapshot();
        expect(restored.tickn().eta0Hex).toBe(hex(ticknNewEpochNonce(
            Uint8Array.from(Buffer.from(beforeTickn.etaCHex, "hex")),
            carried,
        )));
        expect(restored.snapshot().etaHHex).toBe(hex(prevHashToNonce(bytes(11))));
    });
});
