import { blake2b_256 } from "@harmoniclabs/crypto";
import { logger } from "./logger";
import { getEpochNonce, putEpochNonce, getEpochVrfOutputs } from '../lmdbWorkers/lmdbWorker';
import { ShelleyGenesisConfig } from '../config/preprod/ShelleyGenesisTypes';
import { toHex } from '@harmoniclabs/uint8array-utils';

export async function calcEpochNonce(endedEpoch: number, genesis: ShelleyGenesisConfig, slot: number): Promise<void> {
	logger.debug(`Calculating nonce for epoch ${endedEpoch} ending at slot ${slot}`);
	const newEpoch = endedEpoch + 1; // Next epoch (e.g., 13)
	const epochVrfOutputs = await getEpochVrfOutputs(endedEpoch);
	const actualSlots = epochVrfOutputs?.length || 0;

	// Collect VRF proofs from first 2/3 slots
	const twoThirdsCount = Math.floor(actualSlots * 2 / 3);
	const selectedVrfOutputs = epochVrfOutputs?.slice(0, twoThirdsCount) || [];
	logger.debug("epochVrfOutputs: ", epochVrfOutputs?.length, " selectedVrfOutputs: ", selectedVrfOutputs.length);

	// Compute candidate nonce as XOR of VRF outputs (already 32 bytes from proofHash)
	let candidateNonce = new Uint8Array(32);
	if (selectedVrfOutputs.length > 0) {
		candidateNonce = selectedVrfOutputs.reduce((acc, entry) => {
			const slotKey = Object.keys(entry)[0];
			const vrfOutput = entry[slotKey]; // 32-byte VRF output
			const xorResult = new Uint8Array(32);
			for (let i = 0; i < 32; i++) {
				xorResult[i] = acc[i] ^ vrfOutput[i];
			}
			return xorResult;
		}, new Uint8Array(32));
	};
	logger.debug("candidateNonce", toHex(candidateNonce));

	// Get previous nonce
	let nonce_h: Uint8Array;
	if (endedEpoch === 0) {
		// For epoch 0, use neutral nonce (genesis nonce should be pre-set or derived)
		nonce_h = new Uint8Array(32); // Assume neutral; update if genesis provides initial nonce
	} else {
		const epochNonceRes = await getEpochNonce(endedEpoch);
		if (!epochNonceRes) throw new Error("Missing previous epoch nonce");
		nonce_h = epochNonceRes;
	};
	// logger.debug("nonce_h", toHex(nonce_h));

	// Compute new nonce = blake2b256(nonce_h || candidateNonce)
	const concatenated = new Uint8Array([...nonce_h, ...candidateNonce]);
	const nonce_c = blake2b_256(concatenated);
	logger.debug(`epoch ${newEpoch} nonce`, toHex(nonce_c));

	// await putEpochNonce(newEpoch, nonce_c);
	// return { nonce_c, nonce_h };
};

