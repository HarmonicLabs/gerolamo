/**
 * Mithril MKTree (IntersectMBO mithril-merkle-tree + ckb-merkle-mountain-range).
 *
 * Stage 5g: recompute Cardano DB merkle_root from immutable digests artifact.
 *
 * Proven (2026-08 preprod tip e305-i6035):
 *   - golden MKTree leaves "golden-1"…"golden-5" → root
 *     3bbced153528697ecde7345a22e50115306478353619411523e804f2323fd921
 *   - digests.json BTreeMap order, leaf = UTF-8 of hex digest string (From<&str>)
 *     → published snapshot merkle_root
 *   - merge = Blake2s256(left || right)
 *   - bag_rhs_peaks = merge_peaks(right, left) = merge(right, left)
 *
 * Does NOT enter dual-run match gate (side-channel only).
 * WASM remains SoT until pureTsStmImplemented cutover.
 *
 * Source:
 *   - internal/mithril-merkle-tree/src/merkle_tree.rs
 *   - ckb-merkle-mountain-range 0.6.1 (push / get_root / bag_rhs_peaks)
 *   - mithril-client cardano_database_client/proving.rs (VerifiedDigests)
 */

import { createHash } from "crypto";

/** IntersectMBO golden_merkle_root leaves "golden-1"…"golden-5". */
export const MKTREE_GOLDEN_ROOT_HEX =
    "3bbced153528697ecde7345a22e50115306478353619411523e804f2323fd921";

export const MKTREE_GOLDEN_LEAVES = [
    "golden-1",
    "golden-2",
    "golden-3",
    "golden-4",
    "golden-5",
] as const;

export type ImmutableFileDigest = {
    immutable_file_name: string;
    digest: string;
};

export type ComputeMkTreeRootResult = {
    ok: boolean;
    rootHex: string | null;
    leafCount: number;
    mmrSize: number;
    reason: string;
};

export type VerifyCardanoDatabaseMerkleRootResult = {
    ok: boolean;
    computedRoot: string | null;
    expectedRoot: string | null;
    leafCount: number;
    mmrSize: number;
    reason: string;
};

const HEX64 = /^[0-9a-fA-F]{64}$/;
const IMM_NAME = /^(\d+)\.(chunk|primary|secondary)$/;

/** Blake2s-256 (mithril-merkle-tree MKTreeNode merge). */
export function blake2s256(...parts: Uint8Array[]): Uint8Array {
    const h = createHash("blake2s256");
    for (const p of parts) h.update(p);
    return new Uint8Array(h.digest());
}

function mergeNodes(left: Uint8Array, right: Uint8Array): Uint8Array {
    return blake2s256(left, right);
}

function toHex(u: Uint8Array): string {
    return Buffer.from(u).toString("hex");
}

/**
 * Leaf bytes for a hex-encoded digest string.
 * MKTreeNode::From<&str> / From<&String> = UTF-8 of the hex text (not decoded).
 */
export function mkTreeLeafFromHexDigestString(digestHex: string): Uint8Array {
    return new TextEncoder().encode(digestHex);
}

/** Leaf bytes for golden / free-form UTF-8 strings. */
export function mkTreeLeafFromUtf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/**
 * ckb get_peak_map(mmr_size) — peak bitmap for push merges.
 * Uses BigInt to match u64 bit ops exactly.
 */
export function getPeakMap(mmrSize: number | bigint): bigint {
    if (mmrSize === 0 || mmrSize === 0n) return 0n;
    const posU = BigInt(mmrSize);
    const bitLen = posU.toString(2).length;
    const leading = 64 - bitLen;
    let peakSizeB = 0xffff_ffff_ffff_ffffn >> BigInt(leading);
    let peakMap = 0n;
    let p = posU;
    while (peakSizeB > 0n) {
        peakMap <<= 1n;
        if (p >= peakSizeB) {
            p -= peakSizeB;
            peakMap |= 1n;
        }
        peakSizeB >>= 1n;
    }
    return peakMap;
}

/**
 * ckb get_peaks(mmr_size) — peak positions left→right.
 */
export function getPeaks(mmrSize: number | bigint): number[] {
    if (mmrSize === 0 || mmrSize === 0n) return [];
    const posU0 = BigInt(mmrSize);
    const bitLen = posU0.toString(2).length;
    const leading = 64 - bitLen;
    let pos = posU0;
    let peakSize = 0xffff_ffff_ffff_ffffn >> BigInt(leading);
    const peaks: number[] = [];
    let peaksSum = 0n;
    while (peakSize > 0n) {
        if (pos >= peakSize) {
            pos -= peakSize;
            peaks.push(Number(peaksSum + peakSize - 1n));
            peaksSum += peakSize;
        }
        peakSize >>= 1n;
    }
    return peaks;
}

/**
 * In-memory MMR matching ckb-merkle-mountain-range push + get_root.
 * Positions are dense u64 indices; values are node hash bytes.
 */
export class MkTreeMmr {
    mmrSize = 0;
    private store = new Map<number, Uint8Array>();

    push(elem: Uint8Array): number {
        const elems: Uint8Array[] = [elem];
        const elemPos = this.mmrSize;
        const peakMap = getPeakMap(this.mmrSize);
        let pos = this.mmrSize;
        let peak = 1n;
        while ((peakMap & peak) !== 0n) {
            peak <<= 1n;
            pos += 1;
            const leftPos = pos - Number(peak);
            const leftElem = this.findElem(leftPos, elems);
            const rightElem = elems[elems.length - 1]!;
            elems.push(mergeNodes(leftElem, rightElem));
        }
        for (let i = 0; i < elems.length; i++) {
            this.store.set(elemPos + i, elems[i]!);
        }
        this.mmrSize = pos + 1;
        return elemPos;
    }

    private findElem(pos: number, hashes: Uint8Array[]): Uint8Array {
        if (pos >= this.mmrSize) {
            const i = pos - this.mmrSize;
            if (i >= 0 && i < hashes.length) return hashes[i]!;
        }
        const e = this.store.get(pos);
        if (!e) throw new Error(`MkTreeMmr: missing elem at pos ${pos}`);
        return e;
    }

    getRoot(): Uint8Array {
        if (this.mmrSize === 0) {
            throw new Error("MkTreeMmr: get_root on empty");
        }
        if (this.mmrSize === 1) {
            const e = this.store.get(0);
            if (!e) throw new Error("MkTreeMmr: missing elem 0");
            return e;
        }
        const peaks = getPeaks(this.mmrSize).map((p) => {
            const e = this.store.get(p);
            if (!e) throw new Error(`MkTreeMmr: missing peak ${p}`);
            return e;
        });
        return bagRhsPeaks(peaks);
    }

    getRootHex(): string {
        return toHex(this.getRoot());
    }
}

/**
 * bag_rhs_peaks: while >1 peaks, pop right then left, push merge_peaks(right, left).
 * Default merge_peaks = merge(peak1, peak2) with peak1=right, peak2=left.
 */
export function bagRhsPeaks(rhsPeaks: Uint8Array[]): Uint8Array {
    const peaks = [...rhsPeaks];
    while (peaks.length > 1) {
        const right = peaks.pop()!;
        const left = peaks.pop()!;
        peaks.push(mergeNodes(right, left));
    }
    if (peaks.length !== 1) {
        throw new Error("bagRhsPeaks: empty peaks");
    }
    return peaks[0]!;
}

/**
 * Build MKTree from leaf node byte arrays (already Into<MKTreeNode> payload).
 */
export function computeMkTreeRootFromLeaves(
    leaves: Uint8Array[],
): ComputeMkTreeRootResult {
    if (leaves.length === 0) {
        return {
            ok: false,
            rootHex: null,
            leafCount: 0,
            mmrSize: 0,
            reason: "Stage 5g: no leaves for MKTree",
        };
    }
    try {
        const mmr = new MkTreeMmr();
        for (const leaf of leaves) {
            mmr.push(leaf);
        }
        const rootHex = mmr.getRootHex();
        return {
            ok: true,
            rootHex,
            leafCount: leaves.length,
            mmrSize: mmr.mmrSize,
            reason: `Stage 5g: MKTree root from ${leaves.length} leaves (mmr_size=${mmr.mmrSize})`,
        };
    } catch (e) {
        return {
            ok: false,
            rootHex: null,
            leafCount: leaves.length,
            mmrSize: 0,
            reason: `Stage 5g: MKTree build failed: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
}

/**
 * Golden vector from mithril-merkle-tree tests::golden_merkle_root.
 */
export function verifyMkTreeGoldenRoot(): ComputeMkTreeRootResult {
    const leaves = MKTREE_GOLDEN_LEAVES.map((s) => mkTreeLeafFromUtf8(s));
    const r = computeMkTreeRootFromLeaves(leaves);
    if (!r.ok || !r.rootHex) return r;
    if (r.rootHex !== MKTREE_GOLDEN_ROOT_HEX) {
        return {
            ...r,
            ok: false,
            reason: `Stage 5g golden mismatch: got ${r.rootHex}, want ${MKTREE_GOLDEN_ROOT_HEX}`,
        };
    }
    return {
        ...r,
        reason: "Stage 5g: golden_merkle_root OK",
    };
}

/**
 * Parse immutable file number from name like "06035.chunk".
 */
export function immutableFileNumberFromName(name: string): number | null {
    const m = IMM_NAME.exec(name);
    if (!m) return null;
    return Number(m[1]);
}

/**
 * Filter + sort digests like proving.rs VerifiedDigests:
 *   BTreeMap by immutable_file_name, keep number <= lastImmutableFileNumber.
 */
export function filterImmutableDigests(
    digests: ImmutableFileDigest[],
    lastImmutableFileNumber: number,
): ImmutableFileDigest[] {
    const filtered = digests.filter((d) => {
        const n = immutableFileNumberFromName(d.immutable_file_name);
        return n != null && n <= lastImmutableFileNumber;
    });
    filtered.sort((a, b) =>
        a.immutable_file_name < b.immutable_file_name
            ? -1
            : a.immutable_file_name > b.immutable_file_name
              ? 1
              : 0,
    );
    return filtered;
}

/**
 * Compute CDB merkle_root from digests artifact entries.
 * Leaves = UTF-8 of hex digest strings in BTreeMap filename order.
 */
export function computeCardanoDatabaseMerkleRootFromDigests(
    digests: ImmutableFileDigest[],
    lastImmutableFileNumber: number,
): ComputeMkTreeRootResult {
    const filtered = filterImmutableDigests(digests, lastImmutableFileNumber);
    if (filtered.length === 0) {
        return {
            ok: false,
            rootHex: null,
            leafCount: 0,
            mmrSize: 0,
            reason: `Stage 5g: no digests with imm# <= ${lastImmutableFileNumber}`,
        };
    }
    for (const d of filtered) {
        if (typeof d.digest !== "string" || !HEX64.test(d.digest)) {
            return {
                ok: false,
                rootHex: null,
                leafCount: filtered.length,
                mmrSize: 0,
                reason: `Stage 5g: bad digest hex for ${d.immutable_file_name}`,
            };
        }
    }
    const leaves = filtered.map((d) =>
        mkTreeLeafFromHexDigestString(d.digest.toLowerCase()),
    );
    // Note: spike used digest as-is (lowercase hex from artifact). toLowerCase is safe.
    const r = computeMkTreeRootFromLeaves(leaves);
    if (!r.ok) return r;
    return {
        ...r,
        reason: `Stage 5g: CDB merkle_root from ${filtered.length} digests (imm#<=${lastImmutableFileNumber})`,
    };
}

/**
 * Compare computed digests root to published snapshot merkle_root.
 */
export function verifyCardanoDatabaseMerkleRootFromDigests(
    digests: ImmutableFileDigest[],
    lastImmutableFileNumber: number,
    expectedMerkleRootHex: string,
): VerifyCardanoDatabaseMerkleRootResult {
    const expected = expectedMerkleRootHex.trim().toLowerCase();
    if (!HEX64.test(expected)) {
        return {
            ok: false,
            computedRoot: null,
            expectedRoot: expectedMerkleRootHex,
            leafCount: 0,
            mmrSize: 0,
            reason: "Stage 5g: expected merkle_root not 64-char hex",
        };
    }
    const computed = computeCardanoDatabaseMerkleRootFromDigests(
        digests,
        lastImmutableFileNumber,
    );
    if (!computed.ok || !computed.rootHex) {
        return {
            ok: false,
            computedRoot: computed.rootHex,
            expectedRoot: expected,
            leafCount: computed.leafCount,
            mmrSize: computed.mmrSize,
            reason: computed.reason,
        };
    }
    const got = computed.rootHex.toLowerCase();
    if (got !== expected) {
        return {
            ok: false,
            computedRoot: got,
            expectedRoot: expected,
            leafCount: computed.leafCount,
            mmrSize: computed.mmrSize,
            reason: `Stage 5g: merkle_root mismatch got=${got.slice(0, 16)}… want=${expected.slice(0, 16)}…`,
        };
    }
    return {
        ok: true,
        computedRoot: got,
        expectedRoot: expected,
        leafCount: computed.leafCount,
        mmrSize: computed.mmrSize,
        reason: `Stage 5g: digests merkle_root matches published (${computed.leafCount} leaves)`,
    };
}
