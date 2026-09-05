/**
 * VRF inputs for block headers.
 *
 * Praos (Babbage+): one VRF, input = blake2b_256(slot ‖ η0).
 * TPraos (Shelley … Alonzo): two VRFs over cardano-ledger's `mkSeed`:
 *   blake2b_256(slot ‖ η0) XOR blake2b_256(u64be n), n = 0 for the nonce VRF
 *   ("seedEta") and n = 1 for the leader VRF ("seedL").
 * Both derivations were checked against real preprod headers with their epoch
 * nonces (Shelley epoch 4, Conway epoch 310) in vrfInputs.test.ts.
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { concatUint8Array, writeBigUInt64BE } from "@harmoniclabs/uint8array-utils";

export function u64be(n: bigint): Uint8Array {
    const out = new Uint8Array(8);
    writeBigUInt64BE(out, n, 0);
    return out;
}

export function praosVrfInput(slot: bigint, epochNonce: Uint8Array): Uint8Array {
    return blake2b_256(concatUint8Array(u64be(slot), epochNonce));
}

export type TPraosSeed = "leader" | "nonce";

export function tpraosVrfInput(slot: bigint, epochNonce: Uint8Array, seed: TPraosSeed): Uint8Array {
    const base = praosVrfInput(slot, epochNonce);
    const uc = blake2b_256(u64be(seed === "leader" ? 1n : 0n));
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = base[i]! ^ uc[i]!;
    return out;
}
