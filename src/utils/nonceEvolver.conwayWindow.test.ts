/**
 * Conway changed the nonce freeze from the 3k/f stability window to the 4k/f
 * randomness stabilisation window. Preview epoch 646 is the first protocol-9
 * epoch; the epoch 647 nonce computed from its headers matches Koios only with
 * the 4k/f window (bug 55, preview halted at slot 55900879).
 */
import { describe, expect, test } from "bun:test";
import { NonceEvolver } from "./nonceEvolver";
import { nonceFreezeWindowSlots, randomnessStabilisationWindowSlots, stabilityWindowSlots } from "./calcEpochNonce";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { setEpochNetwork, firstSlotOfEpoch } from "./epochFromSlotCalculations";
import fixture from "./__fixtures__/preview-epoch-646-nonces.json";

const genesis: any = { securityParam: 432, activeSlotsCoeff: 0.05, epochLength: 86400, network: "preview" };

function replay(protocolMajor: number | null): { eta0: string; freeze: number } {
    const ev = new NonceEvolver(genesis);
    ev.bootstrap(fixture.epoch, fixture.eta0Hex, { etaVHex: fixture.startEtaVHex, etaCHex: fixture.startEtaCHex, etaHHex: fixture.etaHHex });
    ev.setProtocolMajor(fixture.epoch, protocolMajor);
    for (const [slot, bnonce] of fixture.blocks as [number, string][]) ev.processBlock(slot, fromHex(bnonce), null);
    const t = ev.tickn();
    return { eta0: t.eta0Hex, freeze: t.nBeforeFreeze };
}

describe("Conway randomness stabilisation window", () => {
    setEpochNetwork("preview");

    test("window helpers: 3k/f before Conway, 4k/f from protocol 9", () => {
        expect(stabilityWindowSlots(432, 0.05)).toBe(25920);
        expect(randomnessStabilisationWindowSlots(432, 0.05)).toBe(34560);
        expect(nonceFreezeWindowSlots(432, 0.05, 8)).toBe(25920);
        expect(nonceFreezeWindowSlots(432, 0.05, 9)).toBe(34560);
        expect(nonceFreezeWindowSlots(432, 0.05, null)).toBe(25920);
    });

    test("preview epoch 647 nonce matches Koios with the 4k/f window under protocol 9", () => {
        const conway = replay(9);
        expect(conway.eta0).toBe(fixture.koiosEta0NextHex);
        const first647 = Number(firstSlotOfEpoch(647));
        const expectedFreeze = (fixture.blocks as [number, string][]).filter(([s]) => s + 34560 < first647).length;
        expect(conway.freeze).toBe(expectedFreeze);
    });

    test("the 3k/f window gives a different nonce (the pre-fix behaviour)", () => {
        const babbage = replay(8);
        expect(babbage.eta0).not.toBe(fixture.koiosEta0NextHex);
        expect(replay(null).eta0).toBe(babbage.eta0);
    });

    test("the version of the latest known epoch applies to later epochs", () => {
        const ev = new NonceEvolver(genesis);
        ev.setProtocolMajor(640, 8);
        ev.setProtocolMajor(646, 9);
        expect(ev.freezeWindowFor(645)).toBe(25920);
        expect(ev.freezeWindowFor(646)).toBe(34560);
        expect(ev.freezeWindowFor(700)).toBe(34560);
        expect(ev.freezeWindowFor(600)).toBe(25920);
    });
});
