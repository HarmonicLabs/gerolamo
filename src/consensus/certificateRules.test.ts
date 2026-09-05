import { describe, expect, test } from "bun:test";
import { certStakeEffect, checkCertificateSequence, credKey, stakeCredentialsTouched, type CertView } from "./certificateRules";
const k = (h: string) => credKey(0, h);

const A = "aa".repeat(28);
const B = "bb".repeat(28);
const POOL = "cc".repeat(28);
const c = (certType: number, credHex: string | null = A, poolHex: string | null = null): CertView => ({ certType, credHex, credType: 0, poolHex });

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
        expect(registered.has(k(A))).toBe(true);
        expect(delegated.get(k(A))).toBe(POOL);
    });

    test("double registration fails; dereg of unknown key fails; delegation of unknown key fails", () => {
        expect(checkCertificateSequence([c(0), c(0)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(1)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(2, A, POOL)], new Set(), new Map()).ok).toBe(false);
        expect(checkCertificateSequence([c(9)], new Set(), new Map()).ok).toBe(false);
    });

    test("deregistration clears registration and delegation; re-registration is then allowed", () => {
        const registered = new Set([k(A)]);
        const delegated = new Map([[k(A), POOL]]);
        const r = checkCertificateSequence([c(1), c(0)], registered, delegated);
        expect(r.ok).toBe(true);
        expect(registered.has(k(A))).toBe(true);
        expect(delegated.has(k(A))).toBe(false);
    });

    test("Conway: reg_cert / unreg_cert / stake_reg_deleg / vote_deleg behave like their Shelley counterparts", () => {
        const registered = new Set<string>();
        const delegated = new Map<string, string>();
        expect(checkCertificateSequence([c(7), c(9), c(10, A, POOL)], registered, delegated).ok).toBe(true);
        expect(delegated.get(k(A))).toBe(POOL);
        expect(checkCertificateSequence([c(11, B, POOL)], registered, delegated).ok).toBe(true);
        expect(registered.has(k(B))).toBe(true);
        expect(delegated.get(k(B))).toBe(POOL);
        expect(checkCertificateSequence([c(11, B, POOL)], registered, delegated).ok).toBe(false); // already registered
        expect(checkCertificateSequence([c(8)], registered, delegated).ok).toBe(true);
        expect(registered.has(k(A))).toBe(false);
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
        expect(stakeCredentialsTouched([c(0, A), c(2, B, POOL), c(3, null), c(0, A)])).toEqual([{ hex: A, type: 0 }, { hex: B, type: 0 }]);
    });
    test("a script credential and a key credential with the same hash are different accounts (preprod 22056654 / 22056832)", () => {
        const hash = "d64d07cfc02e4f4386926dfb9166904bfc5db0faafdd71f6e0b5b6a4";
        const registered = new Set<string>();
        expect(checkCertificateSequence([{ certType: 0, credHex: hash, credType: 1, poolHex: null }], registered, new Map()).ok).toBe(true);
        expect(checkCertificateSequence([{ certType: 0, credHex: hash, credType: 0, poolHex: null }], registered, new Map()).ok).toBe(true);
        expect(registered.size).toBe(2);
        const again = checkCertificateSequence([{ certType: 0, credHex: hash, credType: 0, poolHex: null }], registered, new Map());
        expect(again.ok).toBe(false);
        expect(stakeCredentialsTouched([{ certType: 0, credHex: hash, credType: 1, poolHex: null }, { certType: 1, credHex: hash, credType: 0, poolHex: null }])).toEqual([{ hex: hash, type: 1 }, { hex: hash, type: 0 }]);
    });
});
