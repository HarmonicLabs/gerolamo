/**
 * Phase 4 dual-run scaffold — WASM is source of truth for full cert-chain.
 *
 * Stage 1 (done): pure-TS cert shape parse of AVK + multi_signature.
 * Stage 2 (done): pure-TS STM crypto *prep* (G1/G2 decode + millerLoop plumbing).
 * Stage 3 (done): pure-TS Merkle batch_proof *structural* validate.
 * Stage 4 (done): pure-TS Merkle batch path root verify (Blake2b-256).
 * Stage 5a (done): pure-TS STM preliminary (lottery + bounds + k).
 * Stage 5b (done): pure-TS BLS multi-sig aggregate verify (aggregateOk).
 *   Still NOT chain-to-genesis / dual-run match / pureTsStmImplemented.
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

export type PureTsVerifyResult = {
    /**
     * Cryptographic full STM/chain verify implemented?
     * Always false until chain-to-genesis lands.
     * Stage 1–5b do NOT flip this.
     */
    implemented: false;
    /** Cryptographic full accept — always false until chain-to-genesis. */
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
     * Still NOT chain-to-genesis.
     */
    aggregateOk: boolean;
    reason: string;
    certShape?: PureTsCertParseResult;
    stmPrep?: PureTsStmCryptoPrepResult;
    merkle?: PureTsMerkleValidateResult;
    stmPrelim?: PureTsStmPreliminaryResult;
    stmAggregate?: PureTsStmAggregateResult;
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
     * Impossible until pure-TS chain-to-genesis exists
     * (shape/cryptoPrep/merkle/root/prelim/aggregate alone never sets match).
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
        mithrilGaps: [
            "Certificate-chain walk to genesis verification key",
            "Message encoding for verify_message_match_certificate (Cardano DB digests)",
            "Genesis vkey handling + epoch transitions in pure-TS",
            "Dual-run golden vectors vs WASM on preprod/mainnet certs (crypto match)",
            "Weighted n≥2 aggregate path soak (golden cert is n=1 identity)",
        ],
        pureTsStmImplemented: false,
        wasmIsSourceOfTruth: true,
        notes: [
            "BLS12-381 primitives exist but are NOT full Mithril cert-chain.",
            "Stage 1: parseAndValidateCertificate (shapeOk; verified=false).",
            "Stage 2: prepareStmCrypto (cryptoPrepOk; verified=false).",
            "Stage 3: structural batch_proof (merkleStructOk).",
            "Stage 4: verifyBatchProofWithRoot Blake2b-256 (rootVerified).",
            "Stage 5a: preliminaryVerifyFromParsed lottery/bounds/k (preliminaryOk).",
            "Stage 5b: verifyStmAggregateFromParsed BLS pairing (aggregateOk).",
            "msgp = utf8(signed_message hex string) || AVK root — NOT decoded hex.",
            "BLS min_sig DST is empty string (blst default); proven on golden.",
            "Source of truth today: client.verifyCertificateChain (IOG mithril-client-wasm).",
        ],
    };
}

/**
 * Pure-TS path for a certificate.
 *
 * - With cert JSON: Stage 1–5b shadow.
 * - ok / implemented always false (no chain-to-genesis).
 * - match never set here (dual-run owns match).
 */
export async function pureTsVerifyCertificateChain(
    certificateHash: string,
    certJson?: MithrilCertificate | Record<string, unknown> | null,
): Promise<PureTsVerifyResult> {
    const inv = cryptoInventory();

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
                reason: `Stage 1: cert.hash ${shape.parsed.hash} !== requested ${certificateHash}`,
                certShape: shape,
            };
        }

        let stmPrep: PureTsStmCryptoPrepResult | undefined;
        let merkle: PureTsMerkleValidateResult | undefined;
        let stmPrelim: PureTsStmPreliminaryResult | undefined;
        let stmAggregate: PureTsStmAggregateResult | undefined;
        let cryptoPrepOk = false;
        let merkleStructOk = false;
        let rootVerified = false;
        let preliminaryOk = false;
        let aggregateOk = false;
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
            // Prefer Stage 5b reason when aggregate ran
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

        return {
            implemented: false,
            ok: false,
            shapeOk: shape.shapeOk,
            cryptoPrepOk,
            merkleStructOk,
            rootVerified,
            preliminaryOk,
            aggregateOk,
            reason,
            certShape: shape,
            stmPrep,
            merkle,
            stmPrelim,
            stmAggregate,
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
        reason:
            "Phase 4 pure-TS full cert-chain not implemented. " +
            "No cert JSON provided for Stage 1–5b. " +
            "Use WASM verifyCertificateChain as SoT. " +
            `Have: Stage 1–5b (shape/cryptoPrep/merkle/root/preliminary/aggregate). ` +
            `Missing: ${inv.mithrilGaps.slice(0, 3).join("; ")}.`,
    };
}

/**
 * Dual-run: WASM verify (SoT) + pure-TS Stage 1–5b shadow on the same cert JSON.
 * match stays false until pure-TS cryptographic cert-chain verify exists and agrees.
 */
export async function dualRunCertificateChain(
    client: GerolamoMithrilClient,
    certificateHash: string,
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
    );

    return {
        certificateHash,
        wasm: { ok: wasmOk, cert, error: wasmError },
        pureTs,
        // Cryptographic full-chain match only — Stage flags alone never set match
        match: false,
    };
}
