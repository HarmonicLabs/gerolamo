import { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

export function calculateCardanoEpoch(
    absoluteSlot: number | bigint,
): number | bigint {
    const byron_slots_per_epoch = 21600;
    const shelley_slots_per_epoch = 432000;
    const byron_epochs = 208;
    const byron_total_slots = byron_epochs * byron_slots_per_epoch;
    if (absoluteSlot < byron_total_slots) {
        return Math.floor(Number(absoluteSlot) / byron_slots_per_epoch);
    }
    const totalSlots = absoluteSlot;
    const shelleyEpochs = Math.floor(
        (Number(totalSlots) - byron_total_slots) / shelley_slots_per_epoch,
    );
    return byron_epochs + shelleyEpochs;
}
export function calculatePreProdCardanoEpoch(
    absoluteSlot: number | bigint,
): number | bigint {
    const byronSlotsPerEpoch = 21600n;
    const shelleySlotsPerEpoch = 432000n;
    // Preprod Shelley HF: first Shelley block is slot 86400 (epoch 4, epoch_slot 0).
    // Confirmed via Blockfrost: /blocks/slot/86400 → epoch=4, epoch_slot=0.
    const shelleyTransitionSlot = 86400n;
    const byronEpochOffset = 4n; // Shelley starts at epoch 4 after Byron 0-3

    const slot = BigInt(absoluteSlot);
    if (slot < shelleyTransitionSlot) {
        return slot / byronSlotsPerEpoch;
    } else {
        const shelleyRelativeSlot = slot - shelleyTransitionSlot;
        return byronEpochOffset + (shelleyRelativeSlot / shelleySlotsPerEpoch);
    }
}

export function getFirstSlotOfEpoch(
    epoch: number | bigint,
    genesis: ShelleyGenesisConfig,
): bigint | number {
    const byronSlotsPerEpoch = 21600n;
    const shelleySlotsPerEpoch = BigInt(genesis.epochLength); // Use genesis for flexibility (e.g., 432000)
    // Must match calculatePreProdCardanoEpoch (86400, not 86409).
    const shelleyTransitionSlot = 86400n;
    const byronEpochOffset = 4n; // Shelley starts at epoch 4

    const epochNum = BigInt(epoch);

    if (epochNum < byronEpochOffset) {
        // Byron era (epochs 0-3)
        return epochNum * byronSlotsPerEpoch;
    } else {
        // Shelley era (epochs 4+)
        const shelleyEpoch = Number(epochNum) - Number(byronEpochOffset);
        return Number(shelleyTransitionSlot) +
            (Number(shelleyEpoch) * Number(shelleySlotsPerEpoch));
    }
}
