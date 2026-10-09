/**
 * Governance facts the node-to-client queries report verbatim but the ledger store never kept
 * (the rules do not need them): DRep anchors, the raw ProposalProcedure of every governance action,
 * committee resignation anchors, the credential kind (key / script) of committee members, and the
 * deposit each Conway stake registration paid. Collected by walking the CBOR of the selected
 * chain's blocks from the Conway hard fork (certScan-style, no full decode), then kept current:
 *   base   — the immutable chunks, persisted to a cache file when the caller gives one;
 *   overlay — the blocks between the base and the acquired point, re-walked per point.
 * Events apply in chain order (block, transaction, certificate); phase-2 invalid transactions
 * apply nothing.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { cborItemLength } from "../../../storage/chunkFormat";
import type { BlockStore } from "../../../storage/blockStore";
import { logger } from "../../../utils/logger";
import { epochForSlot } from "../../../utils/epochFromSlotCalculations";

const log = logger.child("n2c.lsq.gov");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** Credential key used throughout: "0:<hash>" key hash, "1:<hash>" script hash (the CBOR credential tag). */
export type CredKey = string;
export const credKey = (type: number, hash: string): CredKey => `${type}:${hash.toLowerCase()}`;

export interface GovFacts {
    /** DRep → raw anchor CBOR (`[url, hash]`), or null for a DRep registered / updated without one. */
    drepAnchor: Map<CredKey, Uint8Array | null>;
    /** Action id "txid:index" → raw ProposalProcedure CBOR `[deposit, return account, action, anchor]`. */
    proposal: Map<string, Uint8Array>;
    /** Committee credential hash → kind (0 key, 1 script), from authorisations, resignations and UpdateCommittee. */
    credType: Map<string, number>;
    /** Cold credential → raw anchor of its latest resignation (null: resigned without one); authorisation clears it. */
    ccResign: Map<CredKey, Uint8Array | null>;
    /** Typed stake credential (hash, or 01‖hash for a script) → deposit of its Conway registration; -1 for a legacy registration (keyDeposit then). */
    stakeDeposit: Map<string, bigint>;
}
const emptyFacts = (): GovFacts => ({ drepAnchor: new Map(), proposal: new Map(), credType: new Map(), ccResign: new Map(), stakeDeposit: new Map() });
const cloneFacts = (f: GovFacts): GovFacts => ({ drepAnchor: new Map(f.drepAnchor), proposal: new Map(f.proposal), credType: new Map(f.credType), ccResign: new Map(f.ccResign), stakeDeposit: new Map(f.stakeDeposit) });

// ---------------------------------------------------------------- CBOR walking

function head(b: Uint8Array, p: number): { major: number; value: number; len: number; indef: boolean } {
    const ib = b[p]!, major = ib >> 5, info = ib & 31;
    if (info < 24) return { major, value: info, len: 1, indef: false };
    if (info === 24) return { major, value: b[p + 1]!, len: 2, indef: false };
    if (info === 25) return { major, value: (b[p + 1]! << 8) | b[p + 2]!, len: 3, indef: false };
    if (info === 26) return { major, value: new DataView(b.buffer, b.byteOffset + p + 1, 4).getUint32(0, false), len: 5, indef: false };
    if (info === 27) return { major, value: Number(new DataView(b.buffer, b.byteOffset + p + 1, 8).getBigUint64(0, false)), len: 9, indef: false };
    if (info === 31) return { major, value: -1, len: 1, indef: true };
    throw new Error(`cbor head: info ${info}`);
}
function items(b: Uint8Array, p: number): number[] {
    let h = head(b, p);
    if (h.major === 6) { p += h.len; h = head(b, p); }
    if (h.major !== 4) throw new Error("expected array");
    const out: number[] = [];
    let q = p + h.len;
    if (h.indef) { while (b[q] !== 0xff) { out.push(q); q += cborItemLength(b, q); } return out; }
    for (let i = 0; i < h.value; i++) { out.push(q); q += cborItemLength(b, q); }
    return out;
}
function entries(b: Uint8Array, p: number): Array<[number, number]> {
    const h = head(b, p);
    if (h.major !== 5) throw new Error("expected map");
    const out: Array<[number, number]> = [];
    let q = p + h.len;
    for (let i = 0; h.indef ? b[q] !== 0xff : i < h.value; i++) { const k = q; q += cborItemLength(b, q); out.push([k, q]); q += cborItemLength(b, q); }
    return out;
}
const uintAt = (b: Uint8Array, p: number): bigint => {
    const h = head(b, p);
    if (h.major !== 0) throw new Error("expected uint");
    return h.len === 9 ? new DataView(b.buffer, b.byteOffset + p + 1, 8).getBigUint64(0, false) : BigInt(h.value);
};
const bytesAt = (b: Uint8Array, p: number) => { const h = head(b, p); return b.subarray(p + h.len, p + h.len + h.value); };
const slice = (b: Uint8Array, p: number) => b.slice(p, p + cborItemLength(b, p));
const isNull = (b: Uint8Array, p: number) => b[p] === 0xf6;
/** `[type, hash]` credential at p. */
function credAt(b: Uint8Array, p: number): { type: number; hash: string } { const f = items(b, p); return { type: Number(uintAt(b, f[0]!)), hash: hex(bytesAt(b, f[1]!)) }; }
const stakeTyped = (c: { type: number; hash: string }) => (c.type === 1 ? "01" : "") + c.hash;

/** Apply one transaction body's governance events. */
export function applyTxBody(f: GovFacts, body: Uint8Array): void {
    let txid: string | null = null;
    for (const [k, v] of entries(body, 0)) {
        const key = Number(uintAt(body, k));
        if (key === 4) {
            for (const c of items(body, v)) {
                const x = items(body, c), tag = Number(uintAt(body, x[0]!));
                switch (tag) {
                    case 0: f.stakeDeposit.set(stakeTyped(credAt(body, x[1]!)), -1n); break;
                    case 1: case 8: f.stakeDeposit.delete(stakeTyped(credAt(body, x[1]!))); break;
                    case 7: f.stakeDeposit.set(stakeTyped(credAt(body, x[1]!)), uintAt(body, x[2]!)); break;
                    case 11: case 12: f.stakeDeposit.set(stakeTyped(credAt(body, x[1]!)), uintAt(body, x[3]!)); break;
                    case 13: f.stakeDeposit.set(stakeTyped(credAt(body, x[1]!)), uintAt(body, x[4]!)); break;
                    case 14: { const cold = credAt(body, x[1]!), hot = credAt(body, x[2]!); f.credType.set(cold.hash, cold.type); f.credType.set(hot.hash, hot.type); f.ccResign.delete(credKey(cold.type, cold.hash)); break; }
                    case 15: { const cold = credAt(body, x[1]!); f.credType.set(cold.hash, cold.type); f.ccResign.set(credKey(cold.type, cold.hash), isNull(body, x[2]!) ? null : slice(body, x[2]!)); break; }
                    case 16: { const d = credAt(body, x[1]!); f.drepAnchor.set(credKey(d.type, d.hash), isNull(body, x[3]!) ? null : slice(body, x[3]!)); break; }
                    case 17: { const d = credAt(body, x[1]!); f.drepAnchor.delete(credKey(d.type, d.hash)); break; }
                    case 18: { const d = credAt(body, x[1]!); f.drepAnchor.set(credKey(d.type, d.hash), isNull(body, x[2]!) ? null : slice(body, x[2]!)); break; }
                }
            }
        } else if (key === 20) {
            items(body, v).forEach((pp, idx) => {
                txid ??= hex(blake2b_256(body));
                f.proposal.set(`${txid}:${idx}`, slice(body, pp));
                const ga = items(body, items(body, pp)[2]!);
                if (Number(uintAt(body, ga[0]!)) === 4) for (const [ck] of entries(body, ga[3]!)) { const c = credAt(body, ck); f.credType.set(c.hash, c.type); }
            });
        }
    }
}

/** Apply a stored block (`[eraTag, block]`); Byron blocks carry nothing. */
export function applyBlock(f: GovFacts, entry: Uint8Array): void {
    const top = items(entry, 0);
    if (Number(uintAt(entry, top[0]!)) < 2) return;
    const block = items(entry, top[1]!);
    const invalid = new Set<number>();
    if (block.length >= 5) for (const s of items(entry, block[4]!)) invalid.add(Number(uintAt(entry, s)));
    items(entry, block[1]!).forEach((txStart, i) => {
        if (invalid.has(i)) return;
        const body = entry.subarray(txStart, txStart + cborItemLength(entry, txStart));
        if (!body.includes(0x04) && !body.includes(0x14)) return;
        try { applyTxBody(f, body); } catch (err) { log.warn(`gov index: transaction ${i} not walkable: ${(err as Error).message}`); }
    });
}

// ---------------------------------------------------------------- persistence

/** 2: also the facts at the last epoch boundaries (bug 389); a version-1 cache is rebuilt once. */
const CACHE_VERSION = 2;
/** Epoch boundaries whose facts are kept (the pulser snapshot of the current and the previous epochs). */
const BOUNDARIES_KEPT = 3;
type Boundary = { slot: number; hash: string; facts: GovFacts };
const encodeFacts = (f: GovFacts) => {
    const m = (x: Map<string, Uint8Array | null>) => [...x].map(([k, v]) => [k, v ? hex(v) : null]);
    return { drepAnchor: m(f.drepAnchor), proposal: m(f.proposal as Map<string, Uint8Array | null>), credType: [...f.credType], ccResign: m(f.ccResign), stakeDeposit: [...f.stakeDeposit].map(([k, v]) => [k, v.toString()]) };
};
const decodeFacts = (d: ReturnType<typeof encodeFacts>): GovFacts => {
    const m = (x: Array<[string, string | null]>) => new Map(x.map(([k, v]) => [k, v ? unhex(v) : null] as [string, Uint8Array | null]));
    return { drepAnchor: m(d.drepAnchor as Array<[string, string | null]>), proposal: m(d.proposal as Array<[string, string | null]>) as Map<string, Uint8Array>, credType: new Map(d.credType), ccResign: m(d.ccResign as Array<[string, string | null]>), stakeDeposit: new Map((d.stakeDeposit as Array<[string, string]>).map(([k, v]) => [k, BigInt(v)])) };
};
function saveFacts(path: string, f: GovFacts, slot: number, hash: string, boundaries: Boundary[]): void {
    const doc = { v: CACHE_VERSION, slot, hash, ...encodeFacts(f), boundaries: boundaries.map((b) => ({ slot: b.slot, hash: b.hash, facts: encodeFacts(b.facts) })) };
    writeFileSync(path + ".tmp", JSON.stringify(doc));
    renameSync(path + ".tmp", path);
}
function loadFacts(path: string): { facts: GovFacts; slot: number; hash: string; boundaries: Boundary[] } | null {
    try {
        if (!existsSync(path)) return null;
        const d = JSON.parse(readFileSync(path, "utf8"));
        if (d.v !== CACHE_VERSION) return null;
        return {
            slot: d.slot, hash: d.hash, facts: decodeFacts(d),
            boundaries: (d.boundaries ?? []).map((b: { slot: number; hash: string; facts: ReturnType<typeof encodeFacts> }) => ({ slot: b.slot, hash: b.hash, facts: decodeFacts(b.facts) })),
        };
    } catch { return null; }
}

// ---------------------------------------------------------------- the index

export class GovIndex {
    private base: GovFacts = emptyFacts();
    /** Slot and hash of the last immutable block folded into `base` (-1: nothing yet). */
    private baseSlot = -1;
    private baseHash = "";
    private building: Promise<void> | null = null;
    private savedAt = 0;
    private readonly overlays = new Map<string, GovFacts>();
    /**
     * Facts as of the last block before each recent epoch (by that block's hash). The pulser snapshot of an
     * epoch reads its DRep anchors as of that block, which is immutable — below `base` — about k blocks into
     * the epoch: answering from `base` then leaked anchor updates made since the boundary (bug 389).
     */
    private boundaries: Boundary[] = [];

    constructor(private readonly bs: BlockStore, private readonly fromSlot: number, private readonly cachePath: string | null) {
        const c = cachePath ? loadFacts(cachePath) : null;
        if (c) { this.base = c.facts; this.baseSlot = c.slot; this.baseHash = c.hash; this.boundaries = c.boundaries; log.info(`gov index: cache ${cachePath} covers up to slot ${c.slot}`); }
    }

    /** Before folding a block of a later epoch than the base's last block: keep the base as that boundary's facts. */
    private noteBoundary(nextSlot: number): void {
        if (this.baseSlot < 0 || epochForSlot(nextSlot) <= epochForSlot(this.baseSlot)) return;
        this.boundaries.push({ slot: this.baseSlot, hash: this.baseHash, facts: cloneFacts(this.base) });
        while (this.boundaries.length > BOUNDARIES_KEPT) this.boundaries.shift();
    }

    /** Fold the immutable chunks above the base into it (the first call walks from the Conway fork). */
    async catchUp(): Promise<void> {
        if (this.building) return this.building;
        this.building = (async () => {
            const imm = await this.bs.immutableTip();
            if (!imm || imm.slot <= this.baseSlot) return;
            const t0 = performance.now();
            let n = 0, last = this.baseSlot, lastHash = this.baseHash;
            for await (const b of this.bs.chunks.iterate(Math.max(this.fromSlot, this.baseSlot + 1), imm.slot)) {
                if (b.slot <= this.baseSlot) continue;
                this.noteBoundary(b.slot);
                try { applyBlock(this.base, b.bytes); } catch (err) { log.warn(`gov index: block at slot ${b.slot} not walkable: ${(err as Error).message}`); }
                last = b.slot; lastHash = hex(b.hash);
                this.baseSlot = last; this.baseHash = lastHash; // noteBoundary reads them
                if (++n % 2000 === 0) await new Promise((r) => setImmediate(r));
            }
            this.baseSlot = last; this.baseHash = lastHash;
            this.overlays.clear();
            if (n > 1000) log.info(`gov index: walked ${n} blocks up to slot ${last} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
            // the cache (≈ 10 MB on preview) is rewritten after a long walk or every ten minutes, not per block
            if (this.cachePath && n && (n > 5000 || Date.now() - this.savedAt > 600_000)) {
                try { saveFacts(this.cachePath, this.base, last, lastHash, this.boundaries); this.savedAt = Date.now(); } catch (err) { log.warn(`gov index: cache not written: ${(err as Error).message}`); }
            }
        })().finally(() => { this.building = null; });
        return this.building;
    }

    /** Facts as of the block `hashHex` (a block of the selected chain at or above the base). */
    async at(hashHex: string, slot: number): Promise<GovFacts> {
        await this.catchUp();
        if (slot <= this.baseSlot) {
            if (slot === this.baseSlot && hashHex.toLowerCase() === this.baseHash) return this.base;
            const b = this.boundaries.find((x) => x.hash === hashHex.toLowerCase());
            if (b) return b.facts;
            if (slot < this.baseSlot) log.warn(`gov index: point slot ${slot} is below the indexed immutable tip ${this.baseSlot} and not a kept epoch boundary; answering from the tip's facts`);
            return this.base;
        }
        const hit = this.overlays.get(hashHex);
        if (hit) return hit;
        // blocks between the base and the point: the volatile chain down from the point, then chunks
        const vol = this.bs.volatileChain(unhex(hashHex)).filter((v) => v.slot > this.baseSlot).reverse();
        const firstVolSlot = vol.length ? vol[0]!.slot : slot + 1;
        const f = cloneFacts(this.base);
        if (firstVolSlot > this.baseSlot + 1) for await (const b of this.bs.chunks.iterate(this.baseSlot + 1, Math.min(slot, firstVolSlot - 1))) applyBlock(f, b.bytes);
        for (const v of vol) applyBlock(f, v.bytes);
        this.overlays.set(hashHex, f);
        while (this.overlays.size > 4) this.overlays.delete(this.overlays.keys().next().value!);
        return f;
    }
}

let shared: GovIndex | null = null;
let sharedFor: BlockStore | null = null;
/** The process-wide index over the node's block store (rebuilt when the store object changes). */
export function govIndexFor(bs: BlockStore, conwayStartSlot: number, cachePath: string | null): GovIndex {
    if (!shared || sharedFor !== bs) { shared = new GovIndex(bs, conwayStartSlot, cachePath); sharedFor = bs; }
    return shared;
}
/** Carry the index (and its base) over to a re-attached block store of the same directory. */
export function rebindGovIndex(bs: BlockStore): void { if (shared) { (shared as unknown as { bs: BlockStore }).bs = bs; sharedFor = bs; } }
