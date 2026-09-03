export interface BlockRangeIdentity {
    slot: bigint;
    hash: string;
}

/** Require a one-to-one, ordered correspondence between ChainSync and BlockFetch. */
export function assertBlockRangeMatches(
    expected: readonly BlockRangeIdentity[],
    actual: readonly BlockRangeIdentity[],
): void {
    if (actual.length !== expected.length) {
        throw new Error(
            `BlockFetch range expected ${expected.length} blocks, received ${actual.length}`,
        );
    }
    for (let i = 0; i < expected.length; i++) {
        const want = expected[i]!;
        const got = actual[i]!;
        if (
            got.slot !== want.slot ||
            got.hash.toLowerCase() !== want.hash.toLowerCase()
        ) {
            throw new Error(
                `BlockFetch range block ${i} does not match advertised header: expected slot=${want.slot} hash=${want.hash}, received slot=${got.slot} hash=${got.hash}`,
            );
        }
    }
}
