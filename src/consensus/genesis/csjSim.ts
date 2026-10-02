/**
 * Deterministic Genesis-sync simulator with ChainSync Jumping: every simulated upstream peer serves
 * its own chain through a ChainSync-like server (a read pointer; MsgFindIntersect = "is this point on
 * my chain"), the node runs the real `ChainSel` (candidates, Limit on Eagerness), the real GDD
 * (`sharedCandidatePrefix` / `densityDisconnect`) and the real CSJ governor (`ChainSyncJumping`), and
 * executes CSJ's instructions exactly as the ChainSync client would: the dynamo and the objector (and
 * disengaged peers) download headers, jumpers only answer jumps. Adversaries: forks of any density,
 * peers that stall (MsgAwaitReply before their tip), roll back before the last jump, or answer every
 * jump with "no". No I/O, no timers.
 */
import { ChainSel, type ChainHeader, type Point } from "../chainsel/ChainSel";
import { GENESIS, incoming } from "../chainsel/sim";
import { ChainSyncJumping, headPoint, type CsjEvent, type JumpInfo } from "./csj";
import { densityDisconnect, sharedCandidatePrefix, type GddPeerState } from "./gdd";

export interface SimPeerSpec {
    name: string;
    /** The chain it serves, oldest first, starting right after GENESIS. */
    chain: ChainHeader[];
    /** Claims MsgAwaitReply once its read pointer has served this many headers of its chain (an early stall). */
    stallAtIndex?: number;
    /** Answers every jump (MsgFindIntersect) with IntersectNotFound — a lying jumper; "also-good": even its own good point as objector. */
    rejectAllJumps?: boolean | "also-good";
    /** As a header-downloading peer, once it has served header `afterIndex` it rolls back to `toIndex` (once). */
    rollBackOnce?: { afterIndex: number; toIndex: number };
}

interface SimPeer extends SimPeerSpec {
    ptr: number; // index of the last header served (-1: GENESIS)
    byHash: Map<string, number>;
    served: number; // MsgRollForward sent (header downloads)
    findIntersects: number;
    idle: boolean;
    rolledBack: boolean;
}

export interface CsjSimOptions {
    k: number; jumpSize: bigint; sgen: bigint; csj?: boolean; maxTicks?: number;
    /** Wall-clock slot: a header beyond it is from the future (the ChainSync client disconnects its peer: InFutureHeaderExceedsClockSkew). */
    nowSlot?: bigint;
}

export class CsjSim {
    readonly cs: ChainSel;
    readonly csj: ChainSyncJumping | null;
    readonly peers = new Map<string, SimPeer>();
    readonly disconnected = new Map<string, string>();
    readonly events: CsjEvent[] = [];
    ticks = 0;
    /** Most CSJ-engaged peers (dynamo / objector) that downloaded a header in one tick. */
    maxEngagedDownloaders = 0;

    constructor(readonly o: CsjSimOptions, specs: SimPeerSpec[]) {
        this.cs = new ChainSel({ k: o.k, anchor: GENESIS });
        this.csj = o.csj === false ? null : new ChainSyncJumping(o.jumpSize, {
            candidate: (p) => this.candidateInfo(p),
            setCandidate: (p, info) => this.setCandidate(p, info),
        }, (e) => this.events.push(e));
        for (const s of specs) {
            const p: SimPeer = { ...s, ptr: -1, byHash: new Map(s.chain.map((h, i) => [h.hash, i])), served: 0, findIntersects: 0, idle: false, rolledBack: false };
            this.peers.set(s.name, p);
            this.cs.addPeer(s.name, GENESIS);
            this.csj?.register(s.name, "Syncing");
        }
    }

    /** The peer's candidate as CSJ sees it: anchored at our immutable tip. */
    private candidateInfo(peer: string): JumpInfo<ChainHeader> | null {
        const c = this.cs.candidateFromImmutable(peer);
        if (!c) return null;
        const imm = this.cs.immutableTip();
        return { anchor: { hash: imm.hash, slot: imm.slot }, headers: c };
    }

    /** An accepted jump: the jumper's candidate becomes the (dynamo's) jump fragment. */
    private setCandidate(peer: string, info: JumpInfo): void {
        if (!this.cs.hasPeer(peer)) return;
        // re-anchor at our immutable tip when it moved into the jump fragment since the snapshot
        const imm = this.cs.immutableTip();
        let anchor: Point = { hash: info.anchor.hash, slot: info.anchor.slot, blockNo: 0n };
        let hs = info.headers as readonly ChainHeader[];
        const j = hs.findIndex((h) => h.hash === imm.hash);
        if (j >= 0) { anchor = imm; hs = hs.slice(j + 1); }
        this.cs.removePeer(peer);
        this.cs.addPeer(peer, anchor);
        for (const h of hs) this.cs.rollForward(peer, incoming(h));
        this.cs.noteLatestSlot(peer, headPoint(info).slot); // csLatestSlot = head of the jump fragment (the GDD skips peers without one)
    }

    private onChain(p: SimPeer, pt: { hash: string }): number | undefined {
        if (pt.hash === GENESIS.hash) return -1;
        return p.byHash.get(pt.hash);
    }

    disconnect(peer: string, why: string): void {
        if (this.disconnected.has(peer)) return;
        this.disconnected.set(peer, why);
        this.cs.removePeer(peer);
        this.csj?.unregister(peer);
    }

    /** One ChainSync step of `peer` as CSJ instructs (or plain ChainSync without CSJ). */
    private stepPeer(p: SimPeer): void {
        const instr = this.csj ? this.csj.nextInstruction(p.name) : { kind: "run" as const };
        if (instr.kind === "wait") return;
        if (instr.kind === "restart") {
            // MsgFindIntersect with our chain: the newest of our points on its chain
            let at: Point = GENESIS;
            for (const h of [...this.cs.ourChain()].reverse()) if (p.byHash.has(h.hash)) { at = h; break; }
            if (at === GENESIS && p.byHash.has(this.cs.immutableTip().hash)) at = this.cs.immutableTip();
            p.findIntersects++;
            p.ptr = this.onChain(p, at) ?? -1;
            this.cs.removePeer(p.name);
            this.cs.addPeer(p.name, at);
            return;
        }
        if (instr.kind === "jumpTo" || instr.kind === "jumpToGood") {
            p.findIntersects++;
            const target = headPoint(instr.info);
            const idx = this.onChain(p, target);
            const accepted = idx !== undefined && !(p.rejectAllJumps && (instr.kind === "jumpTo" || p.rejectAllJumps === "also-good"));
            if (accepted) p.ptr = idx!; // IntersectFound moves the server's read pointer there: normal ChainSync (dynamo, objector, disengaged) continues from it
            this.csj!.processJumpResult(p.name, { accepted, instruction: instr });
            return;
        }
        // run normally: one MsgRequestNext
        if (p.rollBackOnce && !p.rolledBack && p.ptr >= p.rollBackOnce.afterIndex) {
            p.rolledBack = true;
            p.ptr = p.rollBackOnce.toIndex;
            const to = p.ptr < 0 ? GENESIS : p.chain[p.ptr]!;
            this.cs.rollBackward(p.name, { hash: to.hash, slot: to.slot });
            this.csj?.onRollBackward(p.name, p.ptr < 0 ? null : to.slot);
            return;
        }
        const next = p.chain[p.ptr + 1];
        if (!next || (p.stallAtIndex != null && p.ptr + 1 > p.stallAtIndex)) {
            if (!p.idle) { p.idle = true; this.csj?.onAwaitReply(p.name); }
            return;
        }
        p.idle = false;
        if (this.o.nowSlot != null && next.slot > this.o.nowSlot) { this.disconnect(p.name, "header from the future"); return; }
        this.csj?.onRollForward(p.name, next);
        p.ptr++;
        p.served++;
        this.cs.rollForward(p.name, incoming(next));
        const info = this.candidateInfo(p.name);
        if (info) this.csj?.updateJumpInfo(p.name, info);
    }

    /** LoE (shared candidate prefix), GDD, then chain selection — as ChainSelDriver.runGenesis + select. */
    private judge(): void {
        const live = [...this.peers.keys()].filter((p) => !this.disconnected.has(p));
        const cands = new Map<string, ChainHeader[] | null>();
        for (const p of live) cands.set(p, this.cs.candidateFromImmutable(p));
        const { loe, suffixes } = sharedCandidatePrefix(cands);
        const imm = this.cs.immutableTip();
        const loeTip = loe.length ? loe[loe.length - 1]! : imm;
        const states = new Map<string, GddPeerState>();
        for (const p of live) states.set(p, { latestSlot: this.cs.fragmentOf(p)?.latestSlot ?? null, idling: this.peers.get(p)!.idle });
        const { losing } = densityDisconnect(this.o.sgen, this.o.k, states, suffixes, { hash: loeTip.hash, slot: loeTip.slot });
        for (const p of losing) this.disconnect(p, "GDD");
        for (let guard = 0; guard < 8; guard++) {
            const r = this.cs.select({ loe: { hash: loeTip.hash, slot: loeTip.slot, blockNo: loeTip.blockNo }, prefer: this.csj?.dynamo() ?? null });
            for (const pu of r.punish) this.disconnect(pu.peer, pu.why);
            if (!r.best) break;
            if (r.best.rollback > 0) this.cs.rollbackOursTo(r.best.intersection.hash);
            for (const h of r.best.suffix) this.cs.extendOurs(incoming(h));
        }
    }

    /** Run until nothing changes (every live peer idle or waiting, and our tip stable) or maxTicks. */
    run(): this {
        const max = this.o.maxTicks ?? 200_000;
        let quiet = 0;
        while (this.ticks < max) {
            this.ticks++;
            const before = this.cs.ourTip().hash;
            const servedBefore = this.totalServed();
            let engaged = 0;
            for (const p of this.peers.values()) {
                if (this.disconnected.has(p.name)) continue;
                const st = this.csj?.stateOf(p.name)?.kind;
                const n = p.served;
                this.stepPeer(p);
                if (p.served > n && st !== "disengaged") engaged++;
            }
            this.maxEngagedDownloaders = Math.max(this.maxEngagedDownloaders, engaged);
            this.judge();
            const busy = this.cs.ourTip().hash !== before || this.totalServed() !== servedBefore;
            quiet = busy ? 0 : quiet + 1;
            if (quiet > 50) break;
        }
        return this;
    }

    totalServed(): number { let n = 0; for (const p of this.peers.values()) n += p.served; return n; }
    served(peer: string): number { return this.peers.get(peer)!.served; }
    tip(): ChainHeader { return this.cs.ourTip(); }
}
