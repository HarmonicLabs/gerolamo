import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { headerParser } from "../blockHeaderParser";
import { validateHeader } from "../BlockHeaderValidator";

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
}

export async function runHeaderValidationJob(job: HeaderValidationJob): Promise<HeaderValidationResult> {
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
    const nonce = job.nonceHex ? fromHex(job.nonceHex) : new Uint8Array(0);
    let ok = false;
    let reason: string | undefined;
    try {
        ok = await validateHeader(parsed.multiEraHeader, nonce, job.config);
        if (!ok) reason = "header validation failed";
    } catch (err) {
        ok = false;
        reason = err instanceof Error ? err.message : String(err);
    }
    return {
        ok,
        reason,
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
