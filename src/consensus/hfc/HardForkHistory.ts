/**
 * Where the era boundaries come from (ledger-driven, like the HFC telescope of cardano-node):
 *
 *   1. triggers from the node configuration: `Test<Era>HardForkAtEpoch` (cardano-node's names) —
 *      `TriggerHardForkAtEpoch`, the transition happens at that epoch whatever the ledger says;
 *      every other era is `TriggerHardForkAtVersion (eraProtVerLow)`;
 *   2. transitions the node itself observed: at each epoch boundary the ledger's protocol major
 *      version for the new epoch is checked against the next era's trigger (`noteEpochStart`); the
 *      result is persisted (`hfc-eras.json`) so the history survives restarts;
 *   3. for eras this node did not observe (a Mithril bootstrap starts in Conway): the block store —
 *      the first block carrying the era's tag is in the era's first epoch (binary search over the
 *      immutable chunks, a few dozen block reads);
 *   4. last resort: the known history of the three public networks (logged, and used to check 2–3).
 *
 * Custom testnets and SanchoNet need nothing but their genesis files and the `Test*` overrides.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { logger } from "../../utils/logger";
import { applyExperimentalFromConfig, configEnablesExperimentalHardForks, DIJKSTRA_HFC_ERA, lastReachableEra } from "./experimental";
import { ERA_TRIGGER_MAJOR, HFC_ERAS, eraShape, reconstructSummary, type EraParams, type EraSummary, type GenesisGeometry, type Transition } from "./hfc";

const log = logger.child("hfc");

export type EraTrigger = { kind: "epoch"; epoch: bigint } | { kind: "version"; major: number } | { kind: "never" };

/** cardano-node configuration keys, indexed by the era they lead INTO. */
export const TEST_TRIGGER_KEYS = ["", "TestShelleyHardForkAtEpoch", "TestAllegraHardForkAtEpoch", "TestMaryHardForkAtEpoch", "TestAlonzoHardForkAtEpoch", "TestBabbageHardForkAtEpoch", "TestConwayHardForkAtEpoch", "TestDijkstraHardForkAtEpoch"] as const;

/** The public networks' official cardano-node configuration overrides (config, not boundaries). */
export const NETWORK_TEST_TRIGGERS: Record<string, Partial<Record<(typeof TEST_TRIGGER_KEYS)[number], number>>> = {
    preview: { TestShelleyHardForkAtEpoch: 0, TestAllegraHardForkAtEpoch: 0, TestMaryHardForkAtEpoch: 0, TestAlonzoHardForkAtEpoch: 0 },
    preprod: {},
    mainnet: {},
};

/** Known history (start epoch of each era, Byron first) — only a fallback and a cross-check. */
export const KNOWN_ERA_STARTS: Record<number, number[]> = {
    2: [0, 0, 0, 0, 0, 3, 646], // preview
    1: [0, 4, 5, 6, 7, 12, 163], // preprod
    764824073: [0, 208, 236, 251, 290, 365, 507], // mainnet
};

/** Resolve the trigger of every era from a config object carrying cardano-node `Test*HardForkAtEpoch` keys. */
export function triggersFrom(cfg: Record<string, unknown>, network?: string): EraTrigger[] {
    const base = network ? NETWORK_TEST_TRIGGERS[network] ?? {} : {};
    // cardano-node 11: Conway's successor is NotDuringThisExecution unless ExperimentalHardForksEnabled (bug 421)
    applyExperimentalFromConfig(cfg);
    const reachable = configEnablesExperimentalHardForks(cfg) ? Math.max(lastReachableEra(), DIJKSTRA_HFC_ERA) : lastReachableEra();
    const out: EraTrigger[] = [{ kind: "never" }];
    for (let i = 1; i < HFC_ERAS.length; i++) {
        const key = TEST_TRIGGER_KEYS[i]!;
        const v = cfg[key] ?? (base as Record<string, unknown>)[key];
        if (i > reachable) { out.push({ kind: "never" }); continue; }
        if (v != null && Number.isFinite(Number(v))) out.push({ kind: "epoch", epoch: BigInt(Number(v)) });
        else out.push({ kind: "version", major: ERA_TRIGGER_MAJOR[i]! });
    }
    return out;
}

export interface HardForkHistoryState { magic: number; starts: string[]; sources: string[]; /** Written only once the history reached the tip's era (bug 237). */ complete?: boolean }

export class HardForkHistory {
    readonly shape: EraParams[];
    private starts: bigint[] = [0n]; // Byron starts at 0
    private sources: string[] = ["genesis"];
    /**
     * The history reaches the era of our chain's tip (`markReady`): until then callers with a
     * built-in fallback (public networks) use it instead, and nothing is persisted. Bug 237: it was
     * set without a tip ("nothing to reach"), so a Mithril-bootstrapped node whose only known eras were
     * the config's Byron..Alonzo forged an Alonzo-tagged block in Conway.
     */
    private _ready = false;
    get ready(): boolean { return this._ready; }
    /** Era tag of our chain's tip block and its slot: the floor of every era answer at or after it. */
    private floor: { slot: bigint; era: number } | null = null;

    /** The tip block of the block store / DB is of era `era` at `slot`: no answer at or after it may be lower. */
    noteTipEra(slot: bigint, era: number): void {
        if (!this.floor || slot >= this.floor.slot) this.floor = { slot, era };
    }
    tipEra(): number | null { return this.floor?.era ?? null; }
    /** The floor for `slot`: the tip block's era when `slot` is at or after it (eras are monotone), else none. */
    floorEraAt(slot: bigint): number | null { return this.floor && slot >= this.floor.slot ? this.floor.era : null; }

    /** Ready only when the known eras reach the tip's era; returns the verdict. */
    markReady(tipEra: number): boolean {
        this._ready = this.currentEra() >= tipEra;
        if (this._ready) this.persist();
        return this._ready;
    }
    /** Optional: the next epoch's protocol major when stably known before the boundary (TransitionKnown for version triggers). */
    futureMajor: ((nextEpoch: bigint) => number | null) | null = null;
    /**
     * Byron's `singleEraTransition` for a version trigger: the epoch in which Byron ends, from the
     * Byron update state at the ledger tip (ByronLedger.byronTransitionEpoch — the Shelley-major
     * candidate once stable), null while unknown. Set by the orchestrator while it tracks Byron.
     */
    byronTransition: (() => bigint | null) | null = null;

    constructor(readonly geometry: GenesisGeometry, readonly triggers: EraTrigger[], readonly magic: number, private readonly statePath: string | null = null) {
        this.shape = eraShape(geometry);
    }

    /** HFC index of the last era these triggers can reach (Conway, or Dijkstra with ExperimentalHardForksEnabled). */
    get lastReachableEra(): number {
        let last = 0;
        for (let i = 1; i < this.triggers.length; i++) if (this.triggers[i]!.kind !== "never") last = i; else break;
        return last;
    }

    /** Start epochs of every era up to the current one (the era of the ledger tip). */
    startEpochs(): readonly bigint[] { return this.starts; }
    currentEra(): number { return this.starts.length - 1; }
    sourceOf(era: number): string | null { return this.sources[era] ?? null; }

    /** Set era starts from an outside source when they are not yet known (index = era). */
    adopt(starts: Array<bigint | null>, source: string): number {
        let n = 0;
        for (let i = 1; i < starts.length; i++) {
            const e = starts[i];
            if (e == null) { if (i < this.starts.length) continue; break; } // unknown to the source; known here → carry on
            if (i < this.starts.length) {
                if (this.starts[i] !== e) log.warn(`era ${HFC_ERAS[i]}: ${source} says it starts at epoch ${e}, ${this.sources[i]} said ${this.starts[i]}; keeping ${this.sources[i]}`);
                continue;
            }
            if (i !== this.starts.length) break;
            if (e < this.starts[i - 1]!) { log.warn(`era ${HFC_ERAS[i]}: ${source} start epoch ${e} precedes ${HFC_ERAS[i - 1]} (${this.starts[i - 1]}); ignored`); break; }
            this.starts.push(e); this.sources.push(source); n++;
        }
        if (n) this.persist();
        return n;
    }

    /** Epoch-triggered eras that begin at or before `epoch` and are not recorded yet (walk from the current era). */
    private epochTriggeredUpTo(epoch: bigint, why: string): number[] {
        const moved: number[] = [];
        for (;;) {
            const next = this.currentEra() + 1;
            const t = this.triggers[next];
            if (!t || t.kind !== "epoch" || t.epoch > epoch) break;
            const at = t.epoch < this.starts[this.currentEra()]! ? this.starts[this.currentEra()]! : t.epoch;
            this.starts.push(at); this.sources.push(why); moved.push(next);
        }
        return moved;
    }

    /**
     * The ledger crossed into `epoch` with protocol major `major` (null when unknown): the next era
     * begins now if its trigger fires (`TriggerHardForkAtEpoch` reached, or the major equals its
     * `eraProtVerLow`, as `shelleyTransition` guards with `==`). Returns the eras entered.
     */
    noteEpochStart(epoch: bigint, major: number | null): number[] {
        const moved = this.epochTriggeredUpTo(epoch, "config (Test*HardForkAtEpoch)");
        const next = this.currentEra() + 1;
        const t = this.triggers[next];
        if (t?.kind === "version" && major != null && major === t.major && epoch > this.starts[this.currentEra()]!) {
            this.starts.push(epoch); this.sources.push(`ledger (protocol ${major} adopted at epoch ${epoch})`); moved.push(next);
        }
        if (moved.length) { this.persist(); for (const e of moved) log.info(`Hard fork: ${HFC_ERAS[e]} begins at epoch ${this.starts[e]} (${this.sources[e]})`); }
        return moved;
    }

    /**
     * The chain left Byron at `epoch` as the Byron update state decided (`byronTransition`): with a
     * version trigger for Shelley, record that start. A `Test*HardForkAtEpoch` network keeps its
     * configured epoch. Returns whether Shelley was recorded now.
     */
    noteByronTransition(epoch: bigint, why: string): boolean {
        if (this.currentEra() !== 0 || this.triggers[1]?.kind !== "version") return false;
        this.starts.push(epoch); this.sources.push(`ledger (Byron update state: ${why})`);
        this.persist();
        log.info(`Hard fork: ${HFC_ERAS[1]} begins at epoch ${epoch} (${this.sources[1]})`);
        return true;
    }

    /** Our chain rolled back to `slot`: eras that began after it are undone (a rollback within k across a boundary). */
    rollbackToSlot(slot: bigint): number {
        let dropped = 0;
        while (this.starts.length > 1) {
            const s = this.summaryUnbounded();
            const cur = s[s.length - 1]!;
            if (cur.start.slot <= slot) break;
            this.starts.pop(); this.sources.pop(); dropped++;
        }
        if (dropped) { this.persist(); log.info(`Hard-fork history rolled back ${dropped} era(s) with the chain (slot ${slot}); current era ${HFC_ERAS[this.currentEra()]}`); }
        return dropped;
    }

    /** The current era's transition as the HFC sees it at `ledgerTipSlot`. */
    transitionAt(ledgerTipSlot: bigint | null): Transition {
        const next = this.currentEra() + 1;
        const t = this.triggers[next];
        if (!t || t.kind === "never") return { kind: "unknown", ledgerTipSlot };
        if (t.kind === "epoch") return { kind: "known", epoch: t.epoch < this.starts[this.currentEra()]! ? this.starts[this.currentEra()]! : t.epoch };
        if (this.currentEra() === 0 && this.byronTransition) {
            const e = this.byronTransition();
            if (e != null) return { kind: "known", epoch: e };
            return { kind: "unknown", ledgerTipSlot };
        }
        if (this.futureMajor && ledgerTipSlot != null) {
            const e = this.epochOfSlot(ledgerTipSlot);
            if (e != null) { const m = this.futureMajor(e + 1n); if (m != null && m === t.major) return { kind: "known", epoch: e + 1n }; }
        }
        return { kind: "unknown", ledgerTipSlot };
    }

    /** GetInterpreter summary for a ledger state whose tip is at `ledgerTipSlot`. */
    summary(ledgerTipSlot: bigint | null): EraSummary[] {
        return reconstructSummary(this.shape, this.starts, this.transitionAt(ledgerTipSlot));
    }

    /** Summary whose current era never ends (slot/epoch arithmetic inside the known eras). */
    summaryUnbounded(): EraSummary[] {
        const s = reconstructSummary(this.shape, this.starts, { kind: "impossible" });
        s[s.length - 1] = { ...s[s.length - 1]!, end: null };
        return s;
    }

    epochOfSlot(slot: bigint): bigint | null {
        for (const e of this.summaryUnbounded()) if (slot >= e.start.slot && (e.end == null || slot < e.end.slot)) return e.start.epoch + (slot - e.start.slot) / e.params.epochSize;
        return null;
    }

    firstSlotOfEpoch(epoch: bigint): bigint {
        const s = this.summaryUnbounded();
        for (let i = s.length - 1; i >= 0; i--) if (epoch >= s[i]!.start.epoch) return s[i]!.start.slot + (epoch - s[i]!.start.epoch) * s[i]!.params.epochSize;
        return 0n;
    }

    /** Era (HFC index) of an epoch within the known history (epochs past the last start: the current era). */
    eraOfEpoch(epoch: bigint): number {
        let era = 0;
        for (let i = 0; i < this.starts.length; i++) if (epoch >= this.starts[i]!) era = i;
        // empty eras share their start epoch with the next one: the LAST era starting there is the era of the epoch
        return era;
    }

    eraOfSlot(slot: bigint): number {
        const e = this.epochOfSlot(slot);
        const era = e == null ? this.currentEra() : this.eraOfEpoch(e);
        // eras are monotone along the chain: at or after the tip block, never below its own era tag
        return this.floor && slot >= this.floor.slot && this.floor.era > era ? this.floor.era : era;
    }

    /** Shelley start epoch (the Byron era's length in epochs). */
    shelleyStartEpoch(): bigint | null { return this.starts[1] ?? null; }

    toJSON(): HardForkHistoryState {
        return { magic: this.magic, starts: this.starts.map(String), sources: this.sources, complete: this._ready };
    }

    load(): boolean {
        if (!this.statePath || !existsSync(this.statePath)) return false;
        try {
            const j = JSON.parse(readFileSync(this.statePath, "utf8")) as HardForkHistoryState;
            if (j.magic !== this.magic || !Array.isArray(j.starts) || j.starts[0] !== "0") return false;
            // a file from before bug 237 (five config eras, never completed) is no history: ignore it
            if (j.complete !== true) { log.warn(`hard-fork history ${this.statePath} is incomplete (${j.starts.length} era(s), not marked complete); ignored`); return false; }
            this.starts = j.starts.map((x) => BigInt(x));
            this.sources = j.sources?.length === j.starts.length ? j.sources : j.starts.map(() => "persisted");
            return true;
        } catch (err) {
            log.warn(`hard-fork history ${this.statePath} unreadable: ${(err as Error).message}`);
            return false;
        }
    }

    private persist(): void {
        if (!this.statePath || !this._ready) return; // never persist a history that does not reach the tip (bug 237)
        try {
            const tmp = `${this.statePath}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 1));
            renameSync(tmp, this.statePath);
        } catch (err) {
            log.warn(`hard-fork history not persisted (${this.statePath}): ${(err as Error).message}`);
        }
    }
}

/**
 * Era start epochs from a block store (`[eraTag, block]` blocks, tag 0 = Byron EBB, 1 = Byron,
 * 2 = Shelley … 7 = Conway, HFC era = max(0, tag − 1)): the first block of each era lies in the
 * era's first epoch. Eras are monotone in slot, so each start is a binary search over slots.
 * `firstAtOrAfter(slot)` / `lastBefore(slot)`: the first / last non-EBB block at or after / before
 * a slot. An era without blocks of its own starts where the next one does.
 */
export async function eraStartsFromBlocks(
    firstAtOrAfter: (slot: bigint) => Promise<{ era: number; slot: bigint } | null>,
    lastBefore: (slot: bigint) => Promise<{ era: number; slot: bigint } | null>,
    tipSlot: bigint,
    geo: { byronEpochSize: bigint; shelleyEpochSize: bigint },
): Promise<Array<bigint | null>> {
    const out: Array<bigint | null> = [0n];
    // first block whose era ≥ target
    const firstOfEra = async (target: number): Promise<{ era: number; slot: bigint } | null> => {
        let lo = 0n, hi = tipSlot, ans: { era: number; slot: bigint } | null = null;
        while (lo <= hi) {
            const mid = (lo + hi) / 2n;
            const b = await firstAtOrAfter(mid);
            if (!b) { hi = mid - 1n; continue; }
            if (b.era >= target) { ans = ans && ans.slot <= b.slot ? ans : b; hi = mid - 1n; } else lo = b.slot + 1n;
        }
        return ans;
    };
    const firstBlock = await firstAtOrAfter(0n);
    if (!firstBlock) return out;
    // A store that does not begin at genesis (a Mithril bootstrap keeping only recent chunks) shows
    // the first block of its FIRST era already in progress: that era's start, and every earlier
    // era's, is not observable here (null); the built-in history or observed transitions must fill
    // them. A store whose first block lies in epoch 0 begins at genesis: those eras all start at 0.
    const fromGenesis = firstBlock.slot < geo.byronEpochSize;
    const firstShelley = await firstOfEra(1);
    if (!firstShelley) return out;
    const lastByron = await lastBefore(firstShelley.slot);
    // the Byron era ends on an epoch boundary: Shelley starts the epoch after the last Byron block's
    const shelleyStart: bigint | null = lastByron && lastByron.era === 0 ? lastByron.slot / geo.byronEpochSize + 1n : fromGenesis ? 0n : null;
    if (shelleyStart == null) { for (let era = 1; era <= firstBlock.era; era++) out[era] = null; }
    else out[1] = shelleyStart;
    const s0 = (shelleyStart ?? 0n) * geo.byronEpochSize;
    const epochOf = (slot: bigint): bigint => (slot < s0 ? slot / geo.byronEpochSize : (shelleyStart ?? 0n) + (slot - s0) / geo.shelleyEpochSize);
    for (let era = 2; era <= lastReachableEra(); era++) {
        const b = await firstOfEra(era);
        if (!b) break;
        if (b.slot === firstBlock.slot && !fromGenesis) { out[era] = null; continue; } // already in progress at the store's first block
        out[era] = shelleyStart == null ? null : epochOf(b.slot);
    }
    return out;
}
