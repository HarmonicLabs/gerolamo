import { blake2b_256 } from "@harmoniclabs/crypto";
import { logger } from "./logger";
import { toHex } from '@harmoniclabs/uint8array-utils';

export async function calcEpochNonce(endedEpoch: number, slot: number): Promise<void> {
	logger.debug(`Calculating nonce for epoch ${endedEpoch} ending at slot ${slot}`);
	const newEpoch = endedEpoch + 1;
	
	// Stub (TODO: implement VRF outputs and storage in SQLite)
	const candidateNonce = new Uint8Array(32);
	logger.debug("candidateNonce (stub)", toHex(candidateNonce));

	let nonce_h = new Uint8Array(32); // Stub previous (TODO: get from DB)

	const concatenated = new Uint8Array([...nonce_h, ...candidateNonce]);
	const nonce_c = blake2b_256(concatenated);
	logger.debug(`epoch ${newEpoch} nonce (stub)`, toHex(nonce_c));

	// TODO: store nonce_c in DB
};

