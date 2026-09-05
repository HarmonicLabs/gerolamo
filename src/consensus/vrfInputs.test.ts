/**
 * Real preprod headers, real epoch nonces (Koios epoch_params): the VRF proofs
 * must verify under the pool key for the derived inputs, and fail for a wrong
 * nonce. This is what guards the header validator's `verifyVrfProof` now that
 * its result is honoured.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { VrfProof03 } from "@harmoniclabs/crypto";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blockFetchHeaderIdentity } from "./blockHeaderParser";
import { praosVrfInput, tpraosVrfInput } from "./vrfInputs";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/shelley-conway-preprod.json"), "utf8")) as { blocks: Record<string, string> };

function headerBody(key: string): { era: number; body: any } {
    const id = blockFetchHeaderIdentity(fromHex(fx.blocks[key]!));
    const h: any = MultiEraHeader.fromCbor(new Uint8Array([0x82, id.era, ...id.rawHeaderBytes]));
    return { era: id.era, body: h.header.body };
}

const NONCE_EPOCH_4 = fromHex("162d29c4e1cf6b8a84f2d692e67a3ac6bc7851bc3e6e4afe64d15778bed8bd86");
const NONCE_EPOCH_310 = fromHex("7c00177d24bfbdb3e908f7a792758fe54ccfa634ccf719d81a95b89655dadd35");

describe("VRF inputs against real headers", () => {
    test("TPraos: Shelley block at slot 86400 (epoch 4) — leader and nonce proofs verify", () => {
        const { era, body } = headerBody("shelley_86400");
        expect(era).toBe(2);
        const leader = VrfProof03.fromBytes(body.leaderVrfResult.proof);
        const nonce = VrfProof03.fromBytes(body.nonceVrfResult.proof);
        expect(leader.verify(body.vrfPubKey, tpraosVrfInput(BigInt(body.slot), NONCE_EPOCH_4, "leader"))).toBe(true);
        expect(nonce.verify(body.vrfPubKey, tpraosVrfInput(BigInt(body.slot), NONCE_EPOCH_4, "nonce"))).toBe(true);
        expect(toHex(leader.toHash())).toBe(toHex(body.leaderVrfResult.proofHash));
        expect(toHex(nonce.toHash())).toBe(toHex(body.nonceVrfResult.proofHash));
        // swapped seeds and a wrong nonce must fail
        expect(leader.verify(body.vrfPubKey, tpraosVrfInput(BigInt(body.slot), NONCE_EPOCH_4, "nonce"))).toBe(false);
        expect(leader.verify(body.vrfPubKey, tpraosVrfInput(BigInt(body.slot), NONCE_EPOCH_310, "leader"))).toBe(false);
    });

    test("Praos: Conway tip block (epoch 310) — proof verifies, wrong nonce fails", () => {
        const { era, body } = headerBody("tip");
        expect(era).toBe(7);
        const proof = VrfProof03.fromBytes(body.vrfResult.proof);
        expect(proof.verify(body.vrfPubKey, praosVrfInput(BigInt(body.slot), NONCE_EPOCH_310))).toBe(true);
        expect(toHex(proof.toHash())).toBe(toHex(body.vrfResult.proofHash));
        expect(proof.verify(body.vrfPubKey, praosVrfInput(BigInt(body.slot), NONCE_EPOCH_4))).toBe(false);
    });
});
