/**
 * Certificate try_compute_hash (IntersectMBO mithril-common Certificate::try_compute_hash).
 *
 * Proven against preprod tip cert (HTTP + WASM) 2026-08:
 *   previous_hash utf8
 *   epoch u64 BE
 *   metadata.compute_hash() hex string utf8
 *   protocol_message.compute_hash() hex string utf8  (== signed_message when PM ok)
 *   signed_message utf8
 *   aggregate_verification_key.to_json_hex() as utf8 of the hex field
 *   MultiSignature: SignedEntityType::feed_hash (CardanoDatabase: epoch u64 BE + imm u64 BE)
 *   signature.to_bytes_hex_for_certificate_hash() = multi_signature hex field utf8
 *     (genesis: genesis_signature hex utf8; no entity feed)
 *
 * Goldens (IntersectMBO tests):
 *   ProtocolParameters(1000,100,0.123) → ace01965…
 *   CertificateMetadata devnet fixture → f16631f0…
 *
 * Honesty: contentHashOk ≠ match ≠ pureTsStmImplemented.
 */

import { createHash } from "crypto";

import type { MithrilCertificate } from "../types";
import {
    computeProtocolMessageHash,
    normalizeProtocolMessageParts,
} from "./chain";

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function beU64(n: number | bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
}

function beI64(n: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(n);
    return b;
}

/** SignedEntityTypeId = u16 BE (IntersectMBO signed_entity_type.rs). */
function beU16(n: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n & 0xffff);
    return b;
}

/**
 * Database SignedEntityTypeId values (immutable; do not reuse removed ids).
 * CardanoImmutableFilesFull = 2 was removed — never reuse.
 */
export const ENTITY_TYPE_MITHRIL_STAKE_DISTRIBUTION = 0;
export const ENTITY_TYPE_CARDANO_STAKE_DISTRIBUTION = 1;
export const ENTITY_TYPE_CARDANO_TRANSACTIONS = 3;
export const ENTITY_TYPE_CARDANO_DATABASE = 4;
export const ENTITY_TYPE_CARDANO_BLOCKS_TRANSACTIONS = 5;

/** fixed::types::U8F24 — round(f * 2^24) as u32 BE. Proven on params golden. */
function u8f24BeRound(f: number): Buffer {
    const bits = Math.round(f * 2 ** 24) >>> 0;
    const b = Buffer.alloc(4);
    b.writeUInt32BE(bits);
    return b;
}

/**
 * RFC3339 with optional fractional seconds → nanos since Unix epoch.
 * Matches chrono DateTime::timestamp_nanos_opt for UTC Z timestamps.
 */
export function parseRfc3339Nanos(s: string): bigint {
    const m = String(s).match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/,
    );
    if (!m) {
        throw new Error(`parseRfc3339Nanos: bad timestamp ${s}`);
    }
    const [, Y, Mo, D, H, Mi, S, frac = ""] = m;
    const ms = Date.UTC(+Y!, +Mo! - 1, +D!, +H!, +Mi!, +S!);
    const sec = BigInt(Math.floor(ms / 1000));
    const fracPad = (frac + "000000000").slice(0, 9);
    return sec * 1_000_000_000n + BigInt(fracPad);
}

// ---------------------------------------------------------------------------
// Sub-hashes
// ---------------------------------------------------------------------------

/** ProtocolParameters::compute_hash — k/m u64 BE + phi_f as U8F24 BE. */
export function computeProtocolParametersHash(
    k: number,
    m: number,
    phiF: number,
): string {
    const h = createHash("sha256");
    h.update(beU64(k));
    h.update(beU64(m));
    h.update(u8f24BeRound(phiF));
    return h.digest("hex");
}

/** StakeDistributionParty::compute_hash — party_id utf8 + stake u64 BE. */
export function computeStakePartyHash(
    partyId: string,
    stake: number | bigint,
): string {
    const h = createHash("sha256");
    h.update(Buffer.from(String(partyId), "utf8"));
    h.update(beU64(stake));
    return h.digest("hex");
}

export type CertificateMetadataHashInput = {
    network: string;
    /** protocol_version field (REST: metadata.version) */
    protocolVersion: string;
    k: number;
    m: number;
    phiF: number;
    initiatedAt: string;
    sealedAt: string;
    signers: Array<{ party_id?: string; partyId?: string; stake: number | bigint }>;
};

/**
 * CertificateMetadata::compute_hash.
 * Feeds nested hashes as **hex strings (utf8)**, not raw digests.
 */
export function computeCertificateMetadataHash(
    md: CertificateMetadataHashInput,
): string {
    const h = createHash("sha256");
    h.update(Buffer.from(md.network, "utf8"));
    h.update(Buffer.from(md.protocolVersion, "utf8"));
    h.update(
        Buffer.from(
            computeProtocolParametersHash(md.k, md.m, md.phiF),
            "utf8",
        ),
    );
    h.update(beI64(parseRfc3339Nanos(md.initiatedAt)));
    h.update(beI64(parseRfc3339Nanos(md.sealedAt)));
    for (const s of md.signers) {
        const pid = String(s.party_id ?? s.partyId ?? "");
        h.update(Buffer.from(computeStakePartyHash(pid, s.stake), "utf8"));
    }
    return h.digest("hex");
}

/**
 * SignedEntityType::feed_hash into an existing hasher.
 *
 * SoT (IntersectMBO signed_entity_type.rs):
 *   - Discriminant index (u16 BE) is fed ONLY for CardanoBlocksTransactions
 *     (ENTITY_TYPE_CARDANO_BLOCKS_TRANSACTIONS = 5). Other variants intentionally
 *     omit index until a future hash migration.
 *   - Then beacon fields as u64 BE (epoch / imm / block_number / offset).
 */
export function feedSignedEntityType(
    hasher: ReturnType<typeof createHash>,
    signedEntityType: unknown,
): void {
    if (signedEntityType == null || typeof signedEntityType !== "object") {
        return;
    }
    const set = signedEntityType as Record<string, unknown>;

    if (set.CardanoDatabase && typeof set.CardanoDatabase === "object") {
        const b = set.CardanoDatabase as {
            epoch?: number;
            immutable_file_number?: number;
        };
        hasher.update(beU64(Number(b.epoch ?? 0)));
        hasher.update(beU64(Number(b.immutable_file_number ?? 0)));
        return;
    }
    if (set.MithrilStakeDistribution != null) {
        hasher.update(beU64(Number(set.MithrilStakeDistribution)));
        return;
    }
    if (set.CardanoStakeDistribution != null) {
        hasher.update(beU64(Number(set.CardanoStakeDistribution)));
        return;
    }
    if (Array.isArray(set.CardanoTransactions)) {
        const [ep, bn] = set.CardanoTransactions as [number, number];
        hasher.update(beU64(Number(ep)));
        hasher.update(beU64(Number(bn)));
        return;
    }
    if (Array.isArray(set.CardanoBlocksTransactions)) {
        // Discriminant index ONLY for CBT (SoT TODO: eventually all variants).
        hasher.update(beU16(ENTITY_TYPE_CARDANO_BLOCKS_TRANSACTIONS));
        const [ep, bn, off] = set.CardanoBlocksTransactions as [
            number,
            number,
            number,
        ];
        hasher.update(beU64(Number(ep)));
        hasher.update(beU64(Number(bn)));
        hasher.update(beU64(Number(off)));
    }
}

// ---------------------------------------------------------------------------
// try_compute_hash
// ---------------------------------------------------------------------------

export type TryComputeCertificateHashResult = {
    ok: boolean;
    computed: string | null;
    expected: string | null;
    metadataHash: string | null;
    protocolMessageHash: string | null;
    errors: string[];
    reason: string;
};

function extractMetadataInput(
    cert: MithrilCertificate | Record<string, unknown>,
): CertificateMetadataHashInput | null {
    const meta = cert.metadata as
        | {
              network?: string;
              version?: string;
              protocol_version?: string;
              parameters?: { k?: number; m?: number; phi_f?: number };
              protocol_parameters?: { k?: number; m?: number; phi_f?: number };
              initiated_at?: string;
              sealed_at?: string;
              signers?: Array<{
                  party_id?: string;
                  partyId?: string;
                  stake?: number;
              }>;
          }
        | undefined;
    if (!meta || typeof meta !== "object") return null;
    const params = meta.parameters ?? meta.protocol_parameters;
    if (!params || typeof params.k !== "number" || typeof params.m !== "number") {
        return null;
    }
    const network = meta.network;
    const protocolVersion = meta.version ?? meta.protocol_version;
    const initiatedAt = meta.initiated_at;
    const sealedAt = meta.sealed_at;
    if (
        typeof network !== "string" ||
        typeof protocolVersion !== "string" ||
        typeof initiatedAt !== "string" ||
        typeof sealedAt !== "string"
    ) {
        return null;
    }
    const signers = Array.isArray(meta.signers) ? meta.signers : [];
    return {
        network,
        protocolVersion,
        k: params.k,
        m: params.m,
        phiF: Number(params.phi_f ?? 0),
        initiatedAt,
        sealedAt,
        signers: signers.map((s) => ({
            party_id: s.party_id,
            partyId: s.partyId,
            stake: Number(s.stake ?? 0),
        })),
    };
}

/**
 * Certificate::try_compute_hash — pure-TS port.
 * Returns ok when computed hex equals cert.hash.
 */
export function tryComputeCertificateHash(
    cert: MithrilCertificate | Record<string, unknown>,
): TryComputeCertificateHashResult {
    const errors: string[] = [];
    const expected =
        typeof cert.hash === "string" && cert.hash.length > 0
            ? cert.hash
            : null;
    if (!expected) errors.push("cert.hash missing");

    const previousHash =
        typeof cert.previous_hash === "string" ? cert.previous_hash : null;
    if (!previousHash) errors.push("previous_hash missing");

    const epoch =
        typeof cert.epoch === "number" && Number.isFinite(cert.epoch)
            ? cert.epoch
            : null;
    if (epoch == null) errors.push("epoch missing");

    const signedMessage =
        typeof cert.signed_message === "string" ? cert.signed_message : null;
    if (!signedMessage) errors.push("signed_message missing");

    const avk =
        typeof cert.aggregate_verification_key === "string"
            ? cert.aggregate_verification_key
            : null;
    if (!avk) errors.push("aggregate_verification_key missing");

    const multiSig =
        typeof cert.multi_signature === "string" ? cert.multi_signature : "";
    const genesisSig =
        typeof cert.genesis_signature === "string"
            ? cert.genesis_signature
            : "";
    const isGenesis = genesisSig.length > 0 && multiSig.length === 0;
    const isStandard = multiSig.length > 0;

    if (!isGenesis && !isStandard) {
        errors.push("neither multi_signature nor genesis_signature present");
    }

    let metadataHash: string | null = null;
    try {
        const mdIn = extractMetadataInput(cert);
        if (!mdIn) {
            errors.push("metadata incomplete");
        } else {
            metadataHash = computeCertificateMetadataHash(mdIn);
        }
    } catch (e) {
        errors.push(
            `metadata hash: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    const protocolMessageHash = computeProtocolMessageHash(
        cert.protocol_message,
    );
    if (!protocolMessageHash) {
        errors.push("protocol_message hash failed (empty/missing parts?)");
    }

    if (errors.length > 0) {
        return {
            ok: false,
            computed: null,
            expected,
            metadataHash,
            protocolMessageHash,
            errors,
            reason: `try_compute_hash incomplete: ${errors.join("; ")}`,
        };
    }

    try {
        const h = createHash("sha256");
        h.update(Buffer.from(previousHash!, "utf8"));
        h.update(beU64(epoch!));
        h.update(Buffer.from(metadataHash!, "utf8"));
        h.update(Buffer.from(protocolMessageHash!, "utf8"));
        h.update(Buffer.from(signedMessage!, "utf8"));
        // to_json_hex().as_bytes() ≡ utf8 of the hex field already on the wire
        h.update(Buffer.from(avk!, "utf8"));

        if (isStandard) {
            feedSignedEntityType(h, cert.signed_entity_type);
            h.update(Buffer.from(multiSig, "utf8"));
        } else {
            // GenesisSignature: ed25519 bytes as hex string utf8
            h.update(Buffer.from(genesisSig, "utf8"));
        }

        const computed = h.digest("hex");
        const ok = computed === expected;
        return {
            ok,
            computed,
            expected,
            metadataHash,
            protocolMessageHash,
            errors: ok
                ? []
                : [
                      `hash mismatch computed=${computed.slice(0, 16)} expected=${String(expected).slice(0, 16)}`,
                  ],
            reason: ok
                ? "try_compute_hash OK — computed == cert.hash"
                : `try_compute_hash FAIL — computed≠cert.hash`,
        };
    } catch (e) {
        return {
            ok: false,
            computed: null,
            expected,
            metadataHash,
            protocolMessageHash,
            errors: [e instanceof Error ? e.message : String(e)],
            reason: `try_compute_hash threw: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
}

/**
 * Verify cert.hash matches try_compute_hash and (when present) the requested hash.
 */
export function verifyCertificateContentHash(
    cert: MithrilCertificate | Record<string, unknown>,
    requestedHash?: string | null,
): TryComputeCertificateHashResult {
    const r = tryComputeCertificateHash(cert);
    if (
        requestedHash &&
        typeof cert.hash === "string" &&
        cert.hash !== requestedHash
    ) {
        return {
            ...r,
            ok: false,
            errors: [
                ...r.errors,
                `cert.hash ${cert.hash.slice(0, 16)} !== requested ${requestedHash.slice(0, 16)}`,
            ],
            reason: `content hash: cert.hash ≠ requested hash`,
        };
    }
    // silence unused import guard if tree-shaken oddly
    void normalizeProtocolMessageParts;
    return r;
}
