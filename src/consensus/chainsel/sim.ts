/**
 * Deterministic chain-selection simulator: synthetic headers and peers (forks, equal-length
 * battles, deep forks, sparse adversarial chains, invalid blocks) driving `ChainSel` the way the
 * node does — every peer's ChainSync feeds its candidate, the node switches to `select().best`,
 * validates the blocks it adopts (an invalid one is remembered and its peers are dropped) and
 * re-selects. Used by the unit tests; no I/O.
 */
import { ChainSel, type ChainHeader, type IncomingHeader, type Point } from "./ChainSel";
import type { TieBreakInfo } from "../tieBreak";

/** mulberry32: small, fast, deterministic. */
export function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let hashCounter = 0;
export function freshHash(tag: string): string {
    const n = (hashCounter++).toString(16).padStart(8, "0");
    return (Buffer.from(tag).toString("hex") + n).padEnd(64, "0").slice(0, 64);
}

export const GENESIS: Point = { hash: "00".repeat(32), slot: 0n, blockNo: 0n };

export interface ChainOpts {
    /** Probability that a slot has a block (active slot coefficient of this chain's producers). */
    density?: number;
    rng?: () => number;
    era?: number;
    issuers?: string[];
    tag?: string;
    /** Explicit tie-break views for the first blocks (battles). */
    tb?: Array<Partial<TieBreakInfo>>;
    /** Fixed gap (slots) between blocks instead of the random density. */
    gap?: number;
}

/** `n` headers extending `parent` (slots after `parent.slot`). */
export function growChain(parent: Point, n: number, o: ChainOpts = {}): ChainHeader[] {
    const rng = o.rng ?? prng(1);
    const out: ChainHeader[] = [];
    let slot = parent.slot, blockNo = parent.blockNo, prev = parent.hash;
    const issuers = o.issuers ?? ["pool-a", "pool-b", "pool-c", "pool-d"];
    for (let i = 0; i < n; i++) {
        if (o.gap) slot += BigInt(o.gap);
        else { const d = o.density ?? 0.05; do slot += 1n; while (rng() >= d); }
        blockNo += 1n;
        const vrf = new Uint8Array(64);
        for (let j = 0; j < 64; j++) vrf[j] = Math.floor(rng() * 256);
        const over = o.tb?.[i] ?? {};
        const hash = freshHash(o.tag ?? "blk");
        out.push({
            hash, prevHash: prev, slot, blockNo, hfcEra: o.era ?? 6,
            tb: { issuer: over.issuer ?? issuers[Math.floor(rng() * issuers.length)]!, opcertCounter: over.opcertCounter ?? 1n, vrfOutput: over.vrfOutput ?? vrf, slot },
        });
        prev = hash;
    }
    return out;
}

export const incoming = (h: ChainHeader): IncomingHeader => { const { blockNo: _b, ...rest } = h; return rest; };

/** A simulated node: ChainSel + the applied chain + block validity. */
export class SimNode {
    readonly cs: ChainSel;
    readonly invalidBlocks = new Set<string>();
    readonly disconnected = new Map<string, string>();
    switches = 0;
    rollbacks: number[] = [];

    /** Every block ever produced in the scenario (the "immutable DB" lookup for deep forks). */
    readonly known = new Map<string, Point>();

    constructor(k: number, anchor: Point = GENESIS) {
        this.known.set(anchor.hash, anchor);
        this.cs = new ChainSel({ k, anchor, resolveOld: (h) => (this.cs.onOurChain(h) || this.everOurs.has(h) ? this.known.get(h) ?? null : null) });
    }
    /** Blocks that were on our chain at some point (the DB holds the immutable ones). */
    private readonly everOurs = new Set<string>([GENESIS.hash]);

    connect(peer: string, at?: Point): void { this.cs.addPeer(peer, at); }

    /** Deliver headers from `peer` (validated by the header checks already). */
    feed(peer: string, headers: ChainHeader[]): void {
        if (this.disconnected.has(peer)) return;
        for (const h of headers) this.known.set(h.hash, h);
        for (const h of headers) this.cs.rollForward(peer, incoming(h));
    }

    rollBackward(peer: string, p: Point): void { this.cs.rollBackward(peer, { hash: p.hash, slot: p.slot }); }

    disconnect(peer: string, why: string): void { this.disconnected.set(peer, why); this.cs.removePeer(peer); }

    /** Run chain selection until it settles: switch, validate, remember invalid blocks, punish. */
    settle(opts: { loe?: Point | null; prefer?: string | null } = {}): void {
        for (let guard = 0; guard < 64; guard++) {
            const r = this.cs.select(opts);
            for (const p of r.punish) this.disconnect(p.peer, p.why);
            const best = r.best;
            if (!best) return;
            if (best.rollback > 0) { this.cs.rollbackOursTo(best.intersection.hash); this.rollbacks.push(best.rollback); }
            this.switches++;
            let failed = false;
            for (const h of best.suffix) {
                if (this.invalidBlocks.has(h.hash)) {
                    const culprits = this.cs.markInvalid(h.hash, "ledger rules");
                    for (const c of culprits) this.disconnect(c, `invalid block ${h.hash.slice(0, 8)}`);
                    failed = true;
                    break;
                }
                this.cs.extendOurs(incoming(h));
                this.everOurs.add(h.hash);
            }
            if (!failed && r.punish.length === 0) {
                // one more pass: another candidate may now be preferable (e.g. after truncation)
                const again = this.cs.select(opts);
                if (!again.best) return;
            }
        }
        throw new Error("chain selection did not settle");
    }

    tip(): ChainHeader { return this.cs.ourTip(); }
}
