import {
    Cbor,
    CborArray,
    CborBytes,
    CborMap,
    CborNegInt,
    CborSimple,
    CborTag,
    CborText,
    CborUInt,
    LazyCborArray,
    type CborObj,
} from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { verifyEd25519Fast } from "../fastEd25519";
import { concatBytes, sliceByronMainHeader } from "./ByronCrypto";

/**
 * Byron update-system wire formats, byte-exact with cardano-ledger-byron
 * (`Cardano.Chain.Update.{Payload,Proposal,Vote,ProtocolParameters,
 * ProtocolParametersUpdate,ProtocolVersion,SoftwareVersion,SoftforkRule}`,
 * `Cardano.Chain.Common.{TxFeePolicy,TxSizeLinear,LovelacePortion}`):
 *
 *   Payload   = [ maybe(Proposal), [* Vote] ]              maybe(x) = [] / [x]
 *   Proposal  = [ pv, ppu, sv, metadata, {} , issuerXPub, sig ]
 *   Vote      = [ voterXPub, upId, bool, sig ]              (the bool is decoded and dropped)
 *   pv        = [ major u16, minor u16, alt u8 ]
 *   sv        = [ appName text, number u32 ]
 *   ppu       = [ 14 × maybe(field) ]  (same order as ProtocolParameters)
 *   pp        = [ scriptVersion u16, slotDuration, maxBlockSize, maxHeaderSize, maxTxSize,
 *                 maxProposalSize, mpcThd, heavyDelThd, updateVoteThd, updateProposalThd,
 *                 updateProposalTTL, softforkRule, txFeePolicy, unlockStakeEpoch ]
 *   softforkRule = [ initThd, minThd, thdDecrement ]        LovelacePortion = u64 ≤ 1e15
 *   txFeePolicy  = [ 0, #6.24(bytes .cbor [ summandNano, multiplierNano ]) ]
 *   metadata     = { systemTag text => InstallerHash [ bytes, hash32, bytes, bytes ] }
 *
 * UpId  = blake2b-256 of the whole Proposal encoding (`recoverUpId = hashDecoded`).
 * Signed bytes (`Cardano.Crypto.Signing.Tag`, network = cbor(protocolMagic)):
 *   proposal: 0x04 ‖ network ‖ 0x85 ‖ raw(pv ‖ ppu ‖ sv ‖ metadata ‖ attributes)
 *             (`recoverProposalSignedBytes` re-prepends the list-of-5 header)
 *   vote:     0x06 ‖ network ‖ 0x82 ‖ raw(upId) ‖ 0xf5
 *             (`recoverSignedBytes`: the decision bit is hard-coded True)
 *
 * Every function takes raw bytes and returns plain data; no CborObj leaves this module.
 */

// ───────────────────────────── types ─────────────────────────────

export interface ByronProtocolVersion {
    major: number;
    minor: number;
    alt: number;
}

export interface ByronSoftwareVersion {
    appName: string;
    number: number;
}

/**
 * `TxFeePolicyTxSizeLinear` in *nano-lovelace* (×1e9), the unit the genesis JSON and
 * byronTxRules use. The summand is always a whole number of lovelace (the Haskell type holds
 * `Lovelace`), the multiplier is exact (`Rational` = multiplier / 1e9).
 */
export interface ByronTxFeePolicy {
    summand: bigint;
    multiplier: bigint;
}

/** LovelacePortion numerators (denominator 1e15). */
export interface ByronSoftforkRule {
    initThd: bigint;
    minThd: bigint;
    thdDecrement: bigint;
}

export interface ByronProtocolParameters {
    scriptVersion: number;
    /** Milliseconds. */
    slotDuration: bigint;
    maxBlockSize: bigint;
    maxHeaderSize: bigint;
    maxTxSize: bigint;
    maxProposalSize: bigint;
    mpcThd: bigint;
    heavyDelThd: bigint;
    updateVoteThd: bigint;
    updateProposalThd: bigint;
    /** `ppUpdateProposalTTL` (genesis `updateImplicit`), in slots. */
    updateProposalTTL: bigint;
    softforkRule: ByronSoftforkRule;
    txFeePolicy: ByronTxFeePolicy;
    unlockStakeEpoch: bigint;
}

export type ByronProtocolParametersUpdate = Partial<ByronProtocolParameters>;

export const BYRON_PP_FIELDS = [
    "scriptVersion",
    "slotDuration",
    "maxBlockSize",
    "maxHeaderSize",
    "maxTxSize",
    "maxProposalSize",
    "mpcThd",
    "heavyDelThd",
    "updateVoteThd",
    "updateProposalThd",
    "updateProposalTTL",
    "softforkRule",
    "txFeePolicy",
    "unlockStakeEpoch",
] as const satisfies readonly (keyof ByronProtocolParameters)[];

export interface ByronProposal {
    protocolVersion: ByronProtocolVersion;
    ppUpdate: ByronProtocolParametersUpdate;
    softwareVersion: ByronSoftwareVersion;
    /** SystemTag → InstallerHash (hex). */
    metadata: Map<string, string>;
    /** 64-byte XPub of the proposer. */
    issuer: Uint8Array;
    signature: Uint8Array;
    /** The whole Proposal encoding (its length is the `ppMaxProposalSize` measure). */
    bytes: Uint8Array;
    /** raw(pv ‖ ppu ‖ sv ‖ metadata ‖ attributes): the annotated ProposalBody span. */
    bodyBytes: Uint8Array;
    /** blake2b-256(bytes), hex. */
    upId: string;
}

export interface ByronVote {
    voterVK: Uint8Array;
    /** UpId voted for, hex. */
    proposalId: string;
    /** The exact CBOR encoding of the UpId inside the vote (signed as is). */
    proposalIdRaw: Uint8Array;
    /** Decoded and ignored by the ledger (negative votes were removed). */
    decision: boolean;
    signature: Uint8Array;
    bytes: Uint8Array;
}

export interface ByronUpdatePayload {
    proposal: ByronProposal | null;
    votes: ByronVote[];
}

export interface ByronHeaderUpdateFields {
    epoch: bigint;
    slotInEpoch: bigint;
    /** Absolute slot (epoch · 10k + slotInEpoch). */
    slot: bigint;
    protocolVersion: ByronProtocolVersion;
    softwareVersion: ByronSoftwareVersion;
    /** `headerIssuer`: the delegate key of the block signature (the key that signed). */
    issuerXPub: Uint8Array;
    /** `headerGenesisKey`: consensusData pubkey. */
    genesisXPub: Uint8Array;
}

// ───────────────────────────── primitives ─────────────────────────────

export class ByronDecodeError extends Error {}

function fail(what: string): never {
    throw new ByronDecodeError(`byron update decode: ${what}`);
}

function lazyArray(bytes: Uint8Array, what: string, len?: number): Uint8Array[] {
    const a = Cbor.parseLazy(bytes);
    if (!(a instanceof LazyCborArray)) fail(`${what} is not an array`);
    if (len !== undefined && a.array.length !== len) fail(`${what}: expected ${len} elements, got ${a.array.length}`);
    return a.array;
}

function uintOf(o: CborObj, what: string, max?: bigint): bigint {
    let n: bigint;
    if (o instanceof CborUInt) n = o.num;
    else if (o instanceof CborTag && Number(o.tag) === 2 && o.data instanceof CborBytes) {
        n = 0n;
        for (const b of o.data.bytes) n = (n << 8n) | BigInt(b);
    } else fail(`${what} is not an unsigned integer`);
    if (max !== undefined && n > max) fail(`${what} out of range (${n} > ${max})`);
    return n;
}

function intOf(o: CborObj, what: string): bigint {
    if (o instanceof CborNegInt) return BigInt(o.num);
    if (o instanceof CborTag && Number(o.tag) === 3 && o.data instanceof CborBytes) {
        let n = 0n;
        for (const b of o.data.bytes) n = (n << 8n) | BigInt(b);
        return -1n - n;
    }
    return uintOf(o, what);
}

function bytesOf(o: CborObj, what: string, len?: number): Uint8Array {
    if (!(o instanceof CborBytes)) fail(`${what} is not a byte string`);
    const b = o.bytes;
    if (len !== undefined && b.length !== len) fail(`${what}: expected ${len} bytes, got ${b.length}`);
    return b;
}

function textOf(o: CborObj, what: string): string {
    if (!(o instanceof CborText)) fail(`${what} is not text`);
    return o.text;
}

function arrayOf(o: CborObj, what: string, len?: number): CborObj[] {
    if (!(o instanceof CborArray)) fail(`${what} is not an array`);
    if (len !== undefined && o.array.length !== len) fail(`${what}: expected ${len} elements, got ${o.array.length}`);
    return o.array;
}

const U8 = 0xffn;
const U16 = 0xffffn;
const U32 = 0xffff_ffffn;
const U64 = 0xffff_ffff_ffff_ffffn;
export const LOVELACE_PORTION_DENOMINATOR = 1_000_000_000_000_000n;
/** `maxLovelaceVal` (45e15): `mkLovelace` rejects anything larger. */
const MAX_LOVELACE = 45_000_000_000_000_000n;
const NANO = 1_000_000_000n;

function lovelacePortionOf(o: CborObj, what: string): bigint {
    const n = uintOf(o, what, U64);
    if (n > LOVELACE_PORTION_DENOMINATOR) fail(`${what}: LovelacePortion out of bounds [0..1e15]`);
    return n;
}

export function decodeProtocolVersionObj(o: CborObj): ByronProtocolVersion {
    const a = arrayOf(o, "ProtocolVersion", 3);
    return {
        major: Number(uintOf(a[0]!, "pvMajor", U16)),
        minor: Number(uintOf(a[1]!, "pvMinor", U16)),
        alt: Number(uintOf(a[2]!, "pvAlt", U8)),
    };
}

export function decodeSoftwareVersionObj(o: CborObj): ByronSoftwareVersion {
    const a = arrayOf(o, "SoftwareVersion", 2);
    return { appName: textOf(a[0]!, "ApplicationName"), number: Number(uintOf(a[1]!, "NumSoftwareVersion", U32)) };
}

function decodeSoftforkRuleObj(o: CborObj): ByronSoftforkRule {
    const a = arrayOf(o, "SoftforkRule", 3);
    return {
        initThd: lovelacePortionOf(a[0]!, "srInitThd"),
        minThd: lovelacePortionOf(a[1]!, "srMinThd"),
        thdDecrement: lovelacePortionOf(a[2]!, "srThdDecrement"),
    };
}

/** Haskell `round` (half to even) of n / 1e9, for the `Nano` → `Lovelace` summand. */
function roundHalfEvenNano(n: bigint): bigint {
    const neg = n < 0n;
    const a = neg ? -n : n;
    let q = a / NANO;
    const r = a % NANO;
    if (r * 2n > NANO || (r * 2n === NANO && q % 2n === 1n)) q += 1n;
    return neg ? -q : q;
}

function decodeTxFeePolicyObj(o: CborObj): ByronTxFeePolicy {
    const a = arrayOf(o, "TxFeePolicy", 2);
    const tag = uintOf(a[0]!, "TxFeePolicy tag", U8);
    if (tag !== 0n) fail(`TxFeePolicy: unknown tag ${tag}`);
    const t = a[1]!;
    if (!(t instanceof CborTag) || Number(t.tag) !== 24) fail("TxFeePolicy: expected #6.24 known CBOR data item");
    const inner = arrayOf(Cbor.parse(bytesOf(t.data, "TxSizeLinear bytes")), "TxSizeLinear", 2);
    // `decCBOR @Nano` = Fixed E9 over Integer; summand = mkLovelace (round nano), multiplier = toRational nano.
    const summandLovelace = roundHalfEvenNano(intOf(inner[0]!, "TxSizeLinear summand"));
    if (summandLovelace < 0n || summandLovelace > MAX_LOVELACE) fail(`TxSizeLinear summand ${summandLovelace} is not a valid Lovelace`);
    return { summand: summandLovelace * NANO, multiplier: intOf(inner[1]!, "TxSizeLinear multiplier") };
}

type FieldDecoder = (o: CborObj) => unknown;
const natural = (what: string): FieldDecoder => (o) => uintOf(o, what);
const FIELD_DECODERS: Record<(typeof BYRON_PP_FIELDS)[number], FieldDecoder> = {
    scriptVersion: (o) => Number(uintOf(o, "scriptVersion", U16)),
    slotDuration: natural("slotDuration"),
    maxBlockSize: natural("maxBlockSize"),
    maxHeaderSize: natural("maxHeaderSize"),
    maxTxSize: natural("maxTxSize"),
    maxProposalSize: natural("maxProposalSize"),
    mpcThd: (o) => lovelacePortionOf(o, "mpcThd"),
    heavyDelThd: (o) => lovelacePortionOf(o, "heavyDelThd"),
    updateVoteThd: (o) => lovelacePortionOf(o, "updateVoteThd"),
    updateProposalThd: (o) => lovelacePortionOf(o, "updateProposalThd"),
    updateProposalTTL: (o) => uintOf(o, "updateProposalTTL", U64),
    softforkRule: decodeSoftforkRuleObj,
    txFeePolicy: decodeTxFeePolicyObj,
    unlockStakeEpoch: (o) => uintOf(o, "unlockStakeEpoch", U64),
};

export function decodeProtocolParametersObj(o: CborObj): ByronProtocolParameters {
    const a = arrayOf(o, "ProtocolParameters", 14);
    const out: Record<string, unknown> = {};
    BYRON_PP_FIELDS.forEach((f, i) => (out[f] = FIELD_DECODERS[f](a[i]!)));
    return out as unknown as ByronProtocolParameters;
}

export function decodeProtocolParametersUpdateObj(o: CborObj): ByronProtocolParametersUpdate {
    const a = arrayOf(o, "ProtocolParametersUpdate", 14);
    const out: Record<string, unknown> = {};
    BYRON_PP_FIELDS.forEach((f, i) => {
        // Byron `Maybe` = definite list of 0 or 1 element (`decodeMaybe`).
        const m = arrayOf(a[i]!, `ppu.${f} (Maybe)`);
        if (m.length > 1) fail(`ppu.${f}: Maybe list of length ${m.length}`);
        if (m.length === 1) out[f] = FIELD_DECODERS[f](m[0]!);
    });
    return out as ByronProtocolParametersUpdate;
}

export function decodeProtocolParameters(bytes: Uint8Array): ByronProtocolParameters {
    return decodeProtocolParametersObj(Cbor.parse(bytes));
}

export function decodeProtocolParametersUpdate(bytes: Uint8Array): ByronProtocolParametersUpdate {
    return decodeProtocolParametersUpdateObj(Cbor.parse(bytes));
}

function decodeMetadataObj(o: CborObj): Map<string, string> {
    if (!(o instanceof CborMap)) fail("proposal metadata is not a map");
    const out = new Map<string, string>();
    for (const { k, v } of o.map) {
        const tag = textOf(k, "SystemTag");
        const ih = arrayOf(v, "InstallerHash", 4);
        bytesOf(ih[0]!, "InstallerHash[0]");
        const h = bytesOf(ih[1]!, "InstallerHash hash", 32);
        bytesOf(ih[2]!, "InstallerHash[2]");
        bytesOf(ih[3]!, "InstallerHash[3]");
        out.set(tag, toHex(h));
    }
    return out;
}

// ───────────────────────────── payload ─────────────────────────────

export function decodeByronProposal(bytes: Uint8Array): ByronProposal {
    const f = lazyArray(bytes, "Proposal", 7);
    const protocolVersion = decodeProtocolVersionObj(Cbor.parse(f[0]!));
    const ppUpdate = decodeProtocolParametersUpdateObj(Cbor.parse(f[1]!));
    const softwareVersion = decodeSoftwareVersionObj(Cbor.parse(f[2]!));
    const metadata = decodeMetadataObj(Cbor.parse(f[3]!));
    // `dropEmptyAttributes`: the attributes map must be empty.
    const attrs = Cbor.parse(f[4]!);
    if (!(attrs instanceof CborMap) || attrs.map.length !== 0) fail("proposal attributes are not an empty map");
    const issuer = bytesOf(Cbor.parse(f[5]!), "proposal issuer", 64);
    const signature = bytesOf(Cbor.parse(f[6]!), "proposal signature", 64);
    return {
        protocolVersion,
        ppUpdate,
        softwareVersion,
        metadata,
        issuer,
        signature,
        bytes,
        bodyBytes: concatBytes(f[0]!, f[1]!, f[2]!, f[3]!, f[4]!),
        upId: toHex(new Uint8Array(blake2b_256(bytes))),
    };
}

export function decodeByronVote(bytes: Uint8Array): ByronVote {
    const f = lazyArray(bytes, "Vote", 4);
    const voterVK = bytesOf(Cbor.parse(f[0]!), "voter key", 64);
    const upId = bytesOf(Cbor.parse(f[1]!), "vote UpId", 32);
    const d = Cbor.parse(f[2]!);
    if (!(d instanceof CborSimple) || typeof d.simple !== "boolean") fail("vote decision is not a bool");
    const signature = bytesOf(Cbor.parse(f[3]!), "vote signature", 64);
    return { voterVK, proposalId: toHex(upId), proposalIdRaw: f[1]!, decision: d.simple, signature, bytes };
}

/** Decode the Byron main-body `upd` element. */
export function decodeByronUpdatePayload(bytes: Uint8Array): ByronUpdatePayload {
    const [maybeProposal, votesRaw] = lazyArray(bytes, "Update.Payload", 2) as [Uint8Array, Uint8Array];
    const m = lazyArray(maybeProposal, "Maybe Proposal");
    if (m.length > 1) fail(`Maybe Proposal of length ${m.length}`);
    const proposal = m.length === 1 ? decodeByronProposal(m[0]!) : null;
    const votes = lazyArray(votesRaw, "votes").map(decodeByronVote);
    return { proposal, votes };
}

/** `upd` slice of a raw Byron main body `[txPayload, ssc, dlg, upd]`. */
export function byronUpdatePayloadOfBody(rawBody: Uint8Array): Uint8Array {
    const body = lazyArray(rawBody, "Byron main body");
    if (body.length < 4) fail("Byron main body has fewer than 4 elements");
    return body[3]!;
}

/** Header fields the update interface needs (`headerProtocolVersion`, `headerIssuer`, slot). */
export function decodeByronHeaderUpdateFields(rawHeader: Uint8Array, epochSlots: bigint): ByronHeaderUpdateFields {
    const h = lazyArray(rawHeader, "Byron header");
    if (h.length < 5) fail("Byron header has fewer than 5 elements");
    const consensus = lazyArray(h[3]!, "consensus data");
    const slotId = arrayOf(Cbor.parse(consensus[0]!), "SlotId", 2);
    const epoch = uintOf(slotId[0]!, "epoch", U64);
    const slotInEpoch = uintOf(slotId[1]!, "slot", U16);
    const extra = lazyArray(h[4]!, "extra data");
    if (extra.length < 2) fail("header extra data has fewer than 2 elements");
    const s = sliceByronMainHeader(rawHeader);
    // `headerIssuer = delegateVK cert` (heavyweight delegation); type-0 signatures sign with the header key.
    const issuerXPub = s.blockSig.cert ? s.blockSig.cert.delegateXPub : s.headerPubKey;
    return {
        epoch,
        slotInEpoch,
        slot: epoch * epochSlots + slotInEpoch,
        protocolVersion: decodeProtocolVersionObj(Cbor.parse(extra[0]!)),
        softwareVersion: decodeSoftwareVersionObj(Cbor.parse(extra[1]!)),
        issuerXPub,
        genesisXPub: s.headerPubKey,
    };
}

// ───────────────────────────── signatures ─────────────────────────────

function network(protocolMagic: number): Uint8Array {
    return Cbor.encode(new CborUInt(BigInt(protocolMagic))).toBuffer();
}

export function signTagUSProposal(protocolMagic: number): Uint8Array {
    return concatBytes(new Uint8Array([0x04]), network(protocolMagic));
}

export function signTagUSVote(protocolMagic: number): Uint8Array {
    return concatBytes(new Uint8Array([0x06]), network(protocolMagic));
}

/** The message the proposer signed (`SignUSProposal` tag ‖ `recoverProposalSignedBytes`). */
export function proposalSignedMessage(p: Pick<ByronProposal, "bodyBytes">, protocolMagic: number): Uint8Array {
    return concatBytes(signTagUSProposal(protocolMagic), new Uint8Array([0x85]), p.bodyBytes);
}

/** The message the voter signed (`SignUSVote` tag ‖ `recoverSignedBytes`). */
export function voteSignedMessage(v: Pick<ByronVote, "proposalIdRaw">, protocolMagic: number): Uint8Array {
    return concatBytes(signTagUSVote(protocolMagic), new Uint8Array([0x82]), v.proposalIdRaw, new Uint8Array([0xf5]));
}

export function verifyProposalSignature(p: ByronProposal, protocolMagic: number): boolean {
    return verifyEd25519Fast(p.signature, proposalSignedMessage(p, protocolMagic), p.issuer.subarray(0, 32));
}

export function verifyVoteSignature(v: ByronVote, protocolMagic: number): boolean {
    return verifyEd25519Fast(v.signature, voteSignedMessage(v, protocolMagic), v.voterVK.subarray(0, 32));
}

// ───────────────────────────── genesis ─────────────────────────────

/**
 * `Genesis.configProtocolParameters` from the genesis JSON `blockVersionData`
 * (`FromJSON ProtocolParameters`: `updateImplicit` is the TTL; the fee summand is
 * `div` 1e9 into Lovelace and the multiplier `% 1e9`).
 */
export function byronProtocolParametersFromGenesis(bvd: any): ByronProtocolParameters {
    const n = (v: unknown, what: string): bigint => {
        if (v === undefined || v === null) throw new Error(`byron genesis blockVersionData.${what} missing`);
        return BigInt(String(v));
    };
    const summandLovelace = n(bvd?.txFeePolicy?.summand, "txFeePolicy.summand") / NANO;
    return {
        scriptVersion: Number(n(bvd?.scriptVersion, "scriptVersion")),
        slotDuration: n(bvd?.slotDuration, "slotDuration"),
        maxBlockSize: n(bvd?.maxBlockSize, "maxBlockSize"),
        maxHeaderSize: n(bvd?.maxHeaderSize, "maxHeaderSize"),
        maxTxSize: n(bvd?.maxTxSize, "maxTxSize"),
        maxProposalSize: n(bvd?.maxProposalSize, "maxProposalSize"),
        mpcThd: n(bvd?.mpcThd, "mpcThd"),
        heavyDelThd: n(bvd?.heavyDelThd, "heavyDelThd"),
        updateVoteThd: n(bvd?.updateVoteThd, "updateVoteThd"),
        updateProposalThd: n(bvd?.updateProposalThd, "updateProposalThd"),
        updateProposalTTL: n(bvd?.updateImplicit, "updateImplicit"),
        softforkRule: {
            initThd: n(bvd?.softforkRule?.initThd, "softforkRule.initThd"),
            minThd: n(bvd?.softforkRule?.minThd, "softforkRule.minThd"),
            thdDecrement: n(bvd?.softforkRule?.thdDecrement, "softforkRule.thdDecrement"),
        },
        txFeePolicy: { summand: summandLovelace * NANO, multiplier: n(bvd?.txFeePolicy?.multiplier, "txFeePolicy.multiplier") },
        unlockStakeEpoch: n(bvd?.unlockStakeEpoch, "unlockStakeEpoch"),
    };
}
