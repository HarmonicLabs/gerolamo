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

describe("NonceEvolver lab nonce", () => {
    setEpochNetwork("preprod");
    const epoch = 6;
    const first = Number(firstSlotOfEpoch(epoch));
    const next = Number(firstSlotOfEpoch(epoch + 1));
    const eta0 = bytes(1);

    test("the lab nonce is the parent hash of the last applied block", () => {
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(epoch, toHex(eta0));
        const lastPrev = bytes(42);
        ev.processBlock(first + 20, bytes(2), bytes(3));
        ev.processBlock(first + 40, bytes(4), lastPrev);
        expect(ev.snapshot().etaHHex).toBe(toHex(prevHashToNonce(lastPrev)));

        // TICKN must mix that same last parent hash, not the carried lab nonce.
        const expected = toHex(ticknNewEpochNonce(
            Uint8Array.from(Buffer.from(ev.snapshot().etaCHex, "hex")),
            prevHashToNonce(lastPrev),
        ));
        expect(ev.tickn().eta0Hex).toBe(expected);
    });

    test("two chains with the same blocks but different last parents produce different epoch nonces", () => {
        const run = (lastPrev: Uint8Array): string => {
            const ev = new NonceEvolver(genesis);
            ev.bootstrap(epoch, toHex(eta0));
            ev.processBlock(first + 20, bytes(2), bytes(3));
            ev.processBlock(first + 40, bytes(4), lastPrev);
            return ev.tickn().eta0Hex;
        };
        expect(run(bytes(42))).not.toBe(run(bytes(43)));
    });

    test("the first Shelley epoch TICKN uses NeutralNonce for the lab", () => {
        const firstShelley = Number(firstSlotOfEpoch(4));
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(4, toHex(eta0));
        ev.processBlock(firstShelley + 20, bytes(2), bytes(3));
        ev.processBlock(firstShelley + 40, bytes(4), bytes(5));
        expect(ev.tickn().eta0Hex).toBe(ev.snapshot().etaCHex);
    });

    test("a replay from etaV/etaC rebuilds the per-block lab nonce", () => {
        const source = new NonceEvolver(genesis);
        source.bootstrap(epoch, toHex(eta0));
        source.processBlock(first + 20, bytes(2), bytes(3));
        source.processBlock(first + 40, bytes(4), bytes(5));
        const snap = source.snapshot();

        const restored = new NonceEvolver(genesis);
        restored.bootstrap(epoch, toHex(eta0), { etaVHex: snap.etaVHex, etaCHex: snap.etaCHex, atSlot: first + 40 });
        const lastPrev = bytes(6);
        restored.processBlock(first + 60, bytes(7), lastPrev);
        expect(restored.snapshot().etaHHex).toBe(toHex(prevHashToNonce(lastPrev)));
        const beforeTickn = restored.snapshot();
        expect(restored.tickn().eta0Hex).toBe(toHex(ticknNewEpochNonce(
            Uint8Array.from(Buffer.from(beforeTickn.etaCHex, "hex")),
            prevHashToNonce(lastPrev),
        )));
    });
});
