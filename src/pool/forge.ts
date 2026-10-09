/**
 * Praos block forging (block plan §3), Babbage/Conway header layout:
 *
 *   header      = [header_body, kes_signature (448)]
 *   header_body = [block_number, slot, prev_hash / null, issuer_vkey, vrf_vkey,
 *                  [vrf_output (64), vrf_proof (80)], block_body_size, block_body_hash,
 *                  [kes_vkey, counter, kes_period, cold_signature], [major, minor]]
 *   block       = [header, tx_bodies, tx_witness_sets, auxiliary_data_set, invalid_transactions]
 *   BlockFetch  = [era, block]            ChainSync RollForward data = [era − 1, #6.24(header)]
 *
 * Encoded with the node's own CBOR copy (never a ledger-ts CborObj across
 * library copies). The VRF proof is `vrf03Prove` over `praosVrfInput(slot, η0)`
 * — the value our header validator recomputes; the KES signature covers the
 * header_body bytes at evolution `slotKesPeriod − opcert.kesPeriod`.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborTag, CborUInt, LazyCborArray, LazyCborMap } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { vrf03ProofToHash, vrf03Prove } from "../consensus/fastVrf";
import { praosVrfInput } from "../consensus/vrfInputs";
import { evolveKesTo, kesPeriodOfSlot, kesSignAt, opcertToCborObj, type KesKey, type OpcertFields, type VrfKey } from "./keystore";

export interface HeaderBodyFields {
    /**
     * Dijkstra (ledger era 8) header bodies carry two more fields:
     * `block_body_contains_leios_cert` and `eb_references_announcement` (bug 425).
     * Gerolamo forges neither a Leios certificate nor an endorser block: false / null.
     */
    dijkstra?: boolean;
    blockNumber: bigint;
    slot: bigint;
    /** null for the first block after genesis. */
    prevHash: Uint8Array | null;
    /** Cold verification key (issuer). */
    issuerVkey: Uint8Array;
    vrfVkey: Uint8Array;
    vrfOutput: Uint8Array;
    vrfProof: Uint8Array;
    bodySize: number;
    bodyHash: Uint8Array;
    opcert: OpcertFields;
    protocolVersion: { major: number; minor: number };
}

const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

export function encodeHeaderBody(f: HeaderBodyFields): Uint8Array {
    if (f.issuerVkey.length !== 32 || f.vrfVkey.length !== 32 || f.bodyHash.length !== 32) throw new Error("header body: 32-byte keys/hash expected");
    if (f.vrfOutput.length !== 64 || f.vrfProof.length !== 80) throw new Error("header body: VRF output 64 / proof 80 bytes expected");
    if (f.prevHash && f.prevHash.length !== 32) throw new Error("header body: prev hash must be 32 bytes");
    const body = new CborArray([
        new CborUInt(f.blockNumber),
        new CborUInt(f.slot),
        f.prevHash ? new CborBytes(f.prevHash) : new CborSimple(null),
        new CborBytes(f.issuerVkey),
        new CborBytes(f.vrfVkey),
        new CborArray([new CborBytes(f.vrfOutput), new CborBytes(f.vrfProof)]),
        new CborUInt(BigInt(f.bodySize)),
        new CborBytes(f.bodyHash),
        opcertToCborObj(f.opcert),
        new CborArray([new CborUInt(BigInt(f.protocolVersion.major)), new CborUInt(BigInt(f.protocolVersion.minor))]),
        ...(f.dijkstra ? [new CborSimple(false), new CborSimple(null)] : []),
    ]);
    return Cbor.encode(body).toBuffer();
}

/** `[header_body, kes_signature]` with the body signed at the evolution the slot requires. */
export function signHeader(bodyBytes: Uint8Array, kes: KesKey, evolution: number): Uint8Array {
    evolveKesTo(kes, evolution);
    const sig = kesSignAt(kes, bodyBytes);
    return Cbor.encode(new CborArray([Cbor.parse(bodyBytes), new CborBytes(sig)])).toBuffer();
}

/** Header hash as ChainSync / BlockFetch identify the block. */
export function headerHash(headerBytes: Uint8Array): Uint8Array {
    return new Uint8Array(blake2b_256(headerBytes));
}

export interface VrfForSlot { output: Uint8Array; proof: Uint8Array }

export function vrfForSlot(vrf: VrfKey, slot: bigint, nonce: Uint8Array): VrfForSlot {
    const proof = vrf03Prove(vrf.skey.subarray(0, 32), vrf.vkey, praosVrfInput(slot, nonce));
    const output = vrf03ProofToHash(proof);
    if (!output) throw new Error("vrfForSlot: proof did not hash");
    return { output, proof };
}

/** Encoded body segments: tx bodies, witness sets, auxiliary data map, invalid transactions. */
export interface BodySegments {
    txBodies: Uint8Array;
    witnessSets: Uint8Array;
    auxiliaryData: Uint8Array;
    invalidTransactions: Uint8Array;
}

export const EMPTY_BODY: BodySegments = {
    txBodies: new Uint8Array([0x80]),
    witnessSets: new Uint8Array([0x80]),
    auxiliaryData: new Uint8Array([0xa0]),
    invalidTransactions: new Uint8Array([0x80]),
};

/** `block_body_size` (sum of the segment encodings) and `block_body_hash` (as bodyHash.ts verifies it). */
export function bodyCommitment(b: BodySegments): { size: number; hash: Uint8Array } {
    const segs = [b.txBodies, b.witnessSets, b.auxiliaryData, b.invalidTransactions];
    return {
        size: segs.reduce((n, s) => n + s.length, 0),
        hash: new Uint8Array(blake2b_256(concat(...segs.map((s) => new Uint8Array(blake2b_256(s)))))),
    };
}

export interface ForgeInput {
    era: number; // 6 Babbage, 7 Conway, 8 Dijkstra
    blockNumber: bigint;
    slot: bigint;
    prevHash: Uint8Array | null;
    nonce: Uint8Array;
    coldVkey: Uint8Array;
    vrf: VrfKey;
    kes: KesKey;
    opcert: OpcertFields;
    protocolVersion: { major: number; minor: number };
    slotsPerKESPeriod: bigint;
    body?: BodySegments;
}

export interface ForgedBlock {
    headerBytes: Uint8Array;
    headerHash: Uint8Array;
    /** `[era, block]` as BlockFetch serves it. */
    blockFetchBytes: Uint8Array;
    /** `[era − 1, #6.24(header)]` as ChainSync RollForward carries it. */
    rollForwardData: Uint8Array;
    vrf: VrfForSlot;
    kesEvolution: number;
}

const rawConcat = (parts: Uint8Array[]) => concat(...parts);

/** CBOR array header for `n` raw items: definite up to 23, indefinite above (cardano-binary `encodeFoldableEncoder`). */
function rawList(items: Uint8Array[]): Uint8Array {
    if (items.length <= 23) return rawConcat([new Uint8Array([0x80 | items.length]), ...items]);
    return rawConcat([new Uint8Array([0x9f]), ...items, new Uint8Array([0xff])]);
}

/**
 * Dijkstra `block_body = [[* block_transaction], leios_certificate / nil, peras_certificate / nil]`
 * from the Conway-style segments, every part copied as its original bytes:
 * `block_transaction = [body, witness_set, auxiliary_data / nil, is_valid]` (bug 425).
 */
export function dijkstraBlockBodyFromSegments(b: BodySegments): Uint8Array {
    const bodies = Cbor.parseLazy(b.txBodies);
    const wits = Cbor.parseLazy(b.witnessSets);
    if (!(bodies instanceof LazyCborArray) || !(wits instanceof LazyCborArray) || bodies.array.length !== wits.array.length) throw new Error("dijkstra body: tx bodies and witness sets differ in count");
    const aux = new Map<number, Uint8Array>();
    const auxMap = Cbor.parseLazy(b.auxiliaryData);
    // cbor 1.6's LazyCborMap keeps its entries under `array` (typed `map`)
    if (auxMap instanceof LazyCborMap) for (const e of ((auxMap as any).map ?? (auxMap as any).array ?? []) as Array<{ k: Uint8Array; v: Uint8Array }>) { const k = Cbor.parse(e.k); if (k instanceof CborUInt) aux.set(Number(k.num), e.v); }
    const invalid = new Set<number>();
    const inv = Cbor.parse(b.invalidTransactions);
    const invArr = inv instanceof CborTag ? inv.data : inv;
    if (invArr instanceof CborArray) for (const x of invArr.array) if (x instanceof CborUInt) invalid.add(Number(x.num));
    const txs = bodies.array.map((bodyBytes, i) => rawConcat([
        new Uint8Array([0x84]), bodyBytes, wits.array[i]!, aux.get(i) ?? new Uint8Array([0xf6]), new Uint8Array([invalid.has(i) ? 0xf4 : 0xf5]),
    ]));
    return rawConcat([new Uint8Array([0x83]), rawList(txs), new Uint8Array([0xf6, 0xf6])]);
}

/** Assemble, VRF-prove and KES-sign a block for `slot`. Pure apart from evolving the KES key forward. */
export function forgeBlock(input: ForgeInput): ForgedBlock {
    const body = input.body ?? EMPTY_BODY;
    // Dijkstra (era 8): the header commits to blake2b-256 of the whole block_body and its length
    const dijkstraBody = input.era >= 8 ? dijkstraBlockBodyFromSegments(body) : null;
    const { size, hash } = dijkstraBody ? { size: dijkstraBody.length, hash: new Uint8Array(blake2b_256(dijkstraBody)) } : bodyCommitment(body);
    const vrf = vrfForSlot(input.vrf, input.slot, input.nonce);
    const evolution = Number(kesPeriodOfSlot(input.slot, input.slotsPerKESPeriod) - input.opcert.kesPeriod);
    if (evolution < 0) throw new Error(`slot ${input.slot} is before the operational certificate's KES period ${input.opcert.kesPeriod}`);
    const bodyBytes = encodeHeaderBody({
        blockNumber: input.blockNumber, slot: input.slot, prevHash: input.prevHash,
        issuerVkey: input.coldVkey, vrfVkey: input.vrf.vkey, vrfOutput: vrf.output, vrfProof: vrf.proof,
        bodySize: size, bodyHash: hash, opcert: input.opcert, protocolVersion: input.protocolVersion, dijkstra: dijkstraBody != null,
    });
    const headerBytes = signHeader(bodyBytes, input.kes, evolution);
    const header = Cbor.parse(headerBytes);
    const blockFetchBytes = dijkstraBody
        // `[8, [header, block_body]]` built from raw bytes so the body hashes exactly as committed
        ? rawConcat([new Uint8Array([0x82]), Cbor.encode(new CborUInt(BigInt(input.era))).toBuffer(), new Uint8Array([0x82]), headerBytes, dijkstraBody])
        : Cbor.encode(new CborArray([new CborUInt(BigInt(input.era)), new CborArray([header, Cbor.parse(body.txBodies), Cbor.parse(body.witnessSets), Cbor.parse(body.auxiliaryData), Cbor.parse(body.invalidTransactions)])])).toBuffer();
    const rollForwardData = Cbor.encode(new CborArray([new CborUInt(BigInt(input.era - 1)), new CborTag(24, new CborBytes(headerBytes))])).toBuffer();
    return { headerBytes, headerHash: headerHash(headerBytes), blockFetchBytes, rollForwardData, vrf, kesEvolution: evolution };
}

// keep CborMap referenced for non-empty aux maps built by callers
export { CborMap };
