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
export type EpochNetwork = "mainnet" | "preprod" | "preview" | "custom";

export interface EpochGeometry {
    /** Unix seconds of slot 0 (the network's systemStart). */
    systemStartUnix: bigint;
    byronSlotsPerEpoch: bigint;
    /** First slot of the first Shelley epoch. */
    shelleyStartSlot: bigint;
    /** Epoch number of that first Shelley epoch. */
    shelleyStartEpoch: bigint;
    shelleySlotsPerEpoch: bigint;
    /** Slot lengths in ms (20 000 / 1 000 on every public network). */
    byronSlotMs?: bigint;
    shelleySlotMs?: bigint;
    /** Shelley stability window 3k/f in slots (mainnet/preprod 129 600, preview 25 920). */
    stabilityWindow?: bigint;
}

export const EPOCH_GEOMETRY: Record<EpochNetwork, EpochGeometry> = {
    // Shelley HF at epoch 208 (slot 208 × 21 600 = 4 492 800), 2020-07-29.
    mainnet: { systemStartUnix: 1_506_203_091n, byronSlotsPerEpoch: 21_600n, shelleyStartSlot: 4_492_800n, shelleyStartEpoch: 208n, shelleySlotsPerEpoch: 432_000n, stabilityWindow: 129_600n },
    // Confirmed via Blockfrost: /blocks/slot/86400 → epoch 4, epoch_slot 0.
    preprod: { systemStartUnix: 1_655_769_600n, byronSlotsPerEpoch: 21_600n, shelleyStartSlot: 86_400n, shelleyStartEpoch: 4n, shelleySlotsPerEpoch: 432_000n, stabilityWindow: 129_600n },
    // Preview started in Shelley-era rules (no Byron epochs), 86 400-slot epochs.
    preview: { systemStartUnix: 1_666_656_000n, byronSlotsPerEpoch: 86_400n, shelleyStartSlot: 0n, shelleyStartEpoch: 0n, shelleySlotsPerEpoch: 86_400n, stabilityWindow: 25_920n },
    // any other network (SanchoNet, local testnets): filled from its genesis files and hard-fork
    // history at startup (setCustomEpochGeometry); preprod's numbers until then
    custom: { systemStartUnix: 1_655_769_600n, byronSlotsPerEpoch: 21_600n, shelleyStartSlot: 86_400n, shelleyStartEpoch: 4n, shelleySlotsPerEpoch: 432_000n, stabilityWindow: 129_600n },
};

let customSet = false;

/** Geometry of a network that is not one of the three public ones (from its genesis files; see consensus/hfc). */
export function setCustomEpochGeometry(g: EpochGeometry): void {
    EPOCH_GEOMETRY.custom = { ...g };
    customSet = true;
}

/** The custom geometry when one is set (workers receive it with their jobs). */
export function customEpochGeometry(): EpochGeometry | null {
    return customSet ? EPOCH_GEOMETRY.custom : null;
}

let activeNetwork: EpochNetwork = "preprod";

export function normalizeEpochNetwork(name: unknown): EpochNetwork {
    const n = String(name ?? "").trim().toLowerCase();
    if (n === "mainnet" || n === "preview" || n === "preprod") return n;
    return customSet || n === "custom" ? "custom" : "preprod";
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
    const g = EPOCH_GEOMETRY[network] ?? EPOCH_GEOMETRY[activeNetwork];
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
    if (g.byronSlotMs != null || g.shelleySlotMs != null) return Number(g.systemStartUnix) + Number(byronSlots * (g.byronSlotMs ?? 20_000n) + shelleySlots * (g.shelleySlotMs ?? 1_000n)) / 1000;
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

/**
 * Shelley stability window in slots (3k/f): genesis key delegations and other
 * "future" state become effective this many slots after their certificate.
 * 129 600 on mainnet/preprod (k = 2160), 25 920 on preview (k = 432) — it was 129 600 for every
 * network, so preview genesis delegations took effect five times too late.
 */
export function stabilityWindowSlots(network: EpochNetwork = activeNetwork): number {
    return Number(EPOCH_GEOMETRY[network]?.stabilityWindow ?? 129_600n);
}

/** First Shelley slot of the network (mainnet 4 492 800, preprod 86 400, preview 0). */
export function shelleyStartSlot(network: EpochNetwork = activeNetwork): bigint {
    const g = EPOCH_GEOMETRY[network] ?? EPOCH_GEOMETRY[activeNetwork];
    return firstSlotOfEpoch(g.shelleyStartEpoch, network);
}

/** First Shelley epoch of the network (mainnet 208, preprod 4, preview 0). */
export function shelleyStartEpoch(network: EpochNetwork = activeNetwork): bigint {
    return (EPOCH_GEOMETRY[network] ?? EPOCH_GEOMETRY[activeNetwork]).shelleyStartEpoch;
}
