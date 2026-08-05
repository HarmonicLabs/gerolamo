/**
 * Phase 4 Stage 3–4 — pure-TS Merkle batch_proof validation.
 *
 * Stage 3 (structural):
 * - Validates batch_proof shape against AVK mt_commitment (sizes, indices, depth).
 *
 * Stage 4 (root path crypto — DONE for concatenation proof):
 * - Blake2b-256 batch path verify against AVK mt_commitment.root
 * - Source: IntersectMBO/mithril mithril-stm
 *   - ConcatenationHash = Blake2b<U32>
 *   - Leaf = VK(96B G2) || stake BE u64 (104B) → Blake2b-256
 *   - verify_leaves_membership_from_batch_path (commitment.rs)
 * - Proven on preprod golden cert (rootVerified=true).
 *
 * Still NOT full STM / cert-chain accept:
 * - verified === false always (no BLS multi-sig aggregate, no chain-to-genesis)
 *
 * See docs/phase-4-pure-ts-crypto-research.md
 */

import { createHash } from "crypto";

import type {
    PureTsAggregateVerificationKey,
    PureTsBatchProof,
    PureTsMultiSignature,
    PureTsMsSignatureEntry,
} from "./cert";

export type PureTsMerkleValidateResult = {
    /** Structural checks passed (sizes, indices, depth heuristics). */
    merkleStructOk: boolean;
    /**
     * Cryptographic path → root match (Stage 4).
     * True when Blake2b-256 batch path reconstructs AVK root.
     */
    rootVerified: boolean;
    /** Always false — not STM / cert-chain accept. */
    verified: false;
    reason: string;
    details: {
        nValues: number;
        valueByteLens: number[];
        indices: number[];
        nrLeaves: number | null;
        rootLen: number | null;
        expectedMinPathLen: number | null;
        hasher: unknown;
        /** True when root hex was compared to any value (none matched on golden). */
        anyValueEqualsRoot: boolean;
        /** Stage 4: reconstructed root hex when path walk completed. */
        computedRootHex: string | null;
        /** Stage 4: expected AVK root hex. */
        expectedRootHex: string | null;
        /** Stage 4: leaf hash hex used for the first index (debug). */
        leafHashHex: string | null;
        /** Stage 4 algorithm note. */
        hashAlgo: "blake2b256" | null;
    };
    errors: string[];
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function toHex(b: Uint8Array): string {
    return Buffer.from(b).toString("hex");
}

/** Blake2b-256 = IntersectMBO ConcatenationHash (Blake2b<U32>). */
export function blake2b256(...parts: Uint8Array[]): Uint8Array {
    const h = createHash("blake2b256");
    for (const p of parts) h.update(p);
    return new Uint8Array(h.digest());
}

/**
 * Typical single-leaf path depth for a complete binary tree covering `nrLeaves`.
 *
 * IntersectMBO batch proofs use the Octopus algorithm and can return *fewer*
 * sibling hashes than full tree depth (shared parents collapse). So this is
 * informational only — Stage 3 must NOT hard-fail on values.length < this.
 * Stage 4 `verifyMerkleBatchRoot` is the real membership check.
 *
 * floor(log2(nrLeaves)) matches observed preprod paths (e.g. nr=21 → 4).
 */
export function expectedMerklePathLen(nrLeaves: number): number {
    if (!Number.isFinite(nrLeaves) || nrLeaves <= 1) return 0;
    return Math.floor(Math.log2(nrLeaves));
}

/** Heap parent: nodes[(i-1)/2] owns nodes[i]. */
export function merkleParent(i: number): number {
    return Math.floor((i - 1) / 2);
}

/** Heap sibling of node i. */
export function merkleSibling(i: number): number {
    return i % 2 === 1 ? i + 1 : i - 1;
}

/**
 * Concatenation leaf bytes: VerificationKeyForConcatenation (96B G2) || Stake BE u64.
 * Source: MerkleTreeConcatenationLeaf::to_bytes (leaf.rs).
 */
export function concatenationLeafBytes(
    vkG2Compressed: Uint8Array,
    stake: bigint | number,
): Uint8Array {
    if (vkG2Compressed.length !== 96) {
        throw new Error(
            `concatenationLeafBytes: VK must be 96 bytes, got ${vkG2Compressed.length}`,
        );
    }
    const stakeBE = Buffer.alloc(8);
    const s = typeof stake === "bigint" ? stake : BigInt(stake);
    if (s < 0n || s > 0xffff_ffff_ffff_ffffn) {
        throw new Error(`concatenationLeafBytes: stake out of u64 range: ${s}`);
    }
    stakeBE.writeBigUInt64BE(s);
    const out = new Uint8Array(104);
    out.set(vkG2Compressed, 0);
    out.set(stakeBE, 96);
    return out;
}

/** Leaf node hash = Blake2b-256(leaf_bytes). */
export function concatenationLeafHash(
    vkG2Compressed: Uint8Array,
    stake: bigint | number,
): Uint8Array {
    return blake2b256(concatenationLeafBytes(vkG2Compressed, stake));
}

/**
 * Extract G2 VK (96B) + stake from a Stage-1 MS signature entry path.
 * Observed path: [ u8[96] G2, stakeNumber ].
 */
export function extractConcatenationLeafFromMsEntry(
    entry: PureTsMsSignatureEntry,
): { vk: Uint8Array; stake: bigint } | null {
    const path = entry.path;
    if (!Array.isArray(path) || path.length < 2) return null;

    // path[0] = G2 compressed as number[] (Stage 1 keeps raw path)
    const p0 = path[0];
    if (!Array.isArray(p0) || p0.length !== 96) return null;
    if (!p0.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 255)) {
        return null;
    }
    const vk = new Uint8Array(p0 as number[]);

    const p1 = path[1];
    let stake: bigint;
    if (typeof p1 === "number" && Number.isFinite(p1)) {
        stake = BigInt(Math.trunc(p1));
    } else if (typeof p1 === "bigint") {
        stake = p1;
    } else if (typeof p1 === "string" && /^-?\d+$/.test(p1)) {
        stake = BigInt(p1);
    } else {
        return null;
    }
    return { vk, stake };
}

export type MerkleBatchRootVerifyResult = {
    ok: boolean;
    reason: string;
    computedRoot: Uint8Array | null;
    expectedRoot: Uint8Array | null;
    leafHash: Uint8Array | null;
    remainingValues: number;
};

/**
 * Stage 4: verify MerkleBatchPath against MerkleTreeBatchCommitment.root.
 *
 * Port of IntersectMBO:
 *   MerkleTreeBatchCommitment::verify_leaves_membership_from_batch_path
 * Hash: Blake2b-256 (MithrilMembershipDigest::ConcatenationHash).
 *
 * Requires batch leaf material (VK||stake) for each proof index.
 * For golden preprod cert: single index, leaf from signatures[i].path = [G2, stake].
 */
export function verifyMerkleBatchRoot(args: {
    /** Blake2b-256 leaf hashes, parallel to proof.indices order. */
    leafHashes: Uint8Array[];
    proofValues: Uint8Array[];
    proofIndices: number[];
    nrLeaves: number;
    expectedRoot: Uint8Array;
}): MerkleBatchRootVerifyResult {
    const { leafHashes, proofValues, proofIndices, nrLeaves, expectedRoot } = args;

    if (leafHashes.length !== proofIndices.length) {
        return {
            ok: false,
            reason: `leafHashes.len ${leafHashes.length} !== indices.len ${proofIndices.length}`,
            computedRoot: null,
            expectedRoot,
            leafHash: leafHashes[0] ?? null,
            remainingValues: proofValues.length,
        };
    }
    if (proofIndices.length === 0) {
        return {
            ok: false,
            reason: "empty indices",
            computedRoot: null,
            expectedRoot,
            leafHash: null,
            remainingValues: proofValues.length,
        };
    }
    if (expectedRoot.length !== 32) {
        return {
            ok: false,
            reason: `expectedRoot length ${expectedRoot.length} (want 32)`,
            computedRoot: null,
            expectedRoot,
            leafHash: leafHashes[0] ?? null,
            remainingValues: proofValues.length,
        };
    }

    // Indices must already be sorted (IntersectMBO rejects unsorted)
    const sorted = [...proofIndices].sort((a, b) => a - b);
    if (sorted.join(",") !== proofIndices.join(",")) {
        return {
            ok: false,
            reason: "proof.indices not sorted",
            computedRoot: null,
            expectedRoot,
            leafHash: leafHashes[0] ?? null,
            remainingValues: proofValues.length,
        };
    }

    for (const idx of proofIndices) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= nrLeaves) {
            return {
                ok: false,
                reason: `index ${idx} out of range for nrLeaves=${nrLeaves}`,
                computedRoot: null,
                expectedRoot,
                leafHash: leafHashes[0] ?? null,
                remainingValues: proofValues.length,
            };
        }
    }

    // next_power_of_two(nr_leaves)
    const nrPow2 =
        nrLeaves <= 1 ? 1 : 1 << Math.ceil(Math.log2(nrLeaves));
    const nrNodes = nrPow2 + nrLeaves - 1;

    // Map leaf indices → heap positions: nr_pow2 + i - 1
    let orderedIndices = proofIndices.map((i) => nrPow2 + i - 1);

    let leaves: Uint8Array[] = leafHashes.map((h) => new Uint8Array(h));
    const values: Uint8Array[] = proofValues.map((v) => new Uint8Array(v));
    let valueCursor = 0;

    const takeValue = (): Uint8Array | null => {
        if (valueCursor >= values.length) return null;
        return values[valueCursor++];
    };

    let idx = orderedIndices[0];
    while (idx > 0) {
        const newHashes: Uint8Array[] = [];
        const newIndices: number[] = [];
        let i = 0;
        idx = merkleParent(idx);

        while (i < orderedIndices.length) {
            newIndices.push(merkleParent(orderedIndices[i]));

            if ((orderedIndices[i] & 1) === 0) {
                // even: left sibling from proof values, then this leaf
                const left = takeValue();
                if (!left) {
                    return {
                        ok: false,
                        reason: `values exhausted at even node (i=${i})`,
                        computedRoot: null,
                        expectedRoot,
                        leafHash: leafHashes[0] ?? null,
                        remainingValues: values.length - valueCursor,
                    };
                }
                newHashes.push(blake2b256(left, leaves[i]));
            } else {
                const sib = merkleSibling(orderedIndices[i]);
                if (
                    i < orderedIndices.length - 1 &&
                    orderedIndices[i + 1] === sib
                ) {
                    // next leaf in batch is the sibling
                    newHashes.push(blake2b256(leaves[i], leaves[i + 1]));
                    i += 1;
                } else if (sib < nrNodes) {
                    const right = takeValue();
                    if (!right) {
                        return {
                            ok: false,
                            reason: `values exhausted at odd node (i=${i})`,
                            computedRoot: null,
                            expectedRoot,
                            leafHash: leafHashes[0] ?? null,
                            remainingValues: values.length - valueCursor,
                        };
                    }
                    newHashes.push(blake2b256(leaves[i], right));
                } else {
                    // missing right child → hash with digest([0u8])
                    const z = blake2b256(new Uint8Array([0]));
                    newHashes.push(blake2b256(leaves[i], z));
                }
            }
            i += 1;
        }

        leaves = newHashes;
        orderedIndices = newIndices;
    }

    if (leaves.length !== 1) {
        return {
            ok: false,
            reason: `expected single root hash, got ${leaves.length}`,
            computedRoot: null,
            expectedRoot,
            leafHash: leafHashes[0] ?? null,
            remainingValues: values.length - valueCursor,
        };
    }

    const computedRoot = leaves[0];
    const ok = bytesEqual(computedRoot, expectedRoot);
    return {
        ok,
        reason: ok
            ? "Stage 4 rootVerified — Blake2b-256 batch path matches AVK root"
            : `Stage 4 root mismatch: got ${toHex(computedRoot)} want ${toHex(expectedRoot)}`,
        computedRoot,
        expectedRoot,
        leafHash: leafHashes[0] ?? null,
        remainingValues: values.length - valueCursor,
    };
}

/**
 * Build leaf hashes for each batch_proof index from MS signature entries.
 * Matches entry.leaf.signer_index to proof index (preprod golden: 1:1).
 */
export function leafHashesFromMultiSignature(
    ms: PureTsMultiSignature,
    proofIndices: number[],
): { hashes: Uint8Array[]; errors: string[] } {
    const errors: string[] = [];
    const bySigner = new Map<number, PureTsMsSignatureEntry>();
    for (const e of ms.signatures) {
        bySigner.set(e.leaf.signer_index, e);
    }

    const hashes: Uint8Array[] = [];
    for (const idx of proofIndices) {
        const entry = bySigner.get(idx);
        if (!entry) {
            errors.push(
                `no multi_signature entry with signer_index=${idx} for batch index`,
            );
            continue;
        }
        const leaf = extractConcatenationLeafFromMsEntry(entry);
        if (!leaf) {
            errors.push(
                `signer_index=${idx}: cannot extract VK(96)||stake from path`,
            );
            continue;
        }
        try {
            hashes.push(concatenationLeafHash(leaf.vk, leaf.stake));
        } catch (e) {
            errors.push(
                e instanceof Error ? e.message : `signer_index=${idx}: ${String(e)}`,
            );
        }
    }
    return { hashes, errors };
}

/**
 * Structural validation of multi_signature.batch_proof vs AVK commitment.
 * Does not set rootVerified (use verifyBatchProofWithRoot for Stage 4).
 */
export function validateBatchProofStructural(
    ms: PureTsMultiSignature,
    avk: PureTsAggregateVerificationKey | null,
): PureTsMerkleValidateResult {
    const errors: string[] = [];
    const bp: PureTsBatchProof = ms.batch_proof;
    const nValues = bp.values.length;
    const valueByteLens = bp.values.map((v) => v.length);
    const indices = bp.indices.slice();

    let nrLeaves: number | null = null;
    let rootLen: number | null = null;
    let expectedMinPathLen: number | null = null;
    let anyValueEqualsRoot = false;
    let root: Uint8Array | null = null;

    if (!avk) {
        errors.push("avk missing — cannot cross-check nr_leaves / root");
    } else {
        nrLeaves = avk.mt_commitment.nr_leaves;
        root = avk.mt_commitment.root;
        rootLen = root.length;
        if (rootLen !== 32) {
            errors.push(`avk.mt_commitment.root length ${rootLen} (want 32)`);
        }
        if (typeof nrLeaves !== "number" || nrLeaves <= 0) {
            errors.push(`avk.mt_commitment.nr_leaves invalid: ${String(nrLeaves)}`);
        } else {
            expectedMinPathLen = expectedMerklePathLen(nrLeaves);
        }
    }

    if (nValues === 0) {
        errors.push("batch_proof.values empty");
    }

    for (let i = 0; i < bp.values.length; i++) {
        const len = bp.values[i].length;
        if (len !== 32) {
            errors.push(`batch_proof.values[${i}] length ${len} (want 32)`);
        }
        if (root && bytesEqual(bp.values[i], root)) {
            anyValueEqualsRoot = true;
        }
    }

    if (!Array.isArray(bp.indices) || bp.indices.length === 0) {
        errors.push("batch_proof.indices empty");
    } else {
        for (let i = 0; i < bp.indices.length; i++) {
            const idx = bp.indices[i];
            if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
                errors.push(`batch_proof.indices[${i}] invalid: ${String(idx)}`);
                continue;
            }
            if (nrLeaves != null && idx >= nrLeaves) {
                errors.push(
                    `batch_proof.indices[${i}]=${idx} >= nr_leaves=${nrLeaves}`,
                );
            }
        }
    }

    // NOTE: Do NOT hard-fail when nValues < expectedMinPathLen.
    // Octopus batch paths can be shorter than full tree depth (ep296: 4 vs ceil-log2 5).
    // Stage 4 root verify is the membership gate.

    const merkleStructOk = errors.length === 0;
    const reason = merkleStructOk
        ? "Stage 3 merkleStruct OK — batch_proof sizes/indices pass; " +
          "run verifyBatchProofWithRoot for Stage 4 rootVerified"
        : `Stage 3 merkleStruct FAILED: ${errors.join("; ")}`;

    return {
        merkleStructOk,
        rootVerified: false,
        verified: false,
        reason,
        details: {
            nValues,
            valueByteLens,
            indices,
            nrLeaves,
            rootLen,
            expectedMinPathLen,
            hasher: bp.hasher ?? null,
            anyValueEqualsRoot,
            computedRootHex: null,
            expectedRootHex: root ? toHex(root) : null,
            leafHashHex: null,
            hashAlgo: null,
        },
        errors,
    };
}

/**
 * Stage 3 structural + Stage 4 root path verify.
 * rootVerified may be true; verified stays false (not full STM).
 */
export function verifyBatchProofWithRoot(
    ms: PureTsMultiSignature,
    avk: PureTsAggregateVerificationKey | null,
): PureTsMerkleValidateResult {
    const structural = validateBatchProofStructural(ms, avk);
    if (!structural.merkleStructOk || !avk) {
        return structural;
    }

    const nrLeaves = avk.mt_commitment.nr_leaves;
    const expectedRoot = avk.mt_commitment.root;
    const indices = ms.batch_proof.indices.slice();

    const { hashes, errors: leafErrs } = leafHashesFromMultiSignature(ms, indices);
    if (leafErrs.length > 0 || hashes.length !== indices.length) {
        return {
            ...structural,
            rootVerified: false,
            reason: `Stage 4 leaf extract FAILED: ${leafErrs.join("; ") || "hash count mismatch"}`,
            details: {
                ...structural.details,
                hashAlgo: "blake2b256",
                expectedRootHex: toHex(expectedRoot),
                leafHashHex: hashes[0] ? toHex(hashes[0]) : null,
            },
            errors: [...structural.errors, ...leafErrs],
        };
    }

    const rootResult = verifyMerkleBatchRoot({
        leafHashes: hashes,
        proofValues: ms.batch_proof.values,
        proofIndices: indices,
        nrLeaves,
        expectedRoot,
    });

    const rootVerified = rootResult.ok;
    const reason = rootVerified
        ? "Stage 4 rootVerified OK — Blake2b-256 batch path matches AVK root; " +
          "STM aggregate / cert-chain still NOT verified (verified=false)"
        : `Stage 4 rootVerified FAILED: ${rootResult.reason}`;

    return {
        merkleStructOk: true,
        rootVerified,
        verified: false,
        reason,
        details: {
            ...structural.details,
            computedRootHex: rootResult.computedRoot
                ? toHex(rootResult.computedRoot)
                : null,
            expectedRootHex: toHex(expectedRoot),
            leafHashHex: rootResult.leafHash ? toHex(rootResult.leafHash) : null,
            hashAlgo: "blake2b256",
        },
        errors: rootVerified ? [] : [rootResult.reason],
    };
}

/**
 * Golden / CI checks for Stage 3/4 merkle result.
 */
export function validateMerkleStructuralGolden(
    result: PureTsMerkleValidateResult,
    expect: {
        nValues?: number;
        nrLeaves?: number;
        indices?: number[];
        requireStructOk?: boolean;
        /** When true, require rootVerified===true (Stage 4 golden). */
        requireRootVerified?: boolean;
        /** When true (default if requireRootVerified unset), require rootVerified===false. */
        rootVerifiedMustBeFalse?: boolean;
    } = {},
): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (expect.requireStructOk !== false && !result.merkleStructOk) {
        errors.push(...result.errors);
    }
    if (result.verified !== false) {
        errors.push("verified must be false");
    }
    if (expect.requireRootVerified === true) {
        if (!result.rootVerified) {
            errors.push(`rootVerified must be true: ${result.reason}`);
        }
    } else if (expect.rootVerifiedMustBeFalse === true) {
        if (result.rootVerified !== false) {
            errors.push("rootVerified must stay false");
        }
    }
    if (expect.nValues != null && result.details.nValues !== expect.nValues) {
        errors.push(
            `nValues: got ${result.details.nValues}, want ${expect.nValues}`,
        );
    }
    if (expect.nrLeaves != null && result.details.nrLeaves !== expect.nrLeaves) {
        errors.push(
            `nrLeaves: got ${result.details.nrLeaves}, want ${expect.nrLeaves}`,
        );
    }
    if (expect.indices != null) {
        const got = result.details.indices.join(",");
        const want = expect.indices.join(",");
        if (got !== want) {
            errors.push(`indices: got [${got}], want [${want}]`);
        }
    }
    return { ok: errors.length === 0, errors };
}
