/**
 * Restart timing around an epoch boundary (bugs 341, 342). The node feeds every applied block to
 * the evolver, persists each TICKN (η0 + start state) at once and the running ηv / ηc once per
 * applied range; a restart reads η0 back from the store. These tests run that flow with an
 * in-memory store and "restart" at the two points that broke preview 3037.
 */
import { describe, expect, test } from "bun:test";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { NonceEvolver, RangeNonceSnapshot, type TicknResult } from "./nonceEvolver";
import { setEpochNetwork, firstSlotOfEpoch } from "./epochFromSlotCalculations";

const genesis: any = { securityParam: 2160, activeSlotsCoeff: 0.05, epochLength: 432000, network: "preprod" };
const rnd = (seed: number) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i * 17 + (seed >> 8)) & 0xff; return b; };
type Blk = { slot: number; bnonce: Uint8Array; prev: Uint8Array };
const chain = (fromSlot: number, toSlot: number, step = 20): Blk[] => { const out: Blk[] = []; let prev = rnd(fromSlot + 7); for (let s = fromSlot; s < toSlot; s += step) { out.push({ slot: s, bnonce: rnd(s), prev }); prev = rnd(s + 1); } return out; };

/** The orchestrator's nonce bookkeeping over a key-value "store", minus the network. */
class Node {
    readonly store = new Map<number, { nonceHex: string; evolvingHex: string | null; candidateHex: string | null; startEvolvingHex?: string; startCandidateHex?: string }>();
    readonly cache = new Map<number, string>(); // epochNonceCache (in memory, lost on restart)
    ev = new NonceEvolver(genesis);
    snap = new RangeNonceSnapshot();
    private recordTickn(t: TicknResult): void {
        this.cache.set(t.epoch, t.eta0Hex);
        this.store.set(t.epoch, { ...this.store.get(t.epoch), nonceHex: t.eta0Hex, evolvingHex: t.etaVHex, candidateHex: t.etaCHex, startEvolvingHex: t.etaVHex, startCandidateHex: t.etaCHex });
    }
    /** η0 the header stage hands the applier: cache → store → the evolver's frozen candidate (peek). */
    nonceFor(epoch: number, tipSlot: number): string | null {
        return this.cache.get(epoch) ?? this.store.get(epoch)?.nonceHex ?? (epoch === this.ev.getEpoch() + 1 ? this.ev.peekNextEpochNonceHex(tipSlot) : null);
    }
    /** applyRange: feed every block (feedNonceEvolver), then persist the snapshot (persistNonceSnapshot). */
    applyRange(blocks: Blk[], epochOf: (s: number) => number): void {
        for (const b of blocks) {
            const eta0 = this.nonceFor(epochOf(b.slot), b.slot)!; // headers are validated before their block applies
            expect(eta0).toBeTruthy();
            const tickns = this.ev.processBlock(b.slot, b.bnonce, b.prev);
            for (const t of tickns) this.recordTickn(t);
            this.snap.note(epochOf(b.slot), eta0, tickns);
        }
        const rec = this.snap.take(this.ev);
        if (rec) this.store.set(rec.epoch, { ...this.store.get(rec.epoch)!, nonceHex: rec.eta0Hex, evolvingHex: rec.etaVHex, candidateHex: rec.etaCHex });
    }
}

describe("nonce state across a restart at an epoch boundary", () => {
    setEpochNetwork("preprod");
    const e = 6;
    const firstE = Number(firstSlotOfEpoch(e)), firstNext = Number(firstSlotOfEpoch(e + 1));
    const epochOf = (s: number) => (s >= firstNext ? e + 1 : e);
    const blocks = [...chain(firstE, firstNext), ...chain(firstNext + 3, firstNext + 400)];
    const boundaryIdx = blocks.findIndex((b) => b.slot >= firstNext);

    const reference = (): string => {
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(e, toHex(rnd(1)));
        let t: TicknResult[] = [];
        for (const b of blocks) t = t.concat(ev.processBlock(b.slot, b.bnonce, b.prev));
        return t[0]!.eta0Hex;
    };

    test("bug 341: a range ending on the boundary block persists the new epoch's η0, not the previous one's", () => {
        const eta0Next = reference();
        const node = new Node();
        node.ev.bootstrap(e, toHex(rnd(1)));
        node.store.set(e, { nonceHex: toHex(rnd(1)), evolvingHex: null, candidateHex: null });
        // ranges of 50 blocks, the last one cut right after the first block of e + 1 (shutdown stops new ranges)
        for (let i = 0; i < boundaryIdx - 3; i += 50) node.applyRange(blocks.slice(i, Math.min(i + 50, boundaryIdx - 3)), epochOf);
        node.applyRange(blocks.slice(boundaryIdx - 3, boundaryIdx + 1), epochOf);
        expect(node.cache.get(e + 1)).toBe(eta0Next); // the running process is right…
        // …and so is what a restart reads back (before the fix: η0 of epoch e, every header of e + 1 failed its VRF)
        expect(node.store.get(e + 1)!.nonceHex).toBe(eta0Next);
        expect(node.store.get(e + 1)!.nonceHex).not.toBe(node.store.get(e)!.nonceHex);
        // the running ηv / ηc stored for e + 1 are the evolver's after the boundary block
        const s = node.ev.snapshot();
        expect(node.store.get(e + 1)!.evolvingHex).toBe(s.etaVHex);
        expect(node.store.get(e + 1)!.candidateHex).toBe(s.etaCHex);
        // a later range of e + 1 keeps it
        node.applyRange(blocks.slice(boundaryIdx + 1, boundaryIdx + 5), epochOf);
        expect(node.store.get(e + 1)!.nonceHex).toBe(eta0Next);
    });

    test("bug 341: a range ending on the last block of e and a range of only the boundary block", () => {
        const eta0Next = reference();
        const node = new Node();
        node.ev.bootstrap(e, toHex(rnd(1)));
        node.store.set(e, { nonceHex: toHex(rnd(1)), evolvingHex: null, candidateHex: null });
        node.applyRange(blocks.slice(0, boundaryIdx), epochOf);
        expect(node.store.get(e)!.nonceHex).toBe(toHex(rnd(1)));
        node.applyRange(blocks.slice(boundaryIdx, boundaryIdx + 1), epochOf);
        expect(node.store.get(e + 1)!.nonceHex).toBe(eta0Next);
    });

    test("bug 342: a restart's header replay in progress must not answer the next epoch's η0", () => {
        const eta0Next = reference();
        const lastOfE = blocks[boundaryIdx - 1]!.slot; // applied tip after the restart, past the freeze
        const ev = new NonceEvolver(genesis);
        ev.bootstrap(e, toHex(rnd(1))); // from the epoch-start state, as bootstrapEvolver does
        const half = Math.floor(boundaryIdx / 2); // replay still before the freeze
        for (const b of blocks.slice(0, half)) ev.processBlock(b.slot, b.bnonce, b.prev);
        // before the fix: the tip slot was past the freeze, so the half-replayed ηc was handed out as η0(e + 1)
        expect(ev.peekNextEpochNonceHex(lastOfE)).toBeNull();
        for (const b of blocks.slice(half, boundaryIdx)) ev.processBlock(b.slot, b.bnonce, b.prev);
        expect(ev.peekNextEpochNonceHex(lastOfE)).toBe(eta0Next);
        // an imported snapshot state at a slot past the freeze answers at once
        const s = ev.snapshot();
        const imp = new NonceEvolver(genesis);
        imp.bootstrap(e, toHex(rnd(1)), { etaVHex: s.etaVHex, etaCHex: s.etaCHex, etaHHex: s.etaHHex, atSlot: lastOfE });
        expect(imp.peekNextEpochNonceHex(lastOfE)).toBe(eta0Next);
    });
});
