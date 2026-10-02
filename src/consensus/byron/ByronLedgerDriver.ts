/**
 * The node's Byron chain-validation state (ByronLedger) between blocks: loaded from the ledger
 * store (ledger/byronStore.ts) at the selected tip, stepped per Byron block by the applier, written
 * back inside the block's scope (LMDB diff / SQLite journal) so a rollback or a failed range takes
 * the block's Byron effects with it. After any of those the orchestrator drops the driver and the
 * next Byron block reloads it from the store.
 */
import { splitEraBlock } from "../bodyHash";
import { logger } from "../../utils/logger";
import { loadByronLedgerRecord, saveByronLedgerRecord } from "../../ledger/byronStore";
import type { ByronProtocolParameters } from "./byronUpdateCodec";
import {
    ByronLedgerError,
    applyByronBoundary,
    applyByronMainBlock,
    byronBoundaryFacts,
    byronLedgerConfigFromGenesis,
    byronMainBlockFacts,
    byronTransitionEpoch,
    decodeByronLedger,
    encodeByronLedgerCore,
    encodeByronLedgerTip,
    initialByronLedgerState,
    tickByronLedger,
    type ByronLedgerConfig,
    type ByronLedgerState,
} from "./ByronLedger";

const log = logger.child("byron");

/** How the Byron era ends: `TriggerHardForkAtEpoch` (a `TestShelleyHardForkAtEpoch` override) or at the Shelley major version (`byronTransition`). */
export type ByronEraEnd = { kind: "epoch"; epoch: bigint } | { kind: "version"; major: number };

export interface ByronStep {
    era: 0 | 1;
    slot: bigint;
    /** Adopted parameters after the block's tick: what its header, body and transactions are checked against. */
    params: ByronProtocolParameters;
    /** cardano-node's verdict on the block's chain-validation part (empty = valid). */
    errors: string[];
    next: ByronLedgerState;
}

export class ByronLedgerDriver {
    private constructor(readonly cfg: ByronLedgerConfig, readonly eraEnd: ByronEraEnd, private st: ByronLedgerState, private persistedCore: string | null) {}

    get state(): ByronLedgerState { return this.st; }

    /**
     * Load the state at the store's selected tip. No record: the initial state, or with `rebuild`
     * (the tip is a Byron block a build without this state applied) a rebuild over the stored
     * blocks, signatures not re-checked (those blocks were applied already).
     */
    static async open(genesis: any, eraEnd: ByronEraEnd, opts: { rebuild: boolean; storedBlocks?: () => AsyncIterable<{ slot: number; block_data: Uint8Array }> }): Promise<ByronLedgerDriver> {
        const cfg = byronLedgerConfigFromGenesis(genesis);
        const rec = await loadByronLedgerRecord();
        if (rec) return new ByronLedgerDriver(cfg, eraEnd, decodeByronLedger(rec.core, rec.tip), rec.core);
        let st = initialByronLedgerState(cfg);
        if (opts.rebuild && opts.storedBlocks) {
            const t0 = performance.now();
            const quiet: ByronLedgerConfig = { ...cfg, skipSignatures: true };
            let n = 0, errors = 0;
            for await (const b of opts.storedBlocks()) {
                const { era, rawBlock } = splitEraBlock(b.block_data);
                if (era > 1) break;
                try {
                    const r = era === 0 ? applyByronBoundary(quiet, st, byronBoundaryFacts(rawBlock, cfg.epochSlots)) : (() => { const f = byronMainBlockFacts(rawBlock, cfg.epochSlots); return applyByronMainBlock(quiet, tickByronLedger(quiet, st, f.slot), f); })();
                    st = r.state;
                    errors += r.errors.length;
                } catch (err) {
                    errors++;
                    log.warn(`Byron ledger rebuild: block at slot ${b.slot} does not decode (${(err as Error).message}); skipped`);
                }
                if (++n % 200_000 === 0) log.info(`Byron ledger rebuild: ${n} blocks, slot ${st.lastSlot}`);
            }
            log.warn(`Byron ledger state rebuilt from ${n} stored block(s) in ${((performance.now() - t0) / 1000).toFixed(1)} s (no record: the chain was applied by an older build)${errors ? `; ${errors} rule failure(s) ignored` : ""}; adopted ${pv(st)}`);
        }
        return new ByronLedgerDriver(cfg, eraEnd, st, null);
    }

    /** The epoch in which Byron ends, as the hard-fork combinator sees it at the tip (null = not yet known). */
    transitionEpoch(): bigint | null {
        return this.eraEnd.kind === "epoch" ? this.eraEnd.epoch : byronTransitionEpoch(this.cfg, this.st, this.eraEnd.major);
    }

    /**
     * Validate a Byron block (`[era, block]` bytes) against the state at the tip: its era (a Byron
     * block at or after the known transition is in the next era), the tick, then the chain-validation
     * rules. Pure: `commit` makes it the state.
     */
    step(blockData: Uint8Array): ByronStep {
        const { era, rawBlock } = splitEraBlock(blockData);
        if (era !== 0 && era !== 1) throw new ByronLedgerError(`not a Byron block (era tag ${era})`);
        const errors: string[] = [];
        const facts = era === 0 ? byronBoundaryFacts(rawBlock, this.cfg.epochSlots) : byronMainBlockFacts(rawBlock, this.cfg.epochSlots);
        const end = this.transitionEpoch();
        if (end != null && facts.slot >= end * this.cfg.epochSlots) errors.push(`HardForkLedgerErrorWrongEra: Byron block at slot ${facts.slot} (epoch ${facts.slot / this.cfg.epochSlots}), but the Byron era ends at epoch ${end}`);
        if (era === 0) {
            const r = applyByronBoundary(this.cfg, this.st, facts as ReturnType<typeof byronBoundaryFacts>);
            return { era, slot: facts.slot, params: r.state.update.adoptedProtocolParameters, errors: [...errors, ...r.errors], next: r.state };
        }
        const ticked = tickByronLedger(this.cfg, this.st, facts.slot);
        const r = applyByronMainBlock(this.cfg, ticked, facts as ReturnType<typeof byronMainBlockFacts>);
        return { era, slot: facts.slot, params: ticked.update.adoptedProtocolParameters, errors: [...errors, ...r.errors], next: r.state };
    }

    /** Make the step the state and write it (inside the block's ledger scope). */
    async commit(s: ByronStep): Promise<void> {
        const before = this.st;
        const core = encodeByronLedgerCore(s.next);
        await saveByronLedgerRecord({ core: core === this.persistedCore ? undefined : core, tip: encodeByronLedgerTip(s.next) });
        this.persistedCore = core;
        this.st = s.next;
        if (before.update.adoptedProtocolVersion !== s.next.update.adoptedProtocolVersion) {
            log.info(`Byron: protocol version ${pv(s.next)} adopted at slot ${s.slot} (epoch ${s.slot / this.cfg.epochSlots}); maxBlockSize ${s.next.update.adoptedProtocolParameters.maxBlockSize}, maxTxSize ${s.next.update.adoptedProtocolParameters.maxTxSize}, maxHeaderSize ${s.next.update.adoptedProtocolParameters.maxHeaderSize}`);
        }
    }

    /**
     * `applyChainTick` to `slot` without a block (the Byron→Shelley boundary): the adopted version
     * there. Not persisted — the next era's ledger takes over.
     */
    tickedVersion(slot: bigint): { major: number; minor: number; alt: number } {
        return tickByronLedger(this.cfg, this.st, slot).update.adoptedProtocolVersion;
    }
}

function pv(st: ByronLedgerState): string {
    const v = st.update.adoptedProtocolVersion;
    return `${v.major}.${v.minor}.${v.alt}`;
}
