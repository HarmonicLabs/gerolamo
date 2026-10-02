/**
 * Seeding the pool-ranking state (`esNonMyopic`, consensus/nonMyopic.ts) of a store that was
 * bootstrapped without it (bug 262): read it from a cardano-node ledger state file (a node's
 * `db/ledger/<slot>/state`, or the Mithril snapshot's) and advance it over the store's own epoch
 * boundaries, exactly as the boundary code does (`advanceNonMyopic` in epochRewards.ts), to the
 * epoch wanted. Each step needs the store's records of that boundary: the `go` snapshot's pools
 * (kept for four epochs), blocks made, the pot snapshot and the reward epoch.
 */
import type { StakeReads } from "../ledger/stakeStore";
import type { GovReads } from "../ledger/govStore";
import { toFraction } from "../network/n2c/pparamsCbor";
import { freshLikelihoods, updateLikelihoods, type GoPool, type Likelihood, type NonMyopicState } from "./nonMyopic";

// ---------------------------------------------------------------- raw CBOR navigation (a 40 MB state: no object tree)

function head(b: Uint8Array, o: number): { mt: number; n: number; p: number; indef: boolean } {
    const ib = b[o]!, mt = ib >> 5, ai = ib & 31;
    let p = o + 1, n = 0;
    if (ai < 24) n = ai;
    else if (ai <= 27) { const w = 1 << (ai - 24); for (let i = 0; i < w; i++) n = n * 256 + b[p + i]!; p += w; }
    else if (ai === 31) return { mt, n: -1, p, indef: true };
    return { mt, n, p, indef: false };
}
function end(b: Uint8Array, o: number): number {
    const h = head(b, o);
    if (h.indef) { let p = h.p; if (h.mt === 7) return p; while (b[p] !== 0xff) p = end(b, p); return p + 1; }
    switch (h.mt) {
        case 0: case 1: case 7: return h.p;
        case 2: case 3: return h.p + h.n;
        case 4: { let p = h.p; for (let i = 0; i < h.n; i++) p = end(b, p); return p; }
        case 5: { let p = h.p; for (let i = 0; i < 2 * h.n; i++) p = end(b, p); return p; }
        default: return end(b, h.p); // tag
    }
}
function children(b: Uint8Array, o: number): number[] {
    const h = head(b, o);
    if (h.mt === 6) return [h.p];
    if (h.mt !== 4 && h.mt !== 5) return [];
    const out: number[] = [], cnt = h.indef ? Infinity : h.mt === 5 ? 2 * h.n : h.n;
    let p = h.p;
    for (let i = 0; i < cnt; i++) { if (h.indef && b[p] === 0xff) break; out.push(p); p = end(b, p); }
    return out;
}
const at = (b: Uint8Array, path: number[], o = 0): number => { for (const i of path) { const c = children(b, o)[i]; if (c == null) throw new Error(`ledger state: no item ${i} on the path ${path.join(".")}`); o = c; } return o; };

/** The epoch and `esNonMyopic` of a cardano-node 11 ledger state file (`[1, [telescope, header]]`, Conway = era 6). */
export function nonMyopicOfLedgerState(state: Uint8Array): NonMyopicState {
    const nes = at(state, [1, 0, 6, 1, 1, 1]); // ext → ledger telescope → Conway → [bound, [2, ShelleyLedgerState]] → NewEpochState
    const epoch = head(state, children(state, nes)[0]!).n;
    const [m, pot] = children(state, at(state, [3, 3], nes));
    const lk = new Map<string, Likelihood>();
    const kv = children(state, m!);
    for (let i = 0; i < kv.length; i += 2) {
        const kh = head(state, kv[i]!);
        const id = Buffer.from(state.subarray(kh.p, kh.p + kh.n)).toString("hex");
        const ws = children(state, kv[i + 1]!);
        lk.set(id, Float32Array.from(ws, (o) => { if (state[o] !== 0xfa) throw new Error("ledger state: likelihood is not a float32"); return new DataView(state.buffer, state.byteOffset + o + 1, 4).getFloat32(0, false); }));
    }
    const ph = head(state, pot!);
    let rewardPot = BigInt(ph.n);
    if (state[pot!] === 0x1b) rewardPot = new DataView(state.buffer, state.byteOffset + pot! + 1, 8).getBigUint64(0, false); // beyond 2^53
    return { epoch, rewardPot, likelihoods: lk };
}

export interface AdvanceEnv { activeSlotsCoeff: string | number; slotsPerEpoch: number; maxSupply: bigint }
/**
 * One boundary: esNonMyopic of `epoch` from that of `epoch − 1` and the store's records (the
 * update applied at `epoch` was computed during `epoch − 1` from the snapshot taken at `epoch − 3`,
 * the blocks of `epoch − 2` and that epoch's parameters).
 */
export function advanceNonMyopicFromStore(prev: NonMyopicState, epoch: number, stake: StakeReads, gov: GovReads, env: AdvanceEnv): NonMyopicState {
    const takenAt = epoch - 3, perf = epoch - 2;
    const ids = [...stake.snapshotPoolParams(takenAt).keys()];
    if (!ids.length) throw new Error(`the pools of the snapshot taken at ${takenAt} are not kept`);
    const stakeAt = stake.snapshotPoolStake(takenAt), blocks = stake.blocksMade(perf);
    const pots = stake.potSnapshot(epoch - 1);
    if (!pots) throw new Error(`no pot snapshot of epoch ${epoch - 1}`);
    const re = stake.rewardEpoch(perf);
    if (!re) throw new Error(`no reward record of performance epoch ${perf}`);
    const pp = gov.epochParams(perf)?.params ?? gov.epochParams(epoch - 1)?.params;
    if (!pp) throw new Error(`no parameters of epoch ${perf}`);
    const go = new Map<string, GoPool>();
    for (const id of ids) go.set(id, { stake: stakeAt.get(id) ?? 0n, blocks: blocks.get(id) ?? 0 });
    const asc = toFraction(env.activeSlotsCoeff), d = toFraction(pp.decentralisation_param ?? 0), tau = toFraction(pp.tau ?? "0.2");
    const rewardPot = BigInt(String(re.rewardPot));
    const fresh = freshLikelihoods(go, env.maxSupply - pots.reserves, asc, d, env.slotsPerEpoch);
    return { epoch, rewardPot: rewardPot - (rewardPot * tau[0]) / tau[1], likelihoods: updateLikelihoods(prev.likelihoods, fresh) };
}

/** Advance `seed` boundary by boundary to `toEpoch`. */
export function advanceNonMyopicTo(seed: NonMyopicState, toEpoch: number, stake: StakeReads, gov: GovReads, env: AdvanceEnv): NonMyopicState {
    if (seed.epoch > toEpoch) throw new Error(`the ledger state is of epoch ${seed.epoch}, after ${toEpoch}`);
    let nm = seed;
    for (let e = seed.epoch + 1; e <= toEpoch; e++) nm = advanceNonMyopicFromStore(nm, e, stake, gov, env);
    return nm;
}
