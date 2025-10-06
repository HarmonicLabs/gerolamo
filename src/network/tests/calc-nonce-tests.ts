import { open } from "lmdb";
import { Hash32 } from '@harmoniclabs/cardano-ledger-ts';
import { blake2b_256 } from "@harmoniclabs/crypto";
import { logger } from "../../utils/logger";
import { toHex } from '@harmoniclabs/uint8array-utils';
const rootDB = open({
    path: "./src/store/gerolamo.lmdb",
    maxDbs: 10,
    eventTurnBatching: true,
    strictAsyncOrder: true,
});

const epochNonceIndexDb = rootDB.openDB({
    name: "epoch_nonce_index",
    encoding: "binary"
});

const epochNonceProofsDB = rootDB.openDB({
    name: "epoch_nonce_proofs",
    encoding: "binary"
});

async function calcEpochNonce(epoch: number): Promise<void> {
    const endedEpoch = epoch; 
    const newEpoch = endedEpoch + 1;
    const prevEpoch = endedEpoch - 1;
    const prevEpochNonce = await epochNonceIndexDb.get(prevEpoch);
    const endedEpochNonce = await epochNonceIndexDb.get(endedEpoch);
    
    logger.debug("switching from epoch ", endedEpoch, " to epoch ", newEpoch, "..");
    const epochsVRFCerts = getVRFProofs(endedEpoch);
    // logger.debug("fetched vrf proofs for epoch ", endedEpoch, ":", epochsVRFCerts, " and epoch nonce: ", endedEpoch);

    if (!(
        prevEpochNonce instanceof Uint8Array &&
        prevEpochNonce.length === 32
    )) {
        throw new Error(`Previous epoch nonce is invalid or not found for epoch `, endedEpochNonce);
    }   
    logger.debug("prevEpochNonce: ", toHex(prevEpochNonce));
    
    const epochNonce = calculateEpochNonce(
        prevEpochNonce,
        epochsVRFCerts
    );

    logger.debug("calculated new epoch nonce for epoch ", newEpoch, ": ", epochNonce.toString());
};

function calculateEpochNonce(
    prevNonce: Uint8Array,
    vrfProofs: Uint8Array[]
): Hash32 {
    const twoThirdsCount = Math.floor(vrfProofs.length * 2 / 3);
    logger.debug("twoThirdsCount: ", twoThirdsCount);
    const selectedVrfCerts = vrfProofs.slice(0, twoThirdsCount);

    let candidateNonce = new Uint8Array(32).fill(0);
    if (vrfProofs.length > 0) {
        const result = vrfProofs.reduce((acc, vrfCert) => {
            const outputBytes = vrfCert; // 80-byte proof
            const hashedOutput = blake2b_256(outputBytes); // Hash to 32 bytes
            return new Uint8Array(32).fill(0).map((_, i) => acc[i] ^ hashedOutput[i]);
        }, new Uint8Array(32).fill(0));
        candidateNonce = new Uint8Array(result);
    }

    const concatenated = new Uint8Array([...prevNonce, ...candidateNonce]);
    const newNonceBytes = blake2b_256(concatenated);
    return new Hash32(newNonceBytes);
};

export function getVRFProofs(epoch: number): Uint8Array[] {
    const value = epochNonceProofsDB.get(`${epoch}`) as Buffer;
    if (!value || value.length <= 4) return [];

    const proofCount = value.readUInt32BE(0);
    logger.debug(`Fetching VRF proofs for epoch ${epoch}, expected count: ${proofCount}`);
    const proofs: Uint8Array[] = [];
    const proofSize = 80;

    const dataLength = value.length - 4;
    if (dataLength !== proofCount * proofSize) {
        logger.warn(`Data length (${dataLength}) does not match expected proof count (${proofCount}) * ${proofSize} bytes`);
    }

    for (let i = 4; i < value.length; i += proofSize) {
        if (i + proofSize <= value.length) {
            proofs.push(new Uint8Array(value.subarray(i, i + proofSize)));
        }
    }

    return proofs;
};
calcEpochNonce(12);