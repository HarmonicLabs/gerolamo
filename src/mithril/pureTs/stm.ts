/**
 * Phase 4 Stage 2 + Stage 5a + Stage 5b — pure-TS STM crypto prep / preliminary / aggregate.
 *
 * Stage 2:
 * - Decodes multi_signature leaf sigma → BlsG1 (48B compressed).
 * - Decodes path[0] → BlsG2 (96B compressed) when present.
 * - Runs millerLoop(G1, G2) as a plumbing smoke — proves BLS ops work on real cert bytes.
 *
 * Stage 5a (preliminary_verify subset — IntersectMBO concatenation proof):
 * - evaluateDenseMapping: Blake2b512("map" || msgp || index_LE_u64 || sigma)
 * - isLotteryWon: p = ev/2^512 < 1-(1-phi_f)^w (f64 trivial form; proven 12/12 golden)
 * - index bounds vs parameters.m; unique indices; k threshold
 * - msgp = utf8(signed_message hex string) || AVK root  (NOT decoded hex!)
 * - preliminaryOk can be true; verified/implemented stay FALSE
 *
 * Stage 5b (BLS multi-sig aggregate verify — IntersectMBO Figure 6):
 * - n=1: identity aggregate (vk[0], sig[0])
 * - n≥2: Blake2b-128 scalars + G1/G2 weighted sum
 * - verify: e(aggr_sig, G2) == e(H_G1(msgp, DST=""), aggr_vk)
 * - aggregateOk can be true; still NOT chain-to-genesis / dual-run match
 *
 * Still NOT:
 * - Certificate-chain walk to genesis
 * - dual-run match: true / pureTsStmImplemented: true
 *
 * Observed preprod multi_signature.signatures[i] layout:
 *   [ { sigma: u8[48], indexes: number[], signer_index }, [ u8[96] G2, stakeNumber ] ]
 *
 * See docs/phase-4-pure-ts-crypto-research.md
 */

import { createHash } from "crypto";

import {
    blake2b_128,
    BlsG1,
    BlsG2,
    bls12_381_G1_add,
    bls12_381_G1_compress,
    bls12_381_G1_hashToGroup,
    bls12_381_G1_scalarMul,
    bls12_381_G1_uncompress,
    bls12_381_G2_add,
    bls12_381_G2_compress,
    bls12_381_G2_scalarMul,
    bls12_381_G2_uncompress,
    bls12_381_finalVerify,
    bls12_381_millerLoop,
    type BlsG1 as BlsG1Point,
    type BlsG2 as BlsG2Point,
    type BlsResult,
} from "@harmoniclabs/crypto";

import type {
    PureTsAggregateVerificationKey,
    PureTsMultiSignature,
    PureTsMsSignatureEntry,
    PureTsParsedCertificate,
} from "./cert";
import { extractConcatenationLeafFromMsEntry } from "./merkle";
export type PureTsDecodedG1 = {
    bytes: Uint8Array;
    /** Opaque point from @harmoniclabs/crypto — not JSON-serializable. */
    point: BlsG1Point;
};

export type PureTsDecodedG2 = {
    bytes: Uint8Array;
    point: BlsG2Point;
};

export type PureTsStmEntryPrep = {
    leaf: {
        sigma: PureTsDecodedG1;
        indexes: number[];
        signer_index: number;
    };
    /** Path elements successfully decoded as G2 (usually path[0] = 96B). */
    pathG2: PureTsDecodedG2[];
    /**
     * Non-curve path elements kept as opaque values (e.g. stake bigint/number).
     * Not interpreted in Stage 2.
     */
    pathAux: unknown[];
    /** millerLoop(sigmaG1, firstPathG2) when both available — plumbing only. */
    millerLoop: BlsResult | null;
};

export type PureTsStmCryptoPrepResult = {
    /** G1/G2 decode + at least one millerLoop plumbing succeeded. */
    cryptoPrepOk: boolean;
    /** Always false — STM aggregate verify not implemented. */
    verified: false;
    reason: string;
    entries: PureTsStmEntryPrep[];
    /** First successful millerLoop result (for smoke / dual-run shadow). */
    millerLoopResult: BlsResult | null;
    errors: string[];
};

function isByteArray(v: unknown): v is number[] {
    return (
        Array.isArray(v) &&
        v.length > 0 &&
        typeof v[0] === "number" &&
        Number.isInteger(v[0])
    );
}

function toBytes(arr: number[], label: string): Uint8Array {
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
            throw new Error(`${label}[${i}]: not a byte`);
        }
        out[i] = n;
    }
    return out;
}

/**
 * Try to interpret a value as compressed G1 (48) or G2 (96) point bytes.
 * Returns null if not a byte array of those lengths or uncompress fails.
 */
export function tryDecodeCurvePoint(
    v: unknown,
    label: string,
): { kind: "G1"; decoded: PureTsDecodedG1 } | { kind: "G2"; decoded: PureTsDecodedG2 } | null {
    if (!isByteArray(v)) return null;
    const bytes = toBytes(v, label);
    if (bytes.length === 48) {
        try {
            const point = bls12_381_G1_uncompress(bytes);
            // Round-trip compress as a cheap well-formedness check
            const back = bls12_381_G1_compress(point);
            if (back.length !== 48) {
                throw new Error("G1 compress length mismatch");
            }
            return { kind: "G1", decoded: { bytes, point } };
        } catch {
            return null;
        }
    }
    if (bytes.length === 96) {
        try {
            const point = bls12_381_G2_uncompress(bytes);
            const back = bls12_381_G2_compress(point);
            if (back.length !== 96) {
                throw new Error("G2 compress length mismatch");
            }
            return { kind: "G2", decoded: { bytes, point } };
        } catch {
            return null;
        }
    }
    return null;
}

function prepareOneEntry(
    entry: PureTsMsSignatureEntry,
    index: number,
): { prep: PureTsStmEntryPrep | null; errors: string[] } {
    const errors: string[] = [];
    const label = `signatures[${index}]`;

    // sigma → G1
    let sigmaG1: PureTsDecodedG1;
    try {
        const point = bls12_381_G1_uncompress(entry.leaf.sigma);
        const back = bls12_381_G1_compress(point);
        if (back.length !== entry.leaf.sigma.length && back.length !== 48) {
            errors.push(`${label}.sigma: compress length unexpected ${back.length}`);
        }
        sigmaG1 = { bytes: entry.leaf.sigma, point };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${label}.sigma: G1_uncompress failed: ${msg}`);
        return { prep: null, errors };
    }

    // Walk path: decode G1/G2 where possible; keep rest as aux
    const pathG2: PureTsDecodedG2[] = [];
    const pathAux: unknown[] = [];
    const path = entry.path;

    // path is typically [ u8[96], stakeNumber ] — may also be nested arrays
    const pathElems: unknown[] = Array.isArray(path) ? path : path == null ? [] : [path];

    for (let i = 0; i < pathElems.length; i++) {
        const el = pathElems[i];
        const plabel = `${label}.path[${i}]`;
        const decoded = tryDecodeCurvePoint(el, plabel);
        if (decoded?.kind === "G2") {
            pathG2.push(decoded.decoded);
        } else if (decoded?.kind === "G1") {
            // Unusual on path; keep as aux but note
            pathAux.push({ kind: "G1", bytes: Array.from(decoded.decoded.bytes) });
        } else {
            pathAux.push(el);
        }
    }

    // millerLoop plumbing: sigma G1 × first path G2
    let millerLoop: BlsResult | null = null;
    if (pathG2.length > 0) {
        try {
            millerLoop = bls12_381_millerLoop(sigmaG1.point, pathG2[0].point);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`${label}: millerLoop failed: ${msg}`);
        }
    } else {
        errors.push(`${label}: no G2 on path — cannot run millerLoop plumbing`);
    }

    if (errors.length > 0 && millerLoop == null) {
        return { prep: null, errors };
    }

    return {
        prep: {
            leaf: {
                sigma: sigmaG1,
                indexes: entry.leaf.indexes,
                signer_index: entry.leaf.signer_index,
            },
            pathG2,
            pathAux,
            millerLoop,
        },
        errors,
    };
}

/**
 * Stage 2 crypto prep from a Stage 1 parsed multi_signature.
 * Never claims STM verification success.
 */
export function prepareStmCrypto(
    ms: PureTsMultiSignature,
): PureTsStmCryptoPrepResult {
    const errors: string[] = [];
    const entries: PureTsStmEntryPrep[] = [];
    let millerLoopResult: BlsResult | null = null;

    if (!ms.signatures.length) {
        return {
            cryptoPrepOk: false,
            verified: false,
            reason: "Stage 2: multi_signature.signatures empty",
            entries: [],
            millerLoopResult: null,
            errors: ["multi_signature.signatures empty"],
        };
    }

    for (let i = 0; i < ms.signatures.length; i++) {
        const { prep, errors: e } = prepareOneEntry(ms.signatures[i], i);
        errors.push(...e);
        if (prep) {
            entries.push(prep);
            if (millerLoopResult == null && prep.millerLoop != null) {
                millerLoopResult = prep.millerLoop;
            }
        }
    }

    // batch_proof.values are 32-byte hashes (Merkle), not curve points — do not force G1/G2
    if (!ms.batch_proof.values.length) {
        errors.push("batch_proof.values empty (unexpected but non-fatal for prep)");
    }

    const cryptoPrepOk =
        entries.length > 0 &&
        millerLoopResult != null &&
        entries.every((e) => e.leaf.sigma.bytes.length === 48 || e.leaf.sigma.bytes.length === 96);

    const reason = cryptoPrepOk
        ? "Stage 2 cryptoPrep OK — G1 sigma + G2 path decoded; millerLoop plumbing ran; STM aggregate verify NOT implemented (verified=false)"
        : `Stage 2 cryptoPrep FAILED: ${errors.join("; ") || "no entries prepared"}`;

    return {
        cryptoPrepOk,
        verified: false,
        reason,
        entries,
        millerLoopResult,
        errors,
    };
}

/**
 * Golden / CI checks for Stage 2 prep (no crypto accept).
 */
export function validateStmCryptoPrep(
    result: PureTsStmCryptoPrepResult,
    expect: {
        nEntries?: number;
        sigmaLen?: number;
        pathG2Count?: number;
        g2ByteLen?: number;
        requireMillerLoop?: boolean;
    } = {},
): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!result.cryptoPrepOk) {
        errors.push(...result.errors);
        return { ok: false, errors };
    }
    if (result.verified !== false) {
        errors.push("verified must be false");
    }
    if (expect.nEntries != null && result.entries.length !== expect.nEntries) {
        errors.push(
            `entries: got ${result.entries.length}, want ${expect.nEntries}`,
        );
    }
    const e0 = result.entries[0];
    if (e0) {
        if (expect.sigmaLen != null && e0.leaf.sigma.bytes.length !== expect.sigmaLen) {
            errors.push(
                `sigmaLen: got ${e0.leaf.sigma.bytes.length}, want ${expect.sigmaLen}`,
            );
        }
        if (expect.pathG2Count != null && e0.pathG2.length !== expect.pathG2Count) {
            errors.push(
                `pathG2Count: got ${e0.pathG2.length}, want ${expect.pathG2Count}`,
            );
        }
        if (expect.g2ByteLen != null && e0.pathG2[0]) {
            if (e0.pathG2[0].bytes.length !== expect.g2ByteLen) {
                errors.push(
                    `g2ByteLen: got ${e0.pathG2[0].bytes.length}, want ${expect.g2ByteLen}`,
                );
            }
        }
    }
    if (expect.requireMillerLoop !== false && result.millerLoopResult == null) {
        errors.push("millerLoopResult missing");
    }
    // millerLoop result should have c0/c1 (BlsResult shape)
    if (result.millerLoopResult != null) {
        const ml = result.millerLoopResult as { c0?: unknown; c1?: unknown };
        if (ml.c0 == null || ml.c1 == null) {
            errors.push("millerLoopResult missing c0/c1");
        }
    }
    return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Stage 5a — STM preliminary checks (lottery + bounds + k). NOT aggregate verify.
// Source: IntersectMBO/mithril mithril-stm concatenation proof + eligibility.rs
// ---------------------------------------------------------------------------

export type StmParameters = {
    k: number;
    m: number;
    phi_f: number;
};

export type PureTsStmPreliminaryResult = {
    /**
     * Preliminary checks passed (index bounds, lottery, unique indices, k, root path already separate).
     * Still NOT full STM aggregate / chain accept.
     */
    preliminaryOk: boolean;
    /** Always false — BLS aggregate + chain-to-genesis not implemented. */
    verified: false;
    reason: string;
    details: {
        msgpLen: number;
        nSignatures: number;
        nIndices: number;
        uniqueIndices: number;
        k: number | null;
        m: number | null;
        phi_f: number | null;
        lotteryWins: number;
        lotteryFails: number;
        /** How msgp was built (debug). */
        msgpMode: "utf8_signed_concat_root" | "missing";
    };
    errors: string[];
};

/**
 * Dense mapping: H("map" || msg || index_LE_u64 || sigma) → 64 bytes.
 * Source: BlsSignature::evaluate_dense_mapping (signature.rs).
 * LotteryIndex = u64 LE.
 */
export function evaluateDenseMapping(
    sigma: Uint8Array,
    msg: Uint8Array,
    index: number | bigint,
): Uint8Array {
    if (sigma.length !== 48) {
        throw new Error(
            `evaluateDenseMapping: sigma length ${sigma.length} (want 48)`,
        );
    }
    const idx = Buffer.alloc(8);
    const i = typeof index === "bigint" ? index : BigInt(index);
    if (i < 0n || i > 0xffff_ffff_ffff_ffffn) {
        throw new Error(`evaluateDenseMapping: index out of u64 range: ${i}`);
    }
    idx.writeBigUInt64LE(i);
    const h = createHash("blake2b512");
    h.update(Buffer.from("map"));
    h.update(msg);
    h.update(idx);
    h.update(sigma);
    return new Uint8Array(h.digest());
}

/**
 * Lottery win check: p = ev/2^512 < 1 - (1 - phi_f)^w with w = stake/total_stake.
 *
 * Uses the trivial f64 form from IntersectMBO eligibility tests
 * (`trivial_is_lottery_won`). Proven 12/12 on preprod golden with correct msgp.
 *
 * Not the full Taylor/rug high-precision path — good enough for Stage 5a
 * preliminary scaffolding; upgrade if dual-run lottery mismatches appear.
 */
export function isLotteryWon(
    phi_f: number,
    ev: Uint8Array,
    stake: bigint | number,
    totalStake: bigint | number,
): boolean {
    const s = typeof stake === "bigint" ? stake : BigInt(stake);
    const t = typeof totalStake === "bigint" ? totalStake : BigInt(totalStake);
    if (t === 0n) {
        throw new Error("isLotteryWon: total_stake is zero");
    }
    if (!Number.isFinite(phi_f)) {
        throw new Error(`isLotteryWon: phi_f not finite: ${phi_f}`);
    }
    if (Math.abs(phi_f - 1) < Number.EPSILON) return true;
    if (!(phi_f > 0 && phi_f <= 1)) {
        throw new Error(`isLotteryWon: phi_f out of range: ${phi_f}`);
    }
    if (ev.length !== 64) {
        throw new Error(`isLotteryWon: ev length ${ev.length} (want 64)`);
    }

    let evN = 0n;
    for (let i = 0; i < 64; i++) {
        evN |= BigInt(ev[i]!) << (8n * BigInt(i));
    }
    const evMax = 1n << 512n;
    if (evN === evMax) return false;

    // w as f64 — stake/total can exceed 2^53 for mainnet; use Number carefully.
    // Preprod golden stakes fit; document limit for Stage 5a.
    const w = Number(s) / Number(t);
    if (!Number.isFinite(w) || w < 0 || w > 1) {
        throw new Error(`isLotteryWon: invalid stake ratio w=${w}`);
    }
    const phi = 1 - Math.pow(1 - phi_f, w);

    // Compare ev/2^512 < phi via scaled BigInt: ev * 1e18 < floor(phi*1e18) * 2^512
    const SCALE = 10n ** 18n;
    const phiScaled = BigInt(Math.floor(phi * 1e18));
    return evN * SCALE < phiScaled * evMax;
}

/**
 * Build msgp for STM lottery/sig verify.
 *
 * IntersectMBO cert verifier passes `certificate.signed_message.as_bytes()` —
 * i.e. UTF-8 of the **hex string**, not decoded binary — then
 * `concatenate_with_message` appends AVK root:
 *   msgp = utf8(signed_message) || root
 *
 * Proven on preprod golden: 12/12 lottery wins with this binding only.
 */
export function buildStmMessagePrime(
    signedMessageHex: string,
    avkRoot: Uint8Array,
): Uint8Array {
    if (avkRoot.length !== 32) {
        throw new Error(
            `buildStmMessagePrime: root length ${avkRoot.length} (want 32)`,
        );
    }
    const utf8 = Buffer.from(signedMessageHex, "utf8");
    const out = new Uint8Array(utf8.length + avkRoot.length);
    out.set(utf8, 0);
    out.set(avkRoot, utf8.length);
    return out;
}

/** Extract STM parameters from cert metadata.parameters. */
export function extractStmParameters(
    metadata: unknown,
): StmParameters | null {
    if (metadata == null || typeof metadata !== "object") return null;
    const p = (metadata as { parameters?: unknown }).parameters;
    if (p == null || typeof p !== "object") return null;
    const obj = p as Record<string, unknown>;
    const k = obj.k;
    const m = obj.m;
    const phi_f = obj.phi_f;
    if (
        typeof k !== "number" ||
        typeof m !== "number" ||
        typeof phi_f !== "number" ||
        !Number.isFinite(k) ||
        !Number.isFinite(m) ||
        !Number.isFinite(phi_f)
    ) {
        return null;
    }
    return { k, m, phi_f };
}

/**
 * Stage 5a: preliminary STM checks from a parsed cert.
 *
 * Implements the lottery / bounds / uniqueness / k parts of
 * ConcatenationProof::preliminary_verify (proof.rs). Merkle root is Stage 4
 * (call separately). BLS aggregate verify is NOT done — verified stays false.
 */
export function preliminaryVerifyStm(args: {
    ms: PureTsMultiSignature;
    avk: PureTsAggregateVerificationKey;
    signedMessage: string;
    parameters: StmParameters;
}): PureTsStmPreliminaryResult {
    const { ms, avk, signedMessage, parameters } = args;
    const errors: string[] = [];
    let lotteryWins = 0;
    let lotteryFails = 0;

    let msgp: Uint8Array;
    try {
        msgp = buildStmMessagePrime(signedMessage, avk.mt_commitment.root);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            preliminaryOk: false,
            verified: false,
            reason: `Stage 5a: msgp build failed: ${msg}`,
            details: {
                msgpLen: 0,
                nSignatures: ms.signatures.length,
                nIndices: 0,
                uniqueIndices: 0,
                k: parameters.k,
                m: parameters.m,
                phi_f: parameters.phi_f,
                lotteryWins: 0,
                lotteryFails: 0,
                msgpMode: "missing",
            },
            errors: [msg],
        };
    }

    const totalStake =
        typeof avk.total_stake === "bigint"
            ? avk.total_stake
            : BigInt(avk.total_stake);

    const allIndices: number[] = [];
    const unique = new Set<number>();

    for (let si = 0; si < ms.signatures.length; si++) {
        const entry = ms.signatures[si]!;
        const leaf = entry.leaf;
        const stakeLeaf = extractConcatenationLeafFromMsEntry(entry);
        if (!stakeLeaf) {
            errors.push(
                `sig[${si}]: cannot extract VK||stake from path (need G2[96]+stake)`,
            );
            continue;
        }
        if (leaf.sigma.length !== 48) {
            errors.push(
                `sig[${si}]: sigma length ${leaf.sigma.length} (want 48)`,
            );
            continue;
        }

        for (const idx of leaf.indexes) {
            allIndices.push(idx);
            unique.add(idx);

            // IntersectMBO: index > m fails (IndexBoundFailed)
            if (idx > parameters.m) {
                errors.push(
                    `sig[${si}] index ${idx} > m=${parameters.m} (IndexBoundFailed)`,
                );
                lotteryFails++;
                continue;
            }

            try {
                const ev = evaluateDenseMapping(leaf.sigma, msgp, idx);
                const won = isLotteryWon(
                    parameters.phi_f,
                    ev,
                    stakeLeaf.stake,
                    totalStake,
                );
                if (won) {
                    lotteryWins++;
                } else {
                    lotteryFails++;
                    errors.push(
                        `sig[${si}] index ${idx}: lottery lost (LotteryLost)`,
                    );
                }
            } catch (e) {
                lotteryFails++;
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`sig[${si}] index ${idx}: ${msg}`);
            }
        }
    }

    const nIndices = allIndices.length;
    if (nIndices !== unique.size) {
        errors.push(
            `IndexNotUnique: nIndices=${nIndices} unique=${unique.size}`,
        );
    }
    if (nIndices < parameters.k) {
        errors.push(
            `NotEnoughSignatures: nIndices=${nIndices} < k=${parameters.k}`,
        );
    }

    // preliminaryOk: bounds+lottery+unique+k all pass. Does NOT imply verified.
    const preliminaryOk =
        errors.length === 0 &&
        lotteryFails === 0 &&
        nIndices >= parameters.k &&
        nIndices === unique.size &&
        ms.signatures.length > 0;

    const reason = preliminaryOk
        ? "Stage 5a preliminaryOk — lottery/bounds/k pass; " +
          "BLS aggregate + chain-to-genesis NOT verified (verified=false)"
        : `Stage 5a preliminary FAILED: ${errors.slice(0, 5).join("; ")}${
              errors.length > 5 ? ` (+${errors.length - 5} more)` : ""
          }`;

    return {
        preliminaryOk,
        verified: false,
        reason,
        details: {
            msgpLen: msgp.length,
            nSignatures: ms.signatures.length,
            nIndices,
            uniqueIndices: unique.size,
            k: parameters.k,
            m: parameters.m,
            phi_f: parameters.phi_f,
            lotteryWins,
            lotteryFails,
            msgpMode: "utf8_signed_concat_root",
        },
        errors,
    };
}

/**
 * Convenience: run Stage 5a from a Stage 1 parsed certificate.
 */
export function preliminaryVerifyFromParsed(
    parsed: PureTsParsedCertificate,
): PureTsStmPreliminaryResult {
    if (!parsed.ms || !parsed.avk) {
        return {
            preliminaryOk: false,
            verified: false,
            reason: "Stage 5a: missing ms or avk on parsed cert",
            details: {
                msgpLen: 0,
                nSignatures: 0,
                nIndices: 0,
                uniqueIndices: 0,
                k: null,
                m: null,
                phi_f: null,
                lotteryWins: 0,
                lotteryFails: 0,
                msgpMode: "missing",
            },
            errors: ["missing ms or avk"],
        };
    }
    if (!parsed.signed_message) {
        return {
            preliminaryOk: false,
            verified: false,
            reason: "Stage 5a: missing signed_message",
            details: {
                msgpLen: 0,
                nSignatures: parsed.ms.signatures.length,
                nIndices: 0,
                uniqueIndices: 0,
                k: null,
                m: null,
                phi_f: null,
                lotteryWins: 0,
                lotteryFails: 0,
                msgpMode: "missing",
            },
            errors: ["missing signed_message"],
        };
    }
    const parameters = extractStmParameters(parsed.metadata);
    if (!parameters) {
        return {
            preliminaryOk: false,
            verified: false,
            reason: "Stage 5a: metadata.parameters missing or invalid",
            details: {
                msgpLen: 0,
                nSignatures: parsed.ms.signatures.length,
                nIndices: 0,
                uniqueIndices: 0,
                k: null,
                m: null,
                phi_f: null,
                lotteryWins: 0,
                lotteryFails: 0,
                msgpMode: "missing",
            },
            errors: ["metadata.parameters missing"],
        };
    }
    return preliminaryVerifyStm({
        ms: parsed.ms,
        avk: parsed.avk,
        signedMessage: parsed.signed_message,
        parameters,
    });
}

// ---------------------------------------------------------------------------
// Stage 5b — BLS multi-sig aggregate verify (MSP.BKey / MSP.BSig Figure 6).
// Source: IntersectMBO mithril-stm BlsSignature::{aggregate,verify_aggregate}
// Proven: empty DST + e(sig,G2)==e(H(msg),pk) on preprod golden (n=1).
// Still NOT chain-to-genesis. verified / implemented stay false at dual-run level.
// ---------------------------------------------------------------------------

/** blst min_sig default: empty DST for hash-to-G1. Proven on golden cert. */
export const BLS_MIN_SIG_DST = new Uint8Array(0);

export type PureTsStmAggregateResult = {
    /**
     * Aggregate BLS verify passed for collected (sigma, vk) pairs under msgp.
     * Still NOT certificate-chain / genesis accept.
     */
    aggregateOk: boolean;
    /** Always false here — chain-to-genesis not part of Stage 5b. */
    verified: false;
    reason: string;
    details: {
        nPairs: number;
        /** n=1 identity path vs n≥2 weighted aggregate. */
        mode: "identity" | "weighted" | "none";
        msgpLen: number;
        /** Pairing equation used. */
        pairing: "e(sig,G2)==e(H_G1(msgp,''),pk)" | null;
    };
    errors: string[];
};

/**
 * Convert 16-byte Blake2b-128 digest to a little-endian bigint scalar.
 * IntersectMBO feeds 128-bit limbs into blst mult(&scalars, 128).
 */
export function blake2b128ToScalarLe(digest16: Uint8Array): bigint {
    if (digest16.length !== 16) {
        throw new Error(
            `blake2b128ToScalarLe: want 16 bytes, got ${digest16.length}`,
        );
    }
    let n = 0n;
    for (let i = 0; i < 16; i++) {
        n |= BigInt(digest16[i]!) << (8n * BigInt(i));
    }
    return n;
}

/**
 * Hash-to-G1 with empty DST (blst min_sig default used by Mithril STM).
 */
export function hashMsgToG1(msg: Uint8Array): BlsG1Point {
    return bls12_381_G1_hashToGroup(msg, BLS_MIN_SIG_DST);
}

/**
 * Core pairing check: e(sig, G2) == e(H(msg), pk).
 * Proven true on preprod golden with empty DST.
 */
export function blsMinSigVerify(
    sigmaG1: BlsG1Point,
    msg: Uint8Array,
    pkG2: BlsG2Point,
): boolean {
    const h = hashMsgToG1(msg);
    const mlLeft = bls12_381_millerLoop(sigmaG1, BlsG2.BASE);
    const mlRight = bls12_381_millerLoop(h, pkG2);
    return bls12_381_finalVerify(mlLeft, mlRight);
}

/**
 * Aggregate (vk[], sig[]) per IntersectMBO BlsSignature::aggregate.
 * - n=0 invalid
 * - n=1 identity
 * - n≥2: Blake2b-128 over all sigs, then per-index Blake2b-128 scalar, weighted sum
 */
export function aggregateBlsSignatures(args: {
    sigmas: Uint8Array[];
    vks: Uint8Array[];
}): {
    ok: boolean;
    aggrSig: BlsG1Point | null;
    aggrVk: BlsG2Point | null;
    mode: "identity" | "weighted" | "none";
    error?: string;
} {
    const { sigmas, vks } = args;
    if (sigmas.length !== vks.length || sigmas.length === 0) {
        return {
            ok: false,
            aggrSig: null,
            aggrVk: null,
            mode: "none",
            error: `aggregate: length mismatch or empty (sigs=${sigmas.length} vks=${vks.length})`,
        };
    }
    for (let i = 0; i < sigmas.length; i++) {
        if (sigmas[i]!.length !== 48) {
            return {
                ok: false,
                aggrSig: null,
                aggrVk: null,
                mode: "none",
                error: `aggregate: sigma[${i}] len ${sigmas[i]!.length} (want 48)`,
            };
        }
        if (vks[i]!.length !== 96) {
            return {
                ok: false,
                aggrSig: null,
                aggrVk: null,
                mode: "none",
                error: `aggregate: vk[${i}] len ${vks[i]!.length} (want 96)`,
            };
        }
    }

    try {
        if (sigmas.length === 1) {
            return {
                ok: true,
                aggrSig: bls12_381_G1_uncompress(sigmas[0]!),
                aggrVk: bls12_381_G2_uncompress(vks[0]!),
                mode: "identity",
            };
        }

        // hashed_sigs = Blake2b-128(sig0 || sig1 || ...)
        const allSigBytes = new Uint8Array(sigmas.length * 48);
        for (let i = 0; i < sigmas.length; i++) {
            allSigBytes.set(sigmas[i]!, i * 48);
        }
        // blake2b_128 takes a single buffer; feed concatenation
        // Per-index: Blake2b-128(allSigs || index_BE_u64) — IntersectMBO clones hasher state.
        // blake2b crate Blake2b<U16> clone + update(index BE) — we recompute as:
        //   blake2b_128( allSigBytes || index_BE_8 )
        // which matches clone-after-all-sigs + update(index) for a fresh hash tree.
        let aggrSig: BlsG1Point | null = null;
        let aggrVk: BlsG2Point | null = null;

        for (let i = 0; i < sigmas.length; i++) {
            const idxBe = Buffer.alloc(8);
            idxBe.writeBigUInt64BE(BigInt(i));
            const scalarInput = new Uint8Array(allSigBytes.length + 8);
            scalarInput.set(allSigBytes, 0);
            scalarInput.set(idxBe, allSigBytes.length);
            const digest = blake2b_128(scalarInput);
            const scalar = blake2b128ToScalarLe(digest);

            const sigP = bls12_381_G1_uncompress(sigmas[i]!);
            const vkP = bls12_381_G2_uncompress(vks[i]!);
            const weightedSig = bls12_381_G1_scalarMul(scalar, sigP);
            const weightedVk = bls12_381_G2_scalarMul(scalar, vkP);

            aggrSig =
                aggrSig == null
                    ? weightedSig
                    : bls12_381_G1_add(aggrSig, weightedSig);
            aggrVk =
                aggrVk == null
                    ? weightedVk
                    : bls12_381_G2_add(aggrVk, weightedVk);
        }

        return {
            ok: true,
            aggrSig,
            aggrVk,
            mode: "weighted",
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            aggrSig: null,
            aggrVk: null,
            mode: "none",
            error: `aggregate decode/mul failed: ${msg}`,
        };
    }
}

/**
 * verify_aggregate(msg, vks, sigs): aggregate then pairing-verify.
 * Source: BlsSignature::verify_aggregate.
 */
export function verifyBlsAggregate(args: {
    msg: Uint8Array;
    sigmas: Uint8Array[];
    vks: Uint8Array[];
}): {
    ok: boolean;
    mode: "identity" | "weighted" | "none";
    error?: string;
} {
    const agg = aggregateBlsSignatures({
        sigmas: args.sigmas,
        vks: args.vks,
    });
    if (!agg.ok || !agg.aggrSig || !agg.aggrVk) {
        return {
            ok: false,
            mode: agg.mode,
            error: agg.error ?? "aggregate failed",
        };
    }
    try {
        const ok = blsMinSigVerify(agg.aggrSig, args.msg, agg.aggrVk);
        return {
            ok,
            mode: agg.mode,
            error: ok ? undefined : "pairing equation failed",
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, mode: agg.mode, error: `pairing error: ${msg}` };
    }
}

/**
 * Stage 5b: collect (sigma, vk) from MS entries, build msgp, verify_aggregate.
 * Does NOT require lottery/preliminary — call after Stage 5a for full prelim+agg.
 * verified stays false (no chain-to-genesis).
 */
export function verifyStmAggregate(args: {
    ms: PureTsMultiSignature;
    avk: PureTsAggregateVerificationKey;
    signedMessage: string;
}): PureTsStmAggregateResult {
    const { ms, avk, signedMessage } = args;
    const errors: string[] = [];

    let msgp: Uint8Array;
    try {
        msgp = buildStmMessagePrime(signedMessage, avk.mt_commitment.root);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            aggregateOk: false,
            verified: false,
            reason: `Stage 5b: msgp build failed: ${msg}`,
            details: {
                nPairs: 0,
                mode: "none",
                msgpLen: 0,
                pairing: null,
            },
            errors: [msg],
        };
    }

    const sigmas: Uint8Array[] = [];
    const vks: Uint8Array[] = [];

    for (let i = 0; i < ms.signatures.length; i++) {
        const entry = ms.signatures[i]!;
        const leaf = extractConcatenationLeafFromMsEntry(entry);
        if (!leaf) {
            errors.push(`sig[${i}]: cannot extract VK from path`);
            continue;
        }
        if (entry.leaf.sigma.length !== 48) {
            errors.push(
                `sig[${i}]: sigma len ${entry.leaf.sigma.length} (want 48)`,
            );
            continue;
        }
        sigmas.push(entry.leaf.sigma);
        vks.push(leaf.vk);
    }

    if (sigmas.length === 0) {
        return {
            aggregateOk: false,
            verified: false,
            reason: "Stage 5b: no valid (sigma, vk) pairs",
            details: {
                nPairs: 0,
                mode: "none",
                msgpLen: msgp.length,
                pairing: null,
            },
            errors: errors.length ? errors : ["no pairs"],
        };
    }

    const v = verifyBlsAggregate({ msg: msgp, sigmas, vks });
    if (!v.ok) {
        if (v.error) errors.push(v.error);
        return {
            aggregateOk: false,
            verified: false,
            reason: `Stage 5b aggregate FAILED: ${v.error ?? "pairing failed"}`,
            details: {
                nPairs: sigmas.length,
                mode: v.mode,
                msgpLen: msgp.length,
                pairing: "e(sig,G2)==e(H_G1(msgp,''),pk)",
            },
            errors,
        };
    }

    return {
        aggregateOk: true,
        verified: false,
        reason:
            "Stage 5b aggregateOk — BLS multi-sig pairing passed; " +
            "chain-to-genesis NOT verified (verified=false)",
        details: {
            nPairs: sigmas.length,
            mode: v.mode,
            msgpLen: msgp.length,
            pairing: "e(sig,G2)==e(H_G1(msgp,''),pk)",
        },
        errors,
    };
}

/**
 * Convenience: Stage 5b from Stage 1 parsed certificate.
 */
export function verifyStmAggregateFromParsed(
    parsed: PureTsParsedCertificate,
): PureTsStmAggregateResult {
    if (!parsed.ms || !parsed.avk) {
        return {
            aggregateOk: false,
            verified: false,
            reason: "Stage 5b: missing ms or avk",
            details: {
                nPairs: 0,
                mode: "none",
                msgpLen: 0,
                pairing: null,
            },
            errors: ["missing ms or avk"],
        };
    }
    if (!parsed.signed_message) {
        return {
            aggregateOk: false,
            verified: false,
            reason: "Stage 5b: missing signed_message",
            details: {
                nPairs: parsed.ms.signatures.length,
                mode: "none",
                msgpLen: 0,
                pairing: null,
            },
            errors: ["missing signed_message"],
        };
    }
    return verifyStmAggregate({
        ms: parsed.ms,
        avk: parsed.avk,
        signedMessage: parsed.signed_message,
    });
}
