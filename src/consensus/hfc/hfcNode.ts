/**
 * The node's hard-fork history (singleton): built from the genesis files and the `Test*` triggers
 * at startup, fed by the orchestrator at every epoch boundary (ledger-driven transitions), and
 * read by LocalStateQuery (GetInterpreter / GetCurrentEra), tx-submission (era index of a tx) and
 * the block producer (era of the block it forges).
 */
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { logger } from "../../utils/logger";
import type { BlockStore } from "../../storage/blockStore";
import { HardForkHistory, KNOWN_ERA_STARTS, eraStartsFromBlocks, triggersFrom } from "./HardForkHistory";
import { HFC_ERAS, type GenesisGeometry } from "./hfc";

const log = logger.child("hfc");
let current: HardForkHistory | null = null;

export function getHardForkHistory(): HardForkHistory | null { return current; }
export function setHardForkHistory(h: HardForkHistory | null): void { current = h; }

export interface HfcNodeConfig {
    network?: string;
    networkMagic: number;
    shelleyGenesisFile: string;
    byronGenesisFile?: string;
    dbPath?: string;
    /** A cardano-node config.json whose `Test*HardForkAtEpoch` keys apply (optional). */
    cardanoNodeConfigFile?: string;
    [k: string]: unknown;
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

export function geometryFromGenesis(shelleyGenesisFile: string, byronGenesisFile?: string): GenesisGeometry {
    const sg = readJson(shelleyGenesisFile);
    let k = Number(sg.securityParam), slotDurationMs = 20_000;
    if (byronGenesisFile && existsSync(byronGenesisFile)) {
        const bg = readJson(byronGenesisFile);
        k = Number(bg.protocolConsts?.k ?? k);
        slotDurationMs = Number(bg.blockVersionData?.slotDuration ?? slotDurationMs);
    }
    return {
        byron: { k, slotDurationMs },
        shelley: { epochLength: Number(sg.epochLength), slotLengthSec: Number(sg.slotLength), securityParam: Number(sg.securityParam), activeSlotsCoeff: Number(sg.activeSlotsCoeff), systemStart: String(sg.systemStart) },
    };
}

/** Build the history for a node configuration (no I/O beyond the genesis files and the persisted state). */
export function createHardForkHistory(cfg: HfcNodeConfig): HardForkHistory {
    const geometry = geometryFromGenesis(cfg.shelleyGenesisFile, cfg.byronGenesisFile);
    let triggerCfg: Record<string, unknown> = { ...cfg };
    if (cfg.cardanoNodeConfigFile && existsSync(cfg.cardanoNodeConfigFile)) {
        try { triggerCfg = { ...readJson(cfg.cardanoNodeConfigFile), ...cfg }; } catch (err) { log.warn(`cardano-node config ${cfg.cardanoNodeConfigFile} unreadable: ${(err as Error).message}`); }
    }
    const triggers = triggersFrom(triggerCfg, cfg.network);
    const statePath = cfg.dbPath && cfg.dbPath !== ":memory:" ? join(dirname(cfg.dbPath), "hfc-eras.json") : null;
    const h = new HardForkHistory(geometry, triggers, Number(cfg.networkMagic), statePath);
    h.load();
    return h;
}

function eraOfBlockBytes(bytes: Uint8Array): number | null {
    // `[eraTag, block]`: 0x82 then a small uint
    if (bytes.length < 2 || bytes[0] !== 0x82) return null;
    const tag = bytes[1]! < 24 ? bytes[1]! : null;
    return tag == null ? null : Math.max(0, tag - 1);
}

/** Slot-indexed first/last non-EBB block lookups over the immutable chunk store. */
export function chunkStoreProbe(store: BlockStore) {
    const cs = store.chunks;
    const chunkSlots = BigInt(cs.chunkSlots);
    const chunks = cs.chunks();
    const at = async (slot: number) => { const b = await cs.blockAt(slot); const era = b ? eraOfBlockBytes(b.bytes) : null; return b && era != null ? { era, slot: BigInt(b.slot) } : null; };
    return {
        async firstAtOrAfter(slot: bigint) {
            const c0 = Number(slot / chunkSlots);
            for (const c of chunks) {
                if (c < c0) continue;
                const idx = await cs.index(c);
                if (!idx) continue;
                for (const e of idx.entries) if (!e.isEbb && BigInt(e.slotOrEbb) >= slot) return at(e.slotOrEbb);
            }
            return null;
        },
        async lastBefore(slot: bigint) {
            const c0 = Number(slot / chunkSlots);
            for (let i = chunks.length - 1; i >= 0; i--) {
                const c = chunks[i]!;
                if (c > c0) continue;
                const idx = await cs.index(c);
                if (!idx) continue;
                for (let j = idx.entries.length - 1; j >= 0; j--) { const e = idx.entries[j]!; if (!e.isEbb && BigInt(e.slotOrEbb) < slot) return at(e.slotOrEbb); }
            }
            return null;
        },
    };
}

export type EraProbe = ReturnType<typeof chunkStoreProbe>;

/**
 * Fill the eras this node never observed from the block store, then (last resort) from the known
 * public-network history, and declare the history ready only when it reaches the tip's era.
 * `tipEra` is the HFC era of our tip block (from its era tag) and the floor of every later answer.
 * Bug 237: called with no tip (the SQLite `blocks` table is empty in primary block-store mode and
 * the store was not yet registered), this marked the history ready with the config's five eras.
 */
export async function resolveEraStarts(h: HardForkHistory, opts: { store?: BlockStore | null; probe?: EraProbe | null; tipSlot?: bigint | null; tipEra?: number | null }): Promise<boolean> {
    const want = opts.tipEra ?? null;
    // epoch triggers of the eras up to the tip's (e.g. preview's Test*AtEpoch 0) need no evidence
    h.noteEpochStart(0n, null);
    if (want == null || opts.tipSlot == null) { log.warn(`Hard-fork history: no tip to resolve the eras against (block store ${opts.store ? "given" : "absent"}); era answers stay on the built-in fallback`); return false; }
    h.noteTipEra(opts.tipSlot, want);
    if (h.currentEra() < want) {
        const probe = opts.probe ?? (opts.store ? chunkStoreProbe(opts.store) : null);
        if (probe) {
            try {
                const t0 = performance.now();
                const found = await eraStartsFromBlocks(probe.firstAtOrAfter, probe.lastBefore, opts.tipSlot, { byronEpochSize: h.shape[0]!.epochSize, shelleyEpochSize: h.shape[1]!.epochSize });
                const n = h.adopt(found, "block store (first block of the era)");
                log.info(`Hard-fork history from the block store in ${(performance.now() - t0).toFixed(0)} ms: ${n} era(s) adopted (search: ${found.map((e, i) => `${HFC_ERAS[i]}@${e ?? "?"}`).join(" ")}); starts ${h.startEpochs().map((e, i) => `${HFC_ERAS[i]}@${e}`).join(" ")}`);
            } catch (err) {
                log.warn(`Hard-fork history: block store scan failed: ${(err as Error).message}`);
            }
        }
    }
    const known = KNOWN_ERA_STARTS[h.magic];
    if (known) {
        const mismatch = h.startEpochs().findIndex((e, i) => known[i] != null && BigInt(known[i]!) !== e);
        if (mismatch >= 0) log.error(`Hard-fork history: ${HFC_ERAS[mismatch]} starts at epoch ${h.startEpochs()[mismatch]} (${h.sourceOf(mismatch)}), the network's history says ${known[mismatch]}`);
        if (h.currentEra() < want) {
            const n = h.adopt(known.map((e) => BigInt(e)).slice(0, want + 1), "known network history");
            if (n) log.warn(`Hard-fork history: ${n} era start(s) taken from the built-in history of network magic ${h.magic} (not observed on this node's ledger or block store)`);
        }
    }
    const ready = h.markReady(want);
    if (!ready) log.error(`Hard-fork history reaches ${HFC_ERAS[h.currentEra()]} but our tip is a ${HFC_ERAS[want]} block (slot ${opts.tipSlot}): era answers use the tip's era as a floor and the built-in fallback until the transition is observed`);
    else log.info(`Hard-fork history complete: ${h.startEpochs().map((e, i) => `${HFC_ERAS[i]}@${e} (${h.sourceOf(i)})`).join(", ")}; tip era ${HFC_ERAS[want]}`);
    return ready;
}

/** Slot/epoch geometry of a non-public network from its genesis files and hard-fork history. */
export function epochGeometryOf(h: HardForkHistory) {
    const b = h.shape[0]!, s = h.shape[1]!;
    const shelleyStartEpoch = h.shelleyStartEpoch() ?? 1n << 40n; // Byron until the transition is known
    return {
        systemStartUnix: BigInt(Math.floor(Date.parse(h.geometry.shelley.systemStart) / 1000)),
        byronSlotsPerEpoch: b.epochSize,
        shelleyStartEpoch,
        shelleyStartSlot: shelleyStartEpoch * b.epochSize,
        shelleySlotsPerEpoch: s.epochSize,
        byronSlotMs: b.slotLengthMs,
        shelleySlotMs: s.slotLengthMs,
        stabilityWindow: s.safeZone ?? 0n,
    };
}

/**
 * Startup: build the node's hard-fork history from its configuration; a network other than
 * mainnet/preprod/preview also gets its slot/epoch geometry from it (custom testnets, SanchoNet).
 */
export async function installHardForkHistory(cfg: HfcNodeConfig, networkName: string): Promise<HardForkHistory | null> {
    try {
        const h = createHardForkHistory({ ...cfg, network: networkName });
        h.noteEpochStart(0n, null); // Test*HardForkAtEpoch 0 eras are there from the start
        setHardForkHistory(h);
        const known = ["mainnet", "preprod", "preview"].includes(networkName.toLowerCase());
        if (!known) {
            const { setCustomEpochGeometry, setEpochNetwork } = await import("../../utils/epochFromSlotCalculations");
            setCustomEpochGeometry(epochGeometryOf(h));
            setEpochNetwork("custom");
            log.info(`Network ${networkName}: slot/epoch geometry from its genesis files (epoch ${h.shape[1]!.epochSize} slots of ${h.shape[1]!.slotLengthMs} ms, Shelley from epoch ${h.shelleyStartEpoch() ?? "?"})`);
        }
        log.info(`Hard-fork history: ${h.startEpochs().map((e, i) => `${HFC_ERAS[i]}@${e}`).join(" ")} (${h.triggers.slice(1, 7).map((t, i) => `${HFC_ERAS[i + 1]}:${t.kind === "epoch" ? `epoch ${t.epoch}` : t.kind === "version" ? `v${t.major}` : "never"}`).join(", ")})`);
        return h;
    } catch (err) {
        log.warn(`Hard-fork history unavailable (${(err as Error).message}); era queries fall back to the built-in tables`);
        return null;
    }
}
