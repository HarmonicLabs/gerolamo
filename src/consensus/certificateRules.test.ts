import { describe, expect, test } from "bun:test";
import { certStakeEffect, checkCertificateSequence, stakeCredentialsTouched, type CertView } from "./certificateRules";

const A = "aa".repeat(28);
const B = "bb".repeat(28);
const POOL = "cc".repeat(28);
const c = (certType: number, credHex: string | null = A, poolHex: string | null = null): CertView => ({ certType, credHex, poolHex });

describe("certificateRules", () => {
    test("every certificate type in cardano-ledger-ts (0–18) is known", () => {
        for (let t = 0; t <= 18; t++) expect(certStakeEffect(t).known).toBe(true);
        expect(certStakeEffect(19).known).toBe(false);
        expect(certStakeEffect(-1).known).toBe(false);
    });

    test("registration followed by delegation in one tx passes and updates state", () => {
        const registered = new Set<string>();
        const delegated = new Map<string, string>();
        const r = checkCertificateSequence([c(0), c(2, A, POOL)], registered, delegated);
        expect(r.ok).toBe(true);
        expect(registered.has(A)).toBe(true);
        expect(delegated.get(A)).toBe(POOL);
    });

    test("double registration fails; dereg of unknown key fails; delegation of unknown key fails", () => {
        expect(checkCertificateSequence([c(0), c(0)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(1)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(2, A, POOL)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(9)], new Set(), new Map()).ok).toBe(false);
    });

    test("deregistration clears registration and delegation; re-registration is then allowed", () => {
        const registered = new Set([A]);
        const delegated = new Map([[A, POOL]]);
        const r = checkCertificateSequence([c(1), c(0)], registered, delegated);
        expect(r.ok).toBe(true);
        expect(registered.has(A)).toBe(true);
        expect(delegated.has(A)).toBe(false);
    });

    test("Conway: reg_cert / unreg_cert / stake_reg_deleg / vote_deleg behave like their Shelley counterparts", () => {
        const registered = new Set<string>();
        const delegated = new Map<string, string>();
        expect(checkCertificateSequence([c(7), c(9), c(10, A, POOL)], registered, delegated).ok).toBe(true);
        expect(delegated.get(A)).toBe(POOL);
        expect(checkCertificateSequence([c(11, B, POOL)], registered, delegated).ok).toBe(true);
        expect(registered.has(B)).toBe(true);
        expect(delegated.get(B)).toBe(POOL);
        expect(checkCertificateSequence([c(11, B, POOL)], registered, delegated).ok).toBe(false); // already registered
        expect(checkCertificateSequence([c(8)], registered, delegated).ok).toBe(true);
        expect(registered.has(A)).toBe(false);
    });

    test("pool, genesis, MIR and governance certificates never touch stake state", () => {
        const registered = new Set<string>();
        const delegated = new Map<string, string>();
        const certs = [3, 4, 5, 6, 14, 15, 16, 17, 18].map((t) => c(t, null));
        expect(checkCertificateSequence(certs, registered, delegated).ok).toBe(true);
        expect(stakeCredentialsTouched(certs)).toEqual([]);
    });

    test("unknown type and stake certificate without a credential are rejected", () => {
        expect(checkCertificateSequence([c(42)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(0, null)], new Set(), new Map()).ok).toBe(false);
    });

    test("stakeCredentialsTouched lists only credentials the stake rules read", () => {
        expect(stakeCredentialsTouched([c(0, A), c(2, B, POOL), c(3, null), c(0, A)])).toEqual([A, B]);
    });
});
