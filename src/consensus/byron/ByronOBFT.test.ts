import { describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { ByronObftState, type ByronGenesisConfig } from "./ByronOBFT";
import { verifyByronBlockSignature } from "./ByronCrypto";
import { splitEraBlock } from "../bodyHash";
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import fixture from "../__fixtures__/byron-preprod.json";
import genesisJson from "../../config/preprod/byron-genesis.json";

const genesis = genesisJson as unknown as ByronGenesisConfig;
type FixtureHeader = { byronType: number; headerHex: string; hash: string };
const mains = (fixture.headers as FixtureHeader[]).filter((h) => h.byronType === 1);
const slots = [2n, 2163n]; // preprod blocks 1 and 2 (after the epoch-0 EBB)

function rawBodyOf(blockHex: string): Uint8Array {
    const { rawBlock } = splitEraBlock(fromHex(blockHex));
    const arr = Cbor.parseLazy(rawBlock) as LazyCborArray;
    return arr.array[1]!;
}

describe("ByronObftState", () => {
    test("worker-verified path (validateSignedMainHeader + noteAppliedIssuer) equals the full check", () => {
        const full = new ByronObftState(genesis);
        const split = new ByronObftState(genesis);
        mains.forEach((h, i) => {
            const raw = fromHex(h.headerHex);
            const sig = verifyByronBlockSignature(raw, genesis.protocolConsts.protocolMagic);
            expect(sig.ok).toBe(true);
            const a = full.validateMainHeader(raw, slots[i]!);
            const b = split.validateSignedMainHeader(slots[i]!, sig.issuerKeyHash!, sig.signerKeyHash!);
            expect(b).toEqual(a);
            full.noteApplied(raw, slots[i]!, rawBodyOf((fixture.blocks as string[])[i + 1]!));
            split.noteAppliedIssuer(sig.issuerKeyHash!, slots[i]!, rawBodyOf((fixture.blocks as string[])[i + 1]!));
        });
        expect(split.snapshot()).toEqual(full.snapshot());
        // A signer that is not the registered delegate is still caught by the state half.
        const r = split.validateSignedMainHeader(3000n, [...split.genesisKeys][0]!, "00".repeat(28));
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("not the registered delegate");
    });

    test("loads preprod genesis: 7 genesis keys, k=2160, threshold 475", () => {
        const st = new ByronObftState(genesis);
        expect(st.genesisKeys.size).toBe(7);
        expect(st.k).toBe(2160);
        expect(st.maxSignaturesPerWindow).toBe(475);
        expect(st.delegationMap().size).toBe(7);
    });

    test("real preprod headers pass signature, genesis-key and delegation checks", () => {
        const st = new ByronObftState(genesis);
        mains.forEach((h, i) => {
            const r = st.validateMainHeader(fromHex(h.headerHex), slots[i]!);
            expect(r.ok).toBe(true);
            expect(st.genesisKeys.has(r.issuerKeyHash!)).toBe(true);
            expect(st.delegationMap().get(r.issuerKeyHash!)).toBe(r.signerKeyHash!);
            st.noteApplied(fromHex(h.headerHex), slots[i]!, rawBodyOf((fixture.blocks as string[])[i + 1]!));
        });
        expect(st.snapshot().windowSize).toBe(2);
        expect(st.snapshot().lastSignedSlot).toBe("2163");
    });

    test("rejects a non-monotonic slot", () => {
        const st = new ByronObftState(genesis);
        st.noteApplied(fromHex(mains[1]!.headerHex), 2163n);
        const r = st.validateMainHeader(fromHex(mains[0]!.headerHex), 2n);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("last signed slot");
    });

    test("enforces the signature threshold over a k-window", () => {
        // k = 4, threshold 0.5 → at most 2 signatures per key in any window of 4.
        const st = new ByronObftState(genesis, { k: 4, signatureThreshold: 0.5 });
        const raw = fromHex(mains[0]!.headerHex);
        expect(st.validateMainHeader(raw, 2n).ok).toBe(true);
        st.noteApplied(raw, 2n);
        expect(st.validateMainHeader(raw, 3n).ok).toBe(true);
        st.noteApplied(raw, 3n);
        const third = st.validateMainHeader(raw, 4n);
        expect(third.ok).toBe(false);
        expect(third.reason).toContain("signed 3 of the last 4");
        // Different issuer is still fine.
        expect(st.validateMainHeader(fromHex(mains[1]!.headerHex), 4n).ok).toBe(true);
    });

    test("seed() rebuilds the window from stored headers", () => {
        const st = new ByronObftState(genesis, { k: 4, signatureThreshold: 0.5 });
        const raw = fromHex(mains[0]!.headerHex);
        st.seed([{ rawHeader: raw, slot: 2n }, { rawHeader: raw, slot: 3n }]);
        expect(st.snapshot().windowSize).toBe(2);
        expect(st.validateMainHeader(raw, 4n).ok).toBe(false);
    });

    test("rejects a genesis file whose certificates do not verify", () => {
        const bad = structuredClone(genesisJson) as unknown as ByronGenesisConfig;
        const first = Object.keys(bad.heavyDelegation)[0]!;
        bad.heavyDelegation[first]!.cert = "00".repeat(64);
        expect(() => new ByronObftState(bad)).toThrow(/does not verify/);
    });
});
