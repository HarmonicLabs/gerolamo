/**
 * Phase 4 Stage 5c — pure-TS certificate-chain walk (structural + per-cert STM).
 *
 * Source: IntersectMBO mithril-common certificate_verifier.rs
 *   - verify_certificate_chain: while previous = verify_certificate(cert)
 *   - standard: integrity + epoch chaining + previous_hash + AVK chaining + params chaining
 *   - genesis: Ed25519 verify(signed_message.as_bytes(), genesis_signature) with network genesis vkey
 *
 * Honesty:
 * - chainOk is true ONLY when the walk reaches a genesis cert and Ed25519 verifies.
 * - Without a full chain to genesis (or without genesis vkey), chainOk stays false.
 * - Certificate content-hash recompute (try_compute_hash) is NOT fully ported yet —
 *   we trust aggregator-served hashes for link checks and rely on Stage 5b STM on each standard cert.
 * - dual-run match / pureTsStmImplemented stay false until full chain + dual-run soak.
 *
 * Protocol message hash (proven):
 *   SHA-256 over message_parts in ProtocolMessagePartKey **enum declaration order**
 *   (BTreeMap Ord = enum order, NOT alphabetical Display sort).
 *
 * See docs/phase-4-pure-ts-crypto-research.md
 */

import { createHash } from "crypto";
import { verifyEd25519Signature_sync } from "@harmoniclabs/crypto";

import type { MithrilCertificate } from "../types";
import {
    parseAndValidateCertificate,
    type PureTsCertParseResult,
} from "./cert";
import {
    preliminaryVerifyFromParsed,
    verifyStmAggregateFromParsed,
    type PureTsStmAggregateResult,
    type PureTsStmPreliminaryResult,
} from "./stm";
import {
    verifyBatchProofWithRoot,
    type PureTsMerkleValidateResult,
} from "./merkle";

// ---------------------------------------------------------------------------
// ProtocolMessagePartKey enum declaration order (IntersectMBO Ord / BTreeMap)
// ---------------------------------------------------------------------------

/**
 * Enum declaration order from protocol_message.rs — BTreeMap iterates in this
 * order, NOT alphabetical Display string order. Proven against golden tip+prev.
 */
export const PROTOCOL_MESSAGE_PART_KEY_ORDER = [
    "snapshot_digest",
    "cardano_transactions_merkle_root",
    "cardano_blocks_transactions_merkle_root",
    "next_aggregate_verification_key",
    "next_protocol_parameters",
    "current_epoch",
    "latest_block_number",
    "cardano_blocks_transactions_block_number_offset",
    "cardano_stake_distribution_epoch",
    "cardano_stake_distribution_merkle_root",
    "cardano_database_merkle_root",
    "next_aggregate_verification_key_snark",
] as const;

export type ProtocolMessageParts = Record<string, string>;

/**
 * WASM `@mithril-dev/mithril-client-wasm` returns `message_parts` as a JS `Map`
 * (JSON.stringify → `{}`, Object.keys → []). HTTP aggregator certs use a plain
 * object. Normalize both shapes before hashing.
 */
export function normalizeProtocolMessageParts(
    parts: unknown,
): ProtocolMessageParts {
    if (parts == null) return {};
    if (parts instanceof Map) {
        const out: ProtocolMessageParts = {};
        for (const [k, v] of parts.entries()) {
            if (k != null && v != null) out[String(k)] = String(v);
        }
        return out;
    }
    if (typeof parts === "object" && !Array.isArray(parts)) {
        const out: ProtocolMessageParts = {};
        for (const [k, v] of Object.entries(parts as Record<string, unknown>)) {
            if (v != null) out[k] = String(v);
        }
        return out;
    }
    return {};
}

/**
 * SHA-256 hex of protocol_message.message_parts in enum order.
 * Must equal certificate.signed_message for integrity.
 *
 * Accepts plain objects (HTTP) and Map (WASM verify_certificate_chain).
 */
export function computeProtocolMessageHash(
    protocolMessage: unknown,
): string | null {
    if (protocolMessage == null || typeof protocolMessage !== "object") {
        return null;
    }
    const pm = protocolMessage as {
        message_parts?: unknown;
    };
    // Some callers may pass message_parts directly
    const rawParts =
        pm.message_parts !== undefined
            ? pm.message_parts
            : (protocolMessage as unknown);
    const parts = normalizeProtocolMessageParts(rawParts);
    const h = createHash("sha256");
    let any = false;
    for (const k of PROTOCOL_MESSAGE_PART_KEY_ORDER) {
        const v = parts[k];
        if (v != null) {
            h.update(k);
            h.update(String(v));
            any = true;
        }
    }
    // If Map/object had keys outside our order list, still hash them last so we
    // don't silently accept empty — but enum order is the SoT when known.
    if (!any) {
        const extra = Object.keys(parts).sort();
        for (const k of extra) {
            h.update(k);
            h.update(String(parts[k]));
            any = true;
        }
    }
    if (!any) return null;
    return h.digest("hex");
}

export function verifySignedMessageMatchesProtocolMessage(
    cert: MithrilCertificate | Record<string, unknown>,
): { ok: boolean; computed: string | null; signed: string | null } {
    const signed =
        typeof cert.signed_message === "string" ? cert.signed_message : null;
    const computed = computeProtocolMessageHash(cert.protocol_message);
    return {
        ok: computed != null && signed != null && computed === signed,
        computed,
        signed,
    };
}

/**
 * Certificate::match_message — IntersectMBO SoT:
 *   message.compute_hash() == certificate.signed_message
 *
 * Accepts ProtocolMessage-shaped objects (`{ message_parts }`), bare parts
 * maps/objects, or WASM Map message_parts (via computeProtocolMessageHash).
 * Proven equal to WASM verify_message_match_certificate on preprod CDB tip
 * identity + MSD compute path (2026-08).
 *
 * This is artifact binding after MessageBuilder, NOT full snapshot digest
 * recompute from disk (cardano_database_merkle_root still needs merkle proof).
 */
export type CertificateMatchMessageResult = {
    ok: boolean;
    computed: string | null;
    signed: string | null;
    reason: string;
};

export function certificateMatchMessage(
    message: unknown,
    cert: MithrilCertificate | Record<string, unknown>,
): CertificateMatchMessageResult {
    const signed =
        typeof cert.signed_message === "string" ? cert.signed_message : null;
    const computed = computeProtocolMessageHash(message);
    if (computed == null) {
        return {
            ok: false,
            computed: null,
            signed,
            reason: "match_message: empty/unparseable protocol message",
        };
    }
    if (signed == null) {
        return {
            ok: false,
            computed,
            signed: null,
            reason: "match_message: cert.signed_message missing",
        };
    }
    const ok = computed === signed;
    return {
        ok,
        computed,
        signed,
        reason: ok
            ? "match_message OK — message.compute_hash == signed_message"
            : `match_message FAIL — computed=${computed.slice(0, 16)} signed=${signed.slice(0, 16)}`,
    };
}

/**
 * Identity check: cert.protocol_message hashes to cert.signed_message.
 * Equivalent to certificateMatchMessage(cert.protocol_message, cert).
 */
export function certificateMatchOwnProtocolMessage(
    cert: MithrilCertificate | Record<string, unknown>,
): CertificateMatchMessageResult {
    return certificateMatchMessage(
        (cert as { protocol_message?: unknown }).protocol_message,
        cert,
    );
}

// ---------------------------------------------------------------------------
// Stage 5f: MessageBuilder::compute_cardano_database_message
// ---------------------------------------------------------------------------

/**
 * ProtocolMessage-shaped object with message_parts as plain Record.
 * Suitable for certificateMatchMessage / WASM verify_message_match_certificate.
 */
export type ProtocolMessageJson = {
    message_parts: ProtocolMessageParts;
};

export type ComputeCardanoDatabaseMessageResult = {
    ok: boolean;
    message: ProtocolMessageJson | null;
    merkleRoot: string | null;
    reason: string;
};

export type VerifyCardanoDatabaseMessageMatchResult = CertificateMatchMessageResult & {
    /** True when snapshot merkle_root was applied into the message. */
    messageBuilt: boolean;
    merkleRoot: string | null;
    message: ProtocolMessageJson | null;
};

/**
 * MessageBuilder::compute_cardano_database_message (IntersectMBO mithril-client).
 *
 * Clones cert.protocol_message and sets:
 *   ProtocolMessagePartKey::CardanoDatabaseMerkleRoot = merkle_root hex
 *
 * Source (fs feature):
 *   let mut message = certificate.protocol_message.clone();
 *   message.set_message_part(CardanoDatabaseMerkleRoot, merkle_proof.root().to_hex());
 *
 * When the snapshot's published merkle_root already equals the cert PM part
 * (typical CDB tip), this is equivalent to identity match_message — still the
 * correct MessageBuilder binding step before full disk digest/merkle proof.
 *
 * Does NOT recompute merkle root from immutable files on disk.
 */
export function computeCardanoDatabaseMessage(
    cert: MithrilCertificate | Record<string, unknown>,
    merkleRootHex: string,
): ComputeCardanoDatabaseMessageResult {
    const root = String(merkleRootHex ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(root)) {
        return {
            ok: false,
            message: null,
            merkleRoot: root || null,
            reason: `CDB message: merkle_root must be 64-char hex (got ${root.slice(0, 16) || "empty"}…)`,
        };
    }

    const base = normalizeProtocolMessageParts(
        (cert as { protocol_message?: unknown }).protocol_message &&
            typeof (cert as { protocol_message?: { message_parts?: unknown } })
                .protocol_message === "object" &&
            (cert as { protocol_message?: { message_parts?: unknown } })
                .protocol_message != null &&
            "message_parts" in
                ((cert as { protocol_message?: Record<string, unknown> })
                    .protocol_message as object)
            ? (
                  (cert as { protocol_message?: { message_parts?: unknown } })
                      .protocol_message as { message_parts?: unknown }
              ).message_parts
            : (cert as { protocol_message?: unknown }).protocol_message,
    );

    // Always set/overwrite CardanoDatabaseMerkleRoot from artifact root.
    const parts: ProtocolMessageParts = {
        ...base,
        cardano_database_merkle_root: root,
    };

    // Need at least the root we just set (always true) — require some rigid
    // companion parts when present on cert so empty clone is still useful.
    const message: ProtocolMessageJson = { message_parts: parts };
    return {
        ok: true,
        message,
        merkleRoot: root,
        reason: "CDB MessageBuilder OK — cardano_database_merkle_root set",
    };
}

/**
 * Build CDB protocol message from snapshot merkle_root and match against cert.
 * Pure-TS equivalent of:
 *   msg = MessageBuilder.compute_cardano_database_message(cert, mk_proof)
 *   cert.match_message(&msg)
 *
 * Proven == WASM verify_message_match_certificate on preprod CDB tip (2026-08)
 * when merkle_root comes from list/get_cardano_database_v2.
 */
export function verifyCardanoDatabaseMessageMatch(
    cert: MithrilCertificate | Record<string, unknown>,
    merkleRootHex: string,
): VerifyCardanoDatabaseMessageMatchResult {
    const built = computeCardanoDatabaseMessage(cert, merkleRootHex);
    if (!built.ok || !built.message) {
        return {
            ok: false,
            computed: null,
            signed:
                typeof (cert as { signed_message?: unknown }).signed_message ===
                "string"
                    ? ((cert as { signed_message: string }).signed_message)
                    : null,
            reason: built.reason,
            messageBuilt: false,
            merkleRoot: built.merkleRoot,
            message: null,
        };
    }
    const matched = certificateMatchMessage(built.message, cert);
    return {
        ...matched,
        messageBuilt: true,
        merkleRoot: built.merkleRoot,
        message: built.message,
        reason: matched.ok
            ? "Stage 5f CDB messageMatch OK — MessageBuilder root binds signed_message"
            : matched.reason,
    };
}

// ---------------------------------------------------------------------------
// Genesis vkey / signature helpers
// ---------------------------------------------------------------------------

/**
 * Decode Mithril genesis.vkey file contents.
 * Common formats:
 * - hex-encoded JSON array of bytes (preprod/mainnet release files)
 * - raw 64-char hex of 32-byte pk
 * - base64
 */
export function decodeGenesisVkey(raw: string): Uint8Array {
    const s = raw.trim();
    if (!s) throw new Error("empty genesis vkey");

    // hex of JSON array: 5b31... → [127,73,...]
    if (/^[0-9a-fA-F]+$/.test(s) && s.length > 64) {
        try {
            const decoded = Buffer.from(s, "hex").toString("utf8");
            if (decoded.startsWith("[")) {
                const arr = JSON.parse(decoded) as number[];
                if (Array.isArray(arr) && arr.every((n) => typeof n === "number")) {
                    return Uint8Array.from(arr);
                }
            }
        } catch {
            /* fall through */
        }
    }

    if (/^[0-9a-fA-F]+$/.test(s) && s.length === 64) {
        return new Uint8Array(Buffer.from(s, "hex"));
    }

    try {
        const arr = JSON.parse(s) as number[];
        if (Array.isArray(arr)) return Uint8Array.from(arr);
    } catch {
        /* fall through */
    }

    // base64
    const b64 = Buffer.from(s, "base64");
    if (b64.length === 32) return new Uint8Array(b64);

    throw new Error(
        `decodeGenesisVkey: unrecognized format (len=${s.length} prefix=${s.slice(0, 16)})`,
    );
}

/**
 * Decode genesis_signature field (hex of bytes, hex-JSON array, or base64).
 * Ed25519 sig is 64 bytes.
 */
export function decodeGenesisSignature(raw: string): Uint8Array {
    const s = raw.trim();
    if (!s) throw new Error("empty genesis_signature");

    if (/^[0-9a-fA-F]+$/.test(s) && s.length === 128) {
        return new Uint8Array(Buffer.from(s, "hex"));
    }

    if (/^[0-9a-fA-F]+$/.test(s) && s.length > 128) {
        try {
            const decoded = Buffer.from(s, "hex").toString("utf8");
            if (decoded.startsWith("[")) {
                const arr = JSON.parse(decoded) as number[];
                return Uint8Array.from(arr);
            }
        } catch {
            /* fall through */
        }
    }

    try {
        const arr = JSON.parse(s) as number[];
        if (Array.isArray(arr)) return Uint8Array.from(arr);
    } catch {
        /* fall through */
    }

    const b64 = Buffer.from(s, "base64");
    if (b64.length === 64) return new Uint8Array(b64);

    throw new Error(
        `decodeGenesisSignature: unrecognized format (len=${s.length})`,
    );
}

export function isGenesisCertificate(
    cert: MithrilCertificate | Record<string, unknown>,
): boolean {
    const gs = cert.genesis_signature;
    const ms = cert.multi_signature;
    const hasGs = typeof gs === "string" && gs.length > 0;
    const hasMs = typeof ms === "string" && ms.length > 0;
    // IntersectMBO: GenesisSignature / GenesisDualSignature — wire often has genesis_signature set
    // and multi_signature empty. Also treat hash === previous_hash as chain root marker.
    if (hasGs && !hasMs) return true;
    if (
        typeof cert.hash === "string" &&
        typeof cert.previous_hash === "string" &&
        cert.hash === cert.previous_hash
    ) {
        return true;
    }
    return false;
}

export function isStandardCertificate(
    cert: MithrilCertificate | Record<string, unknown>,
): boolean {
    const ms = cert.multi_signature;
    return typeof ms === "string" && ms.length > 0 && !isGenesisCertificate(cert);
}

// ---------------------------------------------------------------------------
// Structural link checks (IntersectMBO standard certificate predecessor rules)
// ---------------------------------------------------------------------------

export type StructuralLinkResult = {
    ok: boolean;
    errors: string[];
    details: {
        previousHashMatch: boolean;
        epochOk: boolean;
        avkChainingOk: boolean | null;
        paramsChainingOk: boolean | null;
        sameEpoch: boolean | null;
        signedMessageOk: boolean;
    };
};

/**
 * Epoch chaining: current.epoch == previous.epoch OR current.epoch == previous.epoch + 1.
 * (IntersectMBO: no gap — CertificateChainMissingEpoch)
 */
export function verifyEpochChaining(
    epoch: number | undefined,
    prevEpoch: number | undefined,
): boolean {
    if (typeof epoch !== "number" || typeof prevEpoch !== "number") return false;
    if (!Number.isFinite(epoch) || !Number.isFinite(prevEpoch)) return false;
    return epoch === prevEpoch || epoch === prevEpoch + 1;
}

/**
 * AVK chaining (concatenation):
 * - same epoch: AVK strings equal
 * - different epoch: previous.protocol_message.next_aggregate_verification_key
 *   must equal current.aggregate_verification_key
 */
export function verifyAvkChaining(
    cert: MithrilCertificate | Record<string, unknown>,
    prev: MithrilCertificate | Record<string, unknown>,
): boolean {
    const curAvk =
        typeof cert.aggregate_verification_key === "string"
            ? cert.aggregate_verification_key
            : null;
    const prevAvk =
        typeof prev.aggregate_verification_key === "string"
            ? prev.aggregate_verification_key
            : null;
    if (!curAvk || !prevAvk) return false;

    const sameEpoch =
        typeof cert.epoch === "number" &&
        typeof prev.epoch === "number" &&
        cert.epoch === prev.epoch;

    if (sameEpoch) {
        return curAvk === prevAvk;
    }

    const parts = normalizeProtocolMessageParts(
        (prev.protocol_message as { message_parts?: unknown } | undefined)
            ?.message_parts,
    );
    const nextAvk = parts.next_aggregate_verification_key;
    return typeof nextAvk === "string" && nextAvk === curAvk;
}

/**
 * Protocol parameters chaining:
 * - same epoch: metadata.parameters deep-equal (k,m,phi_f)
 * - different epoch: previous.protocol_message.next_protocol_parameters
 *   must equal hash of current metadata.parameters (when we can compute it).
 *
 * For different-epoch we currently check presence of next_protocol_parameters
 * and that current has parameters — full params hash port is optional polish.
 */
export function verifyParamsChaining(
    cert: MithrilCertificate | Record<string, unknown>,
    prev: MithrilCertificate | Record<string, unknown>,
): boolean {
    const curParams = extractParameters(cert);
    const prevParams = extractParameters(prev);
    if (!curParams || !prevParams) return false;

    const sameEpoch =
        typeof cert.epoch === "number" &&
        typeof prev.epoch === "number" &&
        cert.epoch === prev.epoch;

    if (sameEpoch) {
        return (
            curParams.k === prevParams.k &&
            curParams.m === prevParams.m &&
            Number(curParams.phi_f) === Number(prevParams.phi_f)
        );
    }

    const parts = normalizeProtocolMessageParts(
        (prev.protocol_message as { message_parts?: unknown } | undefined)
            ?.message_parts,
    );
    // Different epoch: previous must advertise next_protocol_parameters.
    // Full equality vs hash(current params) needs ProtocolParameters::compute_hash port;
    // presence + current params exist is the structural minimum we enforce today.
    return (
        typeof parts.next_protocol_parameters === "string" &&
        parts.next_protocol_parameters.length > 0
    );
}

function extractParameters(
    cert: MithrilCertificate | Record<string, unknown>,
): { k: number; m: number; phi_f: number } | null {
    const meta = cert.metadata as
        | { parameters?: { k?: number; m?: number; phi_f?: number }; protocol_parameters?: { k?: number; m?: number; phi_f?: number } }
        | undefined;
    const p = meta?.parameters ?? meta?.protocol_parameters;
    if (!p || typeof p.k !== "number" || typeof p.m !== "number") return null;
    return { k: p.k, m: p.m, phi_f: Number(p.phi_f ?? 0) };
}

/**
 * Structural link checks between a standard cert and its predecessor.
 * Does NOT run STM (caller does).
 */
export function verifyStructuralLink(
    cert: MithrilCertificate | Record<string, unknown>,
    prev: MithrilCertificate | Record<string, unknown>,
): StructuralLinkResult {
    const errors: string[] = [];

    const previousHashMatch =
        typeof cert.previous_hash === "string" &&
        typeof prev.hash === "string" &&
        cert.previous_hash === prev.hash;
    if (!previousHashMatch) {
        errors.push(
            `previous_hash unmatch: cert.previous_hash=${String(cert.previous_hash).slice(0, 16)} prev.hash=${String(prev.hash).slice(0, 16)}`,
        );
    }

    if (
        typeof cert.hash === "string" &&
        typeof cert.previous_hash === "string" &&
        cert.hash === cert.previous_hash
    ) {
        errors.push("infinite loop: hash === previous_hash on non-genesis");
    }

    const epochOk = verifyEpochChaining(
        typeof cert.epoch === "number" ? cert.epoch : undefined,
        typeof prev.epoch === "number" ? prev.epoch : undefined,
    );
    if (!epochOk) {
        errors.push(
            `epoch chaining failed: cert.epoch=${String(cert.epoch)} prev.epoch=${String(prev.epoch)}`,
        );
    }

    const sameEpoch =
        typeof cert.epoch === "number" &&
        typeof prev.epoch === "number"
            ? cert.epoch === prev.epoch
            : null;

    const avkChainingOk = verifyAvkChaining(cert, prev);
    if (!avkChainingOk) errors.push("AVK chaining failed");

    const paramsChainingOk = verifyParamsChaining(cert, prev);
    if (!paramsChainingOk) errors.push("protocol parameters chaining failed");

    const sm = verifySignedMessageMatchesProtocolMessage(cert);
    if (!sm.ok) {
        errors.push(
            `signed_message ≠ protocol_message hash (computed=${sm.computed?.slice(0, 16)} signed=${sm.signed?.slice(0, 16)})`,
        );
    }

    return {
        ok: errors.length === 0,
        errors,
        details: {
            previousHashMatch,
            epochOk,
            avkChainingOk,
            paramsChainingOk,
            sameEpoch,
            signedMessageOk: sm.ok,
        },
    };
}

// ---------------------------------------------------------------------------
// Per-cert integrity (standard) + genesis Ed25519
// ---------------------------------------------------------------------------

export type StandardCertIntegrityResult = {
    ok: boolean;
    shapeOk: boolean;
    signedMessageOk: boolean;
    rootVerified: boolean;
    preliminaryOk: boolean;
    aggregateOk: boolean;
    reason: string;
    shape?: PureTsCertParseResult;
    merkle?: PureTsMerkleValidateResult;
    stmPrelim?: PureTsStmPreliminaryResult;
    stmAggregate?: PureTsStmAggregateResult;
    errors: string[];
};

/**
 * Standard cert integrity: shape + protocol_message hash + Stage 4/5a/5b.
 */
export function verifyStandardCertificateIntegrity(
    cert: MithrilCertificate | Record<string, unknown>,
): StandardCertIntegrityResult {
    const errors: string[] = [];
    const sm = verifySignedMessageMatchesProtocolMessage(cert);
    if (!sm.ok) {
        errors.push("signed_message ≠ protocol_message hash");
    }

    const shape = parseAndValidateCertificate(cert);
    if (!shape.shapeOk) {
        errors.push(`shape: ${shape.reason}`);
        return {
            ok: false,
            shapeOk: false,
            signedMessageOk: sm.ok,
            rootVerified: false,
            preliminaryOk: false,
            aggregateOk: false,
            reason: shape.reason,
            shape,
            errors,
        };
    }

    if (!shape.parsed.ms || !shape.parsed.avk) {
        errors.push("missing multi_signature or avk after shape parse");
        return {
            ok: false,
            shapeOk: true,
            signedMessageOk: sm.ok,
            rootVerified: false,
            preliminaryOk: false,
            aggregateOk: false,
            reason: "standard cert missing MS/AVK",
            shape,
            errors,
        };
    }

    const merkle = verifyBatchProofWithRoot(shape.parsed.ms, shape.parsed.avk);
    const stmPrelim = preliminaryVerifyFromParsed(shape.parsed);
    const stmAggregate = verifyStmAggregateFromParsed(shape.parsed);

    if (!merkle.rootVerified) errors.push(`root: ${merkle.reason}`);
    if (!stmPrelim.preliminaryOk) errors.push(`prelim: ${stmPrelim.reason}`);
    if (!stmAggregate.aggregateOk) errors.push(`aggregate: ${stmAggregate.reason}`);

    const ok =
        sm.ok &&
        shape.shapeOk &&
        merkle.rootVerified &&
        stmPrelim.preliminaryOk &&
        stmAggregate.aggregateOk;

    return {
        ok,
        shapeOk: shape.shapeOk,
        signedMessageOk: sm.ok,
        rootVerified: merkle.rootVerified,
        preliminaryOk: stmPrelim.preliminaryOk,
        aggregateOk: stmAggregate.aggregateOk,
        reason: ok
            ? "Stage 5c standard integrity OK (shape+PM+root+prelim+aggregate)"
            : `Stage 5c standard integrity FAILED: ${errors.join("; ")}`,
        shape,
        merkle,
        stmPrelim,
        stmAggregate,
        errors,
    };
}

export type GenesisCertVerifyResult = {
    ok: boolean;
    signedMessageOk: boolean;
    ed25519Ok: boolean;
    reason: string;
    errors: string[];
};

/**
 * Genesis cert: protocol_message hash + Ed25519(signed_message utf8, genesis_signature, genesis_pk).
 * Source: verify_genesis_certificate — signed_message.as_bytes() (UTF-8 of hex string).
 */
export function verifyGenesisCertificate(
    cert: MithrilCertificate | Record<string, unknown>,
    genesisVkeyRaw: string,
): GenesisCertVerifyResult {
    const errors: string[] = [];
    const sm = verifySignedMessageMatchesProtocolMessage(cert);
    if (!sm.ok) errors.push("signed_message ≠ protocol_message hash");

    if (!isGenesisCertificate(cert)) {
        return {
            ok: false,
            signedMessageOk: sm.ok,
            ed25519Ok: false,
            reason: "not a genesis certificate",
            errors: ["InvalidGenesisCertificateProvided"],
        };
    }

    const gsRaw =
        typeof cert.genesis_signature === "string" ? cert.genesis_signature : "";
    if (!gsRaw) {
        return {
            ok: false,
            signedMessageOk: sm.ok,
            ed25519Ok: false,
            reason: "genesis cert missing genesis_signature",
            errors: ["missing genesis_signature"],
        };
    }

    let ed25519Ok = false;
    try {
        const pk = decodeGenesisVkey(genesisVkeyRaw);
        const sig = decodeGenesisSignature(gsRaw);
        const msg = Buffer.from(String(cert.signed_message ?? ""), "utf8");
        ed25519Ok = verifyEd25519Signature_sync(sig, msg, pk);
        if (!ed25519Ok) errors.push("Ed25519 verify failed");
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        errors.push(`Ed25519 error: ${m}`);
    }

    const ok = sm.ok && ed25519Ok;
    return {
        ok,
        signedMessageOk: sm.ok,
        ed25519Ok,
        reason: ok
            ? "Stage 5c genesis OK (PM hash + Ed25519)"
            : `Stage 5c genesis FAILED: ${errors.join("; ")}`,
        errors,
    };
}

// ---------------------------------------------------------------------------
// Chain walk
// ---------------------------------------------------------------------------

export type CertificateFetcher = (
    hash: string,
) => Promise<MithrilCertificate | Record<string, unknown> | null>;

export type ChainStepResult = {
    hash: string;
    epoch: number | null;
    kind: "standard" | "genesis" | "unknown";
    integrityOk: boolean;
    linkOk: boolean | null;
    reason: string;
};

export type PureTsChainWalkResult = {
    /**
     * True only when walk reaches genesis and genesis Ed25519 verifies
     * (and every standard hop integrity + structural link passed).
     */
    chainOk: boolean;
    /** Always false — full dual-run match / SoT flip not claimed by Stage 5c alone. */
    verified: false;
    reason: string;
    details: {
        depth: number;
        reachedGenesis: boolean;
        genesisEd25519Ok: boolean | null;
        maxDepth: number;
        tipHash: string;
        steps: ChainStepResult[];
        /** True when tip standard integrity (Stage 1–5b) passed. */
        tipIntegrityOk: boolean;
        /** True when at least one predecessor was available and linked. */
        walkedPastTip: boolean;
        stoppedReason: string;
    };
    errors: string[];
};

export const DEFAULT_CHAIN_MAX_DEPTH = 128;

/**
 * HTTP certificate fetcher against a Mithril aggregator.
 */
export function createAggregatorCertificateFetcher(
    aggregatorBase: string,
): CertificateFetcher {
    const base = aggregatorBase.replace(/\/$/, "");
    return async (hash: string) => {
        const url = `${base}/certificate/${hash}`;
        const res = await fetch(url);
        if (!res.ok) {
            if (res.status === 404) return null;
            throw new Error(`fetch certificate ${hash.slice(0, 16)}: HTTP ${res.status}`);
        }
        return (await res.json()) as MithrilCertificate;
    };
}

/**
 * Walk certificate chain from tip toward genesis.
 *
 * @param tip Certificate JSON (tip)
 * @param opts.fetcher Required to walk beyond provided `predecessors`
 * @param opts.predecessors Optional known chain (tip's previous first, …)
 * @param opts.genesisVkey Raw genesis.vkey contents (required for chainOk=true at genesis)
 * @param opts.maxDepth Cap walk length (default 128)
 */
export async function walkCertificateChain(
    tip: MithrilCertificate | Record<string, unknown>,
    opts: {
        fetcher?: CertificateFetcher;
        predecessors?: Array<MithrilCertificate | Record<string, unknown>>;
        genesisVkey?: string;
        maxDepth?: number;
    } = {},
): Promise<PureTsChainWalkResult> {
    const maxDepth = opts.maxDepth ?? DEFAULT_CHAIN_MAX_DEPTH;
    const errors: string[] = [];
    const steps: ChainStepResult[] = [];
    const tipHash = typeof tip.hash === "string" ? tip.hash : "";

    // Tip integrity
    let tipIntegrityOk = false;
    if (isGenesisCertificate(tip)) {
        if (!opts.genesisVkey) {
            errors.push("tip is genesis but no genesisVkey provided");
            steps.push({
                hash: tipHash,
                epoch: typeof tip.epoch === "number" ? tip.epoch : null,
                kind: "genesis",
                integrityOk: false,
                linkOk: null,
                reason: "genesis tip without vkey",
            });
        } else {
            const g = verifyGenesisCertificate(tip, opts.genesisVkey);
            tipIntegrityOk = g.ok;
            if (!g.ok) errors.push(...g.errors.map((e) => `tip: ${e}`));
            steps.push({
                hash: tipHash,
                epoch: typeof tip.epoch === "number" ? tip.epoch : null,
                kind: "genesis",
                integrityOk: g.ok,
                linkOk: null,
                reason: g.reason,
            });
            return {
                chainOk: g.ok,
                verified: false,
                reason: g.ok
                    ? "Stage 5c chainOk — tip is genesis and Ed25519 verified"
                    : `Stage 5c chain FAILED at genesis tip: ${g.reason}`,
                details: {
                    depth: 1,
                    reachedGenesis: true,
                    genesisEd25519Ok: g.ed25519Ok,
                    maxDepth,
                    tipHash,
                    steps,
                    tipIntegrityOk,
                    walkedPastTip: false,
                    stoppedReason: g.ok ? "genesis_tip" : "genesis_tip_failed",
                },
                errors,
            };
        }
    } else if (isStandardCertificate(tip)) {
        const integ = verifyStandardCertificateIntegrity(tip);
        tipIntegrityOk = integ.ok;
        if (!integ.ok) errors.push(...integ.errors.map((e) => `tip: ${e}`));
        steps.push({
            hash: tipHash,
            epoch: typeof tip.epoch === "number" ? tip.epoch : null,
            kind: "standard",
            integrityOk: integ.ok,
            linkOk: null,
            reason: integ.reason,
        });
        if (!integ.ok) {
            return {
                chainOk: false,
                verified: false,
                reason: `Stage 5c chain FAILED at tip integrity: ${integ.reason}`,
                details: {
                    depth: 1,
                    reachedGenesis: false,
                    genesisEd25519Ok: null,
                    maxDepth,
                    tipHash,
                    steps,
                    tipIntegrityOk: false,
                    walkedPastTip: false,
                    stoppedReason: "tip_integrity_failed",
                },
                errors,
            };
        }
    } else {
        errors.push("tip is neither standard nor genesis");
        return {
            chainOk: false,
            verified: false,
            reason: "Stage 5c: tip certificate kind unknown",
            details: {
                depth: 0,
                reachedGenesis: false,
                genesisEd25519Ok: null,
                maxDepth,
                tipHash,
                steps,
                tipIntegrityOk: false,
                walkedPastTip: false,
                stoppedReason: "unknown_tip",
            },
            errors,
        };
    }

    // Build predecessor queue: provided first, then fetcher
    const predQueue = [...(opts.predecessors ?? [])];
    let current = tip;
    let walkedPastTip = false;
    let reachedGenesis = false;
    let genesisEd25519Ok: boolean | null = null;
    let stoppedReason = "incomplete";

    for (let depth = 1; depth < maxDepth; depth++) {
        const prevHash =
            typeof current.previous_hash === "string"
                ? current.previous_hash
                : "";
        if (!prevHash) {
            stoppedReason = "missing_previous_hash";
            errors.push("missing previous_hash");
            break;
        }
        if (prevHash === (typeof current.hash === "string" ? current.hash : "")) {
            stoppedReason = "self_loop";
            errors.push("hash === previous_hash without genesis markers");
            break;
        }

        let prev: MithrilCertificate | Record<string, unknown> | null = null;

        // Prefer provided predecessors matching hash
        const qi = predQueue.findIndex(
            (p) => typeof p.hash === "string" && p.hash === prevHash,
        );
        if (qi >= 0) {
            prev = predQueue.splice(qi, 1)[0]!;
        } else if (predQueue.length > 0 && depth === 1) {
            // first hop: take first provided predecessor if hash matches or unknown
            const cand = predQueue[0]!;
            if (
                typeof cand.hash === "string" &&
                cand.hash === prevHash
            ) {
                prev = predQueue.shift()!;
            }
        }

        if (!prev && opts.fetcher) {
            try {
                prev = await opts.fetcher(prevHash);
            } catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                errors.push(`fetch previous ${prevHash.slice(0, 16)}: ${m}`);
                stoppedReason = "fetch_error";
                break;
            }
        }

        if (!prev) {
            stoppedReason = "no_predecessor";
            errors.push(
                `no predecessor for ${prevHash.slice(0, 16)} (provide predecessors or fetcher)`,
            );
            break;
        }

        walkedPastTip = true;

        // Structural link current → prev
        const link = verifyStructuralLink(current, prev);
        if (!link.ok) {
            errors.push(
                ...link.errors.map(
                    (e) => `link ${String(current.hash).slice(0, 12)}→${String(prev!.hash).slice(0, 12)}: ${e}`,
                ),
            );
            steps.push({
                hash: typeof prev.hash === "string" ? prev.hash : prevHash,
                epoch: typeof prev.epoch === "number" ? prev.epoch : null,
                kind: isGenesisCertificate(prev)
                    ? "genesis"
                    : isStandardCertificate(prev)
                      ? "standard"
                      : "unknown",
                integrityOk: false,
                linkOk: false,
                reason: `structural link failed: ${link.errors.join("; ")}`,
            });
            stoppedReason = "link_failed";
            break;
        }

        // Genesis?
        if (isGenesisCertificate(prev)) {
            reachedGenesis = true;
            if (!opts.genesisVkey) {
                genesisEd25519Ok = false;
                errors.push("reached genesis but no genesisVkey provided");
                steps.push({
                    hash: typeof prev.hash === "string" ? prev.hash : prevHash,
                    epoch: typeof prev.epoch === "number" ? prev.epoch : null,
                    kind: "genesis",
                    integrityOk: false,
                    linkOk: true,
                    reason: "genesis reached; genesisVkey missing",
                });
                stoppedReason = "genesis_no_vkey";
                break;
            }
            const g = verifyGenesisCertificate(prev, opts.genesisVkey);
            genesisEd25519Ok = g.ed25519Ok;
            steps.push({
                hash: typeof prev.hash === "string" ? prev.hash : prevHash,
                epoch: typeof prev.epoch === "number" ? prev.epoch : null,
                kind: "genesis",
                integrityOk: g.ok,
                linkOk: true,
                reason: g.reason,
            });
            if (!g.ok) {
                errors.push(...g.errors.map((e) => `genesis: ${e}`));
                stoppedReason = "genesis_verify_failed";
                break;
            }
            stoppedReason = "reached_genesis";
            // Success path — all links + tip + genesis OK
            const chainOk = tipIntegrityOk && errors.length === 0 && g.ok;
            return {
                chainOk,
                verified: false,
                reason: chainOk
                    ? `Stage 5c chainOk — walked ${steps.length} certs to genesis; Ed25519 OK (verified=false: dual-run match not claimed)`
                    : `Stage 5c chain incomplete: ${errors.join("; ")}`,
                details: {
                    depth: steps.length,
                    reachedGenesis: true,
                    genesisEd25519Ok: g.ed25519Ok,
                    maxDepth,
                    tipHash,
                    steps,
                    tipIntegrityOk,
                    walkedPastTip,
                    stoppedReason: chainOk ? "reached_genesis" : stoppedReason,
                },
                errors,
            };
        }

        // Standard predecessor integrity
        if (isStandardCertificate(prev)) {
            const integ = verifyStandardCertificateIntegrity(prev);
            steps.push({
                hash: typeof prev.hash === "string" ? prev.hash : prevHash,
                epoch: typeof prev.epoch === "number" ? prev.epoch : null,
                kind: "standard",
                integrityOk: integ.ok,
                linkOk: true,
                reason: integ.reason,
            });
            if (!integ.ok) {
                errors.push(
                    ...integ.errors.map(
                        (e) => `prev ${String(prev!.hash).slice(0, 12)}: ${e}`,
                    ),
                );
                stoppedReason = "prev_integrity_failed";
                break;
            }
            current = prev;
            continue;
        }

        errors.push(
            `unknown certificate kind at ${String(prev.hash).slice(0, 16)}`,
        );
        steps.push({
            hash: typeof prev.hash === "string" ? prev.hash : prevHash,
            epoch: typeof prev.epoch === "number" ? prev.epoch : null,
            kind: "unknown",
            integrityOk: false,
            linkOk: true,
            reason: "unknown kind",
        });
        stoppedReason = "unknown_kind";
        break;
    }

    if (steps.length >= maxDepth) {
        stoppedReason = "max_depth";
        errors.push(`hit maxDepth=${maxDepth} without genesis`);
    }

    return {
        chainOk: false,
        verified: false,
        reason: `Stage 5c chain NOT complete (chainOk=false): ${stoppedReason}; ${errors.slice(0, 3).join("; ")}`,
        details: {
            depth: steps.length,
            reachedGenesis,
            genesisEd25519Ok,
            maxDepth,
            tipHash,
            steps,
            tipIntegrityOk,
            walkedPastTip,
            stoppedReason,
        },
        errors,
    };
}

/**
 * Convenience: walk tip + single known predecessor (no network).
 * chainOk will be false unless predecessor is genesis.
 */
export async function walkTipWithPredecessor(
    tip: MithrilCertificate | Record<string, unknown>,
    predecessor: MithrilCertificate | Record<string, unknown>,
    genesisVkey?: string,
): Promise<PureTsChainWalkResult> {
    return walkCertificateChain(tip, {
        predecessors: [predecessor],
        genesisVkey,
        maxDepth: 8,
    });
}
