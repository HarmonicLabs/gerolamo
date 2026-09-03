import { Cbor, CborArray, CborBytes, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex, uint8ArrayEq } from "@harmoniclabs/uint8array-utils";
import { BYRON_EBB_ERA, BYRON_MAIN_ERA, isByronEra } from "./blockHeaderParser";

/**
 * Block body integrity: does the body we fetched match what the header commits to?
 *
 * This is pure hashing over the raw block bytes — no ledger state — so it runs
 * for every fetched block regardless of `bodyValidation`. A mismatch means the
 * BlockFetch peer served a body that the block producer never signed.
 *
 * Shelley+ (network CDDL, `block_body_hash`):
 *   Shelley…Mary : blake2b-256( h(tx_bodies) ‖ h(tx_witness_sets) ‖ h(auxiliary_data_set) )
 *   Alonzo+      : blake2b-256( h(tx_bodies) ‖ h(tx_witness_sets) ‖ h(auxiliary_data_set) ‖ h(invalid_transactions) )
 *   where each h(x) is blake2b-256 over x's raw CBOR bytes exactly as they appear in the block.
 *
 * Byron main block (`blockproof = [txProof, sscProof, dlgProof, updProof]`, cardano-ledger-byron):
 *   txProof  = [n, merkleRoot(txs), blake2b-256(0x9f ‖ witnesses… ‖ 0xff)]
 *   merkle   : leaf = h(0x00 ‖ tx), branch = h(0x01 ‖ l ‖ r), split at the largest power of two < n, empty = h("")
 *   dlgProof = blake2b-256(raw dlgPayload), updProof = blake2b-256(raw updPayload)
 *   sscProof = [3, blake2b-256(certificate map)] in the OBFT era; the certificate set is empty so this is h(0xa0).
 *              Pre-OBFT SSC variants (types 0–2) are not recomputed (logged as unchecked).
 * Byron EBB: bodyProof = blake2b-256(raw stakeholders list).
 *
 * All rules verified against live preprod (Byron epoch 0, Shelley slot 86400, Conway tip)
 * and mainnet Byron blocks with 1–5 transactions.
 */

export interface BodyHashResult {
    ok: boolean;
    era: number;
    expected: string;
    actual: string;
    /** Component-level detail for Byron, or a reason when not verifiable. */
    detail?: string;
    /** True when a component could not be recomputed (pre-OBFT SSC) but everything else matched. */
    partial?: boolean;
}

const EMPTY = new Uint8Array(0);

function concat(...parts: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function lazyArray(bytes: Uint8Array, what: string): LazyCborArray {
    const obj = Cbor.parseLazy(bytes);
    if (!(obj instanceof LazyCborArray)) {
        throw new Error(`bodyHash: ${what} is not a CBOR array`);
    }
    return obj;
}

/** Split `[era, block]` into era and the raw block bytes. */
export function splitEraBlock(blockData: Uint8Array): { era: number; rawBlock: Uint8Array } {
    const outer = lazyArray(blockData, "block wrapper");
    if (outer.array.length < 2) throw new Error("bodyHash: block wrapper too short");
    const eraObj = Cbor.parse(outer.array[0]!);
    if (!(eraObj instanceof CborUInt)) throw new Error("bodyHash: era not uint");
    return { era: Number(eraObj.num), rawBlock: outer.array[1]! };
}

// ───────────────────────────── Shelley+ ─────────────────────────────

/** Index of `block_body_hash` inside the header body array. */
function shelleyBodyHashIndex(era: number): number {
    // Shelley…Alonzo header_body is flat (nonce_vrf, leader_vrf, opcert fields inline): index 8.
    // Babbage+ collapses VRF into one field and nests opcert/protocol_version: index 7.
    return era >= 6 ? 7 : 8;
}

/** Read the header's body-hash commitment from raw header bytes `[header_body, kes_signature]`. */
export function shelleyHeaderBodyHash(era: number, rawHeader: Uint8Array): Uint8Array {
    const header = lazyArray(rawHeader, "shelley header");
    const body = Cbor.parse(header.array[0]!);
    if (!(body instanceof CborArray)) throw new Error("bodyHash: header_body not array");
    const item = body.array[shelleyBodyHashIndex(era)];
    if (!(item instanceof CborBytes) || item.bytes.length !== 32) {
        throw new Error("bodyHash: block_body_hash field missing");
    }
    return item.bytes;
}

/** Recompute `block_body_hash` from the raw block `[header, tx_bodies, tx_witness_sets, aux, (invalid)]`. */
export function computeShelleyBodyHash(era: number, rawBlock: Uint8Array): Uint8Array {
    const block = lazyArray(rawBlock, "shelley block");
    const parts = block.array;
    if (parts.length < 4) throw new Error("bodyHash: shelley block has fewer than 4 elements");
    const components = [parts[1]!, parts[2]!, parts[3]!];
    if (era >= 5) {
        // Alonzo+: invalid_transactions is the 5th element; an absent one hashes as an empty array.
        components.push(parts[4] ?? new Uint8Array([0x80]));
    }
    return blake2b_256(concat(...components.map((c) => blake2b_256(c))));
}

// ───────────────────────────── Byron ─────────────────────────────

const byronLeaf = (raw: Uint8Array) => blake2b_256(concat(new Uint8Array([0x00]), raw));
const byronBranch = (l: Uint8Array, r: Uint8Array) => blake2b_256(concat(new Uint8Array([0x01]), l, r));

/** Largest power of two strictly smaller than n (n ≥ 2). */
function powerOfTwoBelow(n: number): number {
    let p = 1;
    while (p * 2 < n) p *= 2;
    return p;
}

/** Byron Merkle root over raw tx encodings (cardano-ledger-byron `Cardano.Chain.Common.Merkle`). */
export function byronMerkleRoot(rawTxs: readonly Uint8Array[]): Uint8Array {
    if (rawTxs.length === 0) return blake2b_256(EMPTY);
    if (rawTxs.length === 1) return byronLeaf(rawTxs[0]!);
    const i = powerOfTwoBelow(rawTxs.length);
    return byronBranch(byronMerkleRoot(rawTxs.slice(0, i)), byronMerkleRoot(rawTxs.slice(i)));
}

export interface ByronTxProof {
    n: number;
    root: Uint8Array;
    witnessesHash: Uint8Array;
}

/** txProof from the raw `txPayload` (`[* [tx, [* witness]]]`). */
export function byronTxProof(rawTxPayload: Uint8Array): ByronTxProof {
    const payload = lazyArray(rawTxPayload, "byron txPayload");
    const txs: Uint8Array[] = [];
    const wits: Uint8Array[] = [];
    for (const aux of payload.array) {
        const pair = lazyArray(aux, "byron txAux");
        if (pair.array.length < 2) throw new Error("bodyHash: byron txAux malformed");
        txs.push(pair.array[0]!);
        wits.push(pair.array[1]!);
    }
    return {
        n: txs.length,
        root: byronMerkleRoot(txs),
        // recoverHashedBytes: indefinite-list marker, raw witness lists, break.
        witnessesHash: blake2b_256(concat(new Uint8Array([0x9f]), ...wits, new Uint8Array([0xff]))),
    };
}

const SSC_EMPTY_CERT_MAP_HASH = blake2b_256(new Uint8Array([0xa0]));

/**
 * Verify a Byron main block's header `blockproof` against its body.
 * rawHeader = `[magic, prevBlock, proof, consensus, extra]`, rawBody = `[txPayload, ssc, dlg, upd]`.
 */
export function verifyByronMainBodyProof(rawHeader: Uint8Array, rawBody: Uint8Array): BodyHashResult {
    const header = lazyArray(rawHeader, "byron header");
    const body = lazyArray(rawBody, "byron body");
    if (header.array.length < 5 || body.array.length < 4) {
        throw new Error("bodyHash: byron header/body too short");
    }
    const proof = Cbor.parse(header.array[2]!);
    if (!(proof instanceof CborArray) || proof.array.length < 4) {
        throw new Error("bodyHash: byron blockproof malformed");
    }
    const [txProofObj, sscProofObj, dlgProofObj, updProofObj] = proof.array;
    if (
        !(txProofObj instanceof CborArray) || txProofObj.array.length < 3 ||
        !(txProofObj.array[0] instanceof CborUInt) ||
        !(txProofObj.array[1] instanceof CborBytes) ||
        !(txProofObj.array[2] instanceof CborBytes) ||
        !(dlgProofObj instanceof CborBytes) || !(updProofObj instanceof CborBytes) ||
        !(sscProofObj instanceof CborArray) || sscProofObj.array.length < 2 ||
        !(sscProofObj.array[0] instanceof CborUInt) || !(sscProofObj.array[1] instanceof CborBytes)
    ) {
        throw new Error("bodyHash: byron blockproof fields malformed");
    }

    const [rawTx, rawSsc, rawDlg, rawUpd] = body.array as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const tx = byronTxProof(rawTx);
    const failures: string[] = [];
    if (Number(txProofObj.array[0].num) !== tx.n) failures.push(`txProof.n ${txProofObj.array[0].num}≠${tx.n}`);
    if (!uint8ArrayEq(txProofObj.array[1].bytes, tx.root)) failures.push("txProof.merkleRoot");
    if (!uint8ArrayEq(txProofObj.array[2].bytes, tx.witnessesHash)) failures.push("txProof.witnessesHash");
    if (!uint8ArrayEq(dlgProofObj.bytes, blake2b_256(rawDlg))) failures.push("dlgProof");
    if (!uint8ArrayEq(updProofObj.bytes, blake2b_256(rawUpd))) failures.push("updProof");

    let partial = false;
    const sscType = Number(sscProofObj.array[0].num);
    if (sscType === 3) {
        // CertificatesPayload: hash of the VSS certificate map. Empty set ⇒ h(0xa0).
        const ssc = lazyArray(rawSsc, "byron ssc");
        const certsRaw = ssc.array[1] ?? EMPTY;
        const certsEmpty = uint8ArrayEq(certsRaw, new Uint8Array([0xd9, 0x01, 0x02, 0x80])) ||
            uint8ArrayEq(certsRaw, new Uint8Array([0x80]));
        if (certsEmpty) {
            if (!uint8ArrayEq(sscProofObj.array[1].bytes, SSC_EMPTY_CERT_MAP_HASH)) failures.push("sscProof");
        } else {
            partial = true;
        }
    } else {
        partial = true; // pre-OBFT SSC payloads (commitments/openings/shares) are not recomputed
    }

    const expected = toHex(header.array[2]!);
    return {
        ok: failures.length === 0,
        era: BYRON_MAIN_ERA,
        expected,
        actual: failures.length === 0 ? expected : `mismatch: ${failures.join(", ")}`,
        detail: partial ? `sscProof type ${sscType} not recomputed` : undefined,
        partial,
    };
}

/** Byron EBB: `bodyProof` is the hash of the raw stakeholders list. */
export function verifyByronEbbBodyProof(rawHeader: Uint8Array, rawStakeholders: Uint8Array): BodyHashResult {
    const header = lazyArray(rawHeader, "byron ebb header");
    const proof = Cbor.parse(header.array[2]!);
    if (!(proof instanceof CborBytes)) throw new Error("bodyHash: ebb bodyProof not bytes");
    const actual = blake2b_256(rawStakeholders);
    return {
        ok: uint8ArrayEq(proof.bytes, actual),
        era: BYRON_EBB_ERA,
        expected: toHex(proof.bytes),
        actual: toHex(actual),
    };
}

// ───────────────────────────── entry point ─────────────────────────────

/**
 * Verify the body of a BlockFetch payload (`[era, block]`) against its own header.
 * Throws only on malformed CBOR; a hash mismatch is reported via `ok: false`.
 */
export function verifyBlockBodyHash(blockData: Uint8Array): BodyHashResult {
    const { era, rawBlock } = splitEraBlock(blockData);
    const block = lazyArray(rawBlock, "block");
    if (block.array.length < 2) throw new Error("bodyHash: block too short");
    const rawHeader = block.array[0]!;

    if (isByronEra(era)) {
        return era === BYRON_EBB_ERA
            ? verifyByronEbbBodyProof(rawHeader, block.array[1]!)
            : verifyByronMainBodyProof(rawHeader, block.array[1]!);
    }

    const expected = shelleyHeaderBodyHash(era, rawHeader);
    const actual = computeShelleyBodyHash(era, rawBlock);
    return {
        ok: uint8ArrayEq(expected, actual),
        era,
        expected: toHex(expected),
        actual: toHex(actual),
    };
}
