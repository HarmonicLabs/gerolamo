import { describe, expect, test } from "bun:test";
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import {
    byronMerkleRoot,
    byronTxProof,
    computeShelleyBodyHash,
    shelleyHeaderBodyHash,
    splitEraBlock,
    verifyBlockBodyHash,
} from "./bodyHash";
import byron from "./__fixtures__/byron-preprod.json";
import shelleyConway from "./__fixtures__/shelley-conway-preprod.json";

const byronBlocks = byron.blocks as string[];
const blocks = shelleyConway.blocks as Record<string, string>;

function rawHeaderOf(blockData: Uint8Array): Uint8Array {
    const { rawBlock } = splitEraBlock(blockData);
    const arr = Cbor.parseLazy(rawBlock);
    if (!(arr instanceof LazyCborArray)) throw new Error("not an array");
    return arr.array[0]!;
}

function cat(...parts: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
}

describe("Shelley+ block_body_hash", () => {
    test("first preprod Shelley block (slot 86400) body matches header commitment", () => {
        const r = verifyBlockBodyHash(fromHex(blocks.shelley_86400!));
        expect(r.era).toBe(2);
        expect(r.ok).toBe(true);
        expect(r.expected).toBe(r.actual);
    });

    test("Conway-era tip block body matches header commitment (4-component hash)", () => {
        const r = verifyBlockBodyHash(fromHex(blocks.tip!));
        expect(r.era).toBe(7);
        expect(r.ok).toBe(true);
    });

    test("tampering with body bytes changes the recomputed hash", () => {
        const { era, rawBlock } = splitEraBlock(fromHex(blocks.tip!));
        const good = computeShelleyBodyHash(era, rawBlock);
        // The tip block is empty ([hdr, [], [], {}, []]), so flip the first byte
        // after the header: that is the tx_bodies element.
        const headerLen = rawHeaderOf(fromHex(blocks.tip!)).length;
        const tampered = rawBlock.slice();
        const idx = 1 + headerLen; // 1 = outer array(5) prefix
        tampered[idx] = tampered[idx]! ^ 0x01;
        let changed = true;
        try {
            changed = toHex(computeShelleyBodyHash(era, tampered)) !== toHex(good);
        } catch {
            changed = true; // structurally invalid CBOR is also a detected tamper
        }
        expect(changed).toBe(true);
        // Tampering the header alone must not affect the body hash.
        const hdrTampered = rawBlock.slice();
        hdrTampered[5] = hdrTampered[5]! ^ 0x01;
        expect(toHex(computeShelleyBodyHash(era, hdrTampered))).toBe(toHex(good));
    });

    test("header commitment is read from index 8 (Shelley) and 7 (Babbage+)", () => {
        const s = fromHex(blocks.shelley_86400!);
        const c = fromHex(blocks.tip!);
        const sHash = shelleyHeaderBodyHash(2, rawHeaderOf(s));
        const cHash = shelleyHeaderBodyHash(7, rawHeaderOf(c));
        expect(sHash.length).toBe(32);
        expect(cHash.length).toBe(32);
        expect(toHex(sHash)).toBe(toHex(computeShelleyBodyHash(2, splitEraBlock(s).rawBlock)));
        expect(toHex(cHash)).toBe(toHex(computeShelleyBodyHash(7, splitEraBlock(c).rawBlock)));
    });
});

describe("Byron body proofs", () => {
    test("EBB bodyProof = hash(stakeholders)", () => {
        const r = verifyBlockBodyHash(fromHex(byronBlocks[0]!));
        expect(r.era).toBe(0);
        expect(r.ok).toBe(true);
    });

    test("main blocks: txProof (n=0), dlgProof, updProof and OBFT sscProof all match", () => {
        for (const hex of byronBlocks.slice(1)) {
            const r = verifyBlockBodyHash(fromHex(hex));
            expect(r.era).toBe(1);
            expect(r.ok).toBe(true);
            expect(r.partial).toBe(false);
        }
    });

    test("empty Merkle tree is the hash of the empty string", () => {
        expect(toHex(byronMerkleRoot([]))).toBe(toHex(blake2b_256(new Uint8Array(0))));
    });

    test("Merkle tree splits at the largest power of two below n", () => {
        const leaf = (b: number) => new Uint8Array([b]);
        const L = (b: number) => blake2b_256(cat(new Uint8Array([0]), leaf(b)));
        const B = (l: Uint8Array, r: Uint8Array) => blake2b_256(cat(new Uint8Array([1]), l, r));
        // n = 3 → [2, 1]
        expect(toHex(byronMerkleRoot([0, 1, 2].map(leaf)))).toBe(toHex(B(B(L(0), L(1)), L(2))));
        // n = 5 → [4, 1]
        expect(toHex(byronMerkleRoot([0, 1, 2, 3, 4].map(leaf)))).toBe(
            toHex(B(B(B(L(0), L(1)), B(L(2), L(3))), L(4))),
        );
    });

    test("txProof of an empty payload", () => {
        const p = byronTxProof(new Uint8Array([0x80]));
        expect(p.n).toBe(0);
        expect(toHex(p.witnessesHash)).toBe(toHex(blake2b_256(new Uint8Array([0x9f, 0xff]))));
    });
});
