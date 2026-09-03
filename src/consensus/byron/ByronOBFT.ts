import { Cbor, CborArray, CborBytes, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { logger } from "../../utils/logger";
import {
    byronKeyHash,
    sliceByronMainHeader,
    verifyByronBlockSignature,
    verifyByronDelegationCert,
    type ByronDelegationCertificate,
} from "./ByronCrypto";

/**
 * Ouroboros-BFT (Byron) header validation state, following what a
 * *validating* cardano-node checks in `Ouroboros.Consensus.Protocol.PBFT`
 * `updateChainDepState` (the round-robin leader schedule is a block-producer
 * concern and is not enforced on received chains):
 *
 *   1. the block signature verifies (delegate key over ToSign);
 *   2. the delegation certificate verifies and its issuer is a genesis key;
 *   3. the issuer → delegate pair is the registered delegation
 *      (genesis `heavyDelegation`, updated by on-chain dlgPayload certificates);
 *   4. slots are monotonic;
 *   5. no genesis key signs more than ⌊threshold·k⌋ of the last k signed blocks
 *      (mainnet/preprod: threshold 0.22, k 2160 ⇒ 475).
 *
 * Delegation certificates found in applied blocks are scheduled with a 2k-slot
 * activation delay (cardano-ledger-byron `Delegation.Validation.Scheduling`);
 * for authorisation we accept either the active or a pending pair — both are
 * cryptographically issued by a genesis key, so the leniency is on timing only.
 */

export interface ByronGenesisConfig {
    protocolConsts: { k: number; protocolMagic: number };
    heavyDelegation: Record<string, { omega: number; issuerPk: string; delegatePk: string; cert: string }>;
    bootStakeholders?: Record<string, number>;
}

export const DEFAULT_PBFT_SIGNATURE_THRESHOLD = 0.22;

export interface ByronObftOptions {
    /** Override k (defaults to genesis protocolConsts.k). */
    k?: number;
    /** PBFT signature threshold (fraction of a k-window one key may sign). */
    signatureThreshold?: number;
}

export interface ByronObftHeaderCheck {
    ok: boolean;
    reason?: string;
    issuerKeyHash?: string;
    signerKeyHash?: string;
}

interface ScheduledDelegation {
    activateAtSlot: bigint;
    issuerKeyHash: string;
    delegateKeyHash: string;
}

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

export class ByronObftState {
    readonly protocolMagic: number;
    readonly k: number;
    readonly maxSignaturesPerWindow: number;
    /** Genesis key hashes (hex). */
    readonly genesisKeys: Set<string>;
    /** issuer (genesis) key hash → active delegate key hash. */
    private readonly activeDelegation = new Map<string, string>();
    private scheduled: ScheduledDelegation[] = [];
    /** Issuer key hashes of the last ≤k signed (main) blocks, oldest first. */
    private window: string[] = [];
    private lastSignedSlot: bigint | null = null;

    constructor(genesis: ByronGenesisConfig, opts: ByronObftOptions = {}) {
        this.protocolMagic = genesis.protocolConsts.protocolMagic;
        this.k = opts.k ?? genesis.protocolConsts.k;
        const threshold = opts.signatureThreshold ?? DEFAULT_PBFT_SIGNATURE_THRESHOLD;
        this.maxSignaturesPerWindow = Math.floor(threshold * this.k);
        this.genesisKeys = new Set(Object.keys(genesis.heavyDelegation));

        for (const [issuerKh, d] of Object.entries(genesis.heavyDelegation)) {
            const issuer = b64(d.issuerPk);
            const delegate = b64(d.delegatePk);
            if (byronKeyHash(issuer) !== issuerKh) {
                throw new Error(`Byron genesis: heavyDelegation key ${issuerKh} does not hash its issuerPk`);
            }
            const cert: ByronDelegationCertificate = {
                epoch: BigInt(d.omega),
                issuerXPub: issuer,
                delegateXPub: delegate,
                signature: Uint8Array.from(Buffer.from(d.cert, "hex")),
            };
            if (!verifyByronDelegationCert(cert, this.protocolMagic)) {
                throw new Error(`Byron genesis: heavyDelegation certificate for ${issuerKh} does not verify`);
            }
            this.activeDelegation.set(issuerKh, byronKeyHash(delegate));
        }
    }

    /** Current issuer → delegate map (copy). */
    delegationMap(): Map<string, string> {
        return new Map(this.activeDelegation);
    }

    private isAuthorisedPair(issuerKh: string, delegateKh: string, atSlot: bigint): boolean {
        this.activatePending(atSlot);
        if (this.activeDelegation.get(issuerKh) === delegateKh) return true;
        return this.scheduled.some((s) => s.issuerKeyHash === issuerKh && s.delegateKeyHash === delegateKh);
    }

    private activatePending(slot: bigint): void {
        if (this.scheduled.length === 0) return;
        const due = this.scheduled.filter((s) => s.activateAtSlot <= slot);
        if (due.length === 0) return;
        for (const s of due) {
            this.activeDelegation.set(s.issuerKeyHash, s.delegateKeyHash);
            logger.info(`Byron delegation active: ${s.issuerKeyHash.slice(0, 12)}… → ${s.delegateKeyHash.slice(0, 12)}… (slot ${slot})`);
        }
        this.scheduled = this.scheduled.filter((s) => s.activateAtSlot > slot);
    }

    /**
     * Full header check for a Byron *main* block. EBBs are not signed and are
     * not counted in the window (they carry no issuer).
     */
    validateMainHeader(rawHeader: Uint8Array, slot: bigint): ByronObftHeaderCheck {
        const sig = verifyByronBlockSignature(rawHeader, this.protocolMagic);
        if (!sig.ok) return { ok: false, reason: sig.reason ?? "signature invalid" };
        const issuerKh = sig.issuerKeyHash!;
        const signerKh = sig.signerKeyHash!;

        if (!this.genesisKeys.has(issuerKh)) {
            return { ok: false, reason: `issuer ${issuerKh} is not a genesis key`, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
        }
        if (!this.isAuthorisedPair(issuerKh, signerKh, slot)) {
            return {
                ok: false,
                reason: `delegate ${signerKh} is not the registered delegate of ${issuerKh}`,
                issuerKeyHash: issuerKh,
                signerKeyHash: signerKh,
            };
        }
        if (this.lastSignedSlot != null && slot < this.lastSignedSlot) {
            return { ok: false, reason: `slot ${slot} < last signed slot ${this.lastSignedSlot}`, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
        }
        // Signature threshold over the trailing k-window including this block.
        let count = 1;
        for (const kh of this.window) if (kh === issuerKh) count++;
        if (count > this.maxSignaturesPerWindow) {
            return {
                ok: false,
                reason: `issuer ${issuerKh} signed ${count} of the last ${this.k} blocks (max ${this.maxSignaturesPerWindow})`,
                issuerKeyHash: issuerKh,
                signerKeyHash: signerKh,
            };
        }
        return { ok: true, issuerKeyHash: issuerKh, signerKeyHash: signerKh };
    }

    /**
     * Record an applied Byron main block: advances the signature window,
     * the last signed slot, and schedules any delegation certificates in
     * its body (`rawBody = [txPayload, ssc, dlgPayload, upd]`).
     */
    noteApplied(rawHeader: Uint8Array, slot: bigint, rawBody?: Uint8Array): void {
        const s = sliceByronMainHeader(rawHeader);
        const issuerKh = byronKeyHash(s.headerPubKey);
        this.window.push(issuerKh);
        if (this.window.length > this.k) this.window.splice(0, this.window.length - this.k);
        this.lastSignedSlot = slot;
        if (rawBody) this.scheduleFromBody(rawBody, slot);
    }

    private scheduleFromBody(rawBody: Uint8Array, slot: bigint): void {
        try {
            const body = Cbor.parseLazy(rawBody);
            if (!(body instanceof LazyCborArray) || body.array.length < 3) return;
            const dlg = Cbor.parse(body.array[2]!);
            if (!(dlg instanceof CborArray) || dlg.array.length === 0) return;
            for (const c of dlg.array) {
                if (
                    !(c instanceof CborArray) || c.array.length < 4 ||
                    !(c.array[0] instanceof CborUInt) || !(c.array[1] instanceof CborBytes) ||
                    !(c.array[2] instanceof CborBytes) || !(c.array[3] instanceof CborBytes)
                ) continue;
                const cert: ByronDelegationCertificate = {
                    epoch: c.array[0].num,
                    issuerXPub: c.array[1].bytes,
                    delegateXPub: c.array[2].bytes,
                    signature: c.array[3].bytes,
                };
                const issuerKh = byronKeyHash(cert.issuerXPub);
                if (!this.genesisKeys.has(issuerKh)) {
                    logger.warn(`Byron dlgPayload at slot ${slot}: issuer ${issuerKh} is not a genesis key; ignored`);
                    continue;
                }
                if (!verifyByronDelegationCert(cert, this.protocolMagic)) {
                    logger.warn(`Byron dlgPayload at slot ${slot}: certificate from ${issuerKh} does not verify; ignored`);
                    continue;
                }
                const delegateKh = byronKeyHash(cert.delegateXPub);
                const activateAtSlot = slot + BigInt(2 * this.k);
                this.scheduled.push({ activateAtSlot, issuerKeyHash: issuerKh, delegateKeyHash: delegateKh });
                logger.info(
                    `Byron delegation scheduled: ${issuerKh.slice(0, 12)}… → ${delegateKh.slice(0, 12)}… active at slot ${activateAtSlot}`,
                );
            }
        } catch (err: unknown) {
            logger.warn(`Byron dlgPayload parse failed at slot ${slot}:`, err);
        }
    }

    /** Seed the window / last slot from previously applied main-block headers (oldest first). */
    seed(headers: Array<{ rawHeader: Uint8Array; slot: bigint }>): void {
        this.window = [];
        this.lastSignedSlot = null;
        for (const h of headers.slice(-this.k)) {
            try {
                const s = sliceByronMainHeader(h.rawHeader);
                this.window.push(byronKeyHash(s.headerPubKey));
                this.lastSignedSlot = h.slot;
            } catch {
                // EBB or foreign header: skip
            }
        }
    }

    /** For metrics / tests. */
    snapshot(): { windowSize: number; lastSignedSlot: string | null; issuers: Record<string, number>; scheduled: number } {
        const issuers: Record<string, number> = {};
        for (const kh of this.window) issuers[kh] = (issuers[kh] ?? 0) + 1;
        return {
            windowSize: this.window.length,
            lastSignedSlot: this.lastSignedSlot?.toString() ?? null,
            issuers,
            scheduled: this.scheduled.length,
        };
    }
}

/** Convenience for callers that only have hex. */
export function issuerKeyHashOfHeader(rawHeader: Uint8Array): string {
    return byronKeyHash(sliceByronMainHeader(rawHeader).headerPubKey);
}

