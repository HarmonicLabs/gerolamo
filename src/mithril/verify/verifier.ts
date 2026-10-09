/**
 * Mithril certificate chain verification, ported from mithril-common
 * `MithrilCertificateVerifier` (concatenation proofs; the SNARK variants are not supported).
 *
 * Standard certificate: not chaining to itself, hash matches content, signed_message equals the
 * protocol message hash, the STM multi-signature verifies against the certificate's AVK and
 * protocol parameters, current_epoch part equals the epoch; then against its previous
 * certificate: no epoch gap, previous_hash matches, AVK chaining (same epoch: same AVK; new
 * epoch: the previous certificate's next_aggregate_verification_key) and protocol parameters
 * chaining (same epoch: equal; new epoch: hash equals the previous next_protocol_parameters).
 *
 * Genesis certificate: hash matches content, signed_message equals the protocol message hash,
 * Ed25519 (strict) signature of the signed_message UTF-8 bytes under the genesis key, and
 * current_epoch part equals the epoch.
 */

import { ed25519 } from "@noble/curves/ed25519";

import {
    CertificateError,
    computeCertificateHash,
    decodeKeyBytes,
    decodeNextAvk,
    parseCertificate,
    phiFFixed,
    protocolMessageHash,
    protocolParametersHash,
    type Certificate,
} from "./certificate";
import { avkEquals, verifyConcatenationProof, type StmVerifyStats } from "./stm";

const err = (code: string, message: string): never => {
    throw new CertificateError(code, message);
};

/** Decode a Mithril genesis verification key (JSON hex of 32 bytes, or bytes hex). */
export function decodeGenesisVerificationKey(raw: string): Uint8Array {
    return decodeKeyBytes(raw.trim(), 32, "genesis verification key");
}

/** ed25519-dalek `verify_strict`: canonical encodings, no small-order key or R. */
export function ed25519VerifyStrict(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean {
    if (sig.length !== 64 || pk.length !== 32) return false;
    try {
        const A = ed25519.Point.fromHex(pk, false);
        const R = ed25519.Point.fromHex(sig.subarray(0, 32), false);
        if (A.isSmallOrder() || R.isSmallOrder()) return false;
        return ed25519.verify(sig, msg, pk, { zip215: false });
    } catch {
        return false;
    }
}

function verifyHashMatchesContent(c: Certificate): void {
    if (computeCertificateHash(c) !== c.hash) err("CertificateHashUnmatch", `certificate ${c.hash} content hash differs`);
}

function verifySignedMessage(c: Certificate): void {
    if (protocolMessageHash(c.protocolMessage) !== c.signedMessage) err("CertificateProtocolMessageUnmatch", `certificate ${c.hash}`);
}

function verifyEpochMatchesProtocolMessage(c: Certificate): void {
    if (c.protocolMessage.get("current_epoch") !== c.epoch.toString()) err("CertificateEpochUnmatch", `certificate ${c.hash}`);
}

export function verifyGenesisCertificate(c: Certificate, genesisVkey: Uint8Array): void {
    if (c.signature.kind !== "genesis") err("InvalidGenesisCertificateProvided", c.hash);
    verifyHashMatchesContent(c);
    verifySignedMessage(c);
    const sig = (c.signature as { signature: Uint8Array }).signature;
    if (!ed25519VerifyStrict(sig, new TextEncoder().encode(c.signedMessage), genesisVkey)) err("CertificateGenesis", `genesis signature of ${c.hash} does not verify`);
    verifyEpochMatchesProtocolMessage(c);
}

/** Integrity checks of a standard certificate on its own (no predecessor). */
export function verifyStandardCertificateIntegrity(c: Certificate): StmVerifyStats {
    if (c.signature.kind !== "multi") return err("InvalidStandardCertificateProvided", c.hash);
    if (c.hash === c.previousHash) err("CertificateChainInfiniteLoop", c.hash);
    verifyHashMatchesContent(c);
    verifySignedMessage(c);
    let stats: StmVerifyStats;
    try {
        stats = verifyConcatenationProof(new TextEncoder().encode(c.signedMessage), c.avk, c.metadata.parameters, c.signature.proof);
    } catch (e) {
        return err("VerifyMultiSignature", `certificate ${c.hash}: ${(e as Error).message}`);
    }
    verifyEpochMatchesProtocolMessage(c);
    return stats;
}

export function verifyStandardCertificate(c: Certificate, previous: Certificate): StmVerifyStats {
    const stats = verifyStandardCertificateIntegrity(c);
    const gap = c.epoch > previous.epoch ? c.epoch - previous.epoch : previous.epoch - c.epoch;
    if (gap > 1n) err("CertificateChainMissingEpoch", `${c.hash} epoch ${c.epoch}, previous ${previous.epoch}`);
    if (previous.hash !== c.previousHash) err("CertificateChainPreviousHashUnmatch", c.hash);
    const sameEpoch = previous.epoch === c.epoch;
    if (sameEpoch) {
        if (!avkEquals(previous.avk, c.avk)) err("CertificateChainAVKUnmatch", c.hash);
    } else {
        const next = decodeNextAvk(previous.protocolMessage);
        if (!next || !avkEquals(next, c.avk)) err("CertificateChainAVKUnmatch", c.hash);
    }
    if (sameEpoch) {
        const a = previous.metadata.parameters;
        const b = c.metadata.parameters;
        if (a.k !== b.k || a.m !== b.m || phiFFixed(a.phiF) !== phiFFixed(b.phiF)) err("CertificateChainProtocolParametersUnmatch", c.hash);
    } else {
        const next = previous.protocolMessage.get("next_protocol_parameters");
        if (next === undefined || next !== protocolParametersHash(c.metadata.parameters)) err("CertificateChainProtocolParametersUnmatch", c.hash);
    }
    return stats;
}

export type CertificateRetriever = (hash: string) => Promise<Certificate>;

export type ChainHop = { hash: string; epoch: bigint; kind: "genesis" | "standard"; signatures: number; indices: number };

export type ChainVerifyResult = {
    /** Hashes from the given certificate back to the genesis certificate (or to a cached hop). */
    hops: ChainHop[];
    genesisHash: string | null;
    /** True when the walk stopped at a certificate already verified earlier (see `verifiedCache`). */
    stoppedAtCache: boolean;
    ms: number;
};

export type ChainVerifyOptions = {
    genesisVkey: Uint8Array;
    retrieve: CertificateRetriever;
    /** Hashes known to chain to genesis (verified before). The walk stops when it reaches one. */
    verifiedCache?: Set<string>;
    /** Safety bound on the number of hops (Mithril has none; one hop per epoch in practice). */
    maxHops?: number;
    onHop?: (hop: ChainHop) => void;
};

/**
 * CertificateVerifier::verify_certificate_chain: verify `cert`, then each previous certificate,
 * until the genesis certificate is verified.
 */
export async function verifyCertificateChain(cert: Certificate, opts: ChainVerifyOptions): Promise<ChainVerifyResult> {
    const t0 = performance.now();
    const hops: ChainHop[] = [];
    const seen = new Set<string>();
    const maxHops = opts.maxHops ?? 100_000;
    let c = cert;
    for (;;) {
        if (seen.has(c.hash)) err("CertificateChainInfiniteLoop", c.hash);
        seen.add(c.hash);
        if (hops.length >= maxHops) err("CertificateChainTooLong", `more than ${maxHops} certificates`);
        if (c.signature.kind === "genesis") {
            verifyGenesisCertificate(c, opts.genesisVkey);
            const hop: ChainHop = { hash: c.hash, epoch: c.epoch, kind: "genesis", signatures: 0, indices: 0 };
            hops.push(hop);
            opts.onHop?.(hop);
            return { hops, genesisHash: c.hash, stoppedAtCache: false, ms: performance.now() - t0 };
        }
        if (opts.verifiedCache?.has(c.hash) && hops.length > 0) {
            return { hops, genesisHash: null, stoppedAtCache: true, ms: performance.now() - t0 };
        }
        const previous = await opts.retrieve(c.previousHash);
        if (previous.hash !== c.previousHash) err("CertificateChainPreviousHashUnmatch", `asked ${c.previousHash}, got ${previous.hash}`);
        const stats = verifyStandardCertificate(c, previous);
        const hop: ChainHop = { hash: c.hash, epoch: c.epoch, kind: "standard", signatures: stats.signatures, indices: stats.indices };
        hops.push(hop);
        opts.onHop?.(hop);
        c = previous;
    }
}

/** A retriever over an aggregator's `/certificate/{hash}` route (lossless JSON). */
export function aggregatorCertificateRetriever(aggregatorUrl: string, fetchImpl: typeof fetch = fetch): CertificateRetriever {
    const base = aggregatorUrl.replace(/\/$/, "");
    return async (hash: string) => {
        if (!/^[0-9a-f]{64}$/.test(hash)) err("CertificateRetrieve", `bad certificate hash ${JSON.stringify(hash)}`);
        const res = await fetchImpl(`${base}/certificate/${hash}`);
        if (!res.ok) err("CertificateRetrieve", `GET ${base}/certificate/${hash}: HTTP ${res.status}`);
        return parseCertificate(await res.text());
    };
}
