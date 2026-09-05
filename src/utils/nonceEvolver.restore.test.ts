/**
 * A mid-epoch restart must not change the next epoch's nonce: an evolver
 * restored from a snapshot (ηv, ηc, ηh) at some block of epoch e must produce
 * the same η0(e+1) as one that ran continuously.
 */
import { describe, expect, test } from "bun:test";
import { NonceEvolver } from "./nonceEvolver";
import { prevHashToNonce } from "./calcEpochNonce";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { setEpochNetwork, firstSlotOfEpoch } from "./epochFromSlotCalculations";

const genesis: any = { securityParam: 2160, activeSlotsCoeff: 0.05, epochLength: 432000, network: "preprod" };
const rnd = (seed: number) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i * 17) & 0xff; return b; };

describe("NonceEvolver restore", () => {
    setEpochNetwork("preprod");
    test("restored ηv/ηc/ηh reproduce the continuous η0 at the next boundary", () => {
        const e = 6;
        const first6 = Number(firstSlotOfEpoch(e)), first7 = Number(firstSlotOfEpoch(e + 1));
        const eta0 = toHex(rnd(1));
        const cont = new NonceEvolver(genesis);
        cont.bootstrap(e, eta0);
        // blocks through epoch 6, every 20 slots
        const blocks: Array<{ slot: number; bnonce: Uint8Array; prev: Uint8Array }> = [];
        let prev = rnd(99);
        for (let s = first6; s < first7; s += 20) {
            const b = { slot: s, bnonce: rnd(s), prev };
            blocks.push(b);
            prev = rnd(s + 1);
        }
        let snapshotAt = -1;
        let snap: any = null;
        const restartIdx = Math.floor(blocks.length * 0.7);
        for (let i = 0; i < blocks.length; i++) {
            cont.processBlock(blocks[i]!.slot, blocks[i]!.bnonce, blocks[i]!.prev);
            if (i === restartIdx) { snap = cont.snapshot(); snapshotAt = i; }
        }
        const t = cont.processBlock(first7 + 5, rnd(7), rnd(8));
        expect(t.length).toBe(1);
        const continuous = t[0]!.eta0Hex;

        const restored = new NonceEvolver(genesis);
        restored.bootstrap(e, eta0, { etaVHex: snap.etaVHex, etaCHex: snap.etaCHex, etaHHex: snap.etaHHex });
        for (let i = snapshotAt + 1; i < blocks.length; i++) restored.processBlock(blocks[i]!.slot, blocks[i]!.bnonce, blocks[i]!.prev);
        const t2 = restored.processBlock(first7 + 5, rnd(7), rnd(8));
        expect(t2[0]!.eta0Hex).toBe(continuous);

        // and without ηh the restart is wrong (the preprod 6→7 incident)
        const lossy = new NonceEvolver(genesis);
        lossy.bootstrap(e, eta0, { etaVHex: snap.etaVHex, etaCHex: snap.etaCHex });
        for (let i = snapshotAt + 1; i < blocks.length; i++) lossy.processBlock(blocks[i]!.slot, blocks[i]!.bnonce, blocks[i]!.prev);
        expect(lossy.processBlock(first7 + 5, rnd(7), rnd(8))[0]!.eta0Hex === continuous).toBe(snap.etaHHex == null);
        void prevHashToNonce;
    });
    test("peekNextEpochNonceHex matches the boundary's TICKN once the candidate is frozen", () => {
        const e = 6;
        const first6 = Number(firstSlotOfEpoch(e)), first7 = Number(firstSlotOfEpoch(e + 1));
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(e, toHex(rnd(3)));
        let prev = rnd(50);
        let lastSlot = first6;
        for (let s = first6; s < first7; s += 20) { ev.processBlock(s, rnd(s), prev); prev = rnd(s + 1); lastSlot = s; }
        const peek = ev.peekNextEpochNonceHex(lastSlot);
        expect(peek).not.toBeNull();
        const t = ev.processBlock(first7 + 3, rnd(9), rnd(10));
        expect(t[0]!.eta0Hex).toBe(peek!);
        // before the freeze the peek is withheld
        const early = new NonceEvolver(genesis);
        early.bootstrap(e, toHex(rnd(3)));
        early.processBlock(first6 + 20, rnd(1), rnd(2));
        expect(early.peekNextEpochNonceHex(first6 + 20)).toBeNull();
    });
});
