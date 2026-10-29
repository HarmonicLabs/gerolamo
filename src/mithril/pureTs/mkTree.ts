/**
 * Mithril MKTree (IntersectMBO mithril-merkle-tree + ckb-merkle-mountain-range), now
 * @harmoniclabs/mithril-ts (core `mkTree`): leaves are UTF-8 bytes of the hex digest text,
 * merge = Blake2s256(left || right), root = bag_rhs_peaks of the MMR peaks.
 *
 * Gerolamo keeps only the golden-vector report (`verifyMkTreeGoldenRoot`); the tree itself,
 * the digest filtering and the Cardano-DB merkle root are the library's.
 */

import { MKTREE_GOLDEN_LEAVES, MKTREE_GOLDEN_ROOT_HEX, mkTreeRoot } from "@harmoniclabs/mithril-ts";

export {
    MKTREE_GOLDEN_LEAVES,
    MKTREE_GOLDEN_ROOT_HEX,
    MkTree,
    cardanoDatabaseMerkleRoot,
    cardanoDatabaseSnapshotHash,
    certifiedDigests,
    digestsFileStem,
    immutableFileNumber,
    mkTreeRoot,
    type ImmutableFileDigest,
} from "@harmoniclabs/mithril-ts";

export type ComputeMkTreeRootResult = {
    ok: boolean;
    rootHex: string | null;
    leafCount: number;
    mmrSize: number;
    reason: string;
};

/** Golden vector from mithril-merkle-tree `tests::golden_merkle_root` (golden-1 … golden-5). */
export function verifyMkTreeGoldenRoot(): ComputeMkTreeRootResult {
    const leaves = MKTREE_GOLDEN_LEAVES.map((s) => new TextEncoder().encode(s));
    let rootHex: string;
    try {
        rootHex = Buffer.from(mkTreeRoot(leaves)).toString("hex");
    } catch (e) {
        return { ok: false, rootHex: null, leafCount: leaves.length, mmrSize: 0, reason: `MKTree build failed: ${(e as Error).message}` };
    }
    if (rootHex !== MKTREE_GOLDEN_ROOT_HEX) {
        return { ok: false, rootHex, leafCount: leaves.length, mmrSize: leaves.length, reason: `golden mismatch: got ${rootHex}, want ${MKTREE_GOLDEN_ROOT_HEX}` };
    }
    return { ok: true, rootHex, leafCount: leaves.length, mmrSize: leaves.length, reason: "golden_merkle_root OK" };
}
