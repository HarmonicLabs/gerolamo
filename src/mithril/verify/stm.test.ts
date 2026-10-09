import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { encodeJsonHex, parseJsonLossless } from "./json";
import { evToBigInt, isLotteryWon, rationalFromFloat, taylorComparison } from "./lottery";
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import {
    aggregateVerificationKeyJson,
    decodeSignature,
    decodeVerificationKey,
    concatenationProofJson,
    parseAggregateVerificationKey,
    parseConcatenationProof,
    verifyConcatenationProof,
    type ConcatenationProof,
    type StmParameters,
} from "./stm";

const FIX = join(import.meta.dir, "..", "__fixtures__", "certs");

async function load(rel: string) {
    const c = parseJsonLossless(await Bun.file(join(FIX, rel)).text()) as Record<string, any>;
    const params: StmParameters = { k: BigInt(c.metadata.parameters.k), m: BigInt(c.metadata.parameters.m), phiF: c.metadata.parameters.phi_f };
    return {
        raw: c,
        msg: new TextEncoder().encode(c.signed_message as string),
        avk: parseAggregateVerificationKey(c.aggregate_verification_key),
        proof: parseConcatenationProof(c.multi_signature),
        params,
    };
}

const clone = (p: ConcatenationProof): ConcatenationProof => ({
    signatures: p.signatures.map((s) => ({ ...s, sigma: s.sigma.slice(), vk: s.vk.slice(), indexes: s.indexes.slice() })),
    batchProof: { values: p.batchProof.values.map((v) => v.slice()), indices: p.batchProof.indices.slice() },
});

describe("STM concatenation proof (real certificates)", () => {
    test("preview certificate, one signer: verifies", async () => {
        const f = await load("preview/cdb.json");
        const r = verifyConcatenationProof(f.msg, f.avk, f.params, f.proof);
        expect(r.mode).toBe("single");
        expect(r.indices).toBeGreaterThanOrEqual(Number(f.params.k));
    });

    test("mainnet certificate, 56 signers: weighted BLS aggregate verifies", async () => {
        const f = await load("mainnet/multi.json");
        const r = verifyConcatenationProof(f.msg, f.avk, f.params, f.proof);
        expect(r.signatures).toBe(56);
        expect(r.mode).toBe("aggregate");
        expect(r.indices).toBeGreaterThanOrEqual(Number(f.params.k));
    });

    test("canonical re-encoding equals the published JSON hex", async () => {
        for (const rel of ["preview/cdb.json", "preview/hop1.json", "mainnet/multi.json", "mainnet/multi-previous.json"]) {
            const f = await load(rel);
            expect(encodeJsonHex(aggregateVerificationKeyJson(f.avk))).toBe(f.raw.aggregate_verification_key);
            expect(encodeJsonHex(concatenationProofJson(f.proof))).toBe(f.raw.multi_signature);
        }
    });

    describe("negative", () => {
        const reject = async (rel: string, mutate: (f: Awaited<ReturnType<typeof load>>) => void, code: RegExp) => {
            const f = await load(rel);
            f.proof = clone(f.proof);
            mutate(f);
            expect(() => verifyConcatenationProof(f.msg, f.avk, f.params, f.proof)).toThrow(code);
        };

        test("one flipped bit in a sigma", () => reject("mainnet/multi.json", (f) => { f.proof.signatures[7]!.sigma[20]! ^= 0x01; }, /SignatureInvalid|LotteryLost/));
        test("one flipped bit in the signed message", () => reject("preview/cdb.json", (f) => { f.msg = f.msg.slice(); f.msg[3]! ^= 0x01; }, /LotteryLost|SignatureInvalid/));
        test("one flipped bit in the AVK root", () => reject("preview/cdb.json", (f) => { f.avk = { ...f.avk, root: f.avk.root.slice() }; f.avk.root[0]! ^= 0x80; }, /LotteryLost|BatchPathInvalid|SignatureInvalid/));
        test("inflated signer stake", () => reject("mainnet/multi.json", (f) => { f.proof.signatures[0]!.stake += 1n; }, /BatchPathInvalid|LotteryLost/));
        test("one flipped bit in a verification key", () => reject("mainnet/multi.json", (f) => { f.proof.signatures[3]!.vk[50]! ^= 0x04; }, /BatchPathInvalid/));
        test("one flipped bit in a batch path value", () => reject("mainnet/multi.json", (f) => { f.proof.batchProof.values[0]![5]! ^= 0x01; }, /BatchPathInvalid/));
        test("duplicated lottery index", () => reject("mainnet/multi.json", (f) => { const s = f.proof.signatures[0]!; s.indexes.push(s.indexes[0]!); }, /IndexNotUnique/));
        test("index above m", () => reject("preview/cdb.json", (f) => { f.params = { ...f.params, m: f.proof.signatures[0]!.indexes[0]! - 1n }; }, /IndexBoundFailed/));
        test("quorum k not reached", () => reject("mainnet/multi.json", (f) => { const n = f.proof.signatures.reduce((a, s) => a + s.indexes.length, 0); f.params = { ...f.params, k: BigInt(n + 1) }; }, /NotEnoughSignatures/));
        test("a signer dropped", () => reject("mainnet/multi.json", (f) => { f.proof.signatures.pop(); }, /NotEnoughSignatures|BatchPathInvalid/));
        test("lower phi_f makes a ticket lose", () => reject("preview/cdb.json", (f) => { f.params = { ...f.params, phiF: 0.0001 }; }, /LotteryLost/));
        test("two signers swapped (sigma no longer matches vk)", () => reject("mainnet/multi.json", (f) => { const a = f.proof.signatures[0]!; const b = f.proof.signatures[1]!; [a.sigma, b.sigma] = [b.sigma, a.sigma]; }, /LotteryLost|SignatureInvalid/));
    });
});

describe("BLS point decoding (blst sig_validate / key_validate)", () => {
    test("a G1 point on the curve but outside the subgroup is rejected", () => {
        const Fp = bls.fields.Fp;
        let x = 5n;
        let bytes: Uint8Array | null = null;
        while (!bytes) {
            const rhs = Fp.add(Fp.pow(x, 3n), 4n);
            let y: bigint | null = null;
            try { y = Fp.sqrt(rhs); } catch { /* not a square */ }
            if (y != null && Fp.eql(Fp.sqr(y), rhs)) {
                bytes = new Uint8Array(48);
                let v = x;
                for (let i = 47; i >= 0; i--) { bytes[i] = Number(v & 0xffn); v >>= 8n; }
                bytes[0]! |= 0x80;
                if (y > (Fp.ORDER - 1n) / 2n) bytes[0]! |= 0x20;
            }
            x++;
        }
        expect(() => decodeSignature(bytes!)).toThrow(/not in prime-order subgroup/);
    });
    test("identity sigma and vk are rejected", () => {
        const inf1 = new Uint8Array(48); inf1[0] = 0xc0;
        const inf2 = new Uint8Array(96); inf2[0] = 0xc0;
        expect(() => decodeSignature(inf1)).toThrow(/SignatureInvalid/);
        expect(() => decodeVerificationKey(inf2)).toThrow(/VerificationKeyInvalid/);
    });
});

describe("lottery (exact rational port)", () => {
    test("rationalFromFloat is exact", () => {
        expect(rationalFromFloat(0.5)).toEqual([1n, 2n]);
        expect(rationalFromFloat(-0.75)).toEqual([-3n, 4n]);
        const [n, d] = rationalFromFloat(Math.log(0.3));
        expect(Number(n) / Number(d)).toBe(Math.log(0.3));
    });

    test("edge rules: phi_f = 1 always wins, zero stake never wins, zero total stake throws", () => {
        const ev = new Uint8Array(64).fill(0xff);
        expect(isLotteryWon(1.0, ev, 1n, 10n)).toBe(true);
        expect(isLotteryWon(0.7, new Uint8Array(64).fill(1), 0n, 10n)).toBe(false);
        expect(() => isLotteryWon(0.7, ev, 1n, 0n)).toThrow(/ZeroTotalStake/);
        expect(() => isLotteryWon(1.5, ev, 1n, 10n)).toThrow(/PhiFValueOutOfRange/);
    });

    test("agrees with a high-precision reference away from the boundary", () => {
        // Reference: p < 1 - (1 - phi)^w evaluated in f64; only cases with a clear margin are compared.
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
        let compared = 0;
        for (let i = 0; i < 400; i++) {
            const ev = new Uint8Array(64).map(() => Math.floor(rnd() * 256));
            const phi = [0.2, 0.65, 0.7][i % 3]!;
            const total = 10n ** 15n + BigInt(Math.floor(rnd() * 1e9));
            const stake = BigInt(Math.floor(rnd() * 1e6)) * 10n ** 9n;
            const p = Number(evToBigInt(ev)) / 2 ** 512;
            const thr = 1 - Math.pow(1 - phi, Number(stake) / Number(total));
            if (Math.abs(p - thr) < 1e-9) continue;
            expect(isLotteryWon(phi, ev, stake, total)).toBe(p < thr);
            compared++;
        }
        expect(compared).toBeGreaterThan(350);
    });

    test("taylorComparison gives up (false) when cmp equals exp(x)", () => {
        // cmp = 1 = exp(0): never conclusive.
        expect(taylorComparison(10, 1n, 1n, 0n, 1n)).toBe(false);
        // cmp = 2 < exp(1) = 2.718..: true; cmp = 3 > e: false.
        expect(taylorComparison(1000, 2n, 1n, 1n, 1n)).toBe(true);
        expect(taylorComparison(1000, 3n, 1n, 1n, 1n)).toBe(false);
    });
});
