import { describe, expect, test } from "bun:test";
import { VrfProof03 } from "@harmoniclabs/crypto";
import {
    checkOperationalCert, decodeIssueCounter, encodeIssueCounter, encodeOperationalCert, evolveKesTo, generateColdKey, generateKesKey, generateVrfKey,
    issueOperationalCert, kesEvolution, kesSecretForEnvelope, kesSignAt, kesVerifyAt, loadColdSigningKey, loadColdVerificationKey, loadKesSigningKey, loadVrfSigningKey,
    poolIdOf, readIssueCounter, readOperationalCert, readTextEnvelope, toLedgerOpcert, vrfKeyHashOf, vrfProvingKey, envelopeOfBytes, EnvelopeType,
} from "./keystore";

// Throwaway keys generated with cardano-cli 11.0 (`node key-gen`, `key-gen-KES`, `key-gen-VRF`,
// `issue-op-cert --kes-period 123`, `key-hash-VRF`, `stake-pool id`). Test fixtures only.
const F = (name: string) => new URL(`./__fixtures__/cli-keys/${name}`, import.meta.url).pathname;
const text = (name: string) => require("node:fs").readFileSync(F(name), "utf8").trim();

describe("pool keystore: cardano-cli TextEnvelope interop", () => {
    test("cold key, pool id and counter", () => {
        const vkey = loadColdVerificationKey(F("cold.vkey"));
        const cold = loadColdSigningKey(F("cold.skey"));
        expect(Buffer.from(cold.vkey).toString("hex")).toBe(Buffer.from(vkey).toString("hex"));
        expect(poolIdOf(vkey)).toBe(text("pool.id"));
        const counter = readIssueCounter(F("cold.counter"));
        expect(counter.next).toBe(1n); // one certificate issued
        expect(Buffer.from(counter.coldVkey).toString("hex")).toBe(Buffer.from(vkey).toString("hex"));
        // re-encoding reproduces cardano-cli's bytes and description
        const env = readTextEnvelope(F("cold.counter"));
        expect(encodeIssueCounter(counter)).toEqual(env);
    });

    test("KES key: vkey derives from skey, signs and evolves", () => {
        const kes = loadKesSigningKey(F("kes.skey"), F("kes.vkey"));
        expect(kesEvolution(kes)).toBe(0);
        const msg = new TextEncoder().encode("header body bytes");
        const sig0 = kesSignAt(kes, msg);
        expect(sig0.length).toBe(448);
        expect(kesVerifyAt(sig0, 0, kes.vkey, msg)).toBe(true);
        expect(kesVerifyAt(sig0, 1, kes.vkey, msg)).toBe(false);
        evolveKesTo(kes, 3);
        expect(kesEvolution(kes)).toBe(3);
        const sig3 = kesSignAt(kes, msg);
        expect(kesVerifyAt(sig3, 3, kes.vkey, msg)).toBe(true);
        expect(kesVerifyAt(sig3, 0, kes.vkey, msg)).toBe(false);
        expect(() => evolveKesTo(kes, 2)).toThrow(/cannot go back/);
        expect(() => evolveKesTo(kes, 63)).toThrow(/out of range/);
    });

    test("VRF key: hash matches key-hash-VRF and proofs verify", () => {
        const vrf = loadVrfSigningKey(F("vrf.skey"), F("vrf.vkey"));
        expect(vrfKeyHashOf(vrf.vkey)).toBe(text("vrf.hash"));
        const { secret, publicKey } = vrfProvingKey(vrf);
        const alpha = new Uint8Array(64).map((_, i) => i);
        const proof = VrfProof03.generate(secret, publicKey, alpha);
        expect(proof.verify(vrf.vkey, alpha)).toBe(true);
    });

    test("operational certificate: decode, verify, re-issue byte-identical, checks", () => {
        const oc = readOperationalCert(F("node.cert"));
        const kes = loadKesSigningKey(F("kes.skey"));
        expect(oc.cert.counter).toBe(0n);
        expect(oc.cert.kesPeriod).toBe(123n);
        expect(Buffer.from(oc.cert.kesVkey).toString("hex")).toBe(Buffer.from(kes.vkey).toString("hex"));
        const ledger = toLedgerOpcert(oc.cert);
        expect(ledger.sequenceNumber).toBe(0n);
        expect(ledger.kesPeriod).toBe(123n);

        // our issue with the same inputs reproduces cardano-cli's certificate exactly
        const cold = loadColdSigningKey(F("cold.skey"));
        const { opcert, nextCounter } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, 123n, cold);
        expect(encodeOperationalCert(opcert)).toEqual(readTextEnvelope(F("node.cert")));
        expect(nextCounter.next).toBe(1n);

        const base = { maxKesEvolutions: 62n, kesVkey: kes.vkey };
        expect(checkOperationalCert(oc, { ...base, currentKesPeriod: 123n, lastOnChainCounter: null })).toEqual({ ok: true, evolution: 0 });
        expect(checkOperationalCert(oc, { ...base, currentKesPeriod: 184n, lastOnChainCounter: null })).toEqual({ ok: true, evolution: 61 });
        expect(checkOperationalCert(oc, { ...base, currentKesPeriod: 185n, lastOnChainCounter: null })).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
        expect(checkOperationalCert(oc, { ...base, currentKesPeriod: 122n, lastOnChainCounter: null })).toMatchObject({ ok: false, reason: expect.stringContaining("starts after") });
        expect(checkOperationalCert(oc, { ...base, currentKesPeriod: 130n, lastOnChainCounter: 0n })).toMatchObject({ ok: false, reason: expect.stringContaining("not above") });
        expect(checkOperationalCert(oc, { ...base, currentKesPeriod: 130n, lastOnChainCounter: null, kesVkey: new Uint8Array(32) })).toMatchObject({ ok: false, reason: expect.stringContaining("different KES key") });
        const tampered = { ...oc, coldVkey: generateColdKey().vkey };
        expect(checkOperationalCert(tampered, { ...base, currentKesPeriod: 130n, lastOnChainCounter: null })).toMatchObject({ ok: false, reason: "cold signature invalid" });

        // second certificate must carry counter +1 relative to the chain
        const second = issueOperationalCert(kes.vkey, nextCounter, 150n, cold).opcert;
        expect(checkOperationalCert(second, { ...base, currentKesPeriod: 150n, lastOnChainCounter: 0n })).toEqual({ ok: true, evolution: 0 });
        expect(checkOperationalCert(second, { ...base, currentKesPeriod: 150n, lastOnChainCounter: -1n })).toMatchObject({ ok: false, reason: expect.stringContaining("skips ahead") });
    });

    test("generated keys round-trip through envelopes and the same checks", () => {
        const cold = generateColdKey(new Uint8Array(32).map((_, i) => i + 1));
        const kes = generateKesKey(new Uint8Array(32).map((_, i) => 200 - i));
        const vrf = generateVrfKey(new Uint8Array(32).map((_, i) => i * 3));
        expect(kes.skey.length).toBe(612);
        expect(vrf.skey.length).toBe(64);
        const env = envelopeOfBytes(EnvelopeType.kesSigningKey, "KES Signing Key", kesSecretForEnvelope(kes));
        expect(env.cborHex.length).toBe(1222);
        const { opcert } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, 7n, cold);
        expect(checkOperationalCert(opcert, { currentKesPeriod: 9n, maxKesEvolutions: 62n, lastOnChainCounter: null, kesVkey: kes.vkey })).toEqual({ ok: true, evolution: 2 });
        evolveKesTo(kes, 2);
        const msg = new Uint8Array([1, 2, 3]);
        expect(kesVerifyAt(kesSignAt(kes, msg), 2, kes.vkey, msg)).toBe(true);
        const { secret, publicKey } = vrfProvingKey(vrf);
        expect(VrfProof03.generate(secret, publicKey, msg).verify(vrf.vkey, msg)).toBe(true);
        const c = decodeIssueCounter(encodeIssueCounter({ next: 5n, coldVkey: cold.vkey }));
        expect(c.next).toBe(5n);
    });
});
