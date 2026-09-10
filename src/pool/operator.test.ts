import { describe, expect, test } from "bun:test";
import { Cbor, CborArray } from "@harmoniclabs/cbor";
import { loadColdSigningKey, loadColdVerificationKey, loadVrfSigningKey, poolIdOf, readTextEnvelope, vrfKeyHashOf } from "./keystore";
import {
    addressBech32, baseAddressBytes, bech32Decode, buildWithMinFee, certificateEnvelope, decodeTx, encodeSignedTx, encodeTxBody, generateKeyPair, keyHash,
    KeyEnvelopeType, loadSigningKey, loadVerificationKey, marginFromDecimal, poolMetadataHash, poolRegistrationCert, sameWitnessSet, signTxBody,
    stakeAddressBytes, stakeDelegationCert, stakeRegistrationCert, txId, verifyWitnesses,
} from "./operator";

const T = (n: string) => new URL(`./__fixtures__/cli-tx/${n}`, import.meta.url).pathname;
const K = (n: string) => new URL(`./__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const text = async (p: string) => (await Bun.file(p).text()).trim();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("operator tooling vs cardano-cli conway 11", () => {
    test("keys, key hashes and addresses", async () => {
        const pay = loadSigningKey(T("payment.skey"), KeyEnvelopeType.paymentSigning);
        const stake = loadSigningKey(T("stake.skey"), KeyEnvelopeType.stakeSigning);
        expect(hex(pay.vkey)).toBe(hex(loadVerificationKey(T("payment.vkey"), KeyEnvelopeType.paymentVerification)));
        expect(hex(stake.vkey)).toBe(hex(loadVerificationKey(T("stake.vkey"), KeyEnvelopeType.stakeVerification)));
        const addr = baseAddressBytes(0, keyHash(pay.vkey), keyHash(stake.vkey));
        expect(addressBech32(addr)).toBe(await text(T("payment.addr")));
        expect(addressBech32(stakeAddressBytes(0, keyHash(stake.vkey)))).toBe(await text(T("stake.addr")));
        const back = bech32Decode(await text(T("payment.addr")));
        expect(back.hrp).toBe("addr_test");
        expect(hex(back.bytes)).toBe(hex(addr));
        expect(() => bech32Decode("addr_test1qzu37m3savk7f95ujgx4s3djwnvkt3eakktktwhxvx3ecqched94mtv4f6yk8ruflve4s7yf5m3z64mfpmwdx3l7rhyq6hr9qq")).toThrow(/checksum/);
        const g = generateKeyPair(new Uint8Array(32).fill(3));
        expect(g.vkey.length).toBe(32);
    });

    test("stake registration, pool registration and delegation certificates are byte-identical", async () => {
        const stakeV = loadVerificationKey(T("stake.vkey"), KeyEnvelopeType.stakeVerification);
        const coldV = loadColdVerificationKey(K("cold.vkey"));
        const vrf = loadVrfSigningKey(K("vrf.skey"));
        const sh = keyHash(stakeV);
        const poolId = Uint8Array.from(Buffer.from(poolIdOf(coldV), "hex"));
        const reg = stakeRegistrationCert(sh, 2_000_000n);
        expect(certificateEnvelope(reg).cborHex).toBe(readTextEnvelope(T("stake-reg.cert")).cborHex);
        const del = stakeDelegationCert(sh, poolId);
        expect(certificateEnvelope(del).cborHex).toBe(readTextEnvelope(T("deleg.cert")).cborHex);
        const metaBytes = new Uint8Array(await Bun.file(T("pool-metadata.json")).arrayBuffer());
        expect(hex(poolMetadataHash(metaBytes))).toBe(await text(T("pool-metadata.hash")));
        const pool = poolRegistrationCert({
            operator: poolId, vrfKeyHash: Uint8Array.from(Buffer.from(vrfKeyHashOf(vrf.vkey), "hex")),
            pledge: 500_000_000_000n, cost: 170_000_000n, margin: marginFromDecimal("0.01"),
            rewardAccount: stakeAddressBytes(0, sh), owners: [sh],
            relays: [{ type: "single-host-name", port: 3001, dnsName: "relay.example.org" }, { type: "single-host-addr", port: 3001, ipv4: "203.0.113.7" }],
            metadata: { url: "https://example.org/gero.json", hash: poolMetadataHash(metaBytes) },
        });
        expect(certificateEnvelope(pool).cborHex).toBe(readTextEnvelope(T("pool-reg.cert")).cborHex);
        expect(marginFromDecimal("0.025")).toEqual({ num: 1n, den: 40n });
        expect(marginFromDecimal(1)).toEqual({ num: 1n, den: 1n });
    });

    test("the transaction body matches build-raw and the txid; witnesses match transaction sign", async () => {
        const pay = loadSigningKey(T("payment.skey"), KeyEnvelopeType.paymentSigning);
        const stake = loadSigningKey(T("stake.skey"), KeyEnvelopeType.stakeSigning);
        const cold = loadColdSigningKey(K("cold.skey"));
        const raw = readTextEnvelope(T("tx.raw"));
        const signed = readTextEnvelope(T("tx.signed"));
        const cliRaw = decodeTx(Uint8Array.from(Buffer.from(raw.cborHex, "hex")));
        const cliSigned = decodeTx(Uint8Array.from(Buffer.from(signed.cborHex, "hex")));
        const certs = [T("stake-reg.cert"), T("pool-reg.cert"), T("deleg.cert")].map((p) => Cbor.parse(Uint8Array.from(Buffer.from(readTextEnvelope(p).cborHex, "hex"))) as CborArray);
        const body = encodeTxBody({
            inputs: [{ txHash: Uint8Array.from(Buffer.from("00".repeat(31) + "01", "hex")), index: 0 }],
            outputs: [{ address: bech32Decode(await text(T("payment.addr"))).bytes, lovelace: 999_000_000_000n }],
            fee: 200_000n, ttl: 40_000_000n, certificates: certs,
        });
        expect(hex(body)).toBe(hex(cliRaw.body));
        expect(hex(txId(body))).toBe(JSON.parse(await text(T("tx.id"))).txhash);
        const witnesses = signTxBody(body, [pay, stake, cold]);
        expect(witnesses.length).toBe(3);
        expect(verifyWitnesses(body, witnesses)).toBe(true);
        expect(sameWitnessSet(witnesses, cliSigned.witnesses)).toBe(true);
        // with cardano-cli's ordering reproduced, the whole signed transaction is byte-identical
        expect(hex(encodeSignedTx(body, witnesses))).toBe(signed.cborHex);
    });

    test("min-fee builder converges and pays the fee from the change output", async () => {
        const pay = loadSigningKey(T("payment.skey"), KeyEnvelopeType.paymentSigning);
        const stake = loadSigningKey(T("stake.skey"), KeyEnvelopeType.stakeSigning);
        const cold = loadColdSigningKey(K("cold.skey"));
        const addr = bech32Decode(await text(T("payment.addr"))).bytes;
        const certs = [T("stake-reg.cert"), T("pool-reg.cert"), T("deleg.cert")].map((p) => Cbor.parse(Uint8Array.from(Buffer.from(readTextEnvelope(p).cborHex, "hex"))) as CborArray);
        const r = buildWithMinFee({
            inputs: [{ txHash: new Uint8Array(32).fill(1), index: 0 }], outputs: [{ address: addr, lovelace: 1_000_000_000n }], changeIndex: 0,
            ttl: 40_000_000n, certificates: certs, minFeeA: 44n, minFeeB: 155_381n, keys: [pay, stake, cold],
        });
        expect(r.fee).toBe(44n * BigInt(r.tx.length) + 155_381n);
        const dec = decodeTx(r.tx);
        expect(hex(dec.body)).toBe(hex(r.body));
        expect(verifyWitnesses(r.body, dec.witnesses)).toBe(true);
        expect(() => buildWithMinFee({ inputs: [{ txHash: new Uint8Array(32), index: 0 }], outputs: [{ address: addr, lovelace: 1000n }], changeIndex: 0, certificates: [], minFeeA: 44n, minFeeB: 155_381n, keys: [pay] })).toThrow(/cover the fee/);
    });
});

describe("message metadata", () => {
    test("the auxiliary data hash goes into body key 7 and the data into the transaction's fourth element", async () => {
        const { Cbor, CborMap, CborUInt, CborBytes, CborArray } = await import("@harmoniclabs/cbor");
        const { blake2b_256 } = await import("@harmoniclabs/crypto");
        const { buildWithMinFee, generateKeyPair, messageMetadata } = await import("./operator");
        const aux = messageMetadata(["Gerolamo was here!"]);
        const built = buildWithMinFee({
            inputs: [{ txHash: new Uint8Array(32).fill(7), index: 1 }], outputs: [{ address: new Uint8Array(57).fill(2), lovelace: 3_000_000n }], changeIndex: 0,
            certificates: [], auxiliaryData: aux, minFeeA: 44n, minFeeB: 155381n, keys: [generateKeyPair(new Uint8Array(32).fill(5))],
        });
        const body = Cbor.parse(built.body) as InstanceType<typeof CborMap>;
        const key7 = body.map.find((e) => e.k instanceof CborUInt && e.k.num === 7n)?.v as InstanceType<typeof CborBytes>;
        expect(Buffer.from(key7.bytes).toString("hex")).toBe(Buffer.from(blake2b_256(Cbor.encode(aux).toBuffer())).toString("hex"));
        const tx = Cbor.parse(built.tx) as InstanceType<typeof CborArray>;
        expect(tx.array.length).toBe(4);
        expect(Buffer.from(Cbor.encode(tx.array[3]!).toBuffer()).toString("hex")).toBe(Buffer.from(Cbor.encode(aux).toBuffer()).toString("hex"));
        expect(() => messageMetadata(["x".repeat(65)])).toThrow();
    });
});
