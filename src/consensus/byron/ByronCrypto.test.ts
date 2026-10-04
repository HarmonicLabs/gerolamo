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

describe("bug 305: SHA3-256 on the Byron hot path (@noble/hashes instead of the BigInt Keccak)", () => {
    const { sha3: bigintSha3 } = require("@harmoniclabs/crypto");
    const { sha3_256 } = require("./ByronCrypto");
    const { bootstrapAddressRoot } = require("../rules/witnesses");
    const { ByronAddress } = require("@harmoniclabs/cardano-ledger-ts");
    test("NIST vectors", () => {
        expect(toHex(sha3_256(new Uint8Array(0)))).toBe("a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
        expect(toHex(sha3_256(new TextEncoder().encode("abc")))).toBe("3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");
    });
    test("the same digest as the previous implementation for every length 0..300 (rate 136: one, two and three blocks)", () => {
        for (let n = 0; n <= 300; n++) {
            const b = new Uint8Array(n);
            for (let i = 0; i < n; i++) b[i] = (n * 31 + i * 7) & 0xff;
            expect(toHex(sha3_256(b))).toBe(toHex(new Uint8Array(bigintSha3(b))));
        }
    });
    test("real bootstrap witnesses (the first spends of the preprod and preview genesis UTxOs) hash to the genesis addresses' roots", () => {
        const cases = [
            { pk: "7229838c0d5c5baaf0f09138853a52c7e7088bda6aa497af5606e5de5120ef99", cc: "cd37d942b4eb28d5435df4d4e18bc7ed11388fe2ea43615f544f7c09c7b29f25", attrs: "a1024101", addr: "FHnt4NL7yPXuYUxBF33VX5dZMBDAab2kvSNLRzCskvuKNCSDknzrQvKeQhGUw5a" }, // preprod slot 86420
            { pk: "faaa72b55e6dcc6c525be6546762057ac60338dcaa1a8d02022772843a3cc150", cc: "27aaab4b53635ae1a1060bd65f8c176ff3efbad1b0553ebd5622000c08e67858", attrs: "a1024102", addr: "FHnt4NL7yPXvDWHa8bVs73UEUdJd64VxWXSFNqetECtYfTd9TtJguJ14Lu3feth" }, // preview slot 60
        ];
        for (const c of cases) expect(bootstrapAddressRoot(fromHex(c.pk), fromHex(c.cc), fromHex(c.attrs))).toBe(toHex(ByronAddress.fromBase58(c.addr).rootHash));
    });
    test("an address root costs well under a millisecond", () => {
        const pk = new Uint8Array(32).fill(7), cc = new Uint8Array(32).fill(9), attrs = fromHex("a1024102");
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) bootstrapAddressRoot(pk, cc, attrs);
        expect((performance.now() - t0) / 2000).toBeLessThan(0.25);
    });
});
