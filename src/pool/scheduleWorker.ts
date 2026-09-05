/** Worker: compute the leader schedule off the main thread (≈100 s per preview epoch). */
import { leaderSlotsForEpoch, type ScheduleInput } from "./leaderSchedule";

declare var self: Worker;

self.onmessage = (ev: MessageEvent) => {
    const { id, input } = ev.data as { id: number; input: Omit<ScheduleInput, "vrf" | "onProgress"> & { vrfSkey: Uint8Array; vrfVkey: Uint8Array } };
    try {
        const slots = leaderSlotsForEpoch({
            ...input,
            sigma: { num: BigInt(input.sigma.num), den: BigInt(input.sigma.den) },
            fromSlot: input.fromSlot == null ? undefined : BigInt(input.fromSlot),
            toSlot: input.toSlot == null ? undefined : BigInt(input.toSlot),
            vrf: { skey: input.vrfSkey, vkey: input.vrfVkey },
        });
        input.vrfSkey.fill(0);
        self.postMessage({ id, slots: slots.map((s) => ({ slot: s.slot.toString(), slotInEpoch: s.slotInEpoch.toString(), time: s.time, vrfOutputHex: s.vrfOutputHex })) });
    } catch (err) {
        self.postMessage({ id, error: String((err as Error)?.message ?? err) });
    }
};
