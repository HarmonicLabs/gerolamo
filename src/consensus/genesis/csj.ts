/**
 * ChainSync Jumping (CSJ), ported from ouroboros-consensus 3.0.1 (cardano-node 11):
 * `Ouroboros.Consensus.MiniProtocol.ChainSync.Client.Jumping` and the state types of
 * `…ChainSync.Client.State`. Genesis mode only, and only while the GSM is not CaughtUp.
 *
 * One peer, the *dynamo*, runs normal ChainSync and gives us the chain. Every other engaged peer is a
 * *jumper*: it downloads no headers; each time the dynamo has delivered `jumpSize` slots past the last
 * jump, every happy jumper is asked whether it has the dynamo's newest validated header (a
 * MsgFindIntersect with that one point). Accepted → the jumper's candidate becomes the dynamo's
 * fragment up to that point. Rejected → the jumper binary-searches (more single-point jumps) for the
 * exact point where it stops agreeing; the dissenting jumper with the oldest intersection becomes the
 * *objector*, which runs normal ChainSync from its last agreed point so the GDD can compare the two
 * chains' densities and disconnect the loser. At most two plausibly honest peers download headers at
 * a time. A peer that claims to have no more headers (MsgAwaitReply), a dynamo that rolls back before
 * its last jump, an objector that rolls back before (or rolls forward exactly to) the point it
 * disputed, is *disengaged*: it is never asked to jump again and simply runs normal ChainSync. CSJ is
 * over once every peer is disengaged.
 *
 *                 j       ╔════════╗
 *             ╭────────── ║ Dynamo ║ ◀─────────╮
 *             │        ╭─ ╚════════╝           │f
 *             ▼        │         ▲             │
 *     ┌────────────┐   │         │     k     ┌──────────┐
 *     │ Disengaged │ ◀─│─────────│────────── │ Objector │
 *     └────────────┘   │   ╭─────│────────── └──────────┘
 *                     l│  g│     │e         b  │    ▲ │
 *                  ╭╌╌╌▼╌╌╌▼╌╌╌╌╌╌╌╌╌╌╌╌╌│╌╌╌╌╌╌╌╌╌│╌▼╌╌╌╮
 *                  ┆ Happy ──a──▶ LookingForIntersection ──d──▶ FoundIntersection ┆
 *                  ┆ Jumper ◀──────────h───────────────────────────╯             ┆
 *                  ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
 *
 * Pure state machine over plain data (the Haskell TVars become fields, STM transactions become
 * synchronous methods); the ChainSync side (`CsjHooks`, the orchestrator / the simulator) executes
 * the instructions and reports the results. `jumpSize` defaults to cardano-node's
 * `defaultCSJJumpSize = 2 * 2160` slots (the mainnet Byron forecast range, the same on every network;
 * configurable as `consensus.csjJumpSize`).
 */

export const DEFAULT_CSJ_JUMP_SIZE = 2n * 2160n;

/** A point of a chain: header hash (hex) and slot. */
export interface CsjPoint { hash: string; slot: bigint }

/**
 * `JumpInfo`: a snapshot of a peer's candidate (the Haskell `jTheirFragment`, possibly a proper
 * prefix of it). `anchor` is the fragment's anchor (our immutable tip when it was taken); `headers`
 * follow it, oldest first.
 */
export interface JumpInfo<H extends CsjPoint = CsjPoint> { anchor: CsjPoint; headers: readonly H[] }

export const headPoint = (j: JumpInfo): CsjPoint => (j.headers.length ? j.headers[j.headers.length - 1]! : j.anchor);
const headSlot = (j: JumpInfo): bigint => headPoint(j).slot;
const pointEq = (a: CsjPoint, b: CsjPoint): boolean => a.slot === b.slot && a.hash.toLowerCase() === b.hash.toLowerCase();

export type DynamoInit = { kind: "starting"; good: JumpInfo } | { kind: "started" };
export type ObjectorInit = "starting" | "started";
export type JumperInit = "fresh" | "started";
export type JumperState =
    /** Agrees with the dynamo as of the last jump; `lastGood`: that accepted jump. */
    | { kind: "happy"; init: JumperInit; lastGood: JumpInfo | null }
    /** Rejected a jump: agrees at `good`'s head, disagrees at `bad`'s head (good's head is in bad's fragment or before it). */
    | { kind: "lfi"; good: JumpInfo; bad: JumpInfo }
    /** Knows its latest agreement (`good`) and earliest disagreement (`badPoint`) with the dynamo. */
    | { kind: "fi"; init: ObjectorInit; good: JumpInfo; badPoint: CsjPoint };
export type CsjState =
    /** `lastJumpSlot`: slot of the last jump requested (null = origin). */
    | { kind: "dynamo"; init: DynamoInit; lastJumpSlot: bigint | null }
    | { kind: "objector"; init: ObjectorInit; good: JumpInfo; badPoint: CsjPoint }
    | { kind: "disengaged"; init: "disengaging" | "done" }
    | { kind: "jumper"; nextJump: JumpInfo | null; state: JumperState };

export type Instruction =
    | { kind: "run" }
    /** Restart ChainSync from scratch (a disengaged peer whose server position we do not know). */
    | { kind: "restart" }
    /** MsgFindIntersect [head of info]; report Accepted/Rejected through `processJumpResult`. */
    | { kind: "jumpTo"; info: JumpInfo }
    /** Position the server at head of info (a starting dynamo / objector), then run normally. */
    | { kind: "jumpToGood"; info: JumpInfo }
    /** A jumper with no jump to make: ask again later. */
    | { kind: "wait" };

export type JumpResult = { accepted: boolean; instruction: Extract<Instruction, { kind: "jumpTo" } | { kind: "jumpToGood" }> };

export type CsjReason = "disengage" | "disconnect";
export type CsjEvent =
    | { kind: "initializedAsDynamo"; peer: string }
    | { kind: "sentJumpInstruction"; peer: string; to: CsjPoint }
    | { kind: "becomingObjector"; peer: string; previous: string | null }
    | { kind: "noLongerDynamo"; peer: string; next: string | null; reason: CsjReason }
    | { kind: "noLongerObjector"; peer: string; next: string | null; reason: CsjReason }
    | { kind: "rotatedDynamo"; from: string; to: string };

/** What CSJ needs from the ChainSync side. */
export interface CsjHooks {
    /** `csCandidate` of the peer (anchored at our immutable tip); null when it has none. */
    candidate(peer: string): JumpInfo | null;
    /** An accepted jump: the jumper's candidate becomes `info` (`csCandidate` / `csLatestSlot`). */
    setCandidate(peer: string, info: JumpInfo): void;
}

interface Handle { peer: string; csj: CsjState; jumpInfo: JumpInfo | null }

export class ChainSyncJumping {
    /** The ChainSync client handles in registration order (`cschcSeq`; `rotateDynamo` moves one to the end). */
    private readonly handles: Handle[] = [];
    readonly events: CsjEvent[] = [];
    private static readonly EVENT_CAP = 1000;

    constructor(readonly jumpSize: bigint, private readonly hooks: CsjHooks, private readonly onEvent?: (e: CsjEvent) => void) {}

    private emit(e: CsjEvent | null): void {
        if (!e) return;
        this.events.push(e);
        if (this.events.length > ChainSyncJumping.EVENT_CAP) this.events.shift();
        this.onEvent?.(e);
    }
    private handle(peer: string): Handle | undefined { return this.handles.find((h) => h.peer === peer); }

    // ───────────────────────────── queries ─────────────────────────────

    stateOf(peer: string): CsjState | null { return this.handle(peer)?.csj ?? null; }
    peers(): string[] { return this.handles.map((h) => h.peer); }
    dynamo(): string | null { return this.handles.find((h) => h.csj.kind === "dynamo")?.peer ?? null; }
    objector(): string | null { return this.handles.find((h) => h.csj.kind === "objector")?.peer ?? null; }
    /** Peers that run normal ChainSync now (dynamo, objector, disengaged): the ones whose headers we download. */
    downloading(): string[] { return this.handles.filter((h) => h.csj.kind !== "jumper").map((h) => h.peer); }
    /** CSJ has nothing left to do: every registered peer is disengaged. */
    finished(): boolean { return this.handles.every((h) => h.csj.kind === "disengaged"); }
    summary(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const h of this.handles) out[h.peer] = h.csj.kind === "jumper" ? `jumper:${h.csj.state.kind}` : h.csj.kind;
        return out;
    }

    // ───────────────────────────── registration ─────────────────────────────

    /**
     * `registerClient`: the GSM state when the peer connected decides — CaughtUp → disengaged at once
     * (CSJ is off); otherwise the first peer becomes the dynamo and the others happy jumpers.
     */
    register(peer: string, gsm: "PreSyncing" | "Syncing" | "CaughtUp"): void {
        if (this.handle(peer)) return;
        let csj: CsjState;
        if (gsm === "CaughtUp") csj = { kind: "disengaged", init: "done" };
        else {
            const dyn = this.handles.find((h) => h.csj.kind === "dynamo");
            if (!dyn) {
                const cand = this.hooks.candidate(peer);
                csj = { kind: "dynamo", init: { kind: "started" }, lastJumpSlot: cand ? cand.anchor.slot : null };
                this.handles.push({ peer, csj, jumpInfo: null });
                this.emit({ kind: "initializedAsDynamo", peer });
                return;
            }
            csj = { kind: "jumper", nextJump: dyn.jumpInfo, state: { kind: "happy", init: "fresh", lastGood: null } };
        }
        this.handles.push({ peer, csj, jumpInfo: null });
    }

    /** `unregisterClient`: a disconnected dynamo / objector is replaced. */
    unregister(peer: string): void {
        const i = this.handles.findIndex((h) => h.peer === peer);
        if (i < 0) return;
        const [h] = this.handles.splice(i, 1);
        if (h!.csj.kind === "objector") this.emit(this.electNewObjector(peer, "disconnect"));
        else if (h!.csj.kind === "dynamo") this.emit(this.backfillDynamo(peer, "disconnect"));
    }

    // ───────────────────────────── ChainSync callbacks ─────────────────────────────

    /** `nextInstruction` (the blocking variant returns `wait` for a jumper with nothing to do). */
    nextInstruction(peer: string): Instruction {
        const h = this.handle(peer);
        if (!h) return { kind: "run" };
        const s = h.csj;
        switch (s.kind) {
            case "disengaged":
                if (s.init === "done") return { kind: "run" };
                h.csj = { kind: "disengaged", init: "done" };
                return { kind: "restart" };
            case "dynamo":
                if (s.init.kind === "starting") { const good = s.init.good; h.csj = { kind: "dynamo", init: { kind: "started" }, lastJumpSlot: s.lastJumpSlot }; return { kind: "jumpToGood", info: good }; }
                return { kind: "run" };
            case "objector":
                if (s.init === "starting") { h.csj = { ...s, init: "started" }; return { kind: "jumpToGood", info: s.good }; }
                return { kind: "run" };
            case "jumper": {
                if (!s.nextJump) return { kind: "wait" };
                const info = s.nextJump;
                const state: JumperState = s.state.kind === "happy" && s.state.init === "fresh" ? { kind: "happy", init: "started", lastGood: s.state.lastGood } : s.state;
                h.csj = { kind: "jumper", nextJump: null, state };
                return { kind: "jumpTo", info };
            }
        }
    }

    /**
     * `jgUpdateJumpInfo`: the peer's ChainSync client validated a header; `info` is its candidate
     * (the jump a jumper would make to follow it). Ignored for disengaged peers.
     */
    updateJumpInfo(peer: string, info: JumpInfo): void {
        const h = this.handle(peer);
        if (h && h.csj.kind !== "disengaged") h.jumpInfo = info;
    }

    /**
     * `onRollForward`, before the header is validated. The dynamo: once the header is more than
     * `jumpSize` slots past the last jump, every happy jumper is asked to jump to the dynamo's last
     * validated header (its jump info). The objector: a header exactly at the point it disputed means
     * it agrees with the dynamo after all — disengage it.
     */
    onRollForward(peer: string, point: CsjPoint): void {
        const h = this.handle(peer);
        if (!h) return;
        const s = h.csj;
        if (s.kind === "objector") {
            if (pointEq(s.badPoint, point)) { this.disengage(h); this.emit(this.electNewObjector(peer, "disengage")); }
            return;
        }
        if (s.kind !== "dynamo") return;
        const succ = (x: bigint | null) => (x == null ? 0n : x + 1n);
        if (!(succ(point.slot) > this.jumpSize + succ(s.lastJumpSlot))) return;
        const info = h.jumpInfo;
        if (!info) return; // (Haskell: `error`) nothing validated from it yet: the next header triggers the jump
        h.csj = { kind: "dynamo", init: { kind: "started" }, lastJumpSlot: headSlot(info) };
        for (const o of this.handles) if (o.csj.kind === "jumper" && o.csj.state.kind === "happy") o.csj = { ...o.csj, nextJump: info };
        this.emit({ kind: "sentJumpInstruction", peer, to: headPoint(info) });
    }

    /**
     * `onRollBackward` (`slot` null = origin). A dynamo rolling back before its last jump, or an objector
     * before the point it disputed, would let an adversary serve the dynamo's own chain as the objector:
     * disengage it.
     */
    onRollBackward(peer: string, slot: bigint | null): void {
        const h = this.handle(peer);
        if (!h) return;
        const lt = (a: bigint | null, b: bigint | null) => (a ?? -1n) < (b ?? -1n);
        const s = h.csj;
        if (s.kind === "objector" && lt(slot, s.badPoint.slot)) { this.disengage(h); this.emit(this.electNewObjector(peer, "disengage")); }
        else if (s.kind === "dynamo" && lt(slot, s.lastJumpSlot)) { this.disengage(h); this.emit(this.backfillDynamo(peer, "disengage")); }
    }

    /** `onAwaitReply`: the peer has no more headers. A dynamo / objector is replaced; every peer is disengaged. */
    onAwaitReply(peer: string): void {
        const h = this.handle(peer);
        if (!h) return;
        const kind = h.csj.kind;
        if (kind === "disengaged") return;
        this.disengage(h);
        if (kind === "dynamo") this.emit(this.backfillDynamo(peer, "disengage"));
        else if (kind === "objector") this.emit(this.electNewObjector(peer, "disengage"));
    }

    /** `processJumpResult`: the answer to a jump (accepted = the server's intersection is the jump point). */
    processJumpResult(peer: string, r: JumpResult): void {
        const h = this.handle(peer);
        if (!h) return;
        const s = h.csj;
        const instr = r.instruction;
        if (s.kind === "disengaged") return;
        if (s.kind === "dynamo" || s.kind === "objector") {
            if (instr.kind !== "jumpToGood") return; // JumpTo results are not interesting for them
            if (r.accepted) { this.hooks.setCandidate(peer, instr.info); h.jumpInfo = instr.info; return; }
            // rejecting its own good point: it rolled back before the last jump
            this.disengage(h, "disengaging");
            this.emit(s.kind === "dynamo" ? this.backfillDynamo(peer, "disengage") : this.electNewObjector(peer, "disengage"));
            return;
        }
        // jumper
        if (instr.kind !== "jumpTo") return;
        const st = s.state;
        if (r.accepted) {
            const good = instr.info;
            // the jumper's candidate is the dynamo's fragment up to the accepted point; jumpers' candidates
            // do not grow otherwise (only the dynamo and the objector download headers)
            this.hooks.setCandidate(peer, good);
            h.jumpInfo = good;
            if (st.kind === "lfi") { this.emit(this.lookForIntersection(h, good, st.bad)); return; }
            if (st.kind === "happy") { if (st.init === "started") h.csj = { kind: "jumper", nextJump: s.nextJump, state: { kind: "happy", init: "started", lastGood: good } }; return; }
            throw new Error("csj processJumpResult: a jumper in FoundIntersection does not jump");
        }
        const bad = instr.info;
        if (st.kind === "lfi") { this.emit(this.lookForIntersection(h, st.good, bad)); return; }
        if (st.kind === "happy") {
            if (st.init === "fresh") return;
            // no accepted jump yet: the bad fragment's anchor is the good point
            const good = st.lastGood ?? { anchor: bad.anchor, headers: [] };
            this.emit(this.lookForIntersection(h, good, bad));
            return;
        }
        throw new Error("csj processJumpResult (rejected): a jumper in FoundIntersection does not jump");
    }

    /**
     * `rotateDynamo` (requested by BlockFetch when the dynamo serves blocks too slowly): the dynamo goes to
     * the end of the queue, every engaged peer becomes a fresh jumper and the first engaged one is the
     * new dynamo. No-op when it is the only engaged peer or not the dynamo.
     */
    rotateDynamo(peer: string): void {
        const i = this.handles.findIndex((h) => h.peer === peer);
        if (i < 0 || this.handles[i]!.csj.kind !== "dynamo") return;
        const [old] = this.handles.splice(i, 1);
        this.handles.push(old!);
        const next = this.handles.find((h) => h.csj.kind !== "disengaged");
        if (!next || next.peer === peer) return;
        old!.csj = { kind: "jumper", nextJump: null, state: { kind: "happy", init: "fresh", lastGood: null } };
        this.promoteToDynamo(next);
        this.emit({ kind: "rotatedDynamo", from: peer, to: next.peer });
    }

    // ───────────────────────────── internals ─────────────────────────────

    private disengage(h: Handle, init: "disengaging" | "done" = "done"): void {
        h.csj = { kind: "disengaged", init };
        h.jumpInfo = null;
    }

    /**
     * `lookForIntersection`: the good point (agreement) is in the bad fragment or before it; the bad
     * fragment's head disagrees. Done when only the bad head is left after the good point; otherwise jump
     * to the middle (drop the newest half of the bad fragment) and continue from the answer.
     */
    private lookForIntersection(h: Handle, good: JumpInfo, bad: JumpInfo): CsjEvent | null {
        const gp = headPoint(good);
        const at = pointEq(bad.anchor, gp) ? 0 : bad.headers.findIndex((x) => pointEq(x, gp)) + 1; // 0 = not in it → search the whole fragment
        const search = bad.headers.slice(at);
        const len = search.length;
        if (len <= 1) {
            if (h.csj.kind === "jumper") h.csj = { ...h.csj, nextJump: null }; // drop jumps the dynamo queued meanwhile
            return this.maybeElectNewObjector(h, good, headPoint(bad));
        }
        const theirs: JumpInfo = { anchor: bad.anchor, headers: bad.headers.slice(0, bad.headers.length - Math.floor(len / 2)) };
        h.csj = { kind: "jumper", nextJump: theirs, state: { kind: "lfi", good, bad } };
        return null;
    }

    /** No objector → this jumper is it; an objector whose disputed point is younger → this one replaces it. */
    private maybeElectNewObjector(h: Handle, good: JumpInfo, badPoint: CsjPoint): CsjEvent | null {
        const o = this.handles.find((x) => x.csj.kind === "objector");
        if (!o) { h.csj = { kind: "objector", init: "starting", good, badPoint }; return { kind: "becomingObjector", peer: h.peer, previous: null }; }
        const os = o.csj as Extract<CsjState, { kind: "objector" }>;
        if (os.badPoint.slot <= badPoint.slot) { h.csj = { kind: "jumper", nextJump: null, state: { kind: "fi", init: "starting", good, badPoint } }; return null; }
        o.csj = { kind: "jumper", nextJump: null, state: { kind: "fi", init: os.init, good: os.good, badPoint: os.badPoint } };
        h.csj = { kind: "objector", init: "starting", good, badPoint };
        return { kind: "becomingObjector", peer: h.peer, previous: o.peer };
    }

    /** `electNewObjector`: the dissenting jumper (FoundIntersection) with the oldest disputed point. */
    private electNewObjector(old: string, reason: CsjReason): CsjEvent {
        let best: Handle | null = null;
        for (const h of this.handles) {
            if (h.csj.kind !== "jumper" || h.csj.state.kind !== "fi") continue;
            if (!best || h.csj.state.badPoint.slot < (best.csj as any).state.badPoint.slot) best = h;
        }
        if (best) { const st = (best.csj as Extract<CsjState, { kind: "jumper" }>).state as Extract<JumperState, { kind: "fi" }>; best.csj = { kind: "objector", init: st.init, good: st.good, badPoint: st.badPoint }; }
        return { kind: "noLongerObjector", peer: old, next: best?.peer ?? null, reason };
    }

    /** `backfillDynamo`: prefer a Started objector (no ChainSync disruption), else the first engaged peer. */
    private backfillDynamo(old: string, reason: CsjReason): CsjEvent {
        const o = this.handles.find((h) => h.csj.kind === "objector" && h.csj.init === "started");
        const next = o ?? this.handles.find((h) => h.csj.kind !== "disengaged") ?? null;
        if (next) this.promoteToDynamo(next);
        return { kind: "noLongerDynamo", peer: old, next: next?.peer ?? null, reason };
    }

    /** `promoteToDynamo`: the peer becomes the dynamo, every other engaged peer a fresh happy jumper. */
    private promoteToDynamo(dyn: Handle): void {
        const ji = dyn.jumpInfo;
        if (dyn.csj.kind === "objector" && dyn.csj.init === "started") {
            dyn.csj = { kind: "dynamo", init: { kind: "started" }, lastJumpSlot: headSlot(dyn.csj.good) };
        } else {
            const cand = this.hooks.candidate(dyn.peer);
            // no jump info: the peer is just starting, its server needs no positioning
            dyn.csj = { kind: "dynamo", init: ji ? { kind: "starting", good: ji } : { kind: "started" }, lastJumpSlot: cand ? headSlot(cand) : null };
        }
        for (const h of this.handles) {
            if (h === dyn || h.csj.kind === "disengaged") continue;
            h.csj = { kind: "jumper", nextJump: ji, state: { kind: "happy", init: "fresh", lastGood: null } };
        }
    }
}
