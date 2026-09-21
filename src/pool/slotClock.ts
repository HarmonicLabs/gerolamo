/**
 * Wall-clock slot ticker and the "forge now" decision (block plan §2).
 *
 * Slots are 1 s after Shelley on every network (Byron 20 s); `slotToUnixTime`
 * holds the geometry. The ticker fires once per slot boundary from the local
 * clock; `decideForge` says whether this node must issue a block for the slot:
 * it leads the slot, the slot is current (not already past its deadline), it has
 * not forged that slot before, and the tip it extends is known.
 */
import { EPOCH_GEOMETRY, epochForSlot, slotToUnixTime, type EpochNetwork } from "../utils/epochFromSlotCalculations";

export interface SlotClockOptions {
    network: EpochNetwork;
    /** Clock source in ms (injectable for tests). */
    now?: () => number;
    /** Tolerated clock skew when judging a slot "current" (ms). */
    skewMs?: number;
}

/** Slot whose window contains `nowMs` (Shelley slots: 1 s). */
export function slotAt(nowMs: number, network: EpochNetwork): bigint {
    const g = geometry(network);
    const sec = Math.floor(nowMs / 1000);
    const shelleyStartSec = slotToUnixTime(g.shelleyStartSlot, network);
    if (sec < shelleyStartSec) return BigInt(Math.floor((sec - Number(g.systemStartUnix)) / 20));
    return g.shelleyStartSlot + BigInt(sec - shelleyStartSec);
}

export function slotStartMs(slot: bigint, network: EpochNetwork): number {
    return slotToUnixTime(slot, network) * 1000;
}

export function slotLengthMs(slot: bigint, network: EpochNetwork): number {
    return slot < geometry(network).shelleyStartSlot ? 20_000 : 1_000;
}

function geometry(network: EpochNetwork) {
    return EPOCH_GEOMETRY[network];
}

export type ForgeVerdict =
    | { forge: true; slot: bigint; epoch: number; blockNumber: bigint; prevHash: Uint8Array | null }
    | { forge: false; reason: string };

export interface ForgeState {
    /** Slots this key leads in the current/next epoch (from leaderSchedule). */
    leaderSlots: ReadonlySet<string>;
    /** Our chain tip: the block a new block extends. null tip = genesis (never on a live network). */
    tip: { slot: bigint; blockNumber: bigint; hash: Uint8Array } | null;
    /** Last slot we issued a block for (persisted across restarts: never two blocks in one slot). */
    lastForgedSlot: bigint | null;
    /** Our tip is within this many slots of the wall clock, i.e. we are synced. */
    maxTipLagSlots?: bigint;
}

/**
 * Deadline rule: a block for slot s must be issued inside s; after the slot has
 * passed (allowing `skewMs`) it is too late, and forging ahead of the slot is a
 * clock error. `nowMs` is the moment of the decision.
 */
export function decideForge(slot: bigint, nowMs: number, state: ForgeState, opts: SlotClockOptions): ForgeVerdict {
    const skew = opts.skewMs ?? 500;
    const start = slotStartMs(slot, opts.network);
    const end = start + slotLengthMs(slot, opts.network);
    if (nowMs < start - skew) return { forge: false, reason: `slot ${slot} starts in ${start - nowMs} ms` };
    if (nowMs >= end + skew) return { forge: false, reason: `slot ${slot} ended ${nowMs - end} ms ago` };
    if (!state.leaderSlots.has(slot.toString())) return { forge: false, reason: `not leader for slot ${slot}` };
    if (state.lastForgedSlot != null && state.lastForgedSlot >= slot) return { forge: false, reason: `already forged slot ${state.lastForgedSlot}` };
    if (!state.tip) return { forge: false, reason: "no chain tip" };
    if (state.tip.slot >= slot) return { forge: false, reason: `tip slot ${state.tip.slot} is not before ${slot}` };
    const lag = state.maxTipLagSlots ?? 600n;
    if (slot - state.tip.slot > lag) return { forge: false, reason: `tip is ${slot - state.tip.slot} slots behind (max ${lag}): not synced` };
    return { forge: true, slot, epoch: Number(epochForSlot(slot, opts.network)), blockNumber: state.tip.blockNumber + 1n, prevHash: state.tip.hash };
}

/**
 * Fires `onSlot(slot)` once at every slot boundary (re-armed per slot so drift
 * never accumulates); catches up one missed slot at most, the others are gone.
 */
export class SlotTicker {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastSlot: bigint | null = null;
    /** Slots that were never delivered because the tick came more than a slot late (event loop stalled). */
    missedSlots = 0;
    private readonly now: () => number;
    constructor(private readonly opts: SlotClockOptions, private readonly onSlot: (slot: bigint, nowMs: number) => void) {
        this.now = opts.now ?? Date.now;
    }
    start(): void {
        if (this.timer) return;
        this.lastSlot = slotAt(this.now(), this.opts.network);
        this.arm();
    }
    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
    private arm(): void {
        const nowMs = this.now();
        const cur = slotAt(nowMs, this.opts.network);
        const nextStart = slotStartMs(cur + 1n, this.opts.network);
        this.timer = setTimeout(() => this.tick(), Math.max(1, nextStart - nowMs));
    }
    private tick(): void {
        this.timer = null;
        const nowMs = this.now();
        const cur = slotAt(nowMs, this.opts.network);
        if (this.lastSlot != null && cur > this.lastSlot) {
            // at most one late slot is delivered; deadlines are judged by decideForge
            const from = cur - this.lastSlot > 1n ? cur : this.lastSlot + 1n;
            if (cur - this.lastSlot > 1n) this.missedSlots += Number(cur - this.lastSlot - 1n);
            for (let s = from; s <= cur; s++) this.onSlot(s, nowMs);
        }
        this.lastSlot = cur;
        this.arm();
    }
}
