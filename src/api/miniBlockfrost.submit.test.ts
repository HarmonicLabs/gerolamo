import { describe, expect, test } from "bun:test";
import { Tx } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { handleMiniBlockfrost, type MiniBfSubmitResult } from "./miniBlockfrost";

/**
 * A minimal, decodable (unsigned) Conway-era transaction: one input, one
 * enterprise-address output, a fee, empty witness set. The fixture blocks carry
 * no transactions; the mempool does not validate, so this exercises the whole
 * path except signature checks.
 */
const MINIMAL_TX_HEX =
    "84a30081825820abababababababababababababababababababababababababababababababab00" +
    "018182581d60000000000000000000000000000000000000000000000000000000001a000f4240021a00029810a0f5f6";

function fixtureTx(): { cbor: Uint8Array; txId: string } {
    const cbor = fromHex(MINIMAL_TX_HEX);
    const tx = Tx.fromCbor(cbor);
    return { cbor, txId: toHex(tx.body.hash.toBuffer()) };
}

function post(body: Uint8Array | string, contentType: string, submitTx?: (cbor: Uint8Array, txId: Uint8Array) => Promise<MiniBfSubmitResult>) {
    const url = new URL("http://127.0.0.1:3030/api/v0/tx/submit");
    const req = new Request(url, { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : new Blob([body as unknown as ArrayBuffer]) });
    return handleMiniBlockfrost(req, url, { network: "preprod", submitTx });
}

describe("POST /api/v0/tx/submit", () => {
    test("returns the ledger tx id (body hash) and the mempool verdict", async () => {
        const { cbor, txId } = fixtureTx();
        const seen: string[] = [];
        const res = await post(cbor, "application/cbor", async (_c, id) => {
            seen.push(toHex(id));
            return { status: "success", nTxs: 1, availableSpace: 1000 };
        });
        expect(res?.status).toBe(202);
        const j = (await res!.json()) as any;
        expect(j.hash).toBe(txId);
        expect(seen).toEqual([txId]);
        expect(j.mempool.nTxs).toBe(1);
        expect(j.status).toBe("accepted");
    });

    test("hex text body is accepted too", async () => {
        const { cbor, txId } = fixtureTx();
        const res = await post(toHex(cbor), "text/plain", async () => ({ status: "success", nTxs: 1, availableSpace: 1 }));
        expect(res?.status).toBe(202);
        expect(((await res!.json()) as any).hash).toBe(txId);
    });

    test("undecodable CBOR is a 400, not a fire-and-forget 202", async () => {
        let called = false;
        const res = await post(new Uint8Array([0x01, 0x02, 0x03]), "application/cbor", async () => {
            called = true;
            return { status: "success", nTxs: 1, availableSpace: 1 };
        });
        expect(res?.status).toBe(400);
        expect(called).toBe(false);
    });

    test("a mempool rejection and a missing submit path surface as 400 / 503", async () => {
        const { cbor } = fixtureTx();
        const dup = await post(cbor, "application/cbor", async () => ({ status: "duplicate", nTxs: 1, availableSpace: 1 }));
        expect(dup?.status).toBe(400);
        expect(((await dup!.json()) as any).message).toContain("duplicate");
        const none = await post(cbor, "application/cbor", undefined);
        expect(none?.status).toBe(503);
        const down = await post(cbor, "application/cbor", async () => {
            throw new Error("No hot peer available for tx submit");
        });
        expect(down?.status).toBe(503);
    });
});
