import {
    ByronBlockHeaderBody,
    ByronEbbHead,
    MultiEraHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { logger } from "../utils/logger";
import { BYRON_EBB_ERA, BYRON_MAIN_ERA } from "./blockHeaderParser";

/** Byron (mainnet/preprod): k=2160, epoch = 10k slots. */
export const BYRON_SLOTS_PER_EPOCH = 21600n;

export interface ByronHeaderValidationConfig {
    networkMagic?: number;
}

/**
 * Structural Byron header validation (Ouroboros-BFT era).
 *
 * Byron has no VRF/KES/epoch nonce: the checks that make sense from the
 * header alone are the protocol magic, a well-formed slot id and a
 * well-formed block signature envelope. Chain continuity (prevBlock linking)
 * is enforced by the orchestrator, which knows the local tip.
 *
 * Not implemented (yet): OBFT slot-leader schedule and delegation-certificate
 * signature verification against the Byron genesis delegates.
 */
export function validateByronHeader(
    h: MultiEraHeader,
    config: ByronHeaderValidationConfig,
): boolean {
    const header = h.header as unknown;
    const expectedMagic = config?.networkMagic;

    if (h.era === BYRON_EBB_ERA) {
        if (!(header instanceof ByronEbbHead)) {
            logger.warn("Byron EBB header validation failed: wrong header class");
            return false;
        }
        if (expectedMagic != null && header.protocolMagic !== expectedMagic) {
            logger.warn(
                `Byron EBB header validation failed: protocolMagic ${header.protocolMagic} != ${expectedMagic}`,
            );
            return false;
        }
        const epoch = header.consensusData?.epoch;
        if (typeof epoch !== "bigint" || epoch < 0n) {
            logger.warn("Byron EBB header validation failed: bad epoch");
            return false;
        }
        return true;
    }

    if (h.era === BYRON_MAIN_ERA) {
        if (!(header instanceof ByronBlockHeaderBody)) {
            logger.warn("Byron header validation failed: wrong header class");
            return false;
        }
        if (expectedMagic != null && header.protocolMagic !== expectedMagic) {
            logger.warn(
                `Byron header validation failed: protocolMagic ${header.protocolMagic} != ${expectedMagic}`,
            );
            return false;
        }
        const slotId = header.consensusData?.slotId;
        if (
            !slotId || typeof slotId.epoch !== "bigint" ||
            typeof slotId.slot !== "bigint" || slotId.epoch < 0n ||
            slotId.slot < 0n || slotId.slot >= BYRON_SLOTS_PER_EPOCH
        ) {
            logger.warn(
                `Byron header validation failed: bad slotId ${JSON.stringify(slotId, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`,
            );
            return false;
        }
        // Byron issuer key is an extended ed25519 public key: 32-byte key + 32-byte chain code.
        const pubkey = header.consensusData.pubkey;
        if (!(pubkey instanceof Uint8Array) || pubkey.length !== 64) {
            logger.warn("Byron header validation failed: issuer pubkey not 64 bytes");
            return false;
        }
        const sig = header.consensusData.blockSig;
        // blocksig = [0, signature] | [1, lwdlg sig] | [2, dlg sig] (Byron CDDL)
        if (
            !Array.isArray(sig) || sig.length < 2 || typeof sig[0] !== "number" ||
            sig[0] < 0 || sig[0] > 2
        ) {
            logger.warn("Byron header validation failed: malformed blockSig");
            return false;
        }
        return true;
    }

    logger.warn(`Byron header validation: era ${h.era} is not Byron`);
    return false;
}
