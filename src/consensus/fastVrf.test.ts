import { describe, expect, test } from "bun:test";
import { VrfProof03 } from "@harmoniclabs/crypto";
import { vrf03Prove } from "./fastVrf";
import { ed25519 } from "@noble/curves/ed25519";
import { vrf03ProofToHash, vrf03Verify } from "./fastVrf";

const sk = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const pk = ed25519.getPublicKey(sk);

describe("fast ECVRF draft-03", () => {
    test("agrees with the reference implementation on generated proofs", () => {
        for (let k = 0; k < 5; k++) {
            const alpha = new Uint8Array(32 + k).map((_, i) => (i * 7 + k) & 0xff);
            const proof = VrfProof03.generate(sk, pk, alpha);
            const bytes = proof.toBytes();
            expect(bytes.length).toBe(80);
            expect(proof.verify(pk, alpha)).toBe(true);
            const out = vrf03Verify(pk, alpha, bytes);
            expect(out).not.toBeNull();
            expect(Buffer.from(out!).toString("hex")).toBe(Buffer.from(proof.toHash()).toString("hex"));
            expect(Buffer.from(vrf03ProofToHash(bytes)!).toString("hex")).toBe(Buffer.from(proof.toHash()).toString("hex"));
        }
    });
    test("rejects a tampered proof, a wrong key and a wrong input", () => {
        const alpha = new Uint8Array(40).map((_, i) => i);
        const bytes = VrfProof03.generate(sk, pk, alpha).toBytes();
        const bad = Uint8Array.from(bytes);
        bad[40] ^= 1; // challenge byte
        expect(vrf03Verify(pk, alpha, bad)).toBeNull();
        const badS = Uint8Array.from(bytes);
        badS[50] ^= 1;
        expect(vrf03Verify(pk, alpha, badS)).toBeNull();
        expect(vrf03Verify(ed25519.getPublicKey(new Uint8Array(32).fill(9)), alpha, bytes)).toBeNull();
        expect(vrf03Verify(pk, alpha.slice(1), bytes)).toBeNull();
        expect(vrf03Verify(pk, alpha, bytes.slice(1))).toBeNull();
    });

    test("vrf03Prove reproduces VrfProof03.generate byte for byte and verifies", () => {
        for (let k = 0; k < 6; k++) {
            const seed = new Uint8Array(32).map((_, i) => (i * 29 + k * 7 + 3) & 0xff);
            const pub = ed25519.getPublicKey(seed);
            const alpha = new Uint8Array(40 + k).map((_, i) => (i * 11 + k) & 0xff);
            const ours = vrf03Prove(seed, pub, alpha);
            const ref = VrfProof03.generate(seed, pub, alpha).toBytes();
            expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(ref).toString("hex"));
            const out = vrf03Verify(pub, alpha, ours);
            expect(out).not.toBeNull();
            expect(Buffer.from(out!).toString("hex")).toBe(Buffer.from(VrfProof03.generate(seed, pub, alpha).toHash()).toString("hex"));
        }
        const seed = new Uint8Array(32).map((_, i) => i);
        const pub = ed25519.getPublicKey(seed);
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) vrf03Prove(seed, pub, new Uint8Array(40).map((_, j) => (i + j) & 0xff));
        const ms = (performance.now() - t0) / 200;
        console.log(`  vrf03Prove ${ms.toFixed(2)} ms/proof`);
        expect(ms).toBeLessThan(10);
    });
});
