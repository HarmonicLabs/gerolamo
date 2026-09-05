import { describe, expect, test } from "bun:test";
import { BabbageHeader, MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborArray, CborTag, CborBytes } from "@harmoniclabs/cbor";
import { validateHeader } from "../consensus/BlockHeaderValidator";
import { blockFetchHeaderIdentity } from "../consensus/blockHeaderParser";
import { verifyBlockBodyHash, splitEraBlock, computeShelleyBodyHash, shelleyHeaderBodyHash } from "../consensus/bodyHash";
import { praosLeaderValue } from "../consensus/workers/validationJob";
import { isSlotLeader } from "../consensus/rules/leaderMath";
import { issueOperationalCert, loadColdSigningKey, loadKesSigningKey, loadVrfSigningKey, kesVerifyAt, checkOperationalCert } from "./keystore";
import { EMPTY_BODY, bodyCommitment, forgeBlock } from "./forge";

const F = (n: string) => new URL(`./__fixtures__/cli-keys/${n}`, import.meta.url).pathname;
const nonceHex = "aa72206c1e2884c06e32970f7d383c59f28b2046434c5bb456c105f344ca154c"; // preview epoch 333 η0
const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
const config = { networkMagic: 2, shelleyGenesisFile: "src/config/preview/shelley-genesis.json", network: "preview" };
const SLOTS_PER_KES = 129600n;

function setup(slot: bigint) {
    const cold = loadColdSigningKey(F("cold.skey"));
    const kes = loadKesSigningKey(F("kes.skey"), F("kes.vkey"));
    const vrf = loadVrfSigningKey(F("vrf.skey"), F("vrf.vkey"));
    // certificate issued for the KES period two periods before the slot → evolution 2
    const kesPeriod = slot / SLOTS_PER_KES - 2n;
    const { opcert } = issueOperationalCert(kes.vkey, { next: 0n, coldVkey: cold.vkey }, kesPeriod, cold);
    return { cold, kes, vrf, opcert: opcert.cert, coldVkey: cold.vkey };
}

describe("forging a Praos block", () => {
    test("an empty Babbage block passes our own header validator, body hash and identity checks", async () => {
        const slot = 333n * 86400n + 4242n;
        const { kes, vrf, opcert, coldVkey } = setup(slot);
        const forged = forgeBlock({
            era: 6, blockNumber: 1_252_900n, slot, prevHash: new Uint8Array(32).fill(7), nonce, coldVkey, vrf, kes, opcert,
            protocolVersion: { major: 8, minor: 0 }, slotsPerKESPeriod: SLOTS_PER_KES,
        });
        expect(forged.kesEvolution).toBe(2);
        // header layout: 10-field body + 448-byte KES signature; same shape our parser reads from real blocks
        const hdr = Cbor.parse(forged.headerBytes) as CborArray;
        expect(hdr.array.length).toBe(2);
        expect((hdr.array[0] as CborArray).array.length).toBe(10);
        expect((hdr.array[1] as CborBytes).bytes.length).toBe(448);
        // KES signature verifies at the evolution the slot requires, not at 0
        const bodyBytes = Cbor.encode(hdr.array[0]!).toBuffer();
        expect(kesVerifyAt((hdr.array[1] as CborBytes).bytes, 2, kes.vkey, bodyBytes)).toBe(true);
        expect(kesVerifyAt((hdr.array[1] as CborBytes).bytes, 0, kes.vkey, bodyBytes)).toBe(false);

        // ledger-ts parses it and the header validator (VRF proof, opcert, KES window) passes
        const parsed = BabbageHeader.fromCbor(forged.headerBytes);
        expect(parsed.body.slot).toBe(slot);
        expect(Buffer.from(parsed.body.blockBodyHash).toString("hex")).toBe(Buffer.from(bodyCommitment(EMPTY_BODY).hash).toString("hex"));
        const meh = new MultiEraHeader({ era: 6, header: parsed });
        expect(await validateHeader(meh, nonce, config)).toBe(true);
        // wrong nonce → VRF proof no longer matches the input
        expect(await validateHeader(meh, new Uint8Array(32), config)).toBe(false);
        // tampered KES signature → false
        const bad = Uint8Array.from(forged.headerBytes); bad[bad.length - 1]! ^= 1;
        expect(await validateHeader(new MultiEraHeader({ era: 6, header: BabbageHeader.fromCbor(bad) }), nonce, config)).toBe(false);

        // BlockFetch payload: identity hash = blake2b(header), body hash verifies, size = 4 bytes of empty segments
        const id = blockFetchHeaderIdentity(forged.blockFetchBytes);
        expect(Buffer.from(id.hash).toString("hex")).toBe(Buffer.from(forged.headerHash).toString("hex"));
        expect(id.era).toBe(6);
        expect(verifyBlockBodyHash(forged.blockFetchBytes).ok).toBe(true);
        const { era, rawBlock } = splitEraBlock(forged.blockFetchBytes);
        expect(Buffer.from(computeShelleyBodyHash(era, rawBlock)).toString("hex")).toBe(Buffer.from(shelleyHeaderBodyHash(era, forged.headerBytes)).toString("hex"));
        expect(parsed.body.blockBodySize).toBe(4);

        // ChainSync RollForward data: [era − 1, #6.24(header)]
        const rf = Cbor.parse(forged.rollForwardData) as CborArray;
        expect(Number((rf.array[0] as any).num)).toBe(5);
        expect(rf.array[1]).toBeInstanceOf(CborTag);
        expect(Buffer.from(((rf.array[1] as CborTag).data as CborBytes).bytes).toString("hex")).toBe(Buffer.from(forged.headerBytes).toString("hex"));

        // the leader value the validator derives from our VRF output is the schedule's
        const leader = praosLeaderValue(forged.vrf.output);
        expect(isSlotLeader(leader, { num: 1n, den: 1n }, 0.05) === isSlotLeader(praosLeaderValue(parsed.body.vrfResult.proofHash), { num: 1n, den: 1n }, 0.05)).toBe(true);
        expect(checkOperationalCert({ cert: opcert, coldVkey }, { currentKesPeriod: slot / SLOTS_PER_KES, maxKesEvolutions: 62n, lastOnChainCounter: null, kesVkey: kes.vkey })).toEqual({ ok: true, evolution: 2 });
    });

    test("refuses a slot before the certificate's KES period and cannot re-sign an earlier evolution", () => {
        const slot = 333n * 86400n;
        const { kes, vrf, opcert, coldVkey } = setup(slot);
        const early = { era: 6, blockNumber: 1n, slot: slot - 3n * SLOTS_PER_KES, prevHash: null, nonce, coldVkey, vrf, kes, opcert, protocolVersion: { major: 8, minor: 0 }, slotsPerKESPeriod: SLOTS_PER_KES };
        expect(() => forgeBlock(early)).toThrow(/before the operational certificate/);
        forgeBlock({ ...early, slot: slot + SLOTS_PER_KES }); // evolution 3
        expect(() => forgeBlock({ ...early, slot })).toThrow(/cannot go back/); // evolution 2 after 3
    });
});
