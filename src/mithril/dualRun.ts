/**
 * Phase 4 dual-run scaffold — WASM is source of truth for full cert-chain.
 *
 * Stage 1 (done): pure-TS cert shape parse of AVK + multi_signature.
 * Stage 2 (done): pure-TS STM crypto *prep* (G1/G2 decode + millerLoop plumbing).
 * Stage 3 (done): pure-TS Merkle batch_proof *structural* validate.
 * Stage 4 (done): pure-TS Merkle batch path root verify (Blake2b-256).
 * Stage 5a (done): pure-TS STM preliminary (lottery + bounds + k).
 * Stage 5b (done): pure-TS BLS multi-sig aggregate verify (aggregateOk).
 * Stage 5c (done): pure-TS certificate-chain walk (chainOk only at genesis+Ed25519).
 *   Still NOT dual-run match / pureTsStmImplemented.
 *
 * Do not claim pure-TS crypto works until PureTsVerifyResult.implemented === true
 * and dual-run matches WASM on real preprod/mainnet certs.
 *
 * See docs/phase-4-pure-ts-crypto-research.md
 */

import type { GerolamoMithrilClient } from "./client";
import type { MithrilCertificate } from "./types";
import {
    parseAndValidateCertificate,
    type PureTsCertParseResult,
} from "./pureTs/cert";
import {
    prepareStmCrypto,
    preliminaryVerifyFromParsed,
    verifyStmAggregateFromParsed,
    type PureTsStmAggregateResult,
    type PureTsStmCryptoPrepResult,
    type PureTsStmPreliminaryResult,
} from "./pureTs/stm";
import {
    verifyBatchProofWithRoot,
    type PureTsMerkleValidateResult,
} from "./pureTs/merkle";
import {
    walkCertificateChain,
    type CertificateFetcher,
    type PureTsChainWalkResult,
} from "./pureTs/chain";

export type PureTsVerifyResult = {
    /**
     * Cryptographic full STM/chain verify implemented?
     * Always false until chain-to-genesis dual-run soak lands.
     * Stage 1–5c do NOT flip this.
     */
    implemented: false;
    /** Cryptographic full accept — always false until dual-run match. */
    ok: false;
    /** Stage 1: structural parse of AVK/MS succeeded. */
    shapeOk: boolean;
    /**
     * Stage 2: G1/G2 decode + millerLoop plumbing succeeded.
     * Still NOT STM aggregate verify.
     */
    cryptoPrepOk: boolean;
    /** Stage 3: batch_proof structural checks vs AVK commitment. */
    merkleStructOk: boolean;
    /**
     * Stage 4: Blake2b-256 batch path reconstructs AVK mt_commitment.root.
     */
    rootVerified: boolean;
    /**
     * Stage 5a: lottery + index bounds + unique indices + k threshold.
     */
    preliminaryOk: boolean;
    /**
     * Stage 5b: BLS multi-sig aggregate pairing verify under msgp.
     */
    aggregateOk: boolean;
    /**
     * Stage 5c: walk reached genesis and Ed25519 verified.
     * False when only tip+predecessor (no genesis) or genesis vkey missing.
     */
    chainOk: boolean;
    reason: string;
    certShape?: PureTsCertParseResult;
    stmPrep?: PureTsStmCryptoPrepResult;
    merkle?: PureTsMerkleValidateResult;
    stmPrelim?: PureTsStmPreliminaryResult;
    stmAggregate?: PureTsStmAggregateResult;
    chainWalk?: PureTsChainWalkResult;
};

export type DualRunVerifyResult = {
    certificateHash: string;
    wasm: {
        ok: boolean;
        cert: MithrilCertificate | null;
        error?: string;
    };
    pureTs: PureTsVerifyResult;
    /**
     * True only when both engines cryptographically agree on full cert-chain.
     * Impossible until pure-TS chain-to-genesis exists and dual-run soak is green
     * (shape/cryptoPrep/merkle/root/prelim/aggregate/chain alone never sets match).
     */
    match: boolean;
};

/**
 * On-disk inventory of crypto building blocks vs Mithril STM gaps.
 * Primitives ≠ cert-chain verify. Use this before claiming Phase 4 progress.
 */
export type CryptoInventory = {
    packages: {
        harmoniclabsCrypto: boolean;
        nobleCurves: boolean;
        mithrilClientWasm: boolean;
    };
    primitives: {
        hlBlsG1G2: boolean;
        hlMillerLoop: boolean;
        hlFinalVerify: boolean;
        nobleBls12Pairing: boolean;
        nobleBls12Signatures: boolean;
    };
    pureTsCertShapeParse: boolean;
    pureTsStmCryptoPrep: boolean;
    pureTsMerkleStructural: boolean;
    pureTsMerkleRootVerify: boolean;
    pureTsStmPreliminary: boolean;
    /** Stage 5b BLS multi-sig aggregate verify (pairing under msgp). */
    pureTsStmAggregate: boolean;
    /** Stage 5c certificate-chain walk (structural + per-cert STM + genesis Ed25519). */
    pureTsCertChainWalk: boolean;
    mithrilGaps: string[];
    pureTsStmImplemented: false;
    wasmIsSourceOfTruth: true;
    notes: string[];
};

export function cryptoInventory(): CryptoInventory {
    return {
        packages: {
            harmoniclabsCrypto: true,
            nobleCurves: true,
            mithrilClientWasm: true,
        },
        primitives: {
            hlBlsG1G2: true,
            hlMillerLoop: true,
            hlFinalVerify: true,
            nobleBls12Pairing: true,
            nobleBls12Signatures: true,
        },
        pureTsCertShapeParse: true,
        pureTsStmCryptoPrep: true,
        pureTsMerkleStructural: true,
        pureTsMerkleRootVerify: true,
        pureTsStmPreliminary: true,
        pureTsStmAggregate: true,
        pureTsCertChainWalk: true,
        mithrilGaps: [
            "Full chain-to-genesis soak (preprod genesis cert golden + Ed25519 proven)",
            "Certificate try_compute_hash content-hash recompute (metadata/signers/sig feed)",
            "Message encoding for verify_message_match_certificate (Cardano DB digests)",
            "Dual-run golden vectors vs WASM on preprod/mainnet certs (crypto match)",
            "Weighted n≥2 aggregate path soak (golden cert is n=1 identity)",
        ],
        pureTsStmImplemented: false,
        wasmIsSourceOfTruth: true,
        notes: [
            "BLS12-381 primitives exist but are NOT full Mithril cert-chain SoT.",
            "Stage 1: parseAndValidateCertificate (shapeOk; verified=false).",
            "Stage 2: prepareStmCrypto (cryptoPrepOk; verified=false).",
            "Stage 3: structural batch_proof (merkleStructOk).",
            "Stage 4: verifyBatchProofWithRoot Blake2b-256 (rootVerified).",
            "Stage 5a: preliminaryVerifyFromParsed lottery/bounds/k (preliminaryOk).",
            "Stage 5b: verifyStmAggregateFromParsed BLS pairing (aggregateOk).",
            "Stage 5c: walkCertificateChain structural+STM+genesis Ed25519 (chainOk).",
            "msgp = utf8(signed_message hex string) || AVK root — NOT decoded hex.",
            "Protocol message hash = SHA-256(parts) in ProtocolMessagePartKey ENUM order.",
            "BLS min_sig DST is empty string (blst default); proven on golden.",
            "Source of truth today: client.verifyCertificateChain (IOG mithril-client-wasm).",
        ],
    };
}

export type PureTsVerifyOptions = {
    /**
     * Optional predecessors for Stage 5c walk (tip's previous first).
     * Without these (or a fetcher), chainOk stays false after tip integrity.
     */
    predecessors?: Array<MithrilCertificate | Record<string, unknown>>;
    /** Optional aggregator fetcher for deeper chain walk. */
    fetcher?: CertificateFetcher;
    /** Raw genesis.vkey contents — required for chainOk at genesis. */
    genesisVkey?: string;
    /** Cap chain walk depth (default 128). */
    maxDepth?: number;
    /**
     * When true (default), run Stage 5c walk if tip JSON is present.
     * Set false to skip network/walk and only report Stage 1–5b.
     */
    runChainWalk?: boolean;
};

/**
 * Pure-TS path for a certificate.
 *
 * - With cert JSON: Stage 1–5b always; Stage 5c when runChainWalk !== false.
 * - ok / implemented always false (no dual-run match claim).
 * - match never set here (dual-run owns match).
 */
export async function pureTsVerifyCertificateChain(
    certificateHash: string,
    certJson?: MithrilCertificate | Record<string, unknown> | null,
    opts: PureTsVerifyOptions = {},
): Promise<PureTsVerifyResult> {
    const inv = cryptoInventory();
    const runChainWalk = opts.runChainWalk !== false;

    if (certJson != null && typeof certJson === "object") {
        const shape = parseAndValidateCertificate(certJson);

        if (
            shape.shapeOk &&
            shape.parsed.hash &&
            certificateHash &&
            shape.parsed.hash !== certificateHash
        ) {
            return {
                implemented: false,
                ok: false,
                shapeOk: false,
                cryptoPrepOk: false,
                merkleStructOk: false,
                rootVerified: false,
                preliminaryOk: false,
                aggregateOk: false,
                chainOk: false,
                reason: `Stage 1: cert.hash ${shape.parsed.hash} !== requested ${certificateHash}`,
                certShape: shape,
            };
        }

        let stmPrep: PureTsStmCryptoPrepResult | undefined;
        let merkle: PureTsMerkleValidateResult | undefined;
        let stmPrelim: PureTsStmPreliminaryResult | undefined;
        let stmAggregate: PureTsStmAggregateResult | undefined;
        let chainWalk: PureTsChainWalkResult | undefined;
        let cryptoPrepOk = false;
        let merkleStructOk = false;
        let rootVerified = false;
        let preliminaryOk = false;
        let aggregateOk = false;
        let chainOk = false;
        let reason = shape.reason;

        if (shape.shapeOk && shape.parsed.ms) {
            stmPrep = prepareStmCrypto(shape.parsed.ms);
            cryptoPrepOk = stmPrep.cryptoPrepOk;
            reason = stmPrep.reason;

            merkle = verifyBatchProofWithRoot(
                shape.parsed.ms,
                shape.parsed.avk,
            );
            merkleStructOk = merkle.merkleStructOk;
            rootVerified = merkle.rootVerified;
            if (merkleStructOk || merkle.errors.length > 0 || rootVerified) {
                reason = merkle.reason;
            }

            stmPrelim = preliminaryVerifyFromParsed(shape.parsed);
            preliminaryOk = stmPrelim.preliminaryOk;
            if (
                stmPrelim.details.msgpMode !== "missing" ||
                stmPrelim.errors.length > 0
            ) {
                reason = stmPrelim.reason;
            }

            stmAggregate = verifyStmAggregateFromParsed(shape.parsed);
            aggregateOk = stmAggregate.aggregateOk;
            if (
                stmAggregate.details.mode !== "none" ||
                stmAggregate.errors.length > 0
            ) {
                reason = stmAggregate.reason;
            }
        } else if (shape.shapeOk) {
            reason =
                "Stage 1 shape OK but multi_signature missing — Stage 2–5b skipped";
        }

        // Stage 5c: optional chain walk (tip integrity re-runs STM; predecessors/fetcher optional)
        if (runChainWalk && shape.shapeOk) {
            chainWalk = await walkCertificateChain(certJson, {
                predecessors: opts.predecessors,
                fetcher: opts.fetcher,
                genesisVkey: opts.genesisVkey,
                maxDepth: opts.maxDepth,
            });
            chainOk = chainWalk.chainOk;
            // Prefer chain reason when walk ran (success or honest incomplete)
            reason = chainWalk.reason;
        }

        return {
            implemented: false,
            ok: false,
            shapeOk: shape.shapeOk,
            cryptoPrepOk,
            merkleStructOk,
            rootVerified,
            preliminaryOk,
            aggregateOk,
            chainOk,
            reason,
            certShape: shape,
            stmPrep,
            merkle,
            stmPrelim,
            stmAggregate,
            chainWalk,
        };
    }

    return {
        implemented: false,
        ok: false,
        shapeOk: false,
        cryptoPrepOk: false,
        merkleStructOk: false,
        rootVerified: false,
        preliminaryOk: false,
        aggregateOk: false,
        chainOk: false,
        reason:
            "Phase 4 pure-TS full cert-chain not dual-run matched. " +
            "No cert JSON provided for Stage 1–5c. " +
            "Use WASM verifyCertificateChain as SoT. " +
            `Have: Stage 1–5c (shape/cryptoPrep/merkle/root/preliminary/aggregate/chainWalk). ` +
            `Missing: ${inv.mithrilGaps.slice(0, 3).join("; ")}.`,
    };
}

/**
 * Dual-run: WASM verify (SoT) + pure-TS Stage 1–5c shadow on the same cert JSON.
 * match stays false until pure-TS cryptographic cert-chain verify exists and agrees.
 */
export async function dualRunCertificateChain(
    client: GerolamoMithrilClient,
    certificateHash: string,
    opts: PureTsVerifyOptions = {},
): Promise<DualRunVerifyResult> {
    let wasmOk = false;
    let cert: MithrilCertificate | null = null;
    let wasmError: string | undefined;

    try {
        cert = await client.verifyCertificateChain(certificateHash);
        wasmOk = true;
    } catch (e) {
        wasmError = e instanceof Error ? e.message : String(e);
        wasmOk = false;
    }

    const pureTs = await pureTsVerifyCertificateChain(
        certificateHash,
        cert ?? null,
        opts,
    );

    return {
        certificateHash,
        wasm: { ok: wasmOk, cert, error: wasmError },
        pureTs,
        // Cryptographic full-chain match only — Stage flags alone never set match
        match: false,
    };
}
