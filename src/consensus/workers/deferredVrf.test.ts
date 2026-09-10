import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { ChainPoint, ChainSyncRollForward, ChainTip } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { splitEraBlock } from "../bodyHash";
import { runHeaderValidationJob } from "./validationJob";

/**
 * Deferred VRF (bug 69 follow-up): a Shelley+ header whose epoch nonce is not known yet is
 * still checked for KES, op-cert and structure; the VRF proof is verified later with the
 * nonce. Fixture: preview block at slot 72702137 (epoch 841, η0 from the node's own TICKN).
 */
const blockHex = readFileSync(new URL("../__fixtures__/preview-block-72702137.hex", import.meta.url), "utf8").trim();
const ETA0_841 = "94e184e05cc510dcd38ce86fcc995a63fcb6f2f9c72e28f791c6cd4063bd5290";
const config = { networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", network: "preview" };

function rollForwardOf(hex: string): Uint8Array {
    const { era, rawBlock } = splitEraBlock(fromHex(hex));
    const arr = Cbor.parseLazy(rawBlock);
    if (!(arr instanceof LazyCborArray)) throw new Error("not an array");
    const rf = new ChainSyncRollForward({
        data: new CborArray([new CborUInt(era - 1), new CborTag(24, new CborBytes(arr.array[0]!))]),
        tip: new ChainTip({ point: new ChainPoint({ blockHeader: { slotNumber: 0n, hash: new Uint8Array(32) } }), blockNo: 0n }),
    });
    return rf.toCborBytes();
}
const rollForward = rollForwardOf(blockHex);

describe("header validation with the VRF deferred", () => {
    test("no nonce and deferral allowed: KES / op-cert pass, result flagged vrfDeferred", async () => {
        const r = await runHeaderValidationJob({ rollForward, nonceHex: "", noncesByEpoch: {}, deferVrfWithoutNonce: true, config });
        expect(r.epoch).toBe(841);
        expect(r.ok).toBe(true);
        expect(r.vrfDeferred).toBe(true);
    });
    test("no nonce without deferral is still a failure", async () => {
        const r = await runHeaderValidationJob({ rollForward, nonceHex: "", noncesByEpoch: {}, config });
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("no epoch nonce");
    });
    test("the real nonce verifies the VRF; a wrong nonce does not", async () => {
        const ok = await runHeaderValidationJob({ rollForward, nonceHex: "", noncesByEpoch: { "841": ETA0_841 }, deferVrfWithoutNonce: true, config });
        expect(ok.ok).toBe(true);
        expect(ok.vrfDeferred).toBeUndefined();
        const bad = await runHeaderValidationJob({ rollForward, nonceHex: "", noncesByEpoch: { "841": "00".repeat(32) }, deferVrfWithoutNonce: true, config });
        expect(bad.ok).toBe(false);
    });
});
