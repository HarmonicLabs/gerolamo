import { describe, expect, test } from "bun:test";
import { getEd25519Signature_sync, deriveEd25519PublicKey_sync, verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { ed25519ImplName, verifyEd25519Fast } from "./fastEd25519";

describe("fastEd25519", () => {
    const sk = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    const pk = deriveEd25519PublicKey_sync(sk);
    const msg = new TextEncoder().encode("gerolamo header body");
    const sig = getEd25519Signature_sync(msg, sk);

    test("uses the noble implementation and agrees with the slow verifier", () => {
        expect(ed25519ImplName()).toBe("noble");
        expect(verifyEd25519Fast(sig, msg, pk)).toBe(true);
        expect(verifyEd25519Signature_sync(sig, msg, pk)).toBe(true);
    });

    test("rejects tampered message, signature and key without throwing", () => {
        const badMsg = new Uint8Array(msg); badMsg[0] ^= 1;
        const badSig = new Uint8Array(sig); badSig[10] ^= 1;
        const badPk = new Uint8Array(pk); badPk[0] ^= 1;
        expect(verifyEd25519Fast(sig, badMsg, pk)).toBe(false);
        expect(verifyEd25519Fast(badSig, msg, pk)).toBe(false);
        expect(verifyEd25519Fast(sig, msg, badPk)).toBe(false);
        expect(verifyEd25519Fast(new Uint8Array(3), msg, pk)).toBe(false);
    });

    test("is fast: 200 verifies well under a second", () => {
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) verifyEd25519Fast(sig, msg, pk);
        expect(performance.now() - t0).toBeLessThan(1000);
    });
});
