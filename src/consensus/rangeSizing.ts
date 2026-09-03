/**
 * BlockFetch range sizing (sync plan §4.2): large ranges while far behind the
 * tip, single blocks at the tip. Pure so it can be unit-tested.
 */

/** Clamp the configured maximum range to 1..256 (default 128). */
export function clampMaxRangeBlocks(configured: unknown, fallback = 128): number {
    const n = Number(configured ?? fallback);
    return Number.isFinite(n) && n >= 1 ? Math.min(256, Math.trunc(n)) : fallback;
}

/**
 * Target range size for a header at `slot` from a peer whose tip is `tipSlot`.
 * Byron: one block per 20 s slot. Shelley+: about one block per 20 slots (f = 0.05).
 */
export function rangeSizeFor(tipSlot: bigint, slot: bigint, isByron: boolean, maxRangeBlocks: number): number {
    const max = Math.max(1, maxRangeBlocks);
    const slotsBehind = tipSlot > slot ? Number(tipSlot - slot) : 0;
    const blocksBehind = isByron ? slotsBehind : Math.floor(slotsBehind / 20);
    if (blocksBehind >= 4096) return max;
    if (blocksBehind >= 512) return Math.min(max, 64);
    if (blocksBehind >= 64) return Math.min(max, 16);
    if (blocksBehind >= 8) return Math.min(max, 4);
    return 1;
}
