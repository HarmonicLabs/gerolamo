import { blake2b_256 } from "@harmoniclabs/crypto";
import { logger } from "./logger";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { sql } from "../sql-compat";

/**
 * Stores a VRF output from a block header into the vrf_outputs table.
 */
export async function storeVrfOutput(
    slot: bigint,
    epoch: number,
    vrfOutput: Uint8Array,
): Promise<void> {
    const vrfHex = toHex(vrfOutput);
    await sql`INSERT OR IGNORE INTO vrf_outputs (slot, epoch, vrf_output) VALUES (${slot}, ${epoch}, ${vrfHex})`;
}

/**
 * Calculates the epoch nonce for the upcoming epoch using VRF outputs
 * from the first 2/3 of the ending epoch's slots.
 *
 * nonce_{e+1} = H(nonce_e || candidateNonce)
 * candidateNonce = H(vrf_1 || vrf_2 || ... || vrf_n)  where n = first 2/3 of epoch slots
 */
export async function calcEpochNonce(
    endedEpoch: number,
    epochLastSlot: number,
    epochFirstSlot: number,
): Promise<string> {
    const newEpoch = endedEpoch + 1;
    logger.debug(
        `Calculating nonce for epoch ${newEpoch} from epoch ${endedEpoch} VRF outputs (slots ${epochFirstSlot}-${epochLastSlot})`,
    );

    // Get the cutoff: first 2/3 of the epoch's slot range
    const epochLength = epochLastSlot - epochFirstSlot;
    const cutoffSlot = epochFirstSlot + Math.floor((epochLength * 2) / 3);

    // Query VRF outputs from the first 2/3 of the epoch, ordered by slot
    const rows = await sql`
        SELECT vrf_output FROM vrf_outputs
        WHERE epoch = ${endedEpoch} AND slot <= ${cutoffSlot}
        ORDER BY slot ASC
    ` as unknown as any[];

    let candidateNonce: Uint8Array;
    if (rows.length === 0) {
        logger.warn(`No VRF outputs found for epoch ${endedEpoch}, using zero nonce`);
        candidateNonce = new Uint8Array(32);
    } else {
        // Concatenate all VRF outputs and hash them
        const vrfBytes: number[] = [];
        for (const row of rows) {
            const hex = row.vrf_output as string;
            for (let i = 0; i < hex.length; i += 2) {
                vrfBytes.push(parseInt(hex.substring(i, i + 2), 16));
            }
        }
        candidateNonce = blake2b_256(new Uint8Array(vrfBytes));
        logger.debug(`Computed candidateNonce from ${rows.length} VRF outputs: ${toHex(candidateNonce).slice(0, 16)}...`);
    }

    // Get previous epoch nonce (nonce_e)
    let prevNonce = new Uint8Array(32); // genesis default: all zeros
    const nonceRows = await sql`
        SELECT nonce FROM epoch_nonces WHERE epoch = ${endedEpoch} ORDER BY epoch DESC LIMIT 1
    ` as unknown as any[];

    if (nonceRows.length > 0 && nonceRows[0].nonce) {
        const hex = nonceRows[0].nonce as string;
        prevNonce = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            prevNonce[i / 2] = parseInt(hex.substring(i, i + 2), 16);
        }
    }

    // nonce_{e+1} = H(nonce_e || candidateNonce)
    const concatenated = new Uint8Array([...prevNonce, ...candidateNonce]);
    const newNonce = blake2b_256(concatenated);
    const nonceHex = toHex(newNonce);

    // Store the new epoch nonce
    await sql`INSERT OR REPLACE INTO epoch_nonces (epoch, nonce) VALUES (${newEpoch}, ${nonceHex})`;

    logger.info(`Epoch ${newEpoch} nonce: ${nonceHex.slice(0, 16)}...`);
    return nonceHex;
}

/**
 * Gets a cached epoch nonce from the DB, or null if not yet computed.
 */
export async function getEpochNonce(epoch: number): Promise<string | null> {
    const rows = await sql`SELECT nonce FROM epoch_nonces WHERE epoch = ${epoch}` as unknown as any[];
    if (rows.length > 0 && rows[0].nonce) {
        return rows[0].nonce as string;
    }
    return null;
}
