import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import {
    byronKeyHash,
    sliceByronMainHeader,
    verifyByronBlockSignature,
    verifyByronDelegationCert,
} from "./ByronCrypto";
import fixture from "../__fixtures__/byron-preprod.json";
import genesis from "../../config/preprod/byron-genesis.json";

type FixtureHeader = { byronType: number; headerHex: string; hash: string };
const headers = (fixture.headers as FixtureHeader[]).filter((h) => h.byronType === 1);
const MAGIC = 1;
const heavy = genesis.heavyDelegation as Record<
    string,
    { omega: number; issuerPk: string; delegatePk: string; cert: string }
>;
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

describe("Byron key hashes", () => {
    test("heavyDelegation map keys are blake2b-224(sha3-256(cbor(issuerPk)))", () => {
        for (const [kh, d] of Object.entries(heavy)) {
            expect(byronKeyHash(b64(d.issuerPk))).toBe(kh);
        }
    });
});

describe("Byron delegation certificates", () => {
    test("every genesis heavyDelegation certificate verifies", () => {
        for (const d of Object.values(heavy)) {
            expect(
                verifyByronDelegationCert(
                    {
                        epoch: BigInt(d.omega),
                        issuerXPub: b64(d.issuerPk),
                        delegateXPub: b64(d.delegatePk),
                        signature: fromHex(d.cert),
                    },
                    MAGIC,
                ),
            ).toBe(true);
        }
    });

    test("wrong protocol magic rejects the certificate", () => {
        const d = Object.values(heavy)[0]!;
        expect(
            verifyByronDelegationCert(
                {
                    epoch: BigInt(d.omega),
                    issuerXPub: b64(d.issuerPk),
                    delegateXPub: b64(d.delegatePk),
                    signature: fromHex(d.cert),
                },
                764824073,
            ),
        ).toBe(false);
    });
});

describe("Byron block signatures (preprod epoch 0)", () => {
    test("headers carry heavyweight (type 2) signatures whose cert issuer is the header pubkey", () => {
        for (const h of headers) {
            const s = sliceByronMainHeader(fromHex(h.headerHex));
            expect(s.blockSig.type).toBe(2);
            expect(toHex(s.blockSig.cert!.issuerXPub)).toBe(toHex(s.headerPubKey));
        }
    });

    test("block signature verifies and the issuer is a genesis key delegating to the signer", () => {
        for (const h of headers) {
            const r = verifyByronBlockSignature(fromHex(h.headerHex), MAGIC);
            expect(r.ok).toBe(true);
            expect(r.issuerKeyHash && heavy[r.issuerKeyHash]).toBeTruthy();
            expect(byronKeyHash(b64(heavy[r.issuerKeyHash!]!.delegatePk))).toBe(r.signerKeyHash!);
        }
    });

    test("wrong magic or a flipped ToSign byte fails", () => {
        const raw = fromHex(headers[0]!.headerHex);
        expect(verifyByronBlockSignature(raw, 2).ok).toBe(false);
        // prevBlock hash lives right after the magic; flipping a byte in it breaks ToSign.
        const tampered = raw.slice();
        tampered[10] = tampered[10]! ^ 0x01;
        expect(verifyByronBlockSignature(tampered, MAGIC).ok).toBe(false);
    });
});
