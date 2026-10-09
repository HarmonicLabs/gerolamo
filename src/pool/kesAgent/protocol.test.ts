import { describe, expect, test } from "bun:test";
import { verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { decodeOperationalCert, envelopeBytes, opcertSigningBytes, readOperationalCert, readTextEnvelope } from "../keystore";
import {
    BUNDLE_BYTES, RecvResult, decodeBundle, decodeOpcertWire, decodeRecvResult, decodeVersionIds, encodeBundle, encodeDropKeyMessageV2,
    encodeKeyMessageV1, encodeKeyMessageV2, encodeOpcertWire, encodeRecvResult, encodeVersionAnswer, encodeVersionOffer, pickVersion, versionId, versionName,
} from "./protocol";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const KA = (n: string) => new URL(`../__fixtures__/kes-agent/${n}`, import.meta.url).pathname;
const Z = (n: number) => "00".repeat(n);

// Version identifiers: ASCII, zero-padded to 32 bytes (mkVersionIdentifier).
const V2_HEX = "536572766963653a322e30" + Z(21); // "Service:2.0"
const V1_HEX = "536572766963653a312e30" + Z(21); // "Service:1.0"

// kes-agent's own fixture certificate (fixtures/opcert.cert): KES vkey, counter 7, KES period 1430, cold signature.
const FIX_KES_VKEY = "df22d655d82015c61cb62c8138dfe7a27238a60c1e1cd5bb18ec71a5dd71f39f";
const FIX_SIG = "412db8487ff22463b8c901b623d0bc62acd30ae7e19f6717e0b57e9b0759b51c0baddf0a6d002aa814d26db064d4c6e7fefc4c98fbd8ca325baaf685aceaf406";
/** The 112-byte OCert as the service protocol carries it (DirectCodec: vkHot ‖ word64BE n ‖ word64BE period ‖ sigma). */
const FIX_OPCERT_WIRE = FIX_KES_VKEY + "0000000000000007" + "0000000000000596" + FIX_SIG;

/** A stand-in 612-byte KES key (no crypto needed for the codec): bytes i % 251, period 5 in the u32 suffix. */
function fakeKey(): Uint8Array {
    const k = new Uint8Array(612);
    for (let i = 0; i < 608; i++) k[i] = i % 251;
    k.set([0, 0, 0, 5], 608);
    return k;
}

describe("kes-agent service protocol codec (450)", () => {
    test("version identifiers and the handshake messages", () => {
        expect(hex(versionId("Service:2.0"))).toBe(V2_HEX);
        expect(versionName(versionId("Service:1.0"))).toBe("Service:1.0");
        // truncation to 32 bytes, as mkVersionIdentifier
        expect(versionId("x".repeat(40)).length).toBe(32);
        // VersionOfferMessage: word32BE count ‖ count × 32 bytes
        expect(hex(encodeVersionOffer(["Service:2.0", "Service:1.0"]))).toBe("00000002" + V2_HEX + V1_HEX);
        // VersionAcceptMessage = Maybe bytes: 0x01 ‖ id; VersionRejectedMessage: 0x00
        expect(hex(encodeVersionAnswer("Service:2.0"))).toBe("01" + V2_HEX);
        expect(hex(encodeVersionAnswer(null))).toBe("00");
        const offer = Buffer.from(V1_HEX + V2_HEX + "536572766963653a5374616e6461726443727970746f" + Z(10), "hex"); // + "Service:StandardCrypto" (V0-style)
        const names = decodeVersionIds(offer, 3);
        expect(names).toEqual(["Service:1.0", "Service:2.0", "Service:StandardCrypto"]);
        expect(pickVersion(names)).toBe("Service:2.0"); // our preference, not the agent's order
        expect(pickVersion(["Service:1.0"])).toBe("Service:1.0");
        expect(pickVersion(["Service:StandardCrypto"])).toBeNull();
        expect(() => decodeVersionIds(new Uint8Array(31), 1)).toThrow();
    });

    test("RecvResult is a word32BE (RawUtil.encodeRecvResult)", () => {
        expect(hex(encodeRecvResult(RecvResult.ok))).toBe("00000000");
        expect(hex(encodeRecvResult(RecvResult.keyOutdated))).toBe("00000001");
        expect(hex(encodeRecvResult(RecvResult.invalidOpCert))).toBe("00000002");
        expect(hex(encodeRecvResult(RecvResult.noKey))).toBe("00000003");
        expect(hex(encodeRecvResult(RecvResult.unsupportedOperation))).toBe("00000004");
        expect(hex(encodeRecvResult(RecvResult.unknown))).toBe("0000ffff");
        expect(decodeRecvResult(Buffer.from("00000002", "hex"))).toBe(RecvResult.invalidOpCert);
        expect(decodeRecvResult(Buffer.from("00000009", "hex"))).toBe(RecvResult.unknown);
    });

    test("kes-agent's fixture certificate: decodes, its cold signature verifies, and its wire form is byte-exact", () => {
        const oc = readOperationalCert(KA("opcert.cert"));
        const cold = envelopeBytes(readTextEnvelope(KA("cold.vkey")), 32);
        const kesVkey = envelopeBytes(readTextEnvelope(KA("kes.vkey")), 32);
        expect(hex(oc.coldVkey)).toBe(hex(cold));
        expect(hex(oc.cert.kesVkey)).toBe(hex(kesVkey));
        expect(oc.cert.counter).toBe(7n);
        expect(oc.cert.kesPeriod).toBe(1430n);
        expect(verifyEd25519Signature_sync(oc.cert.signature, opcertSigningBytes(oc.cert.kesVkey, oc.cert.counter, oc.cert.kesPeriod), cold)).toBe(true);
        expect(hex(encodeOpcertWire(oc.cert))).toBe(FIX_OPCERT_WIRE);
        const back = decodeOpcertWire(Buffer.from(FIX_OPCERT_WIRE, "hex"));
        expect(back.counter).toBe(7n);
        expect(back.kesPeriod).toBe(1430n);
        expect(hex(back.signature)).toBe(FIX_SIG);
    });

    test("Dingo's fixture certificate (bursa KeyPush.opcert CBOR) maps to the same wire layout", () => {
        // dingo kesagent/tests_test.go testOpCertCBORHex: [[KES vkey 4cd49bb0…, 0, 0, sig], cold vkey]
        const cbor = "828458204cd49bb05e9885142fe7af1481107995298771fd1a24e72b506a4d600ee2b3120000584089fc9e9f551b2ea873bf31643659d049152d5c8e8de86be4056370bccc5fa62dd12e3f152f1664e614763e46eaa7a17ed366b5cef19958773d1ab96941442e0b58205a3d778e76741a009e29d23093cfe046131808d34d7c864967b515e98dfc3583";
        const oc = decodeOperationalCert({ type: "NodeOperationalCertificate", description: "", cborHex: cbor });
        expect(verifyEd25519Signature_sync(oc.cert.signature, opcertSigningBytes(oc.cert.kesVkey, oc.cert.counter, oc.cert.kesPeriod), oc.coldVkey)).toBe(true);
        expect(hex(encodeOpcertWire(oc.cert))).toBe("4cd49bb05e9885142fe7af1481107995298771fd1a24e72b506a4d600ee2b312" + Z(16) + hex(oc.cert.signature));
    });

    test("bundle and key / drop messages: byte layout and round trip", () => {
        const key = fakeKey();
        const oc = decodeOpcertWire(Buffer.from(FIX_OPCERT_WIRE, "hex"));
        const bundle = encodeBundle(key, oc);
        expect(bundle.length).toBe(BUNDLE_BYTES);
        expect(hex(bundle)).toBe(hex(key) + FIX_OPCERT_WIRE);
        const d = decodeBundle(bundle);
        expect(d.period).toBe(5);
        expect(hex(d.kesSignKey)).toBe(hex(key));
        expect(d.opcert.counter).toBe(7n);
        // Service:2.0 KeyMessage: word8 0 ‖ word64BE timestamp (µs) ‖ bundle
        const ts = 1_760_000_000_123_456n;
        expect(hex(encodeKeyMessageV2(ts, key, oc))).toBe("00" + ts.toString(16).padStart(16, "0") + hex(key) + FIX_OPCERT_WIRE);
        // DropKeyMessage: word8 1 ‖ word64BE timestamp
        expect(hex(encodeDropKeyMessageV2(ts))).toBe("01" + ts.toString(16).padStart(16, "0"));
        // Service:1.0 KeyMessage: the bare bundle
        expect(hex(encodeKeyMessageV1(key, oc))).toBe(hex(bundle));
        expect(() => decodeBundle(bundle.subarray(1))).toThrow();
        expect(() => encodeBundle(key.subarray(0, 608), oc)).toThrow();
    });
});
