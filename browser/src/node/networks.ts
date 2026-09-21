/** Per-network constants the light client needs without a genesis file. */
export interface NetworkParams {
    name: "preview" | "preprod" | "mainnet";
    magic: number;
    /** Shelley-era epoch length in slots and the Shelley start (slot, epoch) for epoch arithmetic. */
    epochLength: number;
    shelleyStartSlot: number;
    shelleyStartEpoch: number;
    slotsPerKESPeriod: number;
    maxKESEvolutions: number;
}

export const NETWORKS: NetworkParams[] = [
    { name: "preview", magic: 2, epochLength: 86_400, shelleyStartSlot: 0, shelleyStartEpoch: 0, slotsPerKESPeriod: 129_600, maxKESEvolutions: 62 },
    { name: "preprod", magic: 1, epochLength: 432_000, shelleyStartSlot: 86_400, shelleyStartEpoch: 4, slotsPerKESPeriod: 129_600, maxKESEvolutions: 62 },
    { name: "mainnet", magic: 764_824_073, epochLength: 432_000, shelleyStartSlot: 4_492_800, shelleyStartEpoch: 208, slotsPerKESPeriod: 129_600, maxKESEvolutions: 62 },
];

export function networkByMagic(magic: number): NetworkParams | undefined {
    return NETWORKS.find((n) => n.magic === magic);
}

export function epochOfSlot(n: NetworkParams, slot: number): number {
    return n.shelleyStartEpoch + Math.floor((slot - n.shelleyStartSlot) / n.epochLength);
}
