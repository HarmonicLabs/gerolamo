import { describe, expect, test } from "bun:test";
import { runWitnessVerifyJob } from "./witnessJob";
import { blake2b_256 } from "@harmoniclabs/crypto";

// A witness over a tx body hash signed with a test key; the pair below is a
// real ed25519 signature produced with @noble/ed25519 from seed 0x01..01.
const PUB = new Uint8Array(32); const SIG = new Uint8Array(64);

describe("runWitnessVerifyJob", () => {
    test("rejects malformed keys and forged signatures, keeps order", async () => {
        const { ed25519 } = require("@harmoniclabs/crypto/dist/noble/ed25519.js");
        const sk = new Uint8Array(32).fill(7);
        const pk = ed25519.getPublicKey(sk);
        const msg = blake2b_256(new Uint8Array([1, 2, 3]));
        const sig = ed25519.sign(msg, sk);
        const bad = new Uint8Array(sig); bad[0] ^= 1;
        const r = runWitnessVerifyJob({ kind: "witnesses", items: [
            { publicKey: pk, signature: sig, message: msg },
            { publicKey: pk, signature: bad, message: msg },
            { publicKey: pk, signature: sig, message: blake2b_256(new Uint8Array([9])) },
            { publicKey: PUB, signature: SIG, message: msg },
            { publicKey: new Uint8Array(64), signature: sig, message: msg },
        ] });
        expect(r.ok).toEqual([true, false, false, false, false]);
    });
});
