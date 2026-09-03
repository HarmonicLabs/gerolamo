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
