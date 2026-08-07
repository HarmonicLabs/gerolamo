/**
 * Phase 4 Stage 1 — pure-TS Mithril certificate shape parse / validate.
 *
 * Honesty:
 * - Parses AVK + multi_signature hex→JSON structure from aggregator cert JSON.
 * - Validates field presence, types, and known layout from preprod golden cert.
 * - Genesis certs: empty multi_signature + non-empty genesis_signature is valid shape
 *   (STM multi-sig N/A; Ed25519 is Stage 5c). verified === false always.
 * - Does NOT verify STM multi-sig, cert chain, or genesis crypto.
 * - WASM remains source of truth for cryptographic acceptance.
 *
 * Observed preprod layout (testdata/mithril/certs/preprod/latest-verified-chain.json):
 *   aggregate_verification_key = hex(JSON({ mt_commitment: { root: u8[32], nr_leaves, hasher }, total_stake }))
 *   multi_signature = hex(JSON({
 *     signatures: [ [ { sigma: u8[48], indexes: number[], signer_index }, [ u8[], ... ] ] ],
 *     batch_proof: { values: u8[][], indices: number[], hasher }
 *   }))
 * Genesis wire (preprod ep196): multi_signature "" + genesis_signature 128-hex; AVK still present.
 */

import type { MithrilCertificate } from "../types";

/**
 * Genesis shape SoT (aligned with chain.ts isGenesisCertificate):
 * non-empty genesis_signature and empty/absent multi_signature, OR hash === previous_hash.
 * Kept local so Stage 1 does not import chain (avoids cycle); logic must stay in lockstep.
 */
function isGenesisShapeCert(c: Record<string, unknown>): boolean {
    const gs = c.genesis_signature;
    const ms = c.multi_signature;
    const hasGs = typeof gs === "string" && gs.length > 0;
    const hasMs = typeof ms === "string" && ms.length > 0;
    if (hasGs && !hasMs) return true;
    if (
        typeof c.hash === "string" &&
        typeof c.previous_hash === "string" &&
        c.hash === c.previous_hash
    ) {
        return true;
    }
    return false;
}

/** Merkle-tree commitment inside aggregate verification key. */
export type PureTsAvkMtCommitment = {
    /** 32-byte root (from JSON number array). */
    root: Uint8Array;
    nr_leaves: number;
    hasher: unknown;
};

export type PureTsAggregateVerificationKey = {
    mt_commitment: PureTsAvkMtCommitment;
    total_stake: number | bigint;
};

/** Single STM signature leaf (first element of each signatures pair). */
export type PureTsStmSignatureLeaf = {
    /** Typically 48-byte G1 compressed sigma. */
    sigma: Uint8Array;
    indexes: number[];
    signer_index: number;
};

/**
 * Each entry in multi_signature.signatures is a 2-tuple:
 *   [ leaf, pathOrAux ] where pathOrAux is nested byte arrays (Merkle path / aux).
 */
export type PureTsMsSignatureEntry = {
    leaf: PureTsStmSignatureLeaf;
    /** Opaque nested byte arrays — not interpreted in Stage 1. */
    path: unknown;
};

export type PureTsBatchProof = {
    values: Uint8Array[];
    indices: number[];
    hasher: unknown;
};

export type PureTsMultiSignature = {
    signatures: PureTsMsSignatureEntry[];
    batch_proof: PureTsBatchProof;
};

export type PureTsParsedCertificate = {
    hash: string;
    previous_hash: string | null;
    epoch: number | null;
    signed_entity_type: unknown;
    metadata: unknown;
    protocol_message: unknown;
    /** Hex digest string from cert JSON (not decoded further in Stage 1). */
    signed_message: string | null;
    avk: PureTsAggregateVerificationKey | null;
    ms: PureTsMultiSignature | null;
    genesis_signature: string | null;
    /** Raw hex strings preserved for later crypto stages. */
    raw: {
        aggregate_verification_key: string | null;
        multi_signature: string | null;
    };
};

export type PureTsCertParseResult = {
    /** Structural validation passed (required fields + AVK/MS decode). */
    shapeOk: boolean;
    /** Always false until STM verify lands (Stage 2+). */
    verified: false;
    reason: string;
    parsed: PureTsParsedCertificate;
    errors: string[];
};

const HEX_RE = /^[0-9a-fA-F]+$/;

function isHexString(s: string): boolean {
    return s.length > 0 && s.length % 2 === 0 && HEX_RE.test(s);
}

/** Decode hex string → UTF-8, then JSON.parse. Throws on failure. */
export function hexJsonDecode(hex: string, label: string): unknown {
    if (!isHexString(hex)) {
        throw new Error(`${label}: not even-length hex (len=${hex.length})`);
    }
    let text: string;
    try {
        text = Buffer.from(hex, "hex").toString("utf8");
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`${label}: hex→utf8 failed: ${msg}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`${label}: JSON.parse failed: ${msg}`);
    }
}

/** JSON number[] → Uint8Array; rejects non-byte values. */
export function numberArrayToBytes(arr: unknown, label: string): Uint8Array {
    if (!Array.isArray(arr)) {
        throw new Error(`${label}: expected number array`);
    }
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
            throw new Error(`${label}[${i}]: not a byte (got ${String(n)})`);
        }
        out[i] = n;
    }
    return out;
}

function parseAvk(hex: string): PureTsAggregateVerificationKey {
    const obj = hexJsonDecode(hex, "aggregate_verification_key") as Record<
        string,
        unknown
    >;
    if (!obj || typeof obj !== "object") {
        throw new Error("aggregate_verification_key: root not an object");
    }
    const mt = obj.mt_commitment as Record<string, unknown> | undefined;
    if (!mt || typeof mt !== "object") {
        throw new Error("aggregate_verification_key: missing mt_commitment");
    }
    const root = numberArrayToBytes(mt.root, "avk.mt_commitment.root");
    if (root.length !== 32) {
        throw new Error(
            `avk.mt_commitment.root: expected 32 bytes, got ${root.length}`,
        );
    }
    const nr = mt.nr_leaves;
    if (typeof nr !== "number" || !Number.isFinite(nr) || nr < 0) {
        throw new Error("avk.mt_commitment.nr_leaves: invalid");
    }
    const stake = obj.total_stake;
    if (typeof stake !== "number" && typeof stake !== "bigint") {
        throw new Error("avk.total_stake: invalid");
    }
    return {
        mt_commitment: {
            root,
            nr_leaves: nr,
            hasher: mt.hasher ?? null,
        },
        total_stake: stake as number | bigint,
    };
}

function parseStmLeaf(
    leaf: unknown,
    label: string,
): PureTsStmSignatureLeaf {
    if (!leaf || typeof leaf !== "object") {
        throw new Error(`${label}: leaf not an object`);
    }
    const o = leaf as Record<string, unknown>;
    const sigma = numberArrayToBytes(o.sigma, `${label}.sigma`);
    // Preprod golden: 48-byte sigma (G1 compressed). Accept 48 or 96 defensively.
    if (sigma.length !== 48 && sigma.length !== 96) {
        throw new Error(
            `${label}.sigma: unexpected length ${sigma.length} (want 48 or 96)`,
        );
    }
    if (!Array.isArray(o.indexes) || !o.indexes.every((x) => typeof x === "number")) {
        throw new Error(`${label}.indexes: expected number[]`);
    }
    if (typeof o.signer_index !== "number") {
        throw new Error(`${label}.signer_index: expected number`);
    }
    return {
        sigma,
        indexes: o.indexes as number[],
        signer_index: o.signer_index,
    };
}

function parseMultiSignature(hex: string): PureTsMultiSignature {
    const obj = hexJsonDecode(hex, "multi_signature") as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
        throw new Error("multi_signature: root not an object");
    }
    const sigsRaw = obj.signatures;
    if (!Array.isArray(sigsRaw) || sigsRaw.length === 0) {
        throw new Error("multi_signature.signatures: expected non-empty array");
    }
    const signatures: PureTsMsSignatureEntry[] = [];
    for (let i = 0; i < sigsRaw.length; i++) {
        const entry = sigsRaw[i];
        // Observed shape: [ leafObject, pathArray ]
        if (!Array.isArray(entry) || entry.length < 1) {
            throw new Error(
                `multi_signature.signatures[${i}]: expected [leaf, path] pair`,
            );
        }
        const leaf = parseStmLeaf(entry[0], `multi_signature.signatures[${i}].leaf`);
        signatures.push({ leaf, path: entry[1] ?? null });
    }

    const bp = obj.batch_proof as Record<string, unknown> | undefined;
    if (!bp || typeof bp !== "object") {
        throw new Error("multi_signature.batch_proof: missing");
    }
    if (!Array.isArray(bp.values)) {
        throw new Error("multi_signature.batch_proof.values: expected array");
    }
    const values = bp.values.map((v, i) =>
        numberArrayToBytes(v, `batch_proof.values[${i}]`),
    );
    if (!Array.isArray(bp.indices) || !bp.indices.every((x) => typeof x === "number")) {
        throw new Error("multi_signature.batch_proof.indices: expected number[]");
    }

    return {
        signatures,
        batch_proof: {
            values,
            indices: bp.indices as number[],
            hasher: bp.hasher ?? null,
        },
    };
}

function emptyParsed(partial?: Partial<PureTsParsedCertificate>): PureTsParsedCertificate {
    return {
        hash: "",
        previous_hash: null,
        epoch: null,
        signed_entity_type: null,
        metadata: null,
        protocol_message: null,
        signed_message: null,
        avk: null,
        ms: null,
        genesis_signature: null,
        raw: {
            aggregate_verification_key: null,
            multi_signature: null,
        },
        ...partial,
    };
}

/**
 * Parse + validate certificate JSON shape (Stage 1).
 * Never claims cryptographic verification.
 */
export function parseAndValidateCertificate(
    input: MithrilCertificate | Record<string, unknown> | unknown,
): PureTsCertParseResult {
    const errors: string[] = [];
    if (!input || typeof input !== "object") {
        return {
            shapeOk: false,
            verified: false,
            reason: "certificate is not an object",
            parsed: emptyParsed(),
            errors: ["certificate is not an object"],
        };
    }
    const c = input as Record<string, unknown>;

    const hash = typeof c.hash === "string" ? c.hash : "";
    if (!hash || hash.length < 16) {
        errors.push("hash: missing or too short");
    }

    const previous_hash =
        typeof c.previous_hash === "string"
            ? c.previous_hash
            : c.previous_hash == null
              ? null
              : String(c.previous_hash);

    let epoch: number | null = null;
    if (typeof c.epoch === "number" && Number.isFinite(c.epoch)) {
        epoch = c.epoch;
    } else {
        errors.push("epoch: missing or not a number");
    }

    const avkHex =
        typeof c.aggregate_verification_key === "string"
            ? c.aggregate_verification_key
            : null;
    // Empty string is wire-normal for genesis — treat as absent for parse.
    const msHexRaw =
        typeof c.multi_signature === "string" ? c.multi_signature : null;
    const msHex =
        msHexRaw != null && msHexRaw.length > 0 ? msHexRaw : null;

    // genesis_signature may be empty string on non-genesis certs (observed preprod)
    const genesis_signature =
        typeof c.genesis_signature === "string" && c.genesis_signature.length > 0
            ? c.genesis_signature
            : typeof c.genesis_signature === "string"
              ? c.genesis_signature
              : null;

    const isGenesis = isGenesisShapeCert(c);

    let avk: PureTsAggregateVerificationKey | null = null;
    let ms: PureTsMultiSignature | null = null;

    if (!avkHex) {
        errors.push("aggregate_verification_key: missing");
    } else {
        try {
            avk = parseAvk(avkHex);
        } catch (e) {
            // Genesis wire still carries AVK hex-JSON; if decode fails, keep error
            // (preprod genesis AVK decodes — do not silently drop AVK failures).
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }

    if (isGenesis) {
        // IntersectMBO genesis: multi_signature empty; STM multi-sig N/A.
        // Do not require ms decode. Leave ms = null.
        if (msHex) {
            // Unusual: genesis_signature + multi_signature both set — try parse, non-fatal for shape
            try {
                ms = parseMultiSignature(msHex);
            } catch {
                /* ignore dual-sig oddity for Stage 1 */
            }
        }
    } else if (!msHex) {
        errors.push("multi_signature: missing");
    } else {
        try {
            ms = parseMultiSignature(msHex);
        } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }

    if (isGenesis) {
        const gsOk =
            typeof genesis_signature === "string" && genesis_signature.length > 0;
        if (!gsOk) {
            errors.push("genesis_signature: missing on genesis cert");
        }
    }

    const signed_message =
        typeof c.signed_message === "string" ? c.signed_message : null;
    if (!signed_message) {
        errors.push("signed_message: missing");
    } else if (!isHexString(signed_message)) {
        errors.push("signed_message: not hex");
    }

    const parsed = emptyParsed({
        hash,
        previous_hash,
        epoch,
        signed_entity_type: c.signed_entity_type ?? null,
        metadata: c.metadata ?? null,
        protocol_message: c.protocol_message ?? null,
        signed_message,
        avk,
        ms,
        genesis_signature,
        raw: {
            aggregate_verification_key: avkHex,
            multi_signature: msHex,
        },
    });

    // Standard: need AVK + multi_sig. Genesis: need AVK + genesis_signature; multi_sig N/A.
    const shapeOk = isGenesis
        ? errors.length === 0 &&
          avk != null &&
          typeof genesis_signature === "string" &&
          genesis_signature.length > 0
        : errors.length === 0 && avk != null && ms != null;
    const reason = shapeOk
        ? isGenesis
            ? "Stage 1 shape OK — genesis (AVK + genesis_signature; multi_signature N/A; verified=false)"
            : "Stage 1 shape OK — AVK + multi_signature decoded; STM verify NOT implemented (verified=false)"
        : `Stage 1 shape FAILED: ${errors.join("; ")}`;
    return {
        shapeOk,
        verified: false,
        reason,
        parsed,
        errors,
    };
}

/**
 * Compare parse result against known golden-vector expectations (tests / CI).
 * Does not perform crypto.
 */
export function validateAgainstGoldenVector(
    result: PureTsCertParseResult,
    expect: {
        hash?: string;
        epoch?: number;
        avkRootLen?: number;
        msSigCount?: number;
        signedMessageLen?: number;
        sigmaLen?: number;
    },
): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!result.shapeOk) {
        errors.push(...result.errors);
        return { ok: false, errors };
    }
    const p = result.parsed;
    if (expect.hash != null && p.hash !== expect.hash) {
        errors.push(`hash: got ${p.hash}, want ${expect.hash}`);
    }
    if (expect.epoch != null && p.epoch !== expect.epoch) {
        errors.push(`epoch: got ${p.epoch}, want ${expect.epoch}`);
    }
    if (expect.avkRootLen != null) {
        const n = p.avk?.mt_commitment.root.length ?? -1;
        if (n !== expect.avkRootLen) {
            errors.push(`avk.root length: got ${n}, want ${expect.avkRootLen}`);
        }
    }
    if (expect.msSigCount != null) {
        const n = p.ms?.signatures.length ?? -1;
        if (n !== expect.msSigCount) {
            errors.push(`ms.signatures length: got ${n}, want ${expect.msSigCount}`);
        }
    }
    if (expect.signedMessageLen != null) {
        const n = p.signed_message?.length ?? -1;
        if (n !== expect.signedMessageLen) {
            errors.push(
                `signed_message length: got ${n}, want ${expect.signedMessageLen}`,
            );
        }
    }
    if (expect.sigmaLen != null && p.ms?.signatures[0]) {
        const n = p.ms.signatures[0].leaf.sigma.length;
        if (n !== expect.sigmaLen) {
            errors.push(`sigma length: got ${n}, want ${expect.sigmaLen}`);
        }
    }
    return { ok: errors.length === 0, errors };
}
