/**
 * Our pool's leader schedule for an epoch (block plan §2), read-only: which
 * slots the VRF key wins under the σ the ledger uses for that epoch.
 *
 * Exactly the check the header validator applies to other pools' blocks, run
 * forward with our secret key:
 *   input  = praosVrfInput(slot, η0)          (Praos, Babbage+)
 *   proof  = vrf03Prove(vrf seed, vrf vkey, input)   (fastVrf; same bytes as VrfProof03.generate)
 *   leader = blake2b_256("L" ‖ proof output)  (praosLeaderValue)
 *   lead   = isSlotLeader(leader, σ, f)        (leaderMath, same rational compare)
 *
 * σ for epoch e is pool stake / total active stake of the snapshot taken at
 * the start of e − 1 (`poolStakeForEpoch` follows that lag). η0 for e is fixed
 * once the candidate nonce freezes, so the next epoch's schedule is known
 * before it starts (`cardano-cli query leadership-schedule --next`).
 */
import { vrf03ProofToHash, vrf03Prove } from "../consensus/fastVrf";
import { praosVrfInput } from "../consensus/vrfInputs";
import { praosLeaderValue } from "../consensus/workers/validationJob";
import { isSlotLeader } from "../consensus/rules/leaderMath";
import { epochLengthSlots, firstSlotOfEpoch, slotToUnixTime, type EpochNetwork } from "../utils/epochFromSlotCalculations";
import { vrfProvingKey, type VrfKey } from "./keystore";

export interface Sigma { num: bigint; den: bigint }

export interface ScheduleInput {
    epoch: number;
    /** η0 of the epoch (hex, 32 bytes). */
    nonceHex: string;
    sigma: Sigma;
    /** Genesis activeSlotsCoeff (0.05 on mainnet, preprod and preview). */
    activeSlotsCoeff: number;
    vrf: VrfKey;
    network: EpochNetwork;
    /** Optional sub-range of the epoch (absolute slots, inclusive/exclusive). */
    fromSlot?: bigint;
    toSlot?: bigint;
    /** Called every `progressEvery` slots (default 5000). */
    onProgress?: (done: number, total: number) => void;
    progressEvery?: number;
}

export interface LeaderSlot {
    slot: bigint;
    slotInEpoch: bigint;
    /** Wall clock of the slot start (ISO, UTC). */
    time: string;
    /** VRF output (64 bytes hex) the header will carry; the proof is regenerated when forging. */
    vrfOutputHex: string;
}

/** True when the key leads `slot` under σ, plus the VRF output. Pure, one proof. */
export function leadsSlot(vrf: VrfKey, slot: bigint, nonce: Uint8Array, sigma: Sigma, activeSlotsCoeff: number): { leads: boolean; output: Uint8Array } {
    if (sigma.den <= 0n || sigma.num < 0n) throw new Error("σ must be a non-negative rational with positive denominator");
    const { secret, publicKey } = vrfProvingKey(vrf);
    const proof = vrf03Prove(secret, publicKey, praosVrfInput(slot, nonce));
    const output = vrf03ProofToHash(proof)!;
    const leads = sigma.num > 0n && isSlotLeader(praosLeaderValue(output), sigma, activeSlotsCoeff);
    return { leads, output };
}

/** Every slot of the epoch (or range) our VRF key leads. Synchronous and CPU-bound (~86 400 proofs per preview epoch, about a minute). */
export function leaderSlotsForEpoch(input: ScheduleInput): LeaderSlot[] {
    const first = firstSlotOfEpoch(input.epoch, input.network);
    const len = epochLengthSlots(input.epoch, input.network);
    const from = input.fromSlot ?? first;
    const to = input.toSlot ?? first + len;
    if (from < first || to > first + len || from > to) throw new Error(`slot range ${from}..${to} outside epoch ${input.epoch} (${first}..${first + len})`);
    if (!/^[0-9a-f]{64}$/i.test(input.nonceHex)) throw new Error("η0 must be 32 bytes hex");
    const nonce = Uint8Array.from(Buffer.from(input.nonceHex, "hex"));
    const every = input.progressEvery ?? 5000;
    const total = Number(to - from);
    const out: LeaderSlot[] = [];
    let done = 0;
    for (let slot = from; slot < to; slot++) {
        const r = leadsSlot(input.vrf, slot, nonce, input.sigma, input.activeSlotsCoeff);
        if (r.leads) {
            out.push({ slot, slotInEpoch: slot - first, time: new Date(slotToUnixTime(slot, input.network) * 1000).toISOString(), vrfOutputHex: Buffer.from(r.output).toString("hex") });
        }
        if (++done % every === 0) input.onProgress?.(done, total);
    }
    input.onProgress?.(total, total);
    return out;
}

/** Expected number of leader slots: f · σ · slots (the ideal, not the realised count). */
export function expectedLeaderSlots(sigma: Sigma, activeSlotsCoeff: number, slots: bigint): number {
    return activeSlotsCoeff * Number(sigma.num) / Number(sigma.den) * Number(slots);
}
