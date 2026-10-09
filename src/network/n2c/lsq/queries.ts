/**
 * Conway `BlockQuery` answers (ouroboros-consensus-cardano 3.0.1, Shelley/Ledger/Query.hs, as served
 * by cardano-node 11.0.1), written as the node writes them: the ledger's `encCBOR` of each result
 * (cardano-ledger-conway 1.22). Every answer reads the acquired view only, so a client that acquired
 * a past volatile point gets that point's state. Byte-compared with a cardano-node by
 * scripts/n2c-compare.ts.
 *
 * Map keys follow the Haskell `Ord` of the key type: a `Credential` puts script hashes before key
 * hashes (`ScriptHashObj` is the first constructor), a `DRep` orders key, script, abstain, no
 * confidence; hashes compare bytewise.
 */
import { Cbor, CborArray, CborBytes, CborTag, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GovReads, ProposalRow, PulserSnapshot } from "../../../ledger/govStore";
import type { StakeReads } from "../../../ledger/stakeStore";
import { SDB } from "../../../ledger/stakeStore";
import { DB_UTXO } from "../../../ledger/utxoStore";
import { primaryBlockStore } from "../../../storage/nodeBlockStore";
import { getLedgerStore, ledgerStoreMode, ledgerStoreSummary, resolveLedgerDir } from "../../../ledger/nodeLedgerStore";
import { logger } from "../../../utils/logger";
import { pparamsCborFor } from "../pparamsCbor";
import { encodeUtcTime, systemStartOf, type EraHistoryNetwork } from "../eraHistory";
import { addressString, txInRef } from "../utxoCbor";
import { ledgerTxOutBytes, writeLedgerTxOut } from "./txOut";
import { CborWriter, hexBytes, reduced } from "./cborWriter";
import { committeeEntries, drepEntries, genesisCommitteeKinds, type Cred } from "./govAdapter";
import { govIndexFor, type GovFacts } from "./govIndex";
import { chainBlocks } from "./chainWalk";
import { nextEnactState, type NextEnact } from "./ratifyView";
import { debugEpochState, debugNewEpochState } from "./epochState";
import { cborItemLength, locateHeader } from "../../../storage/chunkFormat";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { praosNonceValue } from "../../../utils/nonceEvolver";
import type { LsqView } from "./view";
import { currentSnapshot, memberArgs, nonMyopicFor, nonMyopicMemberRewardsBytes, rewardInfoPoolsBytes, type NonMyopicState } from "./rewardQueries";

const log = logger.child("n2c.lsq");
/** Genesis maxLovelaceSupply of the public networks. */
const MAX_LOVELACE_SUPPLY = 45_000_000_000_000_000n;
/** cardano-node 11's `MaxMajorProtVer` (the highest major version the node validates). */
export const MAX_MAJOR_PROTOCOL_VERSION = 11;

export interface QueryEnv { network: EraHistoryNetwork | null; magic: number }
/** A query cardano-node would decode but this node cannot answer (no data): the host drops the connection. */
export class LsqUnanswerable extends Error {}
/** A query cardano-node's decoder rejects (unknown tag, wrong arity, Conway-only query in an earlier era): the connection is torn down. */
export class LsqUndecodable extends Error {}

// ---------------------------------------------------------------- argument parsing

const inner = (o: CborObj | undefined): CborObj | undefined => (o instanceof CborTag ? o.data : o);
export function setItems(o: CborObj | undefined): CborObj[] { const i = inner(o); return i instanceof CborArray ? i.array : []; }
const bytesHex = (o: CborObj | undefined): string | null => (o instanceof CborBytes ? Buffer.from(o.bytes).toString("hex") : null);
const num = (o: CborObj | undefined): number => (o instanceof CborUInt ? Number(o.num) : -1);
function credArg(o: CborObj): Cred | null { if (!(o instanceof CborArray) || o.array.length !== 2) return null; const h = bytesHex(o.array[1]); const t = num(o.array[0]); return h && (t === 0 || t === 1) ? { type: t, hash: h } : null; }
type DRepId = { type: number; hash: string | null };
function drepArg(o: CborObj): DRepId | null { if (!(o instanceof CborArray) || !o.array.length) return null; const t = num(o.array[0]); if (t === 2 || t === 3) return { type: t, hash: null }; const h = bytesHex(o.array[1]); return h && (t === 0 || t === 1) ? { type: t, hash: h } : null; }
function maybeSetArg(o: CborObj | undefined): CborObj[] | null { const a = o instanceof CborArray ? o.array : []; return a.length ? setItems(a[0]) : null; }

// ---------------------------------------------------------------- ordering and encodings

const credSortKey = (c: Cred) => `${c.type === 1 ? 0 : 1}${c.hash}`;
const drepSortKey = (d: DRepId) => `${d.type}${d.hash ?? ""}`;
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; };
const typedStake = (c: Cred) => (c.type === 1 ? "01" : "") + c.hash;
const credOfTyped = (typed: string): Cred => (typed.length === 58 && typed.startsWith("01") ? { type: 1, hash: typed.slice(2) } : { type: 0, hash: typed.slice(-56) });
const wCred = (w: CborWriter, c: Cred) => { w.array(2).uint(c.type).hex(c.hash); };
const wDRep = (w: CborWriter, d: DRepId) => { if (d.type === 2 || d.type === 3) w.array(1).uint(d.type); else w.array(2).uint(d.type).hex(d.hash!); };
const wActionId = (w: CborWriter, id: string) => { const i = id.indexOf(":"); w.array(2).hex(id.slice(0, i)).uint(Number(id.slice(i + 1))); };
const actionIdSortKey = (id: string) => { const i = id.indexOf(":"); return id.slice(0, i) + Number(id.slice(i + 1)).toString(16).padStart(4, "0"); };
const toBytes = (o: CborObj) => Cbor.encode(o).toBuffer();

// ---------------------------------------------------------------- context

export interface Ctx { view: LsqView; env: QueryEnv; stake: StakeReads; gov: GovReads; epoch: number; slot: number }
export function ctxOf(view: LsqView, env: QueryEnv): Ctx {
    if (!view.stake || !view.gov) throw new LsqUnanswerable("the ledger store is not open (sqlite mode answers only the tip queries)");
    const slot = Number(view.point?.slot ?? 0n);
    return { view, env, stake: view.stake, gov: view.gov, epoch: epochOfSlot(env.network, slot), slot };
}
/** Shelley-era epoch geometry of the public networks (Byron epochs on preprod and mainnet first). */
export function epochOfSlot(network: EraHistoryNetwork | null, slot: number): number {
    if (network === "preprod") return slot < 86_400 ? Math.floor(slot / 21_600) : 4 + Math.floor((slot - 86_400) / 432_000);
    if (network === "mainnet") return slot < 4_492_800 ? Math.floor(slot / 21_600) : 208 + Math.floor((slot - 4_492_800) / 432_000);
    return Math.floor(slot / 86_400);
}
export function epochStartSlot(network: EraHistoryNetwork | null, epoch: number): number {
    if (network === "preprod") return epoch < 4 ? epoch * 21_600 : 86_400 + (epoch - 4) * 432_000;
    if (network === "mainnet") return epoch < 208 ? epoch * 21_600 : 4_492_800 + (epoch - 208) * 432_000;
    return epoch * 86_400;
}
const epochLength = (network: EraHistoryNetwork | null) => (network === "preview" || network == null ? 86_400 : 432_000);
const CONWAY_START_EPOCH: Record<EraHistoryNetwork, number> = { preview: 646, preprod: 163, mainnet: 507 };

const genesisCache = new Map<string, any>();
export function genesis(network: EraHistoryNetwork | null, era: "shelley" | "conway"): any {
    const net = network ?? "preview";
    const key = `${net}:${era}`;
    if (!genesisCache.has(key)) {
        const override = era === "shelley" ? process.env.GEROLAMO_SHELLEY_GENESIS : process.env.GEROLAMO_CONWAY_GENESIS;
        const path = override || join(import.meta.dir, "..", "..", "..", "config", net, `${era}-genesis.json`);
        genesisCache.set(key, JSON.parse(readFileSync(path, "utf8")));
    }
    return genesisCache.get(key);
}

export function pparamsRaw(c: Ctx, epoch = c.epoch): Record<string, unknown> {
    const r = c.gov.epochParams(epoch)?.params ?? c.gov.epochParams(epoch - 1)?.params;
    if (!r) throw new LsqUnanswerable(`no protocol parameters for epoch ${epoch}`);
    return r;
}
// Dijkstra's 54-field encoding once the parameters are at protocol 12 (bug 430)
const pparamsBytes = (raw: Record<string, unknown>) => toBytes(pparamsCborFor(raw));

let factsCachePath: string | null | undefined;
let factsSource: ((hash: string | null, slot: number) => GovFacts | null) | null = null;
/** Tests: the governance facts (procedures, anchors) without a block store. */
export function setGovFactsSource(fn: ((hash: string | null, slot: number) => GovFacts | null) | null): void { factsSource = fn; }
/** The gov index cache: `GEROLAMO_LSQ_GOV_CACHE` ("" keeps it in memory only), default `lsq-gov-index.json` beside the ledger store. */
export async function govFacts(c: Ctx): Promise<GovFacts | null> {
    if (factsSource) return factsSource(c.view.point?.hash ?? null, Number(c.view.point?.slot ?? 0));
    const bs = primaryBlockStore();
    if (!bs || !c.view.point) return null;
    if (factsCachePath === undefined) {
        const env = process.env.GEROLAMO_LSQ_GOV_CACHE;
        if (env != null) factsCachePath = env || null;
        else { const dir = ledgerStoreSummary()?.dir ?? resolveLedgerDir({ dbPath: process.env.GEROLAMO_DB_PATH ?? "" }); factsCachePath = dir ? join(dir, "..", "lsq-gov-index.json") : null; }
    }
    const conway = epochStartSlot(c.env.network, CONWAY_START_EPOCH[c.env.network ?? "preview"]);
    return govIndexFor(bs, conway, factsCachePath).at(c.view.point.hash, Number(c.view.point.slot));
}
/** The facts as of an earlier block of the selected chain (the epoch's boundary block, bug 167). */
async function govFactsAt(c: Ctx, hash: string, slot: number): Promise<GovFacts | null> {
    if (factsSource) return factsSource(hash, slot);
    const bs = primaryBlockStore();
    if (!bs) return null;
    if (factsCachePath === undefined) await govFacts(c);
    const conway = epochStartSlot(c.env.network, CONWAY_START_EPOCH[c.env.network ?? "preview"]);
    return govIndexFor(bs, conway, factsCachePath ?? null).at(hash, slot);
}

// ---------------------------------------------------------------- shared pieces

/** Current DRep states as the ledger's `vsDReps` (with `updateDormantDRepExpiry` applied, as `queryDRepState` does). */
function drepStates(c: Ctx, facts: GovFacts | null): Array<{ cred: Cred; expiry: number; anchor: Uint8Array | null; deposit: bigint; delegators: Cred[] }> {
    const dormant = Number(c.gov.state()?.dormantEpochs ?? 0);
    const delegators = new Map<string, Cred[]>();
    for (const [stakeKey, d] of c.gov.drepDelegations()) {
        if ((d.type !== 0 && d.type !== 1) || !d.hash) continue;
        const k = `${d.type}:${d.hash}`;
        let l = delegators.get(k); if (!l) delegators.set(k, (l = []));
        l.push(credOfTyped(stakeKey));
    }
    return drepEntries(c.gov).map(({ cred, row }) => {
        const e = row.expiryEpoch ?? row.lastActiveEpoch + Number(pparamsRaw(c).drep_activity ?? 20);
        const e2 = dormant > 0 && e + dormant >= c.epoch ? e + dormant : e;
        return { cred, expiry: e2, anchor: facts?.drepAnchor.get(`${cred.type}:${cred.hash}`) ?? null, deposit: BigInt(row.deposit), delegators: (delegators.get(`${cred.type}:${cred.hash}`) ?? []).sort(byKey(credSortKey)) };
    }).sort((a, b) => byKey(credSortKey)(a.cred, b.cred));
}
function wDRepState(w: CborWriter, s: { expiry: number; anchor: Uint8Array | null; deposit: bigint; delegators: Cred[] }): void {
    w.array(4).uint(s.expiry);
    if (s.anchor) w.array(1).raw(s.anchor); else w.array(0);
    w.uint(s.deposit).set(s.delegators, (d) => wCred(w, d));
}

/** Votes on `actionId` split by voter class (latest vote per voter), optionally only those cast before `untilSlot`. */
function votesOf(c: Ctx, actionId: string, untilSlot?: number) {
    const cc: Array<[Cred, number]> = [], drep: Array<[Cred, number]> = [], spo: Array<[string, number]> = [];
    for (const v of c.gov.votes(actionId, untilSlot)) {
        if (v.voterKind === 0 || v.voterKind === 1) cc.push([{ type: v.voterKind, hash: v.voterHash }, v.vote]);
        else if (v.voterKind === 2 || v.voterKind === 3) drep.push([{ type: v.voterKind - 2, hash: v.voterHash }, v.vote]);
        else if (v.voterKind === 4) spo.push([v.voterHash, v.vote]);
    }
    cc.sort((a, b) => byKey(credSortKey)(a[0], b[0])); drep.sort((a, b) => byKey(credSortKey)(a[0], b[0])); spo.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { cc, drep, spo };
}
/** The vote maps of a frozen pulser snapshot proposal in `votesOf`'s shape (bug 167). */
function frozenVotes(p: PulserSnapshot["proposals"][number]) {
    const cc = p.cc.map(([k, v]) => [credOfTyped(k), v] as [Cred, number]), drep = p.drep.map(([k, v]) => [credOfTyped(k), v] as [Cred, number]), spo = p.spo.map(([k, v]) => [k, v] as [string, number]);
    cc.sort((a, b) => byKey(credSortKey)(a[0], b[0])); drep.sort((a, b) => byKey(credSortKey)(a[0], b[0])); spo.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { cc, drep, spo };
}
function wGovActionState(w: CborWriter, c: Ctx, p: ProposalRow, facts: GovFacts | null, untilSlot?: number, frozen?: ReturnType<typeof votesOf>): void {
    const v = frozen ?? votesOf(c, p.actionId, untilSlot);
    w.array(7);
    wActionId(w, p.actionId);
    w.mapOf(v.cc, (k) => wCred(w, k), (x) => w.uint(x));
    w.mapOf(v.drep, (k) => wCred(w, k), (x) => w.uint(x));
    w.mapOf(v.spo, (k) => w.hex(k), (x) => w.uint(x));
    const raw = facts?.proposal.get(p.actionId);
    if (raw) w.raw(raw);
    else throw new LsqUnanswerable(`proposal ${p.actionId} has no recorded procedure (gov index incomplete)`);
    w.uint(p.proposedEpoch).uint(p.expiresEpoch);
}
/** Proposals the ledger still holds at `epoch` (`cgsProposals`): not yet removed by a boundary, in submission order. */
export function liveProposals(c: Ctx, epoch = c.epoch, submittedBefore?: number): ProposalRow[] {
    return c.gov.proposals().filter((p) => {
        if (submittedBefore != null && p.proposedEpoch >= submittedBefore) return false;
        if (p.status === "active") return true;
        // ratified: stays until the boundary that enacts it; expired / enacted / dropped: gone at `decidedEpoch`
        if (p.status === "ratified") return true;
        return p.decidedEpoch != null && p.decidedEpoch > epoch;
    });
}
/** Roots of the proposal forest (`pRoots`): the last enacted action per purpose. The store keeps them advanced past ratified-but-unenacted actions; step those back. */
function proposalRoots(c: Ctx): Array<string | null> {
    const st = c.gov.state();
    const roots: Array<string | null> = [st?.prevPP ?? null, st?.prevHF ?? null, st?.prevCC ?? null, st?.prevCons ?? null];
    const pending = st?.pending ? (JSON.parse(st.pending) as { ratified?: string[] }) : null;
    const purposeIx = (kind: string) => (kind === "ParameterChange" ? 0 : kind === "InitHardFork" ? 1 : kind === "NoConfidence" || kind === "UpdateCommittee" ? 2 : kind === "NewConstitution" ? 3 : -1);
    for (const id of [...(pending?.ratified ?? [])].reverse()) {
        const p = c.gov.proposal(id);
        if (!p) continue;
        const ix = purposeIx(p.kind);
        if (ix >= 0 && roots[ix] === id) roots[ix] = p.prevActionId;
    }
    return roots;
}
function wRoots(w: CborWriter, roots: Array<string | null>): void { w.array(4); for (const r of roots) { if (r) { w.array(1); wActionId(w, r); } else w.array(0); } }
function wConstitution(w: CborWriter, c: Ctx): void {
    const a = c.gov.constitutionAnchor(), st = c.gov.state();
    if (!a) throw new LsqUnanswerable("constitution anchor not recorded yet");
    w.array(2).array(2).text(a.url).hex(a.hash);
    if (st?.constitutionScript) w.hex(st.constitutionScript); else w.null();
}
function committeeThreshold(c: Ctx): [bigint, bigint] { const st = c.gov.state(); return reduced(BigInt(st?.thrNum ?? 2), BigInt(st?.thrDen ?? 3)); }
function wCommittee(w: CborWriter, c: Ctx, facts: GovFacts | null): void {
    if (Number(c.gov.state()?.noConfidence ?? 0)) { w.array(0); return; }
    const { members } = committeeEntries(c.gov, facts, genesisCommitteeKinds(genesis(c.env.network, "conway")));
    const sorted = [...members].sort((a, b) => byKey(credSortKey)(a.cold, b.cold));
    const [n, d] = committeeThreshold(c);
    w.array(1).array(2).mapOf(sorted.map((m) => [m.cold, m.expiresEpoch] as const), (k) => wCred(w, k), (e) => w.uint(e)).rational(n, d);
}
/**
 * The pulser's frozen snapshot of the epoch (bug 167): what the store's boundary wrote, or what a
 * restart backfilled. `GEROLAMO_LSQ_PULSER_BACKFILL=1` (scripts/lsq-host.ts on a node whose boundary
 * ran before bug 167) reconstructs it in memory from the node's stores instead. Null: no snapshot —
 * the answers fall back to the live-state derivation below.
 */
const pulserMemo = new Map<string, Promise<PulserSnapshot | null>>();
async function pulserOf(c: Ctx): Promise<PulserSnapshot | null> {
    const stored = c.gov.pulserSnapshot(c.epoch);
    if (stored) {
        // a snapshot a boundary wrote before bug 247 lacks the zero-stake pools: completed on read until the restart rewrites it
        const { completePulserPoolDistr } = await import("../../../consensus/governance/govPulser");
        return completePulserPoolDistr(stored, c.stake, liveProposals(c, c.epoch, c.epoch).map((p) => ({ returnAccount: p.returnAccount, deposit: BigInt(p.deposit) })));
    }
    if (process.env.GEROLAMO_LSQ_PULSER_BACKFILL !== "1") return null;
    const key = `${c.epoch}:${c.view.point?.hash ?? ""}`;
    let p = pulserMemo.get(key);
    if (!p) {
        p = (async () => {
            const bs = primaryBlockStore(), ls = ledgerStoreMode() === "sqlite" ? null : getLedgerStore();
            if (!bs) return null;
            const { backfillPulserSnapshot, ledgerViewAt } = await import("../../../consensus/governance/govPulser");
            const { chainBlocks } = await import("./chainWalk");
            const tip = c.view.point;
            // chainBlocks bounds only its chunk part by `to`: the volatile part is cut here
            const upTo = async function* (from: number, to: number) { if (!tip) { yield* bs.chunks.iterate(from, to); return; } for await (const b of chainBlocks(bs, from, tip.hash, Math.min(to, Number(tip.slot)))) { if (b.slot > to) return; yield b; } };
            const r = await backfillPulserSnapshot({ epoch: c.epoch, ledger: ls, chain: upTo, now: { gov: c.gov, stake: c.stake }, viewAt: await ledgerViewAt(ls) });
            return r.snap;
        })();
        pulserMemo.set(key, p);
        while (pulserMemo.size > 2) pulserMemo.delete(pulserMemo.keys().next().value!);
    }
    return p;
}
/** `psDRepState` from the snapshot: raw expiry, deposit and delegators as of the boundary; anchors from the facts as of the boundary block. */
async function frozenDRepStates(c: Ctx, snap: PulserSnapshot): Promise<Array<{ cred: Cred; expiry: number; anchor: Uint8Array | null; deposit: bigint; delegators: Cred[] }>> {
    const facts = snap.boundary ? await govFactsAt(c, snap.boundary.hash, snap.boundary.slot) : await govFacts(c);
    return snap.drepStates.map((s) => { const cred = credOfTyped(s.cred); return { cred, expiry: s.expiry, anchor: facts?.drepAnchor.get(`${cred.type}:${cred.hash}`) ?? null, deposit: BigInt(s.deposit), delegators: s.delegators.map(credOfTyped).sort(byKey(credSortKey)) }; }).sort((a, b) => byKey(credSortKey)(a.cred, b.cred));
}
const frozenDRepDistr = (snap: PulserSnapshot): Array<[DRepId, bigint]> => snap.drepDistr.map((e) => [{ type: e.type, hash: e.type <= 1 ? e.hash : null } as DRepId, BigInt(e.stake)] as [DRepId, bigint]).sort((a, b) => byKey(drepSortKey)(a[0], b[0]));
const frozenPoolDistr = (snap: PulserSnapshot): Array<[string, bigint]> => snap.poolDistr.map(([k, v]) => [k, BigInt(v)] as [string, bigint]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
/** The frozen proposals as rows (the procedure, epochs and status live on the row; the votes are the snapshot's). */
function frozenProposals(c: Ctx, snap: PulserSnapshot): Array<{ row: ProposalRow; votes: ReturnType<typeof votesOf> }> {
    const out: Array<{ row: ProposalRow; votes: ReturnType<typeof votesOf> }> = [];
    for (const p of snap.proposals) { const row = c.gov.proposal(p.actionId); if (row) out.push({ row, votes: frozenVotes(p) }); }
    return out;
}

/** DRep stake distribution the pulser computed at the start of `epoch` (`psDRepDistr`), derived from the live state (no frozen snapshot). */
function drepDistr(c: Ctx): Array<[DRepId, bigint]> {
    const out = new Map<string, [DRepId, bigint]>();
    for (const r of c.gov.drepStake(c.epoch)) out.set(`${r.type}:${r.hash}`, [{ type: r.type, hash: r.type <= 1 ? r.hash : null }, r.stake]);
    // the ledger lists every DRep someone delegates to, stake or not; the stored snapshot keeps non-zero sums only
    const registered = new Set(drepEntries(c.gov).map((e) => `${e.cred.type}:${e.cred.hash}`));
    for (const [, d] of c.gov.drepDelegations()) {
        const k = `${d.type}:${d.type <= 1 ? d.hash : ""}`;
        if (out.has(k)) continue;
        if (d.type <= 1 && !registered.has(k)) continue;
        out.set(k, [{ type: d.type, hash: d.type <= 1 ? d.hash : null }, 0n]);
    }
    return [...out.values()].sort((a, b) => byKey(drepSortKey)(a[0], b[0]));
}
/** The pulser's pool distribution (`psPoolDistr`): the mark snapshot per pool plus proposal deposits of accounts delegated to it. */
function spoDistr(c: Ctx): Array<[string, bigint]> {
    const takenAt = c.epoch;
    const stake = c.stake.snapshotPoolStake(takenAt);
    addZeroStakePools(c, takenAt, stake);
    for (const p of liveProposals(c)) {
        const pool = c.stake.delegationOf(p.returnAccount);
        if (pool && stake.has(pool)) stake.set(pool, stake.get(pool)! + BigInt(p.deposit));
    }
    return [...stake.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
/** The ratification the pulser reached and the enact state it leads to (lsq/ratifyView.ts), from the store's pending decision. */
function nextEnact(c: Ctx, facts: GovFacts | null): NextEnact {
    const st = c.gov.state();
    const pending = st?.pending ? (JSON.parse(st.pending) as { ratified: string[]; expired: string[] }) : null;
    const noConfidence = Number(st?.noConfidence ?? 0) !== 0;
    const members = noConfidence ? null : committeeEntries(c.gov, facts, genesisCommitteeKinds(genesis(c.env.network, "conway"))).members;
    const a = c.gov.constitutionAnchor();
    if (!a) throw new LsqUnanswerable("constitution anchor not recorded yet");
    return nextEnactState({
        pending, proposal: (id) => c.gov.proposal(id),
        committee: members ? { members: members.map((m) => ({ cold: m.cold, expires: m.expiresEpoch })), threshold: committeeThreshold(c) } : null,
        constitution: { url: a.url, hash: a.hash, script: st?.constitutionScript ?? null },
        constitutionAnchorOf: (id) => c.gov.constitutionProposalAnchor(id),
        curRaw: pparamsRaw(c),
    });
}
/**
 * `RatifyState` of the completed pulser: the next enact state (the committee, constitution and
 * current parameters after the ratified actions, the epoch's previous parameters, treasury 0, the
 * enacted withdrawals, the chain roots — the store keeps them advanced past the ratified actions),
 * the ratified actions as the pulser's snapshot holds them, the expiring ids, and the delay flag.
 */
function wRatifyState(w: CborWriter, c: Ctx, facts: GovFacts | null, snap: PulserSnapshot | null): void {
    const st = c.gov.state();
    const ne = nextEnact(c, facts);
    w.array(4);
    w.array(7);
    if (!ne.committee) w.array(0);
    else w.array(1).array(2).mapOf(ne.committee.members.map((m) => [m.cold, m.expires] as const), (k) => wCred(w, k), (e) => w.uint(e)).rational(ne.committee.threshold[0], ne.committee.threshold[1]);
    w.array(2).array(2).text(ne.constitution.url).hex(ne.constitution.hash);
    if (ne.constitution.script) w.hex(ne.constitution.script); else w.null();
    w.raw(pparamsBytes(ne.curRaw)).raw(pparamsBytes(pparamsRaw(c, c.epoch - 1))).uint(0);
    w.mapOf(ne.withdrawals, (k) => wCred(w, k), (v) => w.uint(v));
    wRoots(w, [st?.prevPP ?? null, st?.prevHF ?? null, st?.prevCC ?? null, st?.prevCons ?? null]);
    // `rsEnacted`: the pulser's copies (votes as of the boundary)
    const boundary = epochStartSlot(c.env.network, c.epoch);
    w.list(ne.enacted, (p) => { const f = snap?.proposals.find((x) => x.actionId === p.actionId); wGovActionState(w, c, p, facts, boundary - 1, f ? frozenVotes(f) : undefined); });
    w.set([...ne.expired].sort(byKey(actionIdSortKey)), (id) => wActionId(w, id));
    w.bool(ne.delayed);
}

// ---------------------------------------------------------------- the dispatcher

/**
 * Answer the Shelley-family query `sq` = `[tag, args…]` for the Conway era, as result bytes.
 * Throws LsqUndecodable for what cardano-node's decoder rejects and LsqUnanswerable when the data
 * is missing here.
 */
export async function answerConwayQuery(view: LsqView, env: QueryEnv, sq: CborObj[]): Promise<Uint8Array> {
    const tag = num(sq[0]);
    const arity = sq.length;
    const need = (n: number) => { if (arity !== n) throw new LsqUndecodable(`query ${tag}: ${arity - 1} argument(s)`); };
    const w = new CborWriter();
    switch (tag) {
        case 0: { need(1); const p = view.point; if (!p) return Uint8Array.of(0x80); w.array(2).uint(p.slot).hex(p.hash); return w.finish(); }
        case 1: { need(1); return w.uint(epochOfSlot(env.network, Number(view.point?.slot ?? 0n))).finish(); }
        case 2: { need(2); const c = ctxOf(view, env); if (setItems(sq[1]).length) return await nonMyopicMemberRewards(c, setItems(sq[1])); return w.map(0).finish(); }
        case 3: { need(1); const c = ctxOf(view, env); return pparamsBytes(pparamsRaw(c)); }
        case 4: { need(1); return w.map(0).finish(); } // GetProposedPParamsUpdates: no genesis-key updates in Conway
        case 5: { need(1); return stakeDistributionLegacy(ctxOf(view, env)); }
        case 6: { need(2); return utxoByAddress(ctxOf(view, env), setItems(sq[1])); }
        case 7: { need(1); return utxoWhole(ctxOf(view, env)); }
        case 9: {
            need(2);
            const q = sq[1] instanceof CborArray ? sq[1].array : null;
            if (!q) throw new LsqUndecodable("GetCBOR: query expected");
            const innerBytes = await answerConwayQuery(view, env, q);
            return w.tag(24).bytes(innerBytes).finish();
        }
        case 10: { need(2); return delegationsAndRewards(ctxOf(view, env), setItems(sq[1])); }
        case 11: { need(1); return genesisConfig(env); }
        case 13: { need(1); return chainDepState(ctxOf(view, env)); }
        case 14: { need(1); return REWARD_PROVENANCE_CONWAY; }
        case 15: { need(2); return utxoByTxIn(ctxOf(view, env), setItems(sq[1])); }
        case 16: { need(1); const c = ctxOf(view, env); return w.setDefinite([...c.stake.pools().keys()].sort(), (id) => w.hex(id)).finish(); } // ToCBOR (cardano-binary), not EncCBOR
        case 17: { need(2); return stakePoolParams(ctxOf(view, env), setItems(sq[1])); }
        case 19: { need(2); return poolState(ctxOf(view, env), maybeSetArg(sq[1])); }
        case 20: { need(2); return stakeSnapshots(ctxOf(view, env), maybeSetArg(sq[1])); }
        case 21: { need(2); return poolDistrLegacy(ctxOf(view, env), maybeSetArg(sq[1])); }
        case 22: { need(2); return stakeDelegDeposits(ctxOf(view, env), setItems(sq[1])); }
        case 23: { need(1); const c = ctxOf(view, env); wConstitution(w, c); return w.finish(); }
        case 24: { need(1); return govState(ctxOf(view, env)); }
        case 25: { need(2); return drepState(ctxOf(view, env), setItems(sq[1])); }
        case 26: { need(2); return drepStakeDistr(ctxOf(view, env), setItems(sq[1])); }
        case 27: { need(4); return committeeMembersState(ctxOf(view, env), setItems(sq[1]), setItems(sq[2]), setItems(sq[3])); }
        case 28: { need(2); return voteDelegatees(ctxOf(view, env), setItems(sq[1])); }
        case 29: { need(1); const c = ctxOf(view, env); const p = c.stake.pots(); if (!p) throw new LsqUnanswerable("pots not initialised"); return w.array(2).uint(p.treasury).uint(p.reserves).finish(); }
        case 30: { need(2); return spoStakeDistr(ctxOf(view, env), setItems(sq[1])); }
        case 31: { need(2); return proposalsQuery(ctxOf(view, env), setItems(sq[1])); }
        case 32: { need(1); const c = ctxOf(view, env); wRatifyState(w, c, await govFacts(c), await pulserOf(c)); return w.finish(); }
        case 33: { need(1); return futurePParams(ctxOf(view, env)); }
        case 34: {
            if (arity === 1) return ledgerPeerSnapshot(ctxOf(view, env), "legacy");
            need(2);
            const kind = num(sq[1]);
            if (kind !== 0 && kind !== 1) throw new LsqUndecodable(`GetLedgerPeerSnapshot: invalid peer kind ${kind}`);
            return ledgerPeerSnapshot(ctxOf(view, env), kind === 0 ? "all" : "big");
        }
        case 35: { need(2); return defaultVote(ctxOf(view, env), bytesHex(sq[1])); }
        case 36: { need(2); return poolDistr2(ctxOf(view, env), maybeSetArg(sq[1])); }
        case 37: { need(1); return stakeDistribution2(ctxOf(view, env)); }
        case 38: { need(1); return w.uint(MAX_MAJOR_PROTOCOL_VERSION).finish(); }
        case 39: { need(2); return drepDelegationsQuery(ctxOf(view, env), setItems(sq[1])); }
        case 18: { need(1); return rewardInfoPools(ctxOf(view, env)); }
        case 8: { need(1); return debugEpochState(ctxOf(view, env)); }
        case 12: { need(1); return debugNewEpochState(ctxOf(view, env)); }
        default: throw new LsqUndecodable(`decodeShelleyQuery: invalid (len, tag) = (${arity}, ${tag})`);
    }
}
/** `GetRewardProvenance` in Conway: the ledger no longer fills it in; this is its fixed encoding (captured from cardano-node 11.0.1). */
const REWARD_PROVENANCE_CONWAY = Uint8Array.from(Buffer.from("9000a0000000000000d81e82000100d81e820001000000a0a0", "hex"));

// ---------------------------------------------------------------- stake and pools

/**
 * Pool parameters as the ledger re-encodes them. The stored bytes are the registration
 * certificate's fields verbatim; cardano-node answers with its own encoding: the margin reduced
 * (0 / 1000000 → 0 / 1, `UnitInterval`) and the relay list definite-length (a certificate may
 * write it indefinite). Other fields already match (owners are stored as a sorted set).
 */
export function normalizePoolParams(raw: Uint8Array): Uint8Array {
    try {
        if (raw[0] !== 0x89) return raw; // array(9)
        const starts: number[] = [];
        let p = 1;
        for (let i = 0; i < 9; i++) { starts.push(p); p += cborItemLength(raw, p); }
        const item = (i: number) => raw.subarray(starts[i]!, i < 8 ? starts[i + 1]! : p);
        const w = new CborWriter(raw.length + 16).array(9);
        for (let i = 0; i < 9; i++) {
            if (i === 4) {
                const m = Cbor.parse(item(4));
                const nd = m instanceof CborTag && m.data instanceof CborArray ? m.data.array.map((x) => (x instanceof CborUInt ? BigInt(x.num) : -1n)) : [];
                if (nd.length === 2 && nd[0]! >= 0n && nd[1]! > 0n) { const [rn, rd] = reduced(nd[0]!, nd[1]!); w.rational(rn, rd); } else w.raw(item(4));
            } else if (i === 7) {
                const rel = item(7);
                const rs: Uint8Array[] = [];
                let q = 1 + (rel[0] === 0x9f ? 0 : 0);
                const h = rel[0]!;
                if (h === 0x9f) { while (rel[q] !== 0xff) { const n = cborItemLength(rel, q); rs.push(rel.subarray(q, q + n)); q += n; } }
                else { const ai = h & 31; let count = ai; q = 1; if (ai === 24) { count = rel[1]!; q = 2; } else if (ai === 25) { count = (rel[1]! << 8) | rel[2]!; q = 3; } for (let j = 0; j < count; j++) { const n = cborItemLength(rel, q); rs.push(rel.subarray(q, q + n)); q += n; } }
                w.list(rs, (r) => w.raw(r));
            } else w.raw(item(i));
        }
        return w.finish();
    } catch { return raw; }
}

function poolIds(items: CborObj[]): string[] { return [...new Set(items.map(bytesHex).filter((x): x is string => !!x))].sort(); }

/** Deprecated `GetStakeDistribution`: live delegated stake (UTxO + rewards) per registered pool over the circulation. */
function stakeDistributionLegacy(c: Ctx): Uint8Array {
    const pools = c.stake.pools(), pots = c.stake.pots();
    if (!pots) throw new LsqUnanswerable("pots not initialised");
    const perPool = new Map<string, bigint>();
    for (const [cred, pool] of c.stake.allDelegations()) {
        if (!pools.has(pool)) continue;
        perPool.set(pool, (perPool.get(pool) ?? 0n) + c.stake.stakeBalance(cred) + c.stake.rewardBalance(cred));
    }
    return stakeDistributionLegacyExact(pools, perPool, MAX_LOVELACE_SUPPLY - pots.reserves);
}
function stakeDistributionLegacyExact(pools: Map<string, { vrf: string }>, perPool: Map<string, bigint>, total: bigint): Uint8Array {
    const w = new CborWriter();
    const ids = [...perPool.keys()].sort();
    const end = w.mapHead(ids.length);
    for (const id of ids) { const [n, d] = reduced(perPool.get(id)!, total); w.hex(id).array(2).rational(n, d).hex(pools.get(id)!.vrf); }
    end();
    return w.finish();
}

function stakePoolParams(c: Ctx, items: CborObj[]): Uint8Array {
    const w = new CborWriter();
    const out: Array<[string, Uint8Array]> = [];
    for (const id of poolIds(items)) {
        const raw = c.stake.poolCbor(id);
        if (raw) out.push([id, normalizePoolParams(raw)]);
        else if (c.stake.pool(id)) log.warn(`GetStakePoolParams: pool ${id.slice(0, 12)}… has no raw parameters yet (backfill pending)`);
    }
    w.mapOf(out, (k) => w.hex(k), (v) => w.raw(v));
    return w.finish();
}

function poolState(c: Ctx, filter: CborObj[] | null): Uint8Array {
    const want = filter ? new Set(poolIds(filter)) : null;
    const pools = c.stake.pools();
    const ids = [...pools.keys()].filter((id) => !want || want.has(id)).sort();
    const deposit = BigInt(String(pparamsRaw(c).pool_deposit ?? 500_000_000));
    const w = new CborWriter();
    w.array(4);
    const params: Array<[string, Uint8Array]> = [];
    for (const id of ids) { const raw = c.stake.poolCbor(id); if (raw) params.push([id, normalizePoolParams(raw)]); else throw new LsqUnanswerable(`pool ${id} has no raw parameters yet`); }
    w.mapOf(params, (k) => w.hex(k), (v) => w.raw(v));
    const future: Array<[string, Uint8Array]> = [];
    for (const id of [...c.stake.pendingPools().keys()].filter((id) => !want || want.has(id)).sort()) {
        const raw = c.view.stake ? (c.stake as unknown as { s: { get(db: string, k: Uint8Array): Uint8Array | undefined } }).s.get(SDB.poolCborPending, hexBytes(id)) : undefined;
        if (raw) future.push([id, normalizePoolParams(raw)]);
    }
    w.mapOf(future, (k) => w.hex(k), (v) => w.raw(v));
    const retiring = ids.map((id) => [id, pools.get(id)!.retiringEpoch] as const).filter((x): x is readonly [string, number] => x[1] != null);
    w.mapOf(retiring, (k) => w.hex(k), (e) => w.uint(e));
    w.mapOf(ids.map((id) => [id, deposit] as const), (k) => w.hex(k), (d) => w.uint(d));
    return w.finish();
}

function stakeSnapshots(c: Ctx, filter: CborObj[] | null): Uint8Array {
    const want = filter ? new Set(poolIds(filter)) : null;
    const E = c.epoch;
    const snaps = [E, E - 1, E - 2].map((e) => c.stake.snapshotPoolStake(e));
    const ids = new Set<string>(); for (const m of snaps) for (const [id, s] of m) if (s > 0n) ids.add(id);
    const sel = [...(want ?? ids)].filter((id) => snaps.some((m) => (m.get(id) ?? 0n) > 0n)).sort();
    const totals = [E, E - 1, E - 2].map((e) => c.stake.snapshotTotals(e)?.total ?? 0n);
    const w = new CborWriter();
    w.array(4).mapOf(sel.map((id) => [id, snaps.map((m) => m.get(id) ?? 0n)] as const), (k) => w.hex(k), (v) => { w.array(3); for (const s of v) w.uint(s); });
    for (const t of totals) w.uint(t);
    return w.finish();
}

/**
 * Pools a snapshot lists at zero stake (delegators whose stake summed to nothing). Snapshots taken
 * before these were recorded (2026-09-29) are completed from the pools registered at the snapshot
 * that have delegators now — exact for preview epoch 1434 (36 of 36), an approximation in general.
 */
function addZeroStakePools(c: Ctx, takenAt: number, stake: Map<string, bigint>): void {
    const zero = c.stake.snapshotZeroPools(takenAt);
    const recordedFrom = c.stake.snapshotEpochs().find((e) => c.stake.snapshotZeroPools(e).length > 0);
    if (zero.length || !c.stake.snapshotTotals(takenAt) || (recordedFrom != null && takenAt >= recordedFrom)) { for (const id of zero) if (!stake.has(id)) stake.set(id, 0n); return; }
    const delegated = new Set(c.stake.allDelegations().map(([, p]) => p));
    for (const id of c.stake.snapshotPoolParams(takenAt).keys()) if (!stake.has(id) && delegated.has(id)) stake.set(id, 0n);
}

/** The `set` snapshot's pool distribution (`nesPd`): [pool → (relative stake, stake, vrf)], total. */
function setPoolDistr(c: Ctx, filter: CborObj[] | null): { rows: Array<{ id: string; stake: bigint; vrf: string }>; total: bigint } {
    const want = filter ? new Set(poolIds(filter)) : null;
    const takenAt = c.epoch - 1;
    const stakeBy = c.stake.snapshotPoolStake(takenAt), params = c.stake.snapshotPoolParams(takenAt), total = c.stake.snapshotTotals(takenAt)?.total ?? 0n;
    if (!total) throw new LsqUnanswerable(`no stake snapshot taken at ${takenAt}`);
    addZeroStakePools(c, takenAt, stakeBy);
    const rows = [...stakeBy.keys()].filter((id) => !want || want.has(id)).sort().map((id) => ({ id, stake: stakeBy.get(id)!, vrf: params.get(id)?.vrf ?? c.stake.pool(id)?.vrf ?? "" }));
    return { rows, total };
}
function poolDistrLegacy(c: Ctx, filter: CborObj[] | null): Uint8Array {
    const { rows, total } = setPoolDistr(c, filter);
    const w = new CborWriter();
    w.mapOf(rows.map((r) => [r.id, r] as const), (k) => w.hex(k), (r) => { const [n, d] = reduced(r.stake, total); w.array(2).rational(n, d).hex(r.vrf); });
    return w.finish();
}
function poolDistr2(c: Ctx, filter: CborObj[] | null): Uint8Array {
    const { rows, total } = setPoolDistr(c, filter);
    const w = new CborWriter();
    w.array(2).mapOf(rows.map((r) => [r.id, r] as const), (k) => w.hex(k), (r) => { const [n, d] = reduced(r.stake, total); w.array(3).rational(n, d).uint(r.stake).hex(r.vrf); });
    w.uint(total);
    return w.finish();
}
/**
 * `poolsByTotalStakeFraction`: the pool distribution of the *current* stake (instant stake of
 * credentials delegated to registered pools), each pool's share taken over the total stake in
 * circulation (maxLovelaceSupply − reserves); the second field is the active total.
 */
function stakeDistribution2(c: Ctx): Uint8Array {
    const pools = c.stake.pools(), pots = c.stake.pots();
    if (!pots) throw new LsqUnanswerable("pots not initialised");
    const perPool = new Map<string, bigint>();
    let active = 0n;
    for (const [cred, pool] of c.stake.allDelegations()) {
        if (!pools.has(pool)) continue;
        const s = c.stake.stakeBalance(cred) + c.stake.rewardBalance(cred);
        perPool.set(pool, (perPool.get(pool) ?? 0n) + s); // a pool whose delegators hold nothing is listed at 0
        active += s;
    }
    const circulation = MAX_LOVELACE_SUPPLY - pots.reserves;
    const ids = [...perPool.keys()].sort();
    const w = new CborWriter();
    w.array(2).mapOf(ids.map((id) => [id, { s: perPool.get(id)!, vrf: pools.get(id)!.vrf }] as const), (k) => w.hex(k), (r) => { const [n, d] = reduced(r.s, circulation); w.array(3).rational(n, d).uint(r.s).hex(r.vrf); });
    w.uint(active);
    return w.finish();
}

function delegationsAndRewards(c: Ctx, items: CborObj[]): Uint8Array {
    const creds = items.map(credArg).filter((x): x is Cred => !!x).sort(byKey(credSortKey));
    const uniq = creds.filter((x, i) => i === 0 || credSortKey(x) !== credSortKey(creds[i - 1]!));
    const reg = uniq.filter((x) => c.stake.isRegistered(typedStake(x)));
    const w = new CborWriter();
    const delegs = reg.map((x) => [x, c.stake.delegationOf(typedStake(x))] as const).filter((x): x is readonly [Cred, string] => !!x[1]);
    w.array(2).mapOf(delegs, (k) => wCred(w, k), (p) => w.hex(p));
    w.mapOf(reg.map((x) => [x, c.stake.rewardBalance(typedStake(x))] as const), (k) => wCred(w, k), (b) => w.uint(b));
    return w.finish();
}

async function stakeDelegDeposits(c: Ctx, items: CborObj[]): Promise<Uint8Array> {
    const creds = items.map(credArg).filter((x): x is Cred => !!x).sort(byKey(credSortKey));
    const reg = creds.filter((x, i) => (i === 0 || credSortKey(x) !== credSortKey(creds[i - 1]!)) && c.stake.isRegistered(typedStake(x)));
    const facts = reg.length ? await govFacts(c) : null;
    const keyDeposit = BigInt(String(pparamsRaw(c).key_deposit ?? 2_000_000));
    const w = new CborWriter();
    w.mapOf(reg.map((x) => { const d = facts?.stakeDeposit.get(typedStake(x)); return [x, d != null && d >= 0n ? d : keyDeposit] as const; }), (k) => wCred(w, k), (d) => w.uint(d));
    return w.finish();
}

function defaultVote(c: Ctx, poolId: string | null): Uint8Array {
    const p = poolId ? c.stake.pool(poolId) : null;
    let v = 0;
    const ra = p?.params?.rewardAccount ? String(p.params.rewardAccount).toLowerCase() : null;
    // the stored reward account is the typed credential (hash, or 01 ‖ hash for a script), the vote delegation's key
    if (ra && /^(01)?[0-9a-f]{56}$/.test(ra)) { const d = c.gov.drepDelegation(ra); if (d?.type === 2) v = 1; else if (d?.type === 3) v = 2; }
    return new CborWriter().uint(v).finish();
}

// ---------------------------------------------------------------- UTxO

/** TxIn order: transaction id bytes, then the index as a number. */
const txInOrder = (x: string, y: string) => { const i = x.indexOf(":"), j = y.indexOf(":"); const a = x.slice(0, i), b = y.slice(0, j); return a !== b ? (a < b ? -1 : 1) : Number(x.slice(i + 1)) - Number(y.slice(j + 1)); };
const wTxIn = (w: CborWriter, ref: string) => { const i = ref.indexOf(":"); w.array(2).hex(ref.slice(0, i)).uint(Number(ref.slice(i + 1))); };
function utxoRowsBytes(rows: Array<{ utxo_ref: string; tx_out: string }>): Uint8Array {
    const entries: Array<[string, Uint8Array]> = [];
    for (const r of rows) { const out = ledgerTxOutBytes(JSON.parse(r.tx_out)); if (out) entries.push([r.utxo_ref, out]); }
    const uniq = entries.sort((x, y) => txInOrder(x[0], y[0])).filter((e, i, a) => i === 0 || e[0] !== a[i - 1]![0]);
    const w = new CborWriter();
    w.mapOf(uniq, (ref) => wTxIn(w, ref), (b) => w.raw(b));
    return w.finish();
}
function utxoByAddress(c: Ctx, items: CborObj[]): Uint8Array {
    const addrs = [...new Set(items.map((a) => (a instanceof CborBytes ? addressString(a.bytes) : null)).filter((a): a is string => !!a))];
    const u = c.view.utxo!;
    return utxoRowsBytes(addrs.flatMap((a) => u.byAddress(a).map((r) => ({ utxo_ref: r.utxo_ref, tx_out: String(r.tx_out) }))));
}
function utxoByTxIn(c: Ctx, items: CborObj[]): Uint8Array {
    const refs = [...new Set(items.map(txInRef).filter((r): r is string => !!r))];
    return utxoRowsBytes(c.view.utxo!.getMany(refs).map((r) => ({ utxo_ref: r.utxo_ref, tx_out: String(r.tx_out) })));
}
/** `GetUTxOWhole`, written in one pass in key order (the store's keys are txid ‖ u16 index: already TxIn order). */
function utxoWhole(c: Ctx): Uint8Array {
    const u = c.view.utxo!;
    const s = (u as unknown as { s: { range(db: string, p: Uint8Array): Iterable<[Uint8Array, Uint8Array]> } }).s;
    const count = u.count();
    const w = new CborWriter(Math.max(1 << 16, count * 210)); // ~200 B per output on preview
    const end = w.mapHead(count);
    let n = 0;
    for (const [k] of s.range(DB_UTXO, new Uint8Array(0))) {
        const ref = `${Buffer.from(k.subarray(0, 32)).toString("hex")}:${new DataView(k.buffer, k.byteOffset + 32).getUint16(0, false)}`;
        const r = u.get(ref);
        wTxIn(w, ref);
        if (!r || !writeLedgerTxOut(w, JSON.parse(String(r.tx_out)))) throw new LsqUnanswerable(`UTxO ${ref} cannot be encoded`);
        n++;
        if (n % 200_000 === 0) Bun.gc(false); // the parsed outputs are garbage at once; keep the heap from growing to several GB
    }
    if (n !== count) throw new LsqUnanswerable(`UTxO count ${count} but ${n} entries scanned`);
    end();
    return w.finishInPlace();
}

// ---------------------------------------------------------------- governance

async function govState(c: Ctx): Promise<Uint8Array> {
    const facts = await govFacts(c);
    const w = new CborWriter(1 << 21);
    w.array(7);
    // proposals: roots, then every live action in submission order with its current votes
    w.array(2);
    wRoots(w, proposalRoots(c));
    const live = liveProposals(c);
    w.list(live, (p) => wGovActionState(w, c, p, facts));
    wCommittee(w, c, facts);
    wConstitution(w, c);
    w.raw(pparamsBytes(pparamsRaw(c))).raw(pparamsBytes(pparamsRaw(c, c.epoch - 1)));
    futurePParamsField(w, c);
    // DRComplete: the pulser's snapshot of the epoch start (frozen, bug 167; derived when no snapshot is stored), then its ratify state
    w.array(2).array(4);
    const snap = await pulserOf(c);
    if (snap) {
        w.list(frozenProposals(c, snap), (p) => wGovActionState(w, c, p.row, facts, undefined, p.votes));
        w.mapOf(frozenDRepDistr(snap), (k) => wDRep(w, k), (s) => w.uint(s));
        w.mapOf((await frozenDRepStates(c, snap)).map((s) => [s.cred, s] as const), (k) => wCred(w, k), (s) => wDRepState(w, s));
        w.mapOf(frozenPoolDistr(snap), (k) => w.hex(k), (s) => w.uint(s));
    } else {
        const boundary = epochStartSlot(c.env.network, c.epoch);
        w.list(liveProposals(c, c.epoch, c.epoch), (p) => wGovActionState(w, c, p, facts, boundary - 1));
        w.mapOf(drepDistr(c), (k) => wDRep(w, k), (s) => w.uint(s));
        w.mapOf(drepStates(c, facts).map((s) => [s.cred, s] as const), (k) => wCred(w, k), (s) => wDRepState(w, s));
        w.mapOf(spoDistr(c), (k) => w.hex(k), (s) => w.uint(s));
    }
    wRatifyState(w, c, facts, snap);
    return w.finish();
}

/**
 * `cgsFuturePParams`: from the boundary on a potential update (`predictFuturePParams`: the enact
 * state's parameters when the pulser ratified a ParameterChange or a hard fork, else none), made
 * definite at the slot of no return (two stability windows before the epoch's end).
 */
function futurePParamsField(w: CborWriter, c: Ctx): void {
    const noReturn = epochStartSlot(c.env.network, c.epoch) + epochLength(c.env.network) - 2 * stabilityWindow(c);
    const ne = nextEnact(c, null);
    if (ne.changesPParams) { if (c.slot < noReturn) w.array(2).uint(2).array(1).raw(pparamsBytes(ne.curRaw)); else w.array(2).uint(1).raw(pparamsBytes(ne.curRaw)); }
    else if (c.slot < noReturn) w.array(2).uint(2).array(0); else w.array(1).uint(0);
}
/** `GetFuturePParams`: the potential or definite update, `Maybe PParams`. */
function futurePParams(c: Ctx): Uint8Array { const ne = nextEnact(c, null); if (!ne.changesPParams) return Uint8Array.of(0x80); return new CborWriter().array(1).raw(pparamsBytes(ne.curRaw)).finish(); }
/** 3k/f slots. */
function stabilityWindow(c: Ctx): number { const g = genesis(c.env.network, "shelley"); return Math.ceil((3 * Number(g.securityParam)) / Number(g.activeSlotsCoeff)); }

async function drepState(c: Ctx, items: CborObj[]): Promise<Uint8Array> {
    const want = new Set(items.map(credArg).filter((x): x is Cred => !!x).map(credSortKey));
    const facts = await govFacts(c);
    const states = drepStates(c, facts).filter((s) => !want.size || want.has(credSortKey(s.cred)));
    const w = new CborWriter(1 << 20);
    w.mapOf(states.map((s) => [s.cred, s] as const), (k) => wCred(w, k), (s) => wDRepState(w, s));
    return w.finish();
}

async function drepStakeDistr(c: Ctx, items: CborObj[]): Promise<Uint8Array> {
    const want = new Set(items.map(drepArg).filter((x): x is DRepId => !!x).map(drepSortKey));
    const snap = await pulserOf(c);
    const w = new CborWriter();
    w.mapOf((snap ? frozenDRepDistr(snap) : drepDistr(c)).filter(([d]) => !want.size || want.has(drepSortKey(d))), (k) => wDRep(w, k), (s) => w.uint(s));
    return w.finish();
}
async function spoStakeDistr(c: Ctx, items: CborObj[]): Promise<Uint8Array> {
    const want = new Set(poolIds(items));
    const snap = await pulserOf(c);
    const w = new CborWriter();
    w.mapOf((snap ? frozenPoolDistr(snap) : spoDistr(c)).filter(([id]) => !want.size || want.has(id)), (k) => w.hex(k), (s) => w.uint(s));
    return w.finish();
}

function voteDelegatees(c: Ctx, items: CborObj[]): Uint8Array {
    const want = new Set(items.map(credArg).filter((x): x is Cred => !!x).map(typedStake));
    const rows: Array<[Cred, DRepId]> = [];
    for (const [stakeKey, d] of c.gov.drepDelegations()) {
        if (want.size && !want.has(stakeKey)) continue;
        rows.push([credOfTyped(stakeKey), { type: d.type, hash: d.type <= 1 ? d.hash : null }]);
    }
    rows.sort((a, b) => byKey(credSortKey)(a[0], b[0]));
    const w = new CborWriter(1 << 22);
    w.mapOf(rows, (k) => wCred(w, k), (d) => wDRep(w, d));
    return w.finish();
}

function drepDelegationsQuery(c: Ctx, items: CborObj[]): Uint8Array {
    const want = items.map(drepArg).filter((x): x is DRepId => !!x);
    const wantKeys = new Set(want.map(drepSortKey));
    const predefined = want.some((d) => d.type >= 2) || !want.length;
    const byDrep = new Map<string, { d: DRepId; creds: Cred[] }>();
    const registered = new Set(drepEntries(c.gov).map((e) => `${e.cred.type}${e.cred.hash}`));
    if (!predefined) for (const d of want) if (registered.has(drepSortKey(d))) byDrep.set(drepSortKey(d), { d, creds: [] }); // a registered DRep is listed even without delegators
    for (const [stakeKey, del] of c.gov.drepDelegations()) {
        const d: DRepId = { type: del.type, hash: del.type <= 1 ? del.hash : null };
        const k = drepSortKey(d);
        if (wantKeys.size && !wantKeys.has(k)) continue;
        if (!predefined && !registered.has(k)) continue;
        let e = byDrep.get(k); if (!e) byDrep.set(k, (e = { d, creds: [] }));
        e.creds.push(credOfTyped(stakeKey));
    }
    const rows = [...byDrep.values()].sort((a, b) => byKey(drepSortKey)(a.d, b.d));
    const w = new CborWriter(1 << 22);
    w.mapOf(rows.map((r) => [r.d, r.creds.sort(byKey(credSortKey))] as const), (k) => wDRep(w, k), (cs) => w.set(cs, (x) => wCred(w, x)));
    return w.finish();
}

async function committeeMembersState(c: Ctx, coldItems: CborObj[], hotItems: CborObj[], statusItems: CborObj[]): Promise<Uint8Array> {
    const facts = await govFacts(c);
    const coldF = new Set(coldItems.map(credArg).filter((x): x is Cred => !!x).map(credSortKey));
    const hotF = new Set(hotItems.map(credArg).filter((x): x is Cred => !!x).map(credSortKey));
    const statusF = new Set(statusItems.map(num));
    const { members, strayAuths } = committeeEntries(c.gov, facts, genesisCommitteeKinds(genesis(c.env.network, "conway")));
    const noConfidence = Number(c.gov.state()?.noConfidence ?? 0) !== 0;
    const current = noConfidence ? [] : members;
    // next epoch's committee: the ratify state's (`getNextEpochCommitteeMembers`: changed by a ratified UpdateCommittee / NoConfidence)
    const nextMembers = nextEnact(c, facts).committee?.members ?? [];
    const next = new Map(nextMembers.map((m) => [credSortKey(m.cold), m.expires]));
    const all = new Map<string, { cold: Cred; expires: number | null; hot: Cred | null; resigned: boolean }>();
    for (const m of current) all.set(credSortKey(m.cold), { cold: m.cold, expires: m.expiresEpoch, hot: m.hot, resigned: m.resigned });
    const unrecognisedWanted = !statusF.size || statusF.has(2);
    if (unrecognisedWanted) for (const a of strayAuths) if (!all.has(credSortKey(a.cold))) all.set(credSortKey(a.cold), { cold: a.cold, expires: null, hot: a.hot, resigned: a.resigned });
    // a member of the next committee only (no authorisation yet): Unrecognized, ToBeEnacted
    if (unrecognisedWanted) for (const m of nextMembers) if (!all.has(credSortKey(m.cold))) all.set(credSortKey(m.cold), { cold: m.cold, expires: null, hot: null, resigned: false });
    const rows = [...all.values()].filter((m) => (!coldF.size || coldF.has(credSortKey(m.cold))) && (!hotF.size || (!!m.hot && !m.resigned && hotF.has(credSortKey(m.hot))))).sort((a, b) => byKey(credSortKey)(a.cold, b.cold));
    const w = new CborWriter();
    const out: Array<[Cred, (w: CborWriter) => void]> = [];
    for (const m of rows) {
        const status = m.expires == null ? 2 : c.epoch > m.expires ? 1 : 0;
        if (statusF.size && !statusF.has(status)) continue;
        const nextTerm = next.get(credSortKey(m.cold));
        const inCur = m.expires != null, inNext = nextTerm != null;
        const nec: [number, number?] = !inCur && inNext ? [0] : !inNext ? [1] : m.expires !== nextTerm && nextTerm !== c.epoch ? [4, nextTerm!] : m.expires === c.epoch || nextTerm === c.epoch ? [3] : [2];
        const resignAnchor = facts?.ccResign.get(`${m.cold.type}:${m.cold.hash}`);
        out.push([m.cold, (w) => {
            w.array(4);
            if (m.resigned) { w.array(2).uint(2); if (resignAnchor) w.array(1).raw(resignAnchor); else w.array(0); }
            else if (m.hot) { w.array(2).uint(0); wCred(w, m.hot); }
            else w.array(1).uint(1);
            w.uint(status);
            if (m.expires != null) w.array(1).uint(m.expires); else w.array(0);
            if (nec.length === 2) w.array(2).uint(nec[0]).uint(nec[1]!); else w.array(1).uint(nec[0]);
        }]);
    }
    w.array(3).mapOf(out, (k) => wCred(w, k), (f) => f(w));
    if (noConfidence) w.array(0); else { const [n, d] = committeeThreshold(c); w.array(1).rational(n, d); }
    w.uint(c.epoch);
    return w.finish();
}

async function proposalsQuery(c: Ctx, items: CborObj[]): Promise<Uint8Array> {
    const want = new Set(items.map((o) => (o instanceof CborArray && o.array.length === 2 ? `${bytesHex(o.array[0])}:${num(o.array[1])}` : "")).filter(Boolean));
    const facts = await govFacts(c);
    const w = new CborWriter();
    const snap = await pulserOf(c);
    if (snap) { w.list(frozenProposals(c, snap).filter((p) => !want.size || want.has(p.row.actionId)), (p) => wGovActionState(w, c, p.row, facts, undefined, p.votes)); return w.finish(); }
    const boundary = epochStartSlot(c.env.network, c.epoch);
    const rows = liveProposals(c, c.epoch, c.epoch).filter((p) => !want.size || want.has(p.actionId));
    w.list(rows, (p) => wGovActionState(w, c, p, facts, boundary - 1));
    return w.finish();
}

// ---------------------------------------------------------------- genesis, chain-dependent state, peers

export function genesisConfig(env: QueryEnv): Uint8Array {
    const g = genesis(env.network, "shelley");
    const pp = g.protocolParams;
    const dec = (x: number | string): [bigint, bigint] => { const s = String(x); const [i, f = ""] = s.split("."); return reduced(BigInt(i + f), 10n ** BigInt(f.length)); };
    const w = new CborWriter();
    w.array(15);
    w.raw(toBytes(encodeUtcTime(g.systemStart))).uint(g.networkMagic).uint(g.networkId === "Mainnet" ? 1 : 0);
    const [an, ad] = dec(g.activeSlotsCoeff); w.array(2).uint(an).uint(ad);
    w.uint(g.securityParam).uint(g.epochLength).uint(g.slotsPerKESPeriod).uint(g.maxKESEvolutions).uint(Math.round(Number(g.slotLength) * 1_000_000)).uint(g.updateQuorum).uint(BigInt(g.maxLovelaceSupply));
    w.array(17).uint(pp.minFeeA).uint(pp.minFeeB).uint(pp.maxBlockBodySize).uint(pp.maxTxSize).uint(pp.maxBlockHeaderSize).uint(pp.keyDeposit).uint(pp.poolDeposit).uint(pp.eMax).uint(pp.nOpt);
    for (const k of ["a0", "rho", "tau", "decentralisationParam"]) { const [n, d] = dec(pp[k]); w.rational(n, d); }
    if (pp.extraEntropy?.tag === "NeutralNonce" || !pp.extraEntropy) w.array(1).uint(0); else w.array(2).uint(1).hex(pp.extraEntropy.contents);
    w.array(2).uint(pp.protocolVersion.major).uint(pp.protocolVersion.minor).uint(pp.minUTxOValue).uint(pp.minPoolCost);
    const gd = Object.entries(g.genDelegs as Record<string, { delegate: string; vrf: string }>).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    w.mapOf(gd, (k) => w.hex(k), (v) => w.array(2).hex(v.delegate).hex(v.vrf));
    if (Object.keys(g.initialFunds ?? {}).length) throw new LsqUnanswerable("genesis initial funds are not encoded");
    w.map(0).array(2).map(0).map(0);
    return w.finish();
}

/**
 * `DebugChainDepState` = Praos `PraosState`, versioned `[0, state]`: last slot (WithOrigin), the
 * operational certificate counters (cardano-binary `ToCBOR` map: definite), then the evolving,
 * candidate, epoch, previous-epoch, last-applied-block (the tip's prev hash) and last-epoch-block
 * nonces. The evolving and candidate nonces are replayed from the epoch-start values over the
 * epoch's headers up to the acquired block, so a past point gets its own values. Nonce = [0]
 * neutral or [1, hash].
 */
async function chainDepState(c: Ctx): Promise<Uint8Array> {
    const bs = primaryBlockStore();
    const p = c.view.point;
    if (!bs || !p) throw new LsqUnanswerable("no block store");
    const row = c.gov.nonce(c.epoch), prevRow = c.gov.nonce(c.epoch - 1);
    if (!row?.startEvolvingHex || !row.startCandidateHex || !prevRow) throw new LsqUnanswerable(`epoch ${c.epoch} nonce state not recorded`);
    const g = genesis(c.env.network, "shelley");
    const start = epochStartSlot(c.env.network, c.epoch), firstNext = start + epochLength(c.env.network);
    const freeze = Math.floor((4 * Number(g.securityParam)) / Number(g.activeSlotsCoeff)); // Conway: randomness stabilisation window 4k/f
    let etaV: Uint8Array = hexBytes(row.startEvolvingHex), etaC: Uint8Array = hexBytes(row.startCandidateHex);
    let firstPrev: Uint8Array | null = null, tipPrev: Uint8Array | null = null;
    for await (const b of chainBlocks(bs, start, p.hash, Number(p.slot))) {
        const h = praosHeaderFacts(b.bytes);
        if (!h) continue;
        firstPrev ??= h.prevHash;
        etaV = blake2b_256(concatBytes(etaV, blake2b_256(praosNonceValue(h.vrfOutput))));
        if (b.slot + freeze < firstNext) etaC = etaV;
        tipPrev = h.prevHash;
    }
    // the last block of the previous epoch: the first block of this one names it; its own prev hash is the nonce kept at the tick
    let lastEpochBlockPrev: Uint8Array | null = null;
    const lastPrevEpoch = firstPrev ? await bs.byHash(firstPrev) : null;
    if (lastPrevEpoch) lastEpochBlockPrev = praosHeaderFacts(lastPrevEpoch.bytes)?.prevHash ?? null;
    else if (row.startLabHex) lastEpochBlockPrev = hexBytes(row.startLabHex);
    if (!tipPrev) { const tb = await bs.byHash(hexBytes(p.hash)); tipPrev = tb ? praosHeaderFacts(tb.bytes)?.prevHash ?? null : null; }
    const counters: Array<[string, number]> = [];
    for (const [k, v] of (c.stake as unknown as { s: { range(db: string, p: Uint8Array): Iterable<[Uint8Array, Uint8Array]> } }).s.range(SDB.opcert, new Uint8Array(0))) counters.push([Buffer.from(k).toString("hex"), new DataView(v.buffer, v.byteOffset).getUint32(0, false)]);
    const w = new CborWriter();
    const nonce = (x: Uint8Array | null) => { if (x && x.length) w.array(2).uint(1).bytes(x); else w.array(1).uint(0); };
    w.array(2).uint(0).array(8).array(2).uint(1).uint(p.slot);
    w.map(counters.length); for (const [k, n] of counters) w.hex(k).uint(n);
    nonce(etaV); nonce(etaC); nonce(hexBytes(row.nonceHex)); nonce(hexBytes(prevRow.nonceHex)); nonce(tipPrev); nonce(lastEpochBlockPrev);
    return w.finish();
}
/** Babbage+ header body `[block_no, slot, prev_hash, issuer_vkey, vrf_vkey, [vrf_output, proof], …]`. */
function praosHeaderFacts(bytes: Uint8Array): { prevHash: Uint8Array | null; vrfOutput: Uint8Array } | null {
    const h = locateHeader(bytes);
    if (h.eraTag < 6) return null; // TPraos headers (two VRFs) end at Alonzo
    const hdr = Cbor.parse(bytes.subarray(h.headerOffset, h.headerOffset + h.headerSize)) as CborArray;
    const body = hdr.array[0] as CborArray;
    const prev = body.array[2];
    const vrf = body.array[5] as CborArray;
    return { prevHash: prev instanceof CborBytes ? prev.bytes : null, vrfOutput: (vrf.array[0] as CborBytes).bytes };
}
const concatBytes = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/**
 * `GetLedgerPeerSnapshot` (ouroboros-network 1.1 LedgerPeers/Type.hs, SRV-capable form): the
 * `set` snapshot's pools ordered by stake (descending, ties by pool id), each with the relays of
 * its future and current registrations that a peer can dial (`relayToLedgerRelayAccessPoint`).
 *   all [3, [point, magic, [_ [stake, [_ relays]] ]]] · big [2, [point, magic, [_ [accumulated, relative, [_ relays]] ]]]
 *   (big: relative stake recomputed over the listed pools, cut once the accumulated stake passed 0.9)
 *   legacy [34] (N2C < 23): [1, [[1, slot], [_ [accumulated, [relative, [_ relays]]] ]]]
 * Rationals are cardano-binary's untagged [num, den], reduced.
 */
function ledgerPeerSnapshot(c: Ctx, kind: "all" | "big" | "legacy"): Uint8Array {
    const { rows, total } = setPoolDistr(c, null);
    const pending = c.stake.pendingPools();
    const pendingRaw = (id: string) => (c.stake as unknown as { s: { get(db: string, k: Uint8Array): Uint8Array | undefined } }).s.get(SDB.poolCborPending, hexBytes(id));
    const peers: Array<{ id: string; stake: bigint; aps: Uint8Array[] }> = [];
    for (const r of [...rows].sort((a, b) => (a.stake === b.stake ? (a.id < b.id ? -1 : 1) : a.stake > b.stake ? -1 : 1))) {
        const cur = c.stake.poolCbor(r.id);
        if (!cur) continue;
        const fut = pending.has(r.id) ? pendingRaw(r.id) : undefined;
        // `Map.unionWith (\f c -> NE.nub (f <> c))`: duplicates are dropped only for a pool with both a
        // future and a current registration (and a Future and a Current copy of one relay both stay)
        let aps: Uint8Array[];
        if (fut) {
            const tagged: string[] = [];
            for (const [tag, raw] of [["f", fut], ["c", cur]] as const) for (const ap of relayAccessPoints(raw)) { const k = tag + Buffer.from(ap).toString("hex"); if (!tagged.includes(k)) tagged.push(k); }
            aps = tagged.map((k) => hexBytes(k.slice(1)));
        } else aps = relayAccessPoints(cur);
        if (aps.length) peers.push({ id: r.id, stake: r.stake, aps });
    }
    const p = c.view.point!;
    const w = new CborWriter(1 << 16);
    const relays = (aps: Uint8Array[]) => { w.arrayIndef(); for (const ap of aps) w.raw(ap); w.brk(); };
    const ratio = (n: bigint, d: bigint) => { const [a, b] = d === 0n ? [0n, 1n] : reduced(n, d); w.array(2).uint(a).uint(b); };
    if (kind === "all") {
        w.array(2).uint(3).array(3).array(3).uint(1).uint(p.slot).hex(p.hash).uint(c.env.magic).arrayIndef();
        for (const x of peers) { w.array(2); ratio(x.stake, total); relays(x.aps); }
        w.brk();
        return w.finish();
    }
    const listed = peers.reduce((a, x) => a + x.stake, 0n);
    const big: Array<{ acc: bigint; x: (typeof peers)[number] }> = [];
    let acc = 0n;
    for (const x of peers) { // already by stake, descending: the relative order is the same
        if (big.length && acc * 10n > listed * 9n) break; // takeWhilePrev (acc ≤ 0.9)
        acc += x.stake;
        big.push({ acc, x });
    }
    if (kind === "big") {
        w.array(2).uint(2).array(3).array(3).uint(1).uint(p.slot).hex(p.hash).uint(c.env.magic).arrayIndef();
        for (const b of big) { w.array(3); ratio(b.acc, listed); ratio(b.x.stake, listed); relays(b.x.aps); }
        w.brk();
        return w.finish();
    }
    w.array(2).uint(1).array(2).array(2).uint(1).uint(p.slot).arrayIndef();
    for (const b of big) { w.array(2); ratio(b.acc, listed); w.array(2); ratio(b.x.stake, listed); relays(b.x.aps); }
    w.brk();
    return w.finish();
}
/** A registration's relays (PoolParams field 7) as ledger relay access points, in order. */
function relayAccessPoints(params: Uint8Array): Uint8Array[] {
    const pp = Cbor.parse(params) as CborArray;
    const rel = pp.array[7];
    const out: Uint8Array[] = [];
    for (const r of rel instanceof CborArray ? rel.array : []) {
        if (!(r instanceof CborArray)) continue;
        const t = num(r.array[0]);
        const port = r.array[1] instanceof CborUInt ? BigInt(r.array[1].num) : null;
        const w = new CborWriter(64);
        if (t === 0) {
            const v4 = r.array[2] instanceof CborBytes ? r.array[2].bytes : null, v6 = r.array[3] instanceof CborBytes ? r.array[3].bytes : null;
            if (port == null) continue;
            if (v4) { w.array(3).uint(1).uint(port).arrayIndef(); for (const b of v4) w.uint(b); w.brk(); }
            else if (v6) { w.array(3).uint(2).uint(port).arrayIndef(); const dv = new DataView(v6.buffer, v6.byteOffset, 16); for (let i = 0; i < 4; i++) { const x = dv.getUint32(i * 4, true); w.uint(x >>> 16).uint(x & 0xffff); } w.brk(); }
            else continue;
        } else if (t === 1) {
            const dns = r.array[2] instanceof CborText ? r.array[2].text : null;
            if (!dns) continue;
            if (port != null) w.array(3).uint(0).uint(port).bytes(new TextEncoder().encode(dns)); else w.array(2).uint(3).bytes(new TextEncoder().encode(dns));
        } else if (t === 2) {
            const dns = r.array[1] instanceof CborText ? r.array[1].text : null;
            if (!dns) continue;
            w.array(2).uint(3).bytes(new TextEncoder().encode(dns));
        } else continue;
        out.push(w.finish());
    }
    return out;
}

// ---------------------------------------------------------------- pool ranking (lsq/rewardQueries.ts)

async function nonMyopic(c: Ctx): Promise<NonMyopicState> {
    const g = genesis(c.env.network, "shelley");
    const nm = await nonMyopicFor(c.stake, c.gov, c.epoch, c.view.anchorKey + (c.view.point?.hash ?? ""), { activeSlotsCoeff: g.activeSlotsCoeff, slotsPerEpoch: Number(g.epochLength), maxSupply: BigInt(g.maxLovelaceSupply ?? MAX_LOVELACE_SUPPLY) });
    if (!nm) throw new LsqUnanswerable(`the pool-ranking likelihoods of epoch ${c.epoch} are not recorded (store bootstrapped before bug 262; seed with scripts/nonmyopic-seed.ts)`);
    return nm;
}
async function nonMyopicMemberRewards(c: Ctx, items: CborObj[]): Promise<Uint8Array> {
    const nm = await nonMyopic(c);
    return nonMyopicMemberRewardsBytes(currentSnapshot(c.stake, BigInt(genesis(c.env.network, "shelley").maxLovelaceSupply ?? MAX_LOVELACE_SUPPLY)), pparamsRaw(c), nm, memberArgs(items));
}
async function rewardInfoPools(c: Ctx): Promise<Uint8Array> {
    const nm = await nonMyopic(c);
    return rewardInfoPoolsBytes(currentSnapshot(c.stake, BigInt(genesis(c.env.network, "shelley").maxLovelaceSupply ?? MAX_LOVELACE_SUPPLY)), pparamsRaw(c), nm);
}
