/**
 * ChainSync start policy (network-spec §3.7).
 *
 * On connect the producer initialises the consumer read-pointer at genesis.
 * MsgFindIntersect([]) replies IntersectNotFound(tip) and does **not** move
 * that pointer. RequestNext then streams from origin — that is "sync from genesis".
 *
 * FindIntersect([peerTip]) on an empty DB jumps the pointer to the producer
 * head (Gerolamo's old syncFromTip shortcut). That is tip-follow, not genesis.
 */
export type ChainSyncStartMode = "resume" | "genesis" | "point" | "tip";

/**
 * Block offsets behind our tip to offer in MsgFindIntersect when resuming: every one of the
 * last `dense` blocks (a lost slot battle or a short fork is one or two blocks deep), then
 * Fibonacci-spaced back to `k` blocks. The producer answers with the first point it holds,
 * so the list runs newest first. A single point (our tip) was offered before: a peer on the
 * other side of a one-block fork answered IntersectNotFound and the consumer then streamed
 * from origin, marking every honest peer malicious on ancient headers (preview, 2026-09-06).
 */
export function intersectOffsets(k = 2160, dense = 8): number[] {
    const out: number[] = [];
    for (let i = 0; i <= dense && i <= k; i++) out.push(i);
    let a = dense, b = dense + 5;
    while (b < k) { out.push(b); [a, b] = [b, a + b]; }
    if (out[out.length - 1] !== k) out.push(k);
    return out;
}

export function pickChainSyncStart(opts: {
    hasDbTip: boolean;
    syncFromTip: boolean;
    syncFromGenesis: boolean;
    syncFromPoint: boolean;
}): ChainSyncStartMode {
    if (opts.hasDbTip) return "resume";
    if (opts.syncFromPoint) return "point";
    if (opts.syncFromGenesis) return "genesis";
    if (opts.syncFromTip) return "tip";
    throw new Error(
        "Invalid sync configuration: enable syncFromTip, syncFromGenesis, or syncFromPoint",
    );
}
