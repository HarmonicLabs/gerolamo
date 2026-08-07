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
 * Stage 5d (done): Certificate::try_compute_hash content-hash (contentHashOk).
 * Stage 5e (done): Certificate::match_message identity (messageMatchOk).
 * Stage 5f (done): CDB MessageBuilder bind snapshot merkle_root (cdbMessageMatchOk).
 *   Full disk digest/merkle-proof recompute still open.
 *   Still NOT pureTsStmImplemented / pureTs.ok cutover.
 *
 * Do not claim pure-TS crypto SoT until PureTsVerifyResult.implemented === true.
 * dual-run match = wasmOk && Stages 1–5d (5e/5f are side-channels).
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
    certificateMatchOwnProtocolMessage,
    verifyCardanoDatabaseMessageMatch,
    type CertificateFetcher,
    type CertificateMatchMessageResult,
    type PureTsChainWalkResult,
    type VerifyCardanoDatabaseMessageMatchResult,
} from "./pureTs/chain";
import {
    tryComputeCertificateHash,
    type TryComputeCertificateHashResult,
} from "./pureTs/certHash";

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
    /**
     * Stage 5d: Certificate::try_compute_hash recomputes cert.hash
     * (metadata + PM + AVK + signed_entity + sig feed). Not dual-run match.
     */
    contentHashOk: boolean;
    /**
     * Stage 5e: Certificate::match_message identity —
     * cert.protocol_message.compute_hash() === cert.signed_message.
     * Side-channel; does NOT enter pureTsFullChainStagesOk / dual-run match.
     */
    messageMatchOk: boolean;
    /**
     * Stage 5f: MessageBuilder::compute_cardano_database_message + match_message.
     * Binds snapshot merkle_root into PM and checks signed_message.
     * Side-channel only — requires opts.cardanoDatabaseMerkleRoot.
     * Does NOT recompute merkle root from immutable files on disk.
     */
    cdbMessageMatchOk: boolean;
    reason: string;
    certShape?: PureTsCertParseResult;
    stmPrep?: PureTsStmCryptoPrepResult;
    merkle?: PureTsMerkleValidateResult;
    stmPrelim?: PureTsStmPreliminaryResult;
    stmAggregate?: PureTsStmAggregateResult;
    chainWalk?: PureTsChainWalkResult;
    contentHash?: TryComputeCertificateHashResult;
    messageMatch?: CertificateMatchMessageResult;
    cdbMessageMatch?: VerifyCardanoDatabaseMessageMatchResult;
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
     * True when WASM verifyCertificateChain succeeds AND pure-TS Stages 1–5d all
     * succeed on the same cert (shape+prep+merkle+root+prelim+aggregate+chain+contentHash).
     * Partial stage flags alone never set match. Does NOT flip pureTs.implemented/ok
     * (WASM remains SoT until cutover).
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
    /** Stage 5d Certificate::try_compute_hash content-hash recompute. */
    pureTsCertContentHash: boolean;
    /** Stage 5e Certificate::match_message identity (protocol_message ↔ signed_message). */
    pureTsCertMessageMatch: boolean;
    /** Stage 5f CDB MessageBuilder bind snapshot merkle_root → match_message. */
    pureTsCdbMessageMatch: boolean;
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
        pureTsCertContentHash: true,
        pureTsCertMessageMatch: true,
        pureTsCdbMessageMatch: true,
        mithrilGaps: [
            "CDB merkle root recompute from immutable digests on disk (Stage 5f binds published snapshot merkle_root only)",
            "pureTsStmImplemented / pureTs.ok cutover — match is dual-run assert only; WASM remains SoT",
            "CardanoBlocksTransactions signed-entity discriminant index feed (CDB tip is CardanoDatabase)",
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
            "Stage 5d: tryComputeCertificateHash (contentHashOk; preprod + mainnet tip).",
            "Stage 5e: certificateMatchMessage identity (messageMatchOk; == WASM verify_message_match_certificate).",
            "Stage 5f: computeCardanoDatabaseMessage + match (cdbMessageMatchOk; binds snapshot merkle_root).",
            "match = wasmOk && Stages 1–5d only (5e/5f side-channels, not match gate).",
            "implemented/ok stay false until cutover — match ≠ pure-TS SoT.",
            "Preprod dual-run soak: match=true depth 111; contentHashOk; no-walk match=false.",
            "Mainnet dual-run soak: match=true depth 110; nSig=53 weighted aggregateOk; contentHashOk.",
            "Weighted n≥2 aggregate path proven on mainnet tip (mode=weighted); n=1 identity still on preprod tip.",
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
    /**
     * Stage 5f: Cardano DB snapshot merkle_root (64-char hex) from
     * list/get_cardano_database_v2. When set, runs MessageBuilder bind + match_message.
     * Does NOT enter pureTsFullChainStagesOk / dual-run match.
     */
    cardanoDatabaseMerkleRoot?: string;
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
                contentHashOk: false,
                messageMatchOk: false,
                cdbMessageMatchOk: false,
                reason: `Stage 1: cert.hash ${shape.parsed.hash} !== requested ${certificateHash}`,
                certShape: shape,
            };
        }

        let stmPrep: PureTsStmCryptoPrepResult | undefined;
        let merkle: PureTsMerkleValidateResult | undefined;
        let stmPrelim: PureTsStmPreliminaryResult | undefined;
        let stmAggregate: PureTsStmAggregateResult | undefined;
        let chainWalk: PureTsChainWalkResult | undefined;
        let contentHash: TryComputeCertificateHashResult | undefined;
        let messageMatch: CertificateMatchMessageResult | undefined;
        let cdbMessageMatch: VerifyCardanoDatabaseMessageMatchResult | undefined;
        let cryptoPrepOk = false;
        let merkleStructOk = false;
        let rootVerified = false;
        let preliminaryOk = false;
        let aggregateOk = false;
        let chainOk = false;
        let contentHashOk = false;
        let messageMatchOk = false;
        let cdbMessageMatchOk = false;
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

        // Stage 5d: try_compute_hash content-hash (independent of STM stages)
        if (shape.shapeOk) {
            contentHash = tryComputeCertificateHash(certJson);
            contentHashOk = contentHash.ok;
            // Prefer content-hash reason only when it fails; chain walk may override later
            if (!contentHashOk) {
                reason = contentHash.reason;
            }

            // Stage 5e: match_message identity (side-channel; not dual-run match gate)
            messageMatch = certificateMatchOwnProtocolMessage(certJson);
            messageMatchOk = messageMatch.ok;
            if (!messageMatchOk && contentHashOk) {
                // Surface 5e failure only when 5d already passed and walk may not run
                reason = messageMatch.reason;
            }

            // Stage 5f: CDB MessageBuilder bind snapshot merkle_root (side-channel)
            // Requires opts.cardanoDatabaseMerkleRoot — does NOT enter match gate.
            if (opts.cardanoDatabaseMerkleRoot) {
                cdbMessageMatch = verifyCardanoDatabaseMessageMatch(
                    certJson,
                    opts.cardanoDatabaseMerkleRoot,
                );
                cdbMessageMatchOk = cdbMessageMatch.ok;
                if (!cdbMessageMatchOk && contentHashOk && messageMatchOk) {
                    reason = cdbMessageMatch.reason;
                }
            }
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
            contentHashOk,
            messageMatchOk,
            cdbMessageMatchOk,
            reason,
            certShape: shape,
            stmPrep,
            merkle,
            stmPrelim,
            stmAggregate,
            chainWalk,
            contentHash,
            messageMatch,
            cdbMessageMatch,
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
        contentHashOk: false,
        messageMatchOk: false,
        cdbMessageMatchOk: false,
        reason:
            "Phase 4 pure-TS full cert-chain not dual-run matched. " +
            "No cert JSON provided for Stage 1–5f. " +
            "Use WASM verifyCertificateChain as SoT. " +
            `Have: Stage 1–5f (shape/cryptoPrep/merkle/root/preliminary/aggregate/chainWalk/contentHash/messageMatch/cdbMessage). ` +
            `Missing: ${inv.mithrilGaps.slice(0, 3).join("; ")}.`,
    };
}

/**
 * True when every pure-TS Stage 1–5d flag is green.
 * Single-stage flags (shape/prep/… alone) never qualify.
 */
export function pureTsFullChainStagesOk(pureTs: PureTsVerifyResult): boolean {
    return (
        pureTs.shapeOk &&
        pureTs.cryptoPrepOk &&
        pureTs.merkleStructOk &&
        pureTs.rootVerified &&
        pureTs.preliminaryOk &&
        pureTs.aggregateOk &&
        pureTs.chainOk &&
        pureTs.contentHashOk
    );
}

/**
 * Dual-run: WASM verify (SoT) + pure-TS Stage 1–5d shadow on the same cert JSON.
 *
 * match = wasmOk && pureTsFullChainStagesOk — engines agree on full cert-chain crypto.
 * pureTs.implemented / pureTs.ok stay false (shadow/assert only; WASM remains SoT).
 * Skipping chain walk (runChainWalk=false) keeps chainOk false → match false.
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

    // Honest dual-run assert: WASM accept + full pure-TS Stage 1–5d ladder.
    // Not cutover — implemented/ok remain false on PureTsVerifyResult.
    const match = wasmOk && pureTsFullChainStagesOk(pureTs);

    return {
        certificateHash,
        wasm: { ok: wasmOk, cert, error: wasmError },
        pureTs,
        match,
    };
}
