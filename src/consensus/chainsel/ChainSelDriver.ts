/**
 * Bridges the orchestrator to ouroboros-consensus-style chain selection (ChainSel.ts) and, in
 * Genesis mode, to the Genesis State Machine, the Limit on Eagerness and the Genesis Density
 * Disconnector (genesis/).
 *
 * Switch (config `consensus.chainSelection` or GEROLAMO_CHAIN_SELECTION):
 *   "legacy" (default): primary peer + verifier votes, Praos tie-break on equal-length outvotes;
 *   "shadow": the ouroboros-consensus selection runs beside legacy and only logs/counts what it would do;
 *   "praos": every hot peer's validated headers form its candidate fragment; the node follows the
 *            best candidate that forks at most k blocks back (longest, then the Praos tie-break,
 *            restricted VRF from Conway); invalid blocks are remembered and the peers that serve
 *            them, or a fork deeper than k, are disconnected.
 * Consensus mode (`consensus.mode` or GEROLAMO_CONSENSUS_MODE, cardano-node's ConsensusMode):
 *   "praos" (default) or "genesis" (requires chainSelection "praos"): GSM + LoE + GDD + ChainSync
 *   Jumping (genesis/csj.ts; `consensus.csj: false` or GEROLAMO_CSJ=0 turns CSJ off, every peer then
 *   streams its full chain).
 *
 * Our chain inside ChainSel is reconciled with the database tip before each decision (walking back
 * by prev-hash), so applies, rollbacks and aborted ranges need no hooks.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../../utils/logger";
import { ChainSel, type Candidate, type ChainHeader, type IncomingHeader, type Point } from "./ChainSel";
import { GenesisStateMachine, GSM_DEFAULTS, honestAvailability, type GsmState } from "../genesis/gsm";
import { densityDisconnect, sharedCandidatePrefix, type GddPeerState } from "../genesis/gdd";
import { ChainSyncJumping, DEFAULT_CSJ_JUMP_SIZE, headPoint, type CsjEvent, type Instruction, type JumpInfo, type JumpResult } from "../genesis/csj";
import type { TieBreakInfo } from "../tieBreak";
import { ShadowAudit } from "./shadowAudit";

const log = logger.child("chainsel");

export type ChainSelectionMode = "legacy" | "shadow" | "praos";
export type ConsensusMode = "praos" | "genesis";

/**
 * Narrow interface to the big-ledger-peer set (peer selection owns it: src/network/ledgerPeers.ts,
 * PeerGovernor.ts). Keys are the node's peer keys (`host:port`).
 */
export interface BigLedgerPeerSource { bigLedgerPeers(): readonly string[] }

export interface ConsensusConfigLike {
    consensus?: {
        chainSelection?: ChainSelectionMode;
        mode?: ConsensusMode;
        /** Genesis: active big ledger peers required for the Honest Availability Assumption (default 5). */
        minBigLedgerPeersForTrustedState?: number;
        /** Genesis: the node only ever connects to trusted local roots (cardano-node `LocalRootsOnly`): HAA holds. */
        localRootsOnly?: boolean;
        /** Genesis: GSM `maxCaughtUpAge` (default 20 min). */
        maxCaughtUpAgeMs?: number;
        /** Genesis: GDD evaluation rate limit (default 1 s). */
        gddRateLimitMs?: number;
        /** Genesis: ChainSync Jumping (default on, as cardano-node's `EnableCSJ`). */
        csj?: boolean;
        /** Genesis: CSJ jump size in slots (default 2 × 2160, cardano-node's `CSJJumpSize`). */
        csjJumpSize?: number;
    };
    dbPath?: string;
}

export function resolveChainSelection(cfg: ConsensusConfigLike): { chainSelection: ChainSelectionMode; mode: ConsensusMode } {
    const envSel = process.env.GEROLAMO_CHAIN_SELECTION?.trim().toLowerCase();
    const envMode = process.env.GEROLAMO_CONSENSUS_MODE?.trim().toLowerCase();
    const valid = (x: unknown): x is ChainSelectionMode => x === "legacy" || x === "shadow" || x === "praos";
    let chainSelection: ChainSelectionMode = valid(envSel) ? envSel : valid(cfg.consensus?.chainSelection) ? cfg.consensus!.chainSelection! : "legacy";
    const mode: ConsensusMode = envMode === "genesis" || envMode === "praos" ? envMode : cfg.consensus?.mode === "genesis" ? "genesis" : "praos";
    if (mode === "genesis" && chainSelection === "legacy") { log.warn("consensus mode genesis needs chainSelection praos: enabling it"); chainSelection = "praos"; }
    return { chainSelection, mode };
}

/** A block of our chain as the database knows it. */
export interface OurBlock { hash: string; prevHash: string | null; slot: bigint; hfcEra: number; raw: Uint8Array | null; tb?: TieBreakInfo | null }

export interface ChainSelDriverDeps {
    k: number;
    /** Tip of our applied chain with the header's own block number. */
    tip(): Promise<{ hash: string; slot: bigint; blockNo: bigint; hfcEra: number; raw: Uint8Array | null; tb?: TieBreakInfo | null } | null>;
    /** Applied block by hash (null when unknown). */
    block(hash: string): Promise<OurBlock | null>;
    /** Is this hash one of our applied blocks (immutable ones included)? */
    isOurs(hash: string): Promise<boolean>;
    /** Peer's ChainSync said MsgAwaitReply (it has nothing more). */
    isIdle(peer: string): boolean;
    /** Peer is a configured local root. */
    isLocalRoot(peer: string): boolean;
    /** Wall-clock age of a slot, ms. */
    slotAgeMs(slot: bigint): number;
    /** Genesis window (sgen) of the era a slot lies in. */
    genesisWindow(slot: bigint): bigint;
    bigLedger?: BigLedgerPeerSource | null;
    now?: () => number;
}

export type ChainSelDecision =
    | { kind: "keep" }
    /** Our chain extends onto `candidate` without a rollback; `promote` when its peer should drive (the primary is on a worse chain). */
    | { kind: "extend"; candidate: Candidate; promote: boolean }
    | { kind: "switch"; candidate: Candidate };

export interface ChainSelVerdict {
    decision: ChainSelDecision;
    /** Disconnect: `malicious` for invalid blocks / forks deeper than k, not for GDD losers. */
    punish: Array<{ peer: string; why: string; malicious: boolean }>;
}

export class ChainSelDriver {
    cs: ChainSel | null = null;
    gsm: GenesisStateMachine | null = null;
    private loe: Point | null = null;
    private lastGdd = 0;
    private seeding: Promise<void> | null = null;
    private readonly vrfPending = new Set<string>();
    private readonly markerPath: string | null;
    stats = { decisions: 0, switches: 0, extendsPromoted: 0, punished: 0, gddDisconnects: 0, loeHolds: 0, shadowDisagreements: 0, csjJumps: 0, csjRejectedJumps: 0 };
    /** ChainSync Jumping (Genesis mode): which peers stream headers and which only answer jumps. */
    readonly csj: ChainSyncJumping | null;
    /** chainSelection "shadow": what became of each decision praos would have taken (shadowAudit.ts). */
    readonly shadow = new ShadowAudit();
    /** Called on every CSJ event (the orchestrator makes the new dynamo its primary). */
    onCsjEvent: ((e: CsjEvent) => void) | null = null;

    constructor(readonly mode: ConsensusMode, private readonly deps: ChainSelDriverDeps, private readonly cfg: ConsensusConfigLike = {}) {
        this.markerPath = cfg.dbPath && cfg.dbPath !== ":memory:" ? join(dirname(cfg.dbPath), "caught-up") : null;
        const csjOn = mode === "genesis" && cfg.consensus?.csj !== false && process.env.GEROLAMO_CSJ !== "0";
        const size = Number(cfg.consensus?.csjJumpSize);
        this.csj = csjOn ? new ChainSyncJumping(Number.isFinite(size) && size > 0 ? BigInt(Math.trunc(size)) : DEFAULT_CSJ_JUMP_SIZE, {
            candidate: (p) => this.candidateInfo(p),
            setCandidate: (p, info) => this.setCandidate(p, info),
        }, (e) => { log.info(`CSJ: ${describeCsj(e)}`); this.onCsjEvent?.(e); }) : null;
    }

    // ───────────────────────────── ChainSync Jumping ─────────────────────────────

    /** The peer's candidate as CSJ sees it (anchored at our immutable tip). */
    private candidateInfo(peer: string): JumpInfo<ChainHeader> | null {
        const cs = this.cs;
        const c = cs?.candidateFromImmutable(peer);
        if (!cs || !c) return null;
        const imm = cs.immutableTip();
        return { anchor: { hash: imm.hash, slot: imm.slot }, headers: c };
    }

    /** An accepted jump: the jumper's candidate is the dynamo's fragment up to the jump point (`csCandidate`, `csLatestSlot`). */
    private setCandidate(peer: string, info: JumpInfo): void {
        const cs = this.cs;
        if (!cs || !cs.hasPeer(peer)) return;
        const imm = cs.immutableTip();
        let anchor: Point = cs.ourHeader(info.anchor.hash) ?? { hash: info.anchor.hash, slot: info.anchor.slot, blockNo: 0n };
        let hs = info.headers as readonly ChainHeader[];
        const j = hs.findIndex((h) => h.hash === imm.hash); // our immutable tip moved into the fragment since the snapshot
        if (j >= 0) { anchor = imm; hs = hs.slice(j + 1); }
        cs.removePeer(peer);
        cs.addPeer(peer, anchor);
        for (const h of hs) cs.rollForward(peer, stripNo(h));
        cs.noteLatestSlot(peer, headPoint(info).slot);
    }

    /** A hot peer joins: CSJ makes it the dynamo, a jumper, or (GSM CaughtUp) leaves it disengaged. True when CSJ manages it. */
    csjRegister(peer: string): boolean {
        if (!this.csj) return false;
        this.cs?.addPeer(peer); // its candidate starts at our tip: the dynamo's first jump boundary counts from our immutable tip
        this.csj.register(peer, this.gsm?.state ?? "PreSyncing");
        return this.csj.stateOf(peer)?.kind !== "disengaged";
    }
    csjNextInstruction(peer: string): Instruction { return this.csj?.nextInstruction(peer) ?? { kind: "run" }; }
    csjJumpResult(peer: string, r: JumpResult): void {
        if (!this.csj) return;
        if (r.instruction.kind === "jumpTo") { this.stats.csjJumps++; if (!r.accepted) this.stats.csjRejectedJumps++; }
        this.csj.processJumpResult(peer, r);
    }
    /** The peer has no more headers (MsgAwaitReply). */
    awaitReply(peer: string): void { this.csj?.onAwaitReply(peer); }
    /** Is `peer` a CSJ jumper right now (its ChainSync must not stream)? */
    isJumper(peer: string): boolean { return this.csj?.stateOf(peer)?.kind === "jumper"; }

    /** `initializationGsmState`: the marker file and the age of our tip decide where the GSM starts. */
    private initGsm(tipSlot: bigint | null): void {
        if (this.mode !== "genesis" || this.gsm) return;
        const maxAge = this.cfg.consensus?.maxCaughtUpAgeMs ?? GSM_DEFAULTS.maxCaughtUpAgeMs;
        const marker = !!this.markerPath && existsSync(this.markerPath);
        const initial = GenesisStateMachine.initialState(marker, tipSlot == null ? Infinity : this.deps.slotAgeMs(tipSlot), maxAge);
        if (marker && initial !== "CaughtUp") this.setMarker(false);
        this.gsm = new GenesisStateMachine(initial, {
            maxCaughtUpAgeMs: maxAge,
            onTransition: (from, to, why) => { log.info(`GSM ${from} → ${to}: ${why}`); this.setMarker(to === "CaughtUp"); },
        }, this.deps.now?.() ?? Date.now());
        log.info(`Genesis mode: GSM starts in ${initial} (caught-up marker ${marker ? "present" : "absent"})`);
    }

    private setMarker(on: boolean): void {
        if (!this.markerPath) return;
        try { if (on) writeFileSync(this.markerPath, ""); else rmSync(this.markerPath, { force: true }); } catch { /* best effort */ }
    }

    get gsmState(): GsmState | null { return this.gsm?.state ?? null; }

    /** (Re)build our chain from the database: the tip and up to k ancestors. */
    private async seed(): Promise<void> {
        const tip = await this.deps.tip();
        this.initGsm(tip?.slot ?? null);
        if (!tip) { this.cs = new ChainSel({ k: this.deps.k, anchor: { hash: "00".repeat(32), slot: 0n, blockNo: 0n, hfcEra: 0 } }); return; }
        const first = await this.deps.block(tip.hash);
        const chain: OurBlock[] = [{ hash: tip.hash, prevHash: first?.prevHash ?? null, slot: tip.slot, hfcEra: tip.hfcEra, raw: tip.raw ?? first?.raw ?? null, tb: tip.tb ?? first?.tb }];
        while (chain.length < this.deps.k + 1 && chain[chain.length - 1]!.prevHash) {
            const b = await this.deps.block(chain[chain.length - 1]!.prevHash!);
            if (!b) break;
            chain.push(b);
        }
        chain.reverse(); // oldest first; the oldest is the immutable tip
        const anchorNo = tip.blockNo - BigInt(chain.length - 1);
        const a = chain[0]!;
        const prevCs = this.cs;
        const cs = new ChainSel({ k: this.deps.k, anchor: { hash: a.hash, slot: a.slot, blockNo: anchorNo, hfcEra: a.hfcEra }, resolveOld: (h) => this.oldOurs.get(h) ?? null });
        for (const b of chain.slice(1)) cs.extendOurs(ourHeader(b));
        // carry the peers' fragments over (re-fed; they re-anchor on the new chain)
        if (prevCs) for (const p of prevCs.peerKeys()) { const f = prevCs.fragmentOf(p); cs.addPeer(p, f?.anchor ?? undefined); for (const h of f?.headers ?? []) cs.rollForward(p, stripNo(h)); }
        this.cs = cs;
    }

    /** Blocks of ours older than the window that peers' fragments were seen anchored on (ForkTooDeep evidence). */
    private readonly oldOurs = new Map<string, Point>();

    /** Reconcile ChainSel's view of our chain with the database tip. */
    async syncOurs(): Promise<ChainSel> {
        if (this.seeding) await this.seeding;
        if (!this.cs) { this.seeding = this.seed().finally(() => { this.seeding = null; }); await this.seeding; return this.cs!; }
        const cs = this.cs;
        const tip = await this.deps.tip();
        if (!tip || tip.hash === cs.ourTip().hash) return cs;
        const added: OurBlock[] = [];
        let cur: string | null = tip.hash;
        for (let i = 0; cur && i <= this.deps.k + 1; i++) {
            if (cs.onOurChain(cur)) {
                const removed = cs.rollbackOursTo(cur);
                if (removed.length) log.debug(`our chain rolled back ${removed.length} block(s) to ${cur.slice(0, 12)}…`);
                for (const b of added.reverse()) cs.extendOurs(ourHeader(b));
                return cs;
            }
            const b: OurBlock | null = await this.deps.block(cur);
            if (!b) break;
            added.push(b);
            cur = b.prevHash;
        }
        this.seeding = this.seed().finally(() => { this.seeding = null; }); // moved more than k: rebuild
        await this.seeding;
        return this.cs!;
    }

    addPeer(peer: string): void { this.cs?.addPeer(peer); }
    removePeer(peer: string): void { this.cs?.removePeer(peer); this.csj?.unregister(peer); }

    /** Validated headers of a peer's ChainSync (headers still awaiting their VRF check are withheld). */
    async observe(peer: string, headers: Array<IncomingHeader & { vrfDeferred?: boolean }>): Promise<void> {
        const cs = await this.syncOurs();
        const csj = this.csj && this.csj.stateOf(peer) && this.csj.stateOf(peer)!.kind !== "disengaged" ? this.csj : null;
        for (const h of headers) {
            if (h.vrfDeferred) this.vrfPending.add(h.hash.toLowerCase());
            csj?.onRollForward(peer, { hash: h.hash.toLowerCase(), slot: h.slot }); // CSJ: the dynamo triggers jumps, an objector may concede
            cs.rollForward(peer, h);
            if (csj) { const info = this.candidateInfo(peer); if (info) csj.updateJumpInfo(peer, info); } // jgUpdateJumpInfo after each validated header
        }
        // A fragment that chains onto nothing in our window: our old chain re-streamed (a lagging
        // peer: forget it), or a fork off a block older than our immutable tip (deeper than k:
        // remember the anchor so selection reports ForkTooDeep), or a stale stream (left detached).
        const f = cs.fragmentOf(peer);
        if (f && !f.anchor && f.headers.length) {
            const last = f.headers[f.headers.length - 1]!, prev = f.headers[0]!.prevHash;
            if (await this.deps.isOurs(last.hash)) cs.rollBackward(peer, { hash: null, slot: last.slot });
            else if (prev && await this.deps.isOurs(prev)) { const b = await this.deps.block(prev); if (b) { this.oldOurs.set(prev, { hash: prev, slot: b.slot, blockNo: 0n }); cs.rollBackward(peer, { hash: null, slot: b.slot }); cs.addPeer(peer); for (const h of f.headers) cs.rollForward(peer, stripNo(h)); } }
        }
    }

    rollBackward(peer: string, point: { hash: string | null; slot: bigint }): void {
        this.cs?.rollBackward(peer, point);
        this.csj?.onRollBackward(peer, point.hash ? point.slot : null);
    }

    /** A deferred VRF check passed: the header may join a candidate. */
    vrfVerified(hash: string): void { this.vrfPending.delete(hash.toLowerCase()); }

    markInvalid(hash: string, reason: string): string[] { this.vrfPending.delete(hash.toLowerCase()); return this.cs?.markInvalid(hash, reason) ?? []; }

    /**
     * Decide what the node should follow. `primary`: the peer whose stream drives our chain today.
     * `hotPeers`: peers with a live ChainSync (GSM / GDD look at every one of them).
     */
    async decide(primary: string | null, hotPeers: readonly string[]): Promise<ChainSelVerdict> {
        const cs = await this.syncOurs();
        this.stats.decisions++;
        const punish: ChainSelVerdict["punish"] = [];
        if (this.gsm) this.runGenesis(cs, hotPeers, punish);
        const r = cs.select({ loe: this.gsm ? this.loe : null, prefer: primary });
        for (const p of r.punish) punish.push({ ...p, malicious: true });
        let best = r.best;
        // headers whose VRF has not been checked yet are not part of any candidate
        if (best && best.suffix.some((h) => this.vrfPending.has(h.hash))) {
            const cut = best.suffix.findIndex((h) => this.vrfPending.has(h.hash));
            best = cut > 0 && cs.preferCandidate(cs.ourTip(), best.suffix[cut - 1]!) ? { ...best, suffix: best.suffix.slice(0, cut), tip: best.suffix[cut - 1]! } : null;
        }
        this.stats.punished += punish.length;
        if (!best) return { decision: { kind: "keep" }, punish };
        if (best.rollback === 0) {
            const ps = primary ? r.status.get(primary) : undefined;
            // the primary is fine while its own candidate extends our chain (it is merely slower or level)
            // (no fragment yet — e.g. just promoted — is no evidence against it)
            const primaryOk = !ps || ps.kind === "no-candidate" || (ps.kind === "preferable" && ps.candidate.rollback === 0) || (ps.kind === "not-preferable" && cs.onOurChain(ps.tip.hash));
            const promote = best.peer !== primary && !primaryOk;
            if (promote) this.stats.extendsPromoted++;
            return { decision: { kind: "extend", candidate: best, promote }, punish };
        }
        this.stats.switches++;
        return { decision: { kind: "switch", candidate: best }, punish };
    }

    /** GSM step, LoE fragment, GDD (Genesis mode). */
    private runGenesis(cs: ChainSel, hotPeers: readonly string[], punish: ChainSelVerdict["punish"]): void {
        const gsm = this.gsm!;
        const now = this.deps.now?.() ?? Date.now();
        const peers = hotPeers.filter((p) => cs.hasPeer(p));
        const big = new Set(this.deps.bigLedger?.bigLedgerPeers() ?? []);
        const activeBig = peers.filter((p) => big.has(p)).length;
        const localOnly = !!this.cfg.consensus?.localRootsOnly && peers.length > 0 && peers.every((p) => this.deps.isLocalRoot(p));
        const haa = honestAvailability({ activeBigLedgerPeers: activeBig, minBigLedgerPeers: this.cfg.consensus?.minBigLedgerPeersForTrustedState ?? GSM_DEFAULTS.minBigLedgerPeersForTrustedState, onlyTrustedLocalRoots: localOnly });
        const sel = cs.select({ loe: null });
        const anyBetter = [...sel.status.values()].some((s) => s.kind === "preferable" || s.kind === "detached");
        gsm.step({ haa, peers: peers.length, allIdle: peers.length > 0 && peers.every((p) => this.deps.isIdle(p)), anyCandidateBetter: anyBetter, tipAgeMs: this.deps.slotAgeMs(cs.ourTip().slot) }, now);
        const imm = cs.immutableTip();
        if (gsm.state === "CaughtUp") { this.loe = null; return; }
        if (gsm.state === "PreSyncing") { this.loe = { hash: imm.hash, slot: imm.slot, blockNo: imm.blockNo }; return; }
        // Syncing: LoE = shared prefix of the candidates; GDD over the Genesis window after it
        const cands = new Map<string, ChainHeader[] | null>();
        for (const p of peers) cands.set(p, cs.candidateFromImmutable(p));
        const { loe, suffixes } = sharedCandidatePrefix(cands);
        const loeTip = loe.length ? loe[loe.length - 1]! : imm;
        this.loe = { hash: loeTip.hash, slot: loeTip.slot, blockNo: loeTip.blockNo };
        const rate = this.cfg.consensus?.gddRateLimitMs ?? 1000;
        if (now - this.lastGdd < rate) return;
        this.lastGdd = now;
        const states = new Map<string, GddPeerState>();
        for (const p of peers) states.set(p, { latestSlot: cs.fragmentOf(p)?.latestSlot ?? null, idling: this.deps.isIdle(p) });
        const sgen = this.deps.genesisWindow(loeTip.slot + 1n);
        const { losing, bounds } = densityDisconnect(sgen, cs.k, states, suffixes, { hash: loeTip.hash, slot: loeTip.slot });
        for (const p of losing) {
            const b = bounds.get(p)!;
            punish.push({ peer: p, why: `GDD: density ${b.lowerBound}..${b.upperBound} in the ${sgen}-slot Genesis window after the LoE tip (slot ${loeTip.slot}) loses to another peer`, malicious: false });
            this.stats.gddDisconnects++;
        }
    }

    /**
     * LoE for the apply pipeline: the newest slot of `peer`'s candidate the selection may reach
     * (k blocks past the LoE tip). null = unlimited (Praos mode, or Genesis CaughtUp).
     */
    loeSlotLimit(peer: string | null): bigint | null {
        const cs = this.cs;
        if (!this.gsm || !this.loe || !cs) return null;
        const loe = this.loe;
        const cand = peer ? cs.candidateFromImmutable(peer) : null;
        const ours = cs.ourChain();
        const chain = cand ?? ours;
        const i = chain.findIndex((h) => h.hash === loe.hash);
        if (i < 0 && loe.hash !== cs.immutableTip().hash) return cs.ourTip().slot; // LoE tip elsewhere: nothing past our tip
        const limitIdx = i + cs.k; // i = -1 when the LoE tip is the immutable tip
        const last = chain[Math.min(chain.length - 1, limitIdx)];
        if (limitIdx >= chain.length) return null; // the candidate does not reach the limit yet
        return last ? last.slot : cs.immutableTip().slot;
    }

    snapshot() {
        const cs = this.cs;
        return {
            mode: this.mode,
            gsm: this.gsm?.state ?? null,
            loe: this.loe ? { slot: this.loe.slot.toString(), hash: this.loe.hash } : null,
            ourTip: cs ? { slot: cs.ourTip().slot.toString(), blockNo: cs.ourTip().blockNo.toString() } : null,
            immutableTip: cs ? { slot: cs.immutableTip().slot.toString() } : null,
            peers: cs ? cs.peerKeys().length : 0,
            ...(this.shadow.counts.recorded ? { shadow: this.shadow.snapshot() } : {}),
            ...(this.csj ? { csj: { jumpSize: this.csj.jumpSize.toString(), dynamo: this.csj.dynamo(), objector: this.csj.objector(), finished: this.csj.finished(), peers: this.csj.summary() } } : {}),
            ...this.stats,
        };
    }
}

function describeCsj(e: CsjEvent): string {
    switch (e.kind) {
        case "initializedAsDynamo": return `${e.peer} is the dynamo`;
        case "sentJumpInstruction": return `dynamo ${e.peer} asks the jumpers to jump to ${e.to.hash.slice(0, 12)}…@${e.to.slot}`;
        case "becomingObjector": return `${e.peer} objects to the dynamo's chain${e.previous ? ` (replacing ${e.previous}, whose disagreement is younger)` : ""}`;
        case "noLongerDynamo": return `${e.peer} is no longer the dynamo (${e.reason}); ${e.next ?? "no peer"} takes over`;
        case "noLongerObjector": return `${e.peer} is no longer the objector (${e.reason}); ${e.next ?? "none"} next`;
        case "rotatedDynamo": return `dynamo rotated from ${e.from} to ${e.to}`;
    }
}

function stripNo(h: ChainHeader): IncomingHeader { const { blockNo: _b, ...rest } = h; return rest; }
function ourHeader(b: OurBlock): IncomingHeader { return { hash: b.hash, prevHash: b.prevHash, slot: b.slot, hfcEra: b.hfcEra, ...(b.raw ? { raw: b.raw } : {}), ...(b.tb !== undefined ? { tb: b.tb } : {}) }; }
