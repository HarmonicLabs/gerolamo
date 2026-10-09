/**
 * Current-state reads for the Blockfrost API from the node's LMDB ledger store (stake, rewards,
 * pools, snapshots, DReps, proposals, parameters): the same truth the LocalStateQuery answers
 * come from. Whole-table aggregates (live stake per pool, the DRep delegator lists) are built in
 * chunks with event-loop yields and cached for a short while.
 */
import { ledgerGovReads, ledgerStakeReads, ledgerUtxoReads } from "../../ledger/nodeLedgerStore";
import type { StakeReads } from "../../ledger/stakeStore";
import { SDB, cat, hexKey, u32 } from "../../ledger/stakeStore";
import type { GovReads } from "../../ledger/govStore";
import type { UtxoReads } from "../../ledger/utxoStore";

export interface LedgerReads { stake: StakeReads; gov: GovReads; utxo: UtxoReads | null }

let override: LedgerReads | null | undefined;
/** Tests: answer from this store instead of the node's (null: no ledger). */
export function setBlockfrostLedger(l: LedgerReads | null | undefined): void { override = l; liveCache = null; drepCache = null; }

export function ledger(): LedgerReads | null {
    if (override !== undefined) return override;
    const stake = ledgerStakeReads(), gov = ledgerGovReads();
    return stake && gov ? { stake, gov, utxo: ledgerUtxoReads() } : null;
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
const store = (s: StakeReads): { get(db: string, k: Uint8Array): Uint8Array | undefined } => (s as any).s;
const readU64 = (v: Uint8Array | undefined): bigint => (v && v.length >= 8 ? new DataView(v.buffer, v.byteOffset).getBigUint64(0, false) : 0n);

/** Reward paid to one credential for a performance epoch (no scan of the epoch's other accounts). */
export function rewardPayout(s: StakeReads, perfEpoch: number, typed: string): bigint {
    return readU64(store(s).get(SDB.rewardPayouts, cat(u32(perfEpoch), hexKey(typed))));
}
/** One credential of the stake snapshot taken at the boundary into `takenAt`: its pool and stake. */
export function snapshotCredential(s: StakeReads, takenAt: number, typed: string): { pool: string; stake: bigint } | null {
    const v = store(s).get(SDB.snapCred, cat(u32(takenAt), hexKey(typed)));
    if (!v || v.length < 36) return null;
    return { pool: Buffer.from(v.subarray(0, 28)).toString("hex"), stake: readU64(v.subarray(28, 36)) };
}
/** Snapshot pool stake of one pool. */
export function snapshotPool(s: StakeReads, takenAt: number, pool: string): bigint | null {
    const v = store(s).get(SDB.snapPool, cat(u32(takenAt), hexKey(pool)));
    return v ? readU64(v) : null;
}

/** Live stake of an account: its UTxO stake plus its reward balance. */
export function liveAccountStake(l: LedgerReads, typed: string): bigint {
    return l.stake.stakeBalance(typed) + l.stake.rewardBalance(typed);
}

export interface LiveIndex { pools: Map<string, { stake: bigint; delegators: string[] }>; total: bigint; at: number }
let liveCache: LiveIndex | null = null;
let liveBuilding: Promise<LiveIndex> | null = null;
const LIVE_TTL_MS = 120_000;

/** Live delegation index: per pool the delegators and their live stake (cached two minutes). */
export async function liveIndex(l: LedgerReads): Promise<LiveIndex> {
    if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache;
    liveBuilding ??= (async () => {
        try {
            const pools = new Map<string, { stake: bigint; delegators: string[] }>();
            let total = 0n, n = 0;
            for (const [cred, pool] of l.stake.allDelegations()) {
                const st = liveAccountStake(l, cred);
                let e = pools.get(pool);
                if (!e) { e = { stake: 0n, delegators: [] }; pools.set(pool, e); }
                e.stake += st; e.delegators.push(cred); total += st;
                if (++n % 2000 === 0) await yieldNow();
            }
            liveCache = { pools, total, at: Date.now() };
            return liveCache;
        } finally { liveBuilding = null; }
    })();
    return liveBuilding;
}

export interface DRepIndex { delegators: Map<string, string[]>; at: number }
let drepCache: DRepIndex | null = null;
/** DRep → delegating stake credentials (key "type:hash", "2:" abstain, "3:" no confidence), cached two minutes. */
export async function drepIndex(l: LedgerReads): Promise<DRepIndex> {
    if (drepCache && Date.now() - drepCache.at < LIVE_TTL_MS) return drepCache;
    const delegators = new Map<string, string[]>();
    let n = 0;
    for (const [cred, d] of l.gov.drepDelegations()) {
        const k = `${d.type}:${d.type <= 1 ? d.hash ?? "" : ""}`;
        let a = delegators.get(k); if (!a) { a = []; delegators.set(k, a); } a.push(cred);
        if (++n % 5000 === 0) await yieldNow();
    }
    drepCache = { delegators, at: Date.now() };
    return drepCache;
}

/** Parameters of one pool in the snapshot taken at the boundary into `takenAt` (one key read). */
export function snapshotPoolParam(s: StakeReads, takenAt: number, pool: string): { vrf: string; params: { rewardAccount?: string; owners?: string[]; pledge?: string; cost?: string; marginNum?: string; marginDen?: string } | null } | null {
    const v = store(s).get(SDB.snapPParams, cat(u32(takenAt), hexKey(pool)));
    if (!v) return null;
    try { return JSON.parse(new TextDecoder().decode(v)); } catch { return null; }
}
