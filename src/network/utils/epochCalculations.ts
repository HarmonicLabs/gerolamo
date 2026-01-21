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
};
export function calculatePreProdCardanoEpoch(
    absoluteSlot: number | bigint,
): number | bigint {
    const byronSlotsPerEpoch = 21600n;
    const shelleySlotsPerEpoch = 432000n;
    const shelleyTransitionSlot = 84243n; // First Shelley slot (after last Byron at 84,242)
    const byronEpochOffset = 4n; // Shelley starts at epoch 4 after Byron 0-3

    const slot = BigInt(absoluteSlot);
    if (slot < shelleyTransitionSlot) {
        return slot / byronSlotsPerEpoch;
    } else {
        const shelleyRelativeSlot = slot - shelleyTransitionSlot;
        return byronEpochOffset + (shelleyRelativeSlot / shelleySlotsPerEpoch);
    }
}
