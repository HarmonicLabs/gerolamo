import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { blockFetchHeaderIdentity, headerParser } from "../blockHeaderParser";
import { verifyBlockBodyHash } from "../bodyHash";
import { verifyByronBlockSignature, type ByronBlockSignatureCheck } from "../byron/ByronCrypto";
import { validateHeader } from "../BlockHeaderValidator";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";
import type { WitnessVerifyJob } from "./witnessJob";

/**
 * The unit of CPU work handed to a validation worker (or run inline):
 * parse one ChainSync roll-forward and run the era's header validation
 * (KES / VRF / op-cert for Shelley+, structural for Byron).
 *
 * Byron OBFT signature/delegation checks are stateful (k-window) and stay on
 * the main thread; they are cheap ed25519 verifies.
 */
export interface HeaderValidationJob {
    /** ChainSyncRollForward CBOR bytes. */
    rollForward: Uint8Array;
    /** Epoch η0 hex for Shelley+ headers; empty for Byron. */
    nonceHex: string;
    /** Minimal config the validators read. */
    config: HeaderValidationConfig;
    /**
     * Epoch η0 (hex) per epoch the batch may span, keyed by epoch number. When
     * present the worker picks the nonce for the epoch it parsed, so the main
     * thread does not need to parse headers to look nonces up one by one.
     */
    noncesByEpoch?: Record<string, string>;
    /**
     * When set, Byron main-block signatures (block signature + delegation
     * certificate, two ed25519 verifies) are checked here, off the main thread.
     * The stateful OBFT checks (genesis key, delegation map, k-window) stay on
     * the main thread and use the returned key hashes.
     */
    byronProtocolMagic?: number;
}

export interface HeaderValidationConfig {
    networkMagic: number;
    shelleyGenesisFile: string;
    network?: string;
}

export interface HeaderValidationResult {
    ok: boolean;
    reason?: string;
    slot: string;
    hashHex: string;
    era: number;
    epoch: number;
    isByron: boolean;
    isEbb: boolean;
    prevHashHex: string | null;
    rawHeader: Uint8Array;
    /** Byron main blocks, when `byronProtocolMagic` was given. */
    byron?: ByronBlockSignatureCheck;
    /** Shelley+ headers: what the main-thread leader rules need (hex / bytes). */
    shelley?: {
        issuerHash: string;
        vrfKeyHash: string;
        leaderValue: Uint8Array;
        opcertCounter: number;
        opcertKesPeriod: number;
    };
}

/** Issuer / VRF / opcert facts of a Shelley+ header body. */
function shelleyFacts(era: number, header: any): HeaderValidationResult["shelley"] | undefined {
    if (era < 2) return undefined;
    try {
        const body = header?.header?.body ?? header?.body;
        if (!body) return undefined;
        const issuer = bytesOf(body.issuerPubKey);
        const vrf = bytesOf(body.vrfPubKey);
        if (!issuer || !vrf) return undefined;
        // Praos (Babbage+): leader value = blake2b_256("L" ‖ VRF output); the ledger-ts
        // helper hashes with SHA-256, which is not what the ledger compares against.
        // TPraos: the raw 64-byte output of the leader VRF.
        const leaderValue = era >= 6
            ? praosLeaderValue(bytesOf(body.vrfResult?.proofHash) ?? new Uint8Array(0))
            : new Uint8Array(bytesOf(body.leaderVrfResult?.proofHash) ?? new Uint8Array(0));
        return {
            issuerHash: toHex(blake2b_224(issuer)),
            vrfKeyHash: toHex(blake2b_256(vrf)),
            leaderValue,
            opcertCounter: Number(body.opCert?.sequenceNumber ?? -1),
            opcertKesPeriod: Number(body.opCert?.kesPeriod ?? -1),
        };
    } catch {
        return undefined;
    }
}

function bytesOf(v: any): Uint8Array | null {
    if (v instanceof Uint8Array) return v;
    if (v?.toBuffer) return new Uint8Array(v.toBuffer());
    if (typeof v?.toString === "function" && /^[0-9a-f]+$/i.test(String(v))) return fromHex(String(v));
    return null;
}

/** The header fields every result carries (one place to extend when ParsedHeader grows). */
function summarize(parsed: Awaited<ReturnType<typeof headerParser>> & object): Omit<HeaderValidationResult, "ok" | "reason" | "byron"> {
    return {
        slot: parsed.slot.toString(),
        hashHex: toHex(parsed.blockHeaderHash),
        era: parsed.era,
        epoch: parsed.epoch,
        isByron: parsed.isByron,
        isEbb: parsed.isEbb,
        prevHashHex: parsed.prevHashHex,
        rawHeader: parsed.rawHeaderBytes,
    };
}

export async function runHeaderValidationJob(job: HeaderValidationJob): Promise<HeaderValidationResult> {
    // Worker threads have their own module state: pin slot→epoch math to the job's network.
    if (job.config.network) setEpochNetwork(job.config.network);
    const parsed = await headerParser(job.rollForward);
    if (!parsed) {
        return {
            ok: false,
            reason: "header parse failed (unsupported era?)",
            slot: "0",
            hashHex: "",
            era: -1,
            epoch: -1,
            isByron: false,
            isEbb: false,
            prevHashHex: null,
            rawHeader: new Uint8Array(0),
        };
    }
    let nonceHex = job.nonceHex;
    if (job.noncesByEpoch && !parsed.isByron) {
        nonceHex = job.noncesByEpoch[String(parsed.epoch)] ?? "";
        if (!nonceHex) {
            return { ...summarize(parsed), ok: false, reason: `no epoch nonce supplied for epoch ${parsed.epoch}` };
        }
    }
    const nonce = nonceHex ? fromHex(nonceHex) : new Uint8Array(0);
    let ok = false;
    let reason: string | undefined;
    try {
        ok = await validateHeader(parsed.multiEraHeader, nonce, job.config);
        if (!ok) reason = "header validation failed";
    } catch (err) {
        ok = false;
        reason = err instanceof Error ? err.message : String(err);
    }
    let byron: ByronBlockSignatureCheck | undefined;
    if (ok && parsed.isByron && !parsed.isEbb && job.byronProtocolMagic != null) {
        try {
            byron = verifyByronBlockSignature(parsed.rawHeaderBytes, job.byronProtocolMagic);
        } catch (err) {
            byron = { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (!byron.ok) {
            ok = false;
            reason = `Byron block signature: ${byron.reason ?? "invalid"}`;
        }
    }
    const shelley = ok && !parsed.isByron ? shelleyFacts(parsed.era, parsed.multiEraHeader) : undefined;
    return { ...summarize(parsed), ok, reason, ...(byron ? { byron } : {}), ...(shelley ? { shelley } : {}) };
}

// ───────────────────────── fetched-range verification ─────────────────────────

/** Verify a fetched BlockFetch range against its validated headers (identity + body hash). */
export interface RangeVerifyJob {
    kind: "range";
    /** BlockFetch payloads `[era, block]`, one per point, in range order. */
    blocks: Uint8Array[];
    /** Advertised header hashes (hex) from the validated ChainSync headers. */
    expectedHashes: string[];
}

export interface RangeIdentity {
    era: number;
    hashHex: string;
    /** Raw header bytes exactly as they appear inside the block. */
    rawHeader: Uint8Array;
}

export interface RangeVerifyResult {
    ok: boolean;
    /** First offending block and why, when `!ok`. */
    index?: number;
    reason?: string;
    /** Identities of the blocks verified so far (all of them when `ok`). */
    identities: RangeIdentity[];
}

export type PoolJob = HeaderValidationJob | RangeVerifyJob | WitnessVerifyJob;

/**
 * Copy into a fresh ArrayBuffer before transferring: a Node Buffer's `.slice()` is a
 * view, and transferring a view's buffer would detach the caller's bytes (and any
 * sibling views in the same multiplexer chunk).
 */
export function fresh(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out;
}

export function isRangeVerifyJob(job: PoolJob): job is RangeVerifyJob {
    return (job as RangeVerifyJob).kind === "range";
}

/**
 * Pure over bytes: the header hash must equal the advertised hash and the body must
 * hash to the header's commitment. This binds every body to a validated header, which
 * is what makes fetching ranges from any peer safe.
 */
export function runRangeVerifyJob(job: RangeVerifyJob): RangeVerifyResult {
    const identities: RangeIdentity[] = [];
    if (job.blocks.length !== job.expectedHashes.length) {
        return { ok: false, index: 0, reason: `${job.blocks.length} blocks for ${job.expectedHashes.length} points`, identities };
    }
    for (let i = 0; i < job.blocks.length; i++) {
        const bytes = job.blocks[i]!;
        const want = job.expectedHashes[i]!.toLowerCase();
        try {
            const id = blockFetchHeaderIdentity(bytes);
            const got = toHex(id.hash).toLowerCase();
            if (got !== want) {
                return { ok: false, index: i, reason: `header hash ${got} ≠ advertised ${want}`, identities };
            }
            const body = verifyBlockBodyHash(bytes);
            if (!body.ok) {
                return { ok: false, index: i, reason: `body hash mismatch: expected=${body.expected} actual=${body.actual}`, identities };
            }
            identities.push({ era: id.era, hashHex: got, rawHeader: id.rawHeaderBytes });
        } catch (err) {
            return { ok: false, index: i, reason: `undecodable block: ${err instanceof Error ? err.message : String(err)}`, identities };
        }
    }
    return { ok: true, identities };
}

/** Praos leader value: blake2b_256 over the "L"-tagged VRF output. */
export function praosLeaderValue(vrfOutput: Uint8Array): Uint8Array {
    const tagged = new Uint8Array(1 + vrfOutput.length);
    tagged[0] = 0x4c; // "L"
    tagged.set(vrfOutput, 1);
    return new Uint8Array(blake2b_256(tagged));
}
