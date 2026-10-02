import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborTag, CborText, CborUInt, LazyCborArray, type CborObj } from "@harmoniclabs/cbor";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import golden from "./__fixtures__/byron-update-golden.json";
import fixture from "../__fixtures__/byron-preprod.json";
import preprodGenesis from "../../config/preprod/byron-genesis.json";
import mainnetGenesis from "../../config/mainnet/byron-genesis.json";
import { splitEraBlock } from "../bodyHash";
import { byronKeyHash, concatBytes } from "./ByronCrypto";
import { ByronObftState, type ByronGenesisConfig } from "./ByronOBFT";
import {
    ByronDecodeError,
    byronProtocolParametersFromGenesis,
    byronUpdatePayloadOfBody,
    decodeByronHeaderUpdateFields,
    decodeByronProposal,
    decodeByronUpdatePayload,
    decodeByronVote,
    decodeProtocolParameters,
    decodeProtocolParametersUpdate,
    signTagUSProposal,
    signTagUSVote,
    verifyProposalSignature,
    verifyVoteSignature,
    type ByronProposal,
    type ByronProtocolParameters,
    type ByronProtocolParametersUpdate,
    type ByronProtocolVersion,
    type ByronSoftwareVersion,
    type ByronUpdatePayload,
    type ByronVote,
} from "./byronUpdateCodec";
import {
    ByronUpdateError,
    ByronUpdateTracker,
    currentByronProtocolParameters,
    initialByronUpdateState,
    pvCanFollow,
    registerUpdate,
    setActiveByronUpdateTracker,
    upAdptThd,
    type ByronUpdateEnv,
} from "./ByronUpdate";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const noble = require("@harmoniclabs/crypto/dist/noble/ed25519.js").ed25519 as {
    getPublicKey(sk: Uint8Array): Uint8Array;
    sign(msg: Uint8Array, sk: Uint8Array): Uint8Array;
};

// ───────────────────────────── builders ─────────────────────────────

interface Key { sk: Uint8Array; xpub: Uint8Array; kh: string }
function key(seed: number): Key {
    const sk = new Uint8Array(32).fill(seed);
    const xpub = concatBytes(noble.getPublicKey(sk), new Uint8Array(32).fill(seed)); // pub ‖ chain code
    return { sk, xpub, kh: byronKeyHash(xpub) };
}
const enc = (o: CborObj) => Cbor.encode(o).toBuffer();
const u = (n: number | bigint) => new CborUInt(BigInt(n));
const b = (x: Uint8Array) => new CborBytes(x);
const pvObj = (pv: ByronProtocolVersion) => new CborArray([u(pv.major), u(pv.minor), u(pv.alt)]);
const svObj = (sv: ByronSoftwareVersion) => new CborArray([new CborText(sv.appName), u(sv.number)]);

function ppuObj(ppu: ByronProtocolParametersUpdate): CborArray {
    const just = (x: CborObj | undefined) => new CborArray(x ? [x] : []);
    const n = (v: bigint | number | undefined) => (v === undefined ? undefined : u(v));
    const sfr = ppu.softforkRule && new CborArray([u(ppu.softforkRule.initThd), u(ppu.softforkRule.minThd), u(ppu.softforkRule.thdDecrement)]);
    const fee = ppu.txFeePolicy && new CborArray([u(0), new CborTag(24, b(enc(new CborArray([u(ppu.txFeePolicy.summand), u(ppu.txFeePolicy.multiplier)]))))]);
    return new CborArray([
        just(n(ppu.scriptVersion)), just(n(ppu.slotDuration)), just(n(ppu.maxBlockSize)), just(n(ppu.maxHeaderSize)),
        just(n(ppu.maxTxSize)), just(n(ppu.maxProposalSize)), just(n(ppu.mpcThd)), just(n(ppu.heavyDelThd)),
        just(n(ppu.updateVoteThd)), just(n(ppu.updateProposalThd)), just(n(ppu.updateProposalTTL)), just(sfr), just(fee),
        just(n(ppu.unlockStakeEpoch)),
    ]);
}

const MAGIC = 42;

function makeProposal(o: { pv: ByronProtocolVersion; sv: ByronSoftwareVersion; ppu?: ByronProtocolParametersUpdate; tags?: string[]; signer: Key; magic?: number }): ByronProposal {
    const meta = new CborMap((o.tags ?? []).map((t) => ({ k: new CborText(t), v: new CborArray([b(new Uint8Array()), b(new Uint8Array(32).fill(9)), b(new Uint8Array()), b(new Uint8Array())]) })));
    const body = concatBytes(enc(pvObj(o.pv)), enc(ppuObj(o.ppu ?? {})), enc(svObj(o.sv)), enc(meta), enc(new CborMap([])));
    const sig = noble.sign(concatBytes(signTagUSProposal(o.magic ?? MAGIC), new Uint8Array([0x85]), body), o.signer.sk);
    return decodeByronProposal(concatBytes(new Uint8Array([0x87]), body, enc(b(o.signer.xpub)), enc(b(sig))));
}

function makeVote(upId: string, voter: Key, magic = MAGIC): ByronVote {
    const idRaw = enc(b(fromHex(upId)));
    const sig = noble.sign(concatBytes(signTagUSVote(magic), new Uint8Array([0x82]), idRaw, new Uint8Array([0xf5])), voter.sk);
    return decodeByronVote(concatBytes(new Uint8Array([0x84]), enc(b(voter.xpub)), idRaw, enc(new CborSimple(true)), enc(b(sig))));
}

const genesisKeys = [1, 2, 3, 4, 5, 6, 7].map(key);
const delegates = [11, 12, 13, 14, 15, 16, 17].map(key);
const dm = new Map(genesisKeys.map((g, i) => [g.kh, delegates[i]!.kh]));
const outsider = key(99);
const K = 2; // epoch = 20 slots, 2k = 4, 4k = 8
const baseParams: ByronProtocolParameters = { ...byronProtocolParametersFromGenesis(mainnetGenesis.blockVersionData), updateProposalTTL: 10n };
const PV0 = { major: 0, minor: 0, alt: 0 };
const PV1 = { major: 1, minor: 0, alt: 0 };
const SV = { appName: "cardano-sl", number: 1 };

function env(slot: number, over: Partial<ByronUpdateEnv> = {}): ByronUpdateEnv {
    return { protocolMagic: MAGIC, k: K, currentSlot: BigInt(slot), numGenKeys: 7, delegationMap: dm, ...over };
}
const payload = (proposal: ByronProposal | null, votes: ByronVote[] = []): ByronUpdatePayload => ({ proposal, votes });
const tracker = (params = baseParams) => new ByronUpdateTracker({ protocolMagic: MAGIC, k: K, numGenKeys: 7, genesisParams: params });
const block = (slot: number, p: ByronUpdatePayload = payload(null), pv = PV0, issuer = delegates[0]!) => ({ slot: BigInt(slot), protocolVersion: pv, issuerKeyHash: issuer.kh, payload: p });
const errCode = (f: () => unknown): string => {
    try { f(); } catch (e) { if (e instanceof ByronUpdateError) return e.code; throw e; }
    return "none";
};

// ───────────────────────────── codec ─────────────────────────────

describe("Byron update codec", () => {
    const upIdHex = golden.UpId.slice(4); // strip 0x5820

    test("golden Proposal: fields, UpId = blake2b-256(bytes), signed body span", () => {
        const p = decodeByronProposal(fromHex(golden.Proposal));
        expect(p.protocolVersion).toEqual({ major: 1, minor: 1, alt: 1 });
        expect(p.softwareVersion).toEqual({ appName: "Golden", number: 99 });
        expect(p.upId).toBe(upIdHex);
        expect(p.bytes.length).toBe(995);
        expect(p.metadata.size).toBe(5);
        // recoverProposalSignedBytes = 0x85 ‖ annotated body: exactly the ProposalBody golden encoding
        expect(Buffer.from(concatBytes(new Uint8Array([0x85]), p.bodyBytes)).toString("hex")).toBe(golden.ProposalBody);
        expect(p.ppUpdate).toEqual({
            scriptVersion: 999, slotDuration: 999n, maxBlockSize: 999n, maxHeaderSize: 999n, maxTxSize: 999n, maxProposalSize: 999n,
            mpcThd: 99n, heavyDelThd: 99n, updateVoteThd: 99n, updateProposalThd: 99n, updateProposalTTL: 99n,
            softforkRule: { initThd: 99n, minThd: 99n, thdDecrement: 99n },
            txFeePolicy: { summand: 999_000_000_000n, multiplier: 77_000_000_000n }, // Lovelace 999, Rational 77, in nano
            unlockStakeEpoch: 99n,
        });
        expect(decodeProtocolParametersUpdate(fromHex(golden.ProtocolParametersUpdate))).toEqual(p.ppUpdate);
    });

    test("golden Vote and Payload", () => {
        const v = decodeByronVote(fromHex(golden.Vote));
        expect(v.proposalId).toBe(upIdHex);
        expect(v.decision).toBe(true);
        expect(Buffer.from(v.proposalIdRaw).toString("hex")).toBe(golden.UpId);
        const pl = decodeByronUpdatePayload(fromHex(golden.Payload));
        expect(pl.proposal!.upId).toBe(upIdHex);
        expect(Buffer.from(pl.proposal!.bytes).toString("hex")).toBe(golden.Proposal);
        expect(pl.votes.map((x) => Buffer.from(x.bytes).toString("hex"))).toEqual([golden.Vote]);
    });

    test("golden ProtocolParameters", () => {
        const pp = decodeProtocolParameters(fromHex(golden.ProtocolParameters));
        expect(pp.scriptVersion).toBe(999);
        expect(pp.updateProposalTTL).toBe(99n);
        expect(pp.txFeePolicy).toEqual({ summand: 999_000_000_000n, multiplier: 77_000_000_000n });
    });

    test("strict shapes: LovelacePortion > 1e15, Maybe of 2, non-empty attributes, 63-byte key", () => {
        const ppu = (o: CborArray) => decodeProtocolParametersUpdate(enc(o));
        const maybes = (i: number, x: CborObj[]) => new CborArray(Array.from({ length: 14 }, (_, j) => new CborArray(j === i ? x : [])));
        expect(() => ppu(maybes(6, [u(1_000_000_000_000_001n)]))).toThrow(ByronDecodeError);
        expect(ppu(maybes(6, [u(1_000_000_000_000_000n)])).mpcThd).toBe(1_000_000_000_000_000n);
        expect(() => ppu(maybes(4, [u(1), u(2)]))).toThrow(ByronDecodeError);
        const p = makeProposal({ pv: PV1, sv: SV, signer: delegates[0]! });
        const withAttr = concatBytes(new Uint8Array([0x87]), p.bodyBytes.subarray(0, p.bodyBytes.length - 1), enc(new CborMap([{ k: u(0), v: b(new Uint8Array(1)) }])), enc(b(p.issuer)), enc(b(p.signature)));
        expect(() => decodeByronProposal(withAttr)).toThrow(ByronDecodeError);
        const shortKey = concatBytes(new Uint8Array([0x87]), p.bodyBytes, enc(b(p.issuer.subarray(0, 63))), enc(b(p.signature)));
        expect(() => decodeByronProposal(shortKey)).toThrow(ByronDecodeError);
    });

    test("fee summand Nano → Lovelace rounds half to even (Haskell `round`)", () => {
        const fee = (s: bigint) => decodeProtocolParametersUpdate(enc(ppuObj({ txFeePolicy: { summand: s, multiplier: 7n } }))).txFeePolicy!;
        expect(fee(1_500_000_000n).summand).toBe(2_000_000_000n);
        expect(fee(2_500_000_000n).summand).toBe(2_000_000_000n);
        expect(fee(2_500_000_001n).summand).toBe(3_000_000_000n);
        expect(fee(2_500_000_001n).multiplier).toBe(7n);
    });

    test("real preprod block (slot 2163): header fields, proposal 1.0.0 and 7 votes with valid signatures", () => {
        const { rawBlock } = splitEraBlock(fromHex((fixture.blocks as string[])[2]!));
        const [hdr, body] = (Cbor.parseLazy(rawBlock) as LazyCborArray).array as [Uint8Array, Uint8Array];
        const h = decodeByronHeaderUpdateFields(hdr, 21600n);
        expect(h.slot).toBe(2163n);
        expect(h.protocolVersion).toEqual(PV0);
        expect(h.softwareVersion).toEqual(SV);
        const pl = decodeByronUpdatePayload(byronUpdatePayloadOfBody(body));
        const p = pl.proposal!;
        expect(p.protocolVersion).toEqual(PV1);
        expect(p.softwareVersion).toEqual(SV);
        expect(p.ppUpdate).toEqual({});
        expect(p.upId.startsWith("561a907d9d31")).toBe(true);
        expect(verifyProposalSignature(p, 1)).toBe(true);
        expect(verifyProposalSignature(p, 2)).toBe(false);
        expect(pl.votes.length).toBe(7);
        for (const v of pl.votes) {
            expect(v.proposalId).toBe(p.upId);
            expect(verifyVoteSignature(v, 1)).toBe(true);
        }
    });

    test("genesis blockVersionData → ProtocolParameters", () => {
        const pp = byronProtocolParametersFromGenesis(mainnetGenesis.blockVersionData);
        expect(pp.txFeePolicy).toEqual({ summand: 155_381_000_000_000n, multiplier: 43_946_000_000n });
        expect(pp.updateProposalTTL).toBe(10_000n);
        expect(pp.maxTxSize).toBe(4096n);
        expect(pp.softforkRule.minThd).toBe(600_000_000_000_000n);
        expect(byronProtocolParametersFromGenesis(preprodGenesis.blockVersionData)).toEqual(pp);
    });
});

// ───────────────────────────── rules ─────────────────────────────

describe("Byron update rules", () => {
    test("upAdptThd = floor(minThd · numGenKeys)", () => {
        expect(upAdptThd(7, baseParams)).toBe(4);
        expect(upAdptThd(5, baseParams)).toBe(3);
        expect(upAdptThd(10, baseParams)).toBe(6);
        expect(upAdptThd(7, { ...baseParams, softforkRule: { ...baseParams.softforkRule, minThd: 1_000_000_000_000_000n } })).toBe(7);
    });

    test("pvCanFollow", () => {
        const pv = (major: number, minor: number, alt = 0) => ({ major, minor, alt });
        expect(pvCanFollow(pv(0, 1), pv(0, 0))).toBe(true);
        expect(pvCanFollow(pv(1, 0), pv(0, 0))).toBe(true);
        expect(pvCanFollow(pv(1, 0, 5), pv(0, 3))).toBe(true);
        expect(pvCanFollow(pv(0, 2), pv(0, 0))).toBe(false);
        expect(pvCanFollow(pv(1, 1), pv(0, 0))).toBe(false);
        expect(pvCanFollow(pv(2, 0), pv(0, 0))).toBe(false);
        expect(pvCanFollow(pv(0, 0, 1), pv(0, 0))).toBe(false); // minor must move
        expect(pvCanFollow(pv(0, 0), pv(0, 0))).toBe(false);
    });

    test("registration rejections", () => {
        const st = initialByronUpdateState(baseParams);
        const reg = (p: ByronProposal, s = st, e = env(1)) => errCode(() => registerUpdate(e, s, { payload: payload(p), protocolVersion: PV0, issuerKeyHash: delegates[0]!.kh }));
        const d0 = delegates[0]!;
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0 }))).toBe("none");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: genesisKeys[0]! }))).toBe("InvalidProposer"); // genesis key itself is not a delegate
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: outsider }))).toBe("InvalidProposer");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0, magic: 43 }))).toBe("InvalidSignature");
        expect(reg(makeProposal({ pv: { major: 0, minor: 2, alt: 0 }, sv: SV, signer: d0 }))).toBe("InvalidProtocolVersion");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0, ppu: { maxBlockSize: 4_000_001n } }))).toBe("MaxBlockSizeTooLarge");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0, ppu: { maxBlockSize: 4_000_000n } }))).toBe("none");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0, ppu: { maxTxSize: 2_000_000n } }))).toBe("MaxTxSizeTooLarge");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0, ppu: { scriptVersion: 2 } }))).toBe("InvalidScriptVersion");
        expect(reg(makeProposal({ pv: PV1, sv: SV, signer: d0, ppu: { scriptVersion: 1 } }))).toBe("none");
        const big = makeProposal({ pv: PV1, sv: SV, signer: d0, tags: "abcdefghijklmnop".split("") });
        expect(big.bytes.length).toBeGreaterThan(700);
        expect(reg(big)).toBe("ProposalTooLarge");
        // Software-only proposals: static checks and svCanFollow (new apps start at 0 or 1).
        expect(reg(makeProposal({ pv: PV0, sv: { appName: "new-app", number: 2 }, signer: d0 }))).toBe("InvalidSoftwareVersion");
        expect(reg(makeProposal({ pv: PV0, sv: { appName: "new-app", number: 0 }, signer: d0 }))).toBe("none");
        expect(reg(makeProposal({ pv: PV0, sv: { appName: "a-very-long-app", number: 1 }, signer: d0 }))).toBe("SoftwareVersionError");
        expect(reg(makeProposal({ pv: PV0, sv: SV, signer: d0, tags: ["linux-x86-64"] }))).toBe("SystemTagError");
        // Duplicates against the registered state.
        const st1 = registerUpdate(env(1), st, { payload: payload(makeProposal({ pv: PV1, sv: SV, signer: d0 })), protocolVersion: PV0, issuerKeyHash: d0.kh });
        expect(reg(makeProposal({ pv: PV1, sv: { appName: "other", number: 1 }, signer: delegates[1]! }), st1, env(2))).toBe("DuplicateProtocolVersion");
        expect(reg(makeProposal({ pv: { major: 0, minor: 1, alt: 0 }, sv: SV, signer: delegates[1]! }), st1, env(2))).toBe("DuplicateSoftwareVersion");
        // Null update: the software version already adopted and no protocol change.
        const t = tracker();
        const p = makeProposal({ pv: PV0, sv: SV, signer: d0 });
        t.applyMainBlock(block(1, payload(p, delegates.slice(0, 4).map((d) => makeVote(p.upId, d)))), dm);
        expect(t.state.appVersions.get("cardano-sl")?.version).toBe(1);
        expect(reg(makeProposal({ pv: PV0, sv: SV, signer: d0 }), t.state, env(2))).toBe("NullUpdateProposal");
        expect(reg(makeProposal({ pv: PV0, sv: { ...SV, number: 3 }, signer: d0 }), t.state, env(2))).toBe("InvalidSoftwareVersion");
        expect(reg(makeProposal({ pv: PV0, sv: { ...SV, number: 2 }, signer: d0 }), t.state, env(2))).toBe("none");
    });

    test("votes: confirmation at exactly upAdptThd = 4, and vote rejections", () => {
        const t = tracker();
        const p = makeProposal({ pv: PV1, sv: SV, signer: delegates[0]! });
        t.applyMainBlock(block(1, payload(p, delegates.slice(0, 3).map((d) => makeVote(p.upId, d)))), dm);
        expect(t.state.proposalVotes.get(p.upId)!.size).toBe(3);
        expect(t.state.confirmedProposals.has(p.upId)).toBe(false);
        const ev = t.applyMainBlock(block(2, payload(null, [makeVote(p.upId, delegates[3]!)])), dm);
        expect(t.state.confirmedProposals.get(p.upId)).toBe(2n);
        expect(ev.some((e) => e.type === "confirmed")).toBe(true);
        // votes are recorded under the genesis key (the delegator), not the voter
        expect(t.state.proposalVotes.get(p.upId)!.has(genesisKeys[3]!.kh)).toBe(true);
        // a fifth vote does not move the confirmation slot
        t.applyMainBlock(block(3, payload(null, [makeVote(p.upId, delegates[4]!)])), dm);
        expect(t.state.confirmedProposals.get(p.upId)).toBe(2n);

        const vote = (v: ByronVote, s = t.state) => errCode(() => registerUpdate(env(4), s, { payload: payload(null, [v]), protocolVersion: PV0, issuerKeyHash: delegates[0]!.kh }));
        expect(vote(makeVote(p.upId, delegates[0]!))).toBe("VotingVoteAlreadyCast");
        expect(vote(makeVote(p.upId, outsider))).toBe("VotingVoterNotDelegate");
        expect(vote(makeVote(p.upId, genesisKeys[5]!))).toBe("VotingVoterNotDelegate");
        expect(vote(makeVote("ab".repeat(32), delegates[5]!))).toBe("VotingProposalNotRegistered");
        expect(vote(makeVote(p.upId, delegates[5]!, 43))).toBe("VotingInvalidSignature");
        expect(vote(makeVote(p.upId, delegates[5]!))).toBe("none");
    });

    test("a failing block is reported and leaves the state untouched", () => {
        const t = tracker();
        const p = makeProposal({ pv: PV1, sv: SV, signer: delegates[0]! });
        const before = t.state;
        const ev = t.applyMainBlock(block(1, payload(p, [makeVote(p.upId, outsider)])), dm);
        expect(ev).toEqual([{ type: "error", slot: 1n, error: expect.stringContaining("VotingVoterNotDelegate") }]);
        expect(t.state).toBe(before);
        expect(t.counters.errors).toBe(1);
    });

    test("TTL expiry: an unconfirmed proposal lives while slot ≤ regSlot + ttl", () => {
        const t = tracker(); // ttl 10
        const p = makeProposal({ pv: PV1, sv: SV, signer: delegates[0]! });
        t.applyMainBlock(block(1, payload(p, [makeVote(p.upId, delegates[0]!)])), dm);
        t.applyMainBlock(block(11, payload(null, [makeVote(p.upId, delegates[1]!)])), dm);
        expect(t.state.proposalRegistrationSlot.has(p.upId)).toBe(true);
        const ev = t.applyMainBlock(block(12), dm);
        expect(ev).toContainEqual({ type: "expired", slot: 12n, upId: p.upId });
        expect(t.state.registeredProtocolUpdateProposals.size).toBe(0);
        expect(t.state.registeredSoftwareUpdateProposals.size).toBe(0);
        expect(t.state.proposalVotes.size).toBe(0);
        const late = t.applyMainBlock(block(13, payload(null, [makeVote(p.upId, delegates[2]!)])), dm);
        expect(late[0]).toMatchObject({ type: "error", error: expect.stringContaining("VotingProposalNotRegistered") });
        // the same version can be proposed again after expiry
        const again = makeProposal({ pv: PV1, sv: { appName: "cardano-sl", number: 0 }, signer: delegates[1]! });
        expect(t.applyMainBlock(block(14, payload(again)), dm).some((e) => e.type === "proposal")).toBe(true);
    });

    test("confirmed proposals do not expire", () => {
        const t = tracker();
        const p = makeProposal({ pv: PV1, sv: SV, signer: delegates[0]! });
        t.applyMainBlock(block(1, payload(p, delegates.slice(0, 4).map((d) => makeVote(p.upId, d)))), dm);
        t.applyMainBlock(block(19), dm);
        expect(t.state.registeredProtocolUpdateProposals.has(p.upId)).toBe(true);
    });

    /** Proposal at slot 1 (confirmed there), endorsements by delegates at `endorseSlots`. */
    function softfork(endorseSlots: number[], ppu: ByronProtocolParametersUpdate) {
        const t = tracker();
        const p = makeProposal({ pv: PV1, sv: SV, signer: delegates[0]!, ppu });
        const events = [...t.applyMainBlock(block(1, payload(p, delegates.slice(0, 4).map((d) => makeVote(p.upId, d)))), dm)];
        endorseSlots.forEach((s, i) => events.push(...t.applyMainBlock(block(s, payload(null), PV1, delegates[i % 7]!), dm)));
        return { t, p, events };
    }

    test("endorsements before confirmation + 2k are ignored; the 4th stable one makes a candidate", () => {
        // confirmed at 1 → stable from slot 1 + 2k = 5
        const early = softfork([2, 3, 4, 5], {});
        expect(early.t.state.registeredEndorsements.size).toBe(1); // only slot 5 counted
        expect(early.t.state.candidateProtocolUpdates.length).toBe(0);
        const { t } = softfork([5, 6, 7, 8], {});
        expect(t.state.candidateProtocolUpdates.map((c) => c.slot)).toEqual([8n]);
        // further endorsements do not move the candidate slot (FADS keeps the older entry)
        t.applyMainBlock(block(9, payload(null), PV1, delegates[4]!), dm);
        expect(t.state.candidateProtocolUpdates.map((c) => c.slot)).toEqual([8n]);
        // the same delegate endorsing twice counts once
        const dup = softfork([5, 6, 7], {});
        dup.t.applyMainBlock(block(8, payload(null), PV1, delegates[0]!), dm);
        expect(dup.t.state.candidateProtocolUpdates.length).toBe(0);
    });

    test("softfork adoption across the epoch boundary changes maxTxSize and the fee policy", () => {
        const newFee = { summand: 200_000_000_000_000n, multiplier: 50_000_000_000n };
        // candidate at slot 12: 12 + 4k = 20 ≤ 20 → adopted at epoch 1
        const { t } = softfork([9, 10, 11, 12], { maxTxSize: 8192n, txFeePolicy: newFee });
        setActiveByronUpdateTracker(t);
        try {
            expect(currentByronProtocolParameters()!.maxTxSize).toBe(4096n);
            t.applyMainBlock(block(19), dm);
            expect(t.adoptedProtocolVersion()).toEqual(PV0);
            const ev = t.applyMainBlock(block(21), dm); // first block of epoch 1 (slot 20 empty)
            expect(ev[0]).toEqual({ type: "adopted", slot: 21n, epoch: 1n, protocolVersion: PV1, changed: ["maxTxSize", "txFeePolicy"] });
            expect(t.adoptedProtocolVersion()).toEqual(PV1);
            expect(currentByronProtocolParameters()!.maxTxSize).toBe(8192n);
            expect(currentByronProtocolParameters()!.txFeePolicy).toEqual(newFee);
            // adoption clears the proposal state but keeps application versions
            expect(t.state.registeredProtocolUpdateProposals.size + t.state.confirmedProposals.size + t.state.candidateProtocolUpdates.length).toBe(0);
            expect(t.state.appVersions.get("cardano-sl")?.version).toBe(1);
        } finally {
            setActiveByronUpdateTracker(null);
        }
        expect(currentByronProtocolParameters()).toBeNull();
    });

    test("a candidate later than first slot − 4k waits one more epoch", () => {
        // candidate at 13: 13 + 8 = 21 > 20 → not at epoch 1; adopted at epoch 2
        const { t } = softfork([10, 11, 12, 13], { maxTxSize: 8192n });
        t.applyMainBlock(block(21), dm);
        expect(t.adoptedProtocolVersion()).toEqual(PV0);
        expect(t.adoptedProtocolParameters().maxTxSize).toBe(4096n);
        t.applyMainBlock(block(39), dm);
        expect(t.adoptedProtocolVersion()).toEqual(PV0);
        // no block at slot 40..: the chain tick at the epoch-2 boundary adopts it
        expect(t.tick(40n)).toEqual([{ type: "adopted", slot: 40n, epoch: 2n, protocolVersion: PV1, changed: ["maxTxSize"] }]);
        expect(t.adoptedProtocolParameters().maxTxSize).toBe(8192n);
        expect(t.tick(40n)).toEqual([]); // idempotent
    });

    test("snapshot / restore round-trip", () => {
        const { t } = softfork([5, 6, 7], { maxTxSize: 8192n });
        const s = JSON.parse(JSON.stringify(t.snapshot()));
        const t2 = tracker();
        t2.restore(s);
        expect(t2.state).toEqual(t.state);
        expect(t2.lastSlot).toBe(t.lastSlot);
        t.applyMainBlock(block(8, payload(null), PV1, delegates[3]!), dm);
        t2.applyMainBlock(block(8, payload(null), PV1, delegates[3]!), dm);
        expect(t2.state).toEqual(t.state);
    });

    test("real preprod blocks through the tracker: 1.0.0 proposal registered and confirmed at slot 2163", () => {
        const genesis = preprodGenesis as unknown as ByronGenesisConfig;
        const t = ByronUpdateTracker.fromGenesis(preprodGenesis);
        expect(t.opts.numGenKeys).toBe(7);
        const delegation = new ByronObftState(genesis).delegationMap();
        for (const hex of (fixture.blocks as string[]).slice(1)) {
            const { rawBlock } = splitEraBlock(fromHex(hex));
            const [hdr, body] = (Cbor.parseLazy(rawBlock) as LazyCborArray).array as [Uint8Array, Uint8Array];
            const ev = t.applyRawMainBlock(hdr, body, delegation);
            expect(ev.filter((e) => e.type === "error")).toEqual([]);
        }
        expect(t.state.confirmedProposals.size).toBe(1);
        const [[upId, slot]] = [...t.state.confirmedProposals];
        expect(upId!.startsWith("561a907d9d31")).toBe(true);
        expect(slot).toBe(2163n);
        expect(t.state.registeredProtocolUpdateProposals.get(upId!)!.protocolVersion).toEqual(PV1);
        expect(t.state.appVersions.get("cardano-sl")).toMatchObject({ version: 1, slot: 2163n });
    });
});
