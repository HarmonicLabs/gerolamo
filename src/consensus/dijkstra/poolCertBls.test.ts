import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { decodeGovTx } from "../governance/govTxDecode";
import { scanTxBody } from "../../ledger/certScan";

/**
 * Dijkstra pool registration (bug 424): `(3, operator, vrf_keyhash, ? bls_key / nil, pledge, cost,
 * margin, reward_account, owners, relays, metadata)`; the raw decoders skip the optional slot.
 */
const op = new Uint8Array(28).fill(1), vrf = new Uint8Array(32).fill(2), owner = new Uint8Array(28).fill(3);
const reward = new Uint8Array([0xe0, ...new Array(28).fill(4)]);
const bls = new CborArray([new CborBytes(new Uint8Array(96).fill(5)), new CborBytes(new Uint8Array(48).fill(6))]);
const cert = (blsSlot: any[]) => new CborArray([
    new CborUInt(3), new CborBytes(op), new CborBytes(vrf), ...blsSlot,
    new CborUInt(500_000_000), new CborUInt(340_000_000), new CborTag(30, new CborArray([new CborUInt(1), new CborUInt(100)])),
    new CborBytes(reward), new CborTag(258, new CborArray([new CborBytes(owner)])), new CborArray([]), new CborSimple(null),
]);
const body = (c: CborArray) => Cbor.encode(new CborMap([
    { k: new CborUInt(0), v: new CborArray([]) }, { k: new CborUInt(1), v: new CborArray([]) }, { k: new CborUInt(2), v: new CborUInt(0) },
    { k: new CborUInt(4), v: new CborArray([c]) },
])).toBuffer();

describe("pool registration with a BLS key (bug 424)", () => {
    for (const [name, slot] of [["no key", []], ["a key", [bls]], ["nil", [new CborSimple(null)]]] as const) {
        test(`governance decoder reads cost and reward account (${name})`, () => {
            const m = decodeGovTx(body(cert([...slot] as any[]))).certs[0]!;
            expect(m.type).toBe(3);
            expect(m.poolReg!.cost).toBe(340_000_000n);
            expect(m.poolReg!.vrf).toBe(Buffer.from(vrf).toString("hex"));
            expect(m.poolReg!.metadataHashLen).toBeNull();
        });
    }
    test("certScan: the BLS key joins the PoolParams encoding, a nil does not", () => {
        const plain = scanTxBody(body(cert([]))).pools[0]!;
        const withNil = scanTxBody(body(cert([new CborSimple(null)]))).pools[0]!;
        const withKey = scanTxBody(body(cert([bls]))).pools[0]!;
        expect(Buffer.from(withNil.paramsCbor).toString("hex")).toBe(Buffer.from(plain.paramsCbor).toString("hex"));
        expect(withKey.paramsCbor[0]).toBe(0x8a); // 10 fields
        expect(plain.paramsCbor[0]).toBe(0x89);
        const parsed = Cbor.parse(withKey.paramsCbor) as CborArray;
        expect((parsed.array[2] as CborArray).array.length).toBe(2);
        expect(withKey.poolId).toBe(plain.poolId);
    });
});
