import { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

/**
 * Slot ↔ epoch arithmetic for every network Gerolamo runs on.
 *
 * Byron epochs are 21 600 slots (20 s each); Shelley+ epochs are 432 000
 * slots (1 s each) on mainnet/preprod and 86 400 on preview. The hard-fork
 * slot and epoch differ per network — using preprod's on mainnet puts every
 * block in the wrong epoch, which breaks the epoch-nonce lookup for header
 * validation at the Shelley boundary.
 *
 * The active network is set once at startup (`setEpochNetwork`); the legacy
 * `calculatePreProdCardanoEpoch` / `getFirstSlotOfEpoch` names delegate to it.
 */
export type EpochNetwork = "mainnet" | "preprod" | "preview";

export interface EpochGeometry {
    /** Unix seconds of slot 0 (the network's systemStart). */
    systemStartUnix: bigint;
    byronSlotsPerEpoch: bigint;
    /** First slot of the first Shelley epoch. */
    shelleyStartSlot: bigint;
    /** Epoch number of that first Shelley epoch. */
    shelleyStartEpoch: bigint;
    shelleySlotsPerEpoch: bigint;
}

export const EPOCH_GEOMETRY: Record<EpochNetwork, EpochGeometry> = {
    // Shelley HF at epoch 208 (slot 208 × 21 600 = 4 492 800), 2020-07-29.
    mainnet: { systemStartUnix: 1_506_203_091n, byronSlotsPerEpoch: 21_600n, shelleyStartSlot: 4_492_800n, shelleyStartEpoch: 208n, shelleySlotsPerEpoch: 432_000n },
    // Confirmed via Blockfrost: /blocks/slot/86400 → epoch 4, epoch_slot 0.
    preprod: { systemStartUnix: 1_655_769_600n, byronSlotsPerEpoch: 21_600n, shelleyStartSlot: 86_400n, shelleyStartEpoch: 4n, shelleySlotsPerEpoch: 432_000n },
    // Preview started in Shelley-era rules (no Byron epochs), 86 400-slot epochs.
    preview: { systemStartUnix: 1_666_656_000n, byronSlotsPerEpoch: 86_400n, shelleyStartSlot: 0n, shelleyStartEpoch: 0n, shelleySlotsPerEpoch: 86_400n },
};

let activeNetwork: EpochNetwork = "preprod";

export function normalizeEpochNetwork(name: unknown): EpochNetwork {
    const n = String(name ?? "").trim().toLowerCase();
    return n === "mainnet" || n === "preview" ? n : "preprod";
}

/** Select the network whose geometry the legacy helpers use. Call once at startup. */
export function setEpochNetwork(name: unknown): EpochNetwork {
    activeNetwork = normalizeEpochNetwork(name);
    return activeNetwork;
}

export function getEpochNetwork(): EpochNetwork {
    return activeNetwork;
}

export function epochForSlot(absoluteSlot: number | bigint, network: EpochNetwork = activeNetwork): bigint {
    const g = EPOCH_GEOMETRY[network];
    const slot = BigInt(absoluteSlot);
    if (slot < g.shelleyStartSlot) return slot / g.byronSlotsPerEpoch;
    return g.shelleyStartEpoch + (slot - g.shelleyStartSlot) / g.shelleySlotsPerEpoch;
}

export function firstSlotOfEpoch(epoch: number | bigint, network: EpochNetwork = activeNetwork): bigint {
    const g = EPOCH_GEOMETRY[network];
    const e = BigInt(epoch);
    if (e < g.shelleyStartEpoch) return e * g.byronSlotsPerEpoch;
    return g.shelleyStartSlot + (e - g.shelleyStartEpoch) * g.shelleySlotsPerEpoch;
}

/** Slot length of `epoch` on the active network. */
export function epochLengthSlots(epoch: number | bigint, network: EpochNetwork = activeNetwork): bigint {
    const g = EPOCH_GEOMETRY[network];
    return BigInt(epoch) < g.shelleyStartEpoch ? g.byronSlotsPerEpoch : g.shelleySlotsPerEpoch;
}

/** Slot number within its epoch. */
export function slotInEpoch(absoluteSlot: number | bigint, network: EpochNetwork = activeNetwork): bigint {
    return BigInt(absoluteSlot) - firstSlotOfEpoch(epochForSlot(absoluteSlot, network), network);
}

/**
 * Wall-clock time (unix seconds) of a slot: systemStart + Byron slots × 20 s +
 * Shelley slots × 1 s. Mainnet slot 4 492 800 (first Shelley block) → 1596059091
 * = 2020-07-29T21:44:51Z.
 */
export function slotToUnixTime(absoluteSlot: number | bigint, network: EpochNetwork = activeNetwork): number {
    const g = EPOCH_GEOMETRY[network];
    const slot = BigInt(absoluteSlot);
    const byronSlots = slot < g.shelleyStartSlot ? slot : g.shelleyStartSlot;
    const shelleySlots = slot < g.shelleyStartSlot ? 0n : slot - g.shelleyStartSlot;
    return Number(g.systemStartUnix + byronSlots * 20n + shelleySlots);
}

// ─── legacy names (all callers) ───────────────────────────────────────────

/** @deprecated use epochForSlot — kept for callers; follows the active network, not preprod. */
export function calculatePreProdCardanoEpoch(absoluteSlot: number | bigint): number | bigint {
    return epochForSlot(absoluteSlot);
}

/** @deprecated use epochForSlot(slot, "mainnet"). */
export function calculateCardanoEpoch(absoluteSlot: number | bigint): number | bigint {
    return epochForSlot(absoluteSlot, "mainnet");
}

/** @deprecated use firstSlotOfEpoch — `genesis` is accepted for signature compatibility. */
export function getFirstSlotOfEpoch(epoch: number | bigint, _genesis?: ShelleyGenesisConfig): bigint | number {
    return firstSlotOfEpoch(epoch);
}
