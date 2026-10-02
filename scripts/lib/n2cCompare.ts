/**
 * The n2c-compare query set and byte-comparison engine, shared by scripts/n2c-compare.ts (run by
 * hand) and scripts/parity-probe.ts (the watchdog's periodic check against the relay).
 *
 * Both sides acquire one block (acquireShared); the query arguments are real (our pool, and DReps,
 * committee members, stake credentials and governance actions picked from the reference's own
 * answers at that block); every answer is compared byte for byte.
 */
import { Cbor, CborArray, CborUInt, CborBytes, CborTag, type CborObj } from "@harmoniclabs/cbor";
import type { LsqClient } from "./lsq";

export const U = (n: number | bigint) => new CborUInt(n);
export const B = (h: string) => new CborBytes(Uint8Array.from(Buffer.from(h, "hex")));
export const S = (xs: CborObj[]) => new CborTag(258, new CborArray(xs));
export const A = (xs: CborObj[]) => new CborArray(xs);
export const cred = (t: number, h: string) => A([U(t), B(h)]);
/** A Shelley-based BlockQuery of era `e` (6 = Conway) wrapped in the hard-fork combinator's query. */
export const ledger = (q: CborObj[], e = 6) => A([U(0), A([U(0), A([U(e), A(q)])])]);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Our preview pool and its reward account's key hash (the default arguments). */
export const DEFAULT_POOL = "8df215df1a762e84d826bae39516a424a76e81e649001a3f903eda12";
export const DEFAULT_OWNER_CRED = "cdcca01b8e958a3cca255df9581cef0ec23c90ceffe1ab9dcd9beb7a";
/** The debug dumps and the whole UTxO: hundreds of MB on preview, so only on request. */
export const HUGE_QUERY_NAMES = ["[7] GetUTxOWhole", "[8] DebugEpochState", "[12] DebugNewEpochState"];

export type CompareQuery = [name: string, q: CborObj, live: boolean];
export interface QueryResult { name: string; same: boolean; ours: number; ref: number; firstDiff?: number; excerpt?: string; err?: string }
export interface SharedAcquire { shared: boolean; slot: bigint | null; hash: string | null; note: string }

const pointOf = async (c: LsqClient) => { const t = (await c.query(A([U(3)]))) as CborArray; return { slot: BigInt((t.array[0] as CborUInt).num), hash: hex((t.array[1] as CborBytes).bytes) }; };

/**
 * Put both clients on one block: the reference acquires our tip (retried while it catches up with
 * a block it has not seen yet); failing that, we acquire the reference's tip; failing that, each
 * stays at its own tip and live answers are retried (`shared` false).
 */
export async function acquireShared(ours: LsqClient, ref: LsqClient, opts: { attempts?: number; waitMs?: number } = {}): Promise<SharedAcquire> {
    const attempts = opts.attempts ?? 1, waitMs = opts.waitMs ?? 3000;
    let failure = "";
    for (let i = 0; i < attempts; i++) {
        if (i) await new Promise((r) => setTimeout(r, waitMs));
        await ours.acquire("tip");
        const p = await pointOf(ours);
        const b = await ref.acquire(p);
        if (b.ok) return { shared: true, slot: p.slot, hash: p.hash, note: `ours at ${p.slot}:${p.hash.slice(0, 16)}…; ref acquired the same block` };
        failure = b.failure;
    }
    if (attempts > 1) { // the reference ahead of us on another branch, or we lag: try its tip on our side
        await ref.acquire("tip");
        const p = await pointOf(ref);
        const a = await ours.acquire(p);
        if (a.ok) return { shared: true, slot: p.slot, hash: p.hash, note: `ref at ${p.slot}:${p.hash.slice(0, 16)}…; ours acquired the same block` };
        await ours.acquire("tip");
    } else await ref.acquire("tip");
    const p = await pointOf(ours);
    return { shared: false, slot: p.slot, hash: p.hash, note: `ours at ${p.slot}:${p.hash.slice(0, 16)}…; ref could not (${failure}): both at their own tips, live answers retried` };
}

/** Acquire the same explicit point on both sides. */
export async function acquirePoint(ours: LsqClient, ref: LsqClient, slot: bigint, hash: string): Promise<{ ok: boolean; note: string }> {
    const [a, b] = await Promise.all([ours.acquire({ slot, hash }), ref.acquire({ slot, hash })]);
    return { ok: a.ok && b.ok, note: `acquire ${slot}:${hash}: ours ${a.ok ? "ok" : a.failure}, ref ${b.ok ? "ok" : b.failure}` };
}

/** The current era index (6 = Conway) by the hard-fork combinator's GetCurrentEra. */
export async function currentEra(c: LsqClient): Promise<number> {
    return Number(((await c.query(A([U(0), A([U(2), A([U(1)])])]))) as CborUInt).num);
}

/** The queries `extra` adds (answered since bugs 260–267; a node needs its pool-ranking state recorded or seeded, scripts/nonmyopic-seed.ts). */
export const EXTRA_QUERY_NAMES = ["DebugLedgerConfig", "[2] GetNonMyopicMemberRewards(stakes, credentials)", "[18] GetRewardInfoPools"];

/**
 * Every Conway BlockQuery cardano-node 11 serves (ouroboros-consensus-cardano 3.0.1), the hard-fork
 * and top-level queries, and two wrong-era queries; arguments picked from the reference's answers
 * at the acquired block. `extra` adds the wallet reward queries and DebugLedgerConfig (EXTRA_QUERY_NAMES),
 * `huge` GetUTxOWhole and the debug dumps.
 */
export async function buildQuerySet(ref: LsqClient, opts: { era?: number; pools?: string[]; ownerCred?: string; huge?: boolean; extra?: boolean } = {}): Promise<CompareQuery[]> {
    const era = opts.era ?? 6;
    const pools = [...(opts.pools?.length ? opts.pools : [DEFAULT_POOL])].sort(); // Conway sets must be sorted: a cardano-node drops the connection otherwise
    const owner = opts.ownerCred ?? DEFAULT_OWNER_CRED;
    const L = (q: CborObj[], e = era) => ledger(q, e);
    const poolSet = () => S(pools.map(B));
    const pick = async (q: CborObj[]) => (await ref.query(L(q))) as CborArray;
    const mapEntries = (o: CborObj): Array<{ k: CborObj; v: CborObj }> => ((o as any)?.map ?? []) as Array<{ k: CborObj; v: CborObj }>;
    const drepStates = mapEntries((await pick([U(25), S([])])).array[0]!);
    const dreps = drepStates.slice(0, 3).map((e) => e.k); // credentials [type, hash]
    const drepIds = [...dreps.map((d) => d), A([U(2)]), A([U(3)])]; // DRep = [0|1, hash] | [2] | [3]
    const committee = (await pick([U(27), S([]), S([]), S([])])).array[0] as CborArray;
    const members = mapEntries(committee.array[0]!);
    const colds = members.slice(0, 2).map((e) => e.k);
    const hots = members.map((e) => (e.v as CborArray).array[0] as CborArray).filter((s) => Number((s.array[0] as CborUInt).num) === 0).slice(0, 1).map((s) => s.array[1]!);
    const delegs = mapEntries((await pick([U(28), S([])])).array[0]!);
    const stakeCreds = [delegs[0], delegs[Math.floor(delegs.length / 2)], delegs[delegs.length - 1]].filter(Boolean).map((e) => e!.k);
    const ownerCred = cred(0, owner); // our pool's reward account
    const proposals = ((await pick([U(31), S([])])).array[0] as CborArray).array.map((g) => (g as CborArray).array[0]!).slice(0, 2);
    const sortSet = (xs: CborObj[]) => S([...xs].sort((a, b) => Buffer.compare(Buffer.from(Cbor.encode(a).toBuffer()), Buffer.from(Cbor.encode(b).toBuffer()))));
    // cardano-node sorts nothing for us: a set argument must be in the key type's order (Credential: script first)
    const credSet = (xs: CborObj[]) => S([...xs].sort((a, b) => { const ta = Number(((a as CborArray).array[0] as CborUInt).num), tb = Number(((b as CborArray).array[0] as CborUInt).num); return ta !== tb ? tb - ta : Buffer.compare(Buffer.from(((a as CborArray).array[1] as CborBytes).bytes), Buffer.from(((b as CborArray).array[1] as CborBytes).bytes)); }));
    // GetNonMyopicMemberRewards' `Set (Either Coin Credential)` in Haskell order: every Left (coins ascending) before every Right (script credentials first)
    const memberSet = (coins: bigint[], creds: CborObj[]) => S([...[...coins].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((c) => A([U(0), U(c)])), ...(credSet(creds).data as CborArray).array.map((c) => A([U(1), c]))]);

    const queries: CompareQuery[] = [
        ["GetSystemStart", A([U(1)]), false],
        ["GetChainBlockNo", A([U(2)]), true],
        ["GetChainPoint", A([U(3)]), true],
        ["GetCurrentEra", A([U(0), A([U(2), A([U(1)])])]), false],
        ["GetInterpreter", A([U(0), A([U(2), A([U(0)])])]), false],
        ["GetEraStart(Conway)", A([U(0), A([U(1), A([U(0)]), U(6)])]), false],
        ["GetEraStart(Babbage)", A([U(0), A([U(1), A([U(0)]), U(5)])]), false],
        ["[0] GetLedgerTip", L([U(0)]), true],
        ["[1] GetEpochNo", L([U(1)]), false],
        ["[2] GetNonMyopicMemberRewards({})", L([U(2), S([])]), false],
        ["[3] GetCurrentPParams", L([U(3)]), false],
        ["[4] GetProposedPParamsUpdates", L([U(4)]), false],
        ["[5] GetStakeDistribution", L([U(5)]), true],
        ["[6] GetUTxOByAddress(owner)", L([U(6), S([B(`60${owner}`)])]), true],
        ["[9] GetCBOR(GetEpochNo)", L([U(9), A([U(1)])]), false],
        ["[9] GetCBOR(DebugChainDepState)", L([U(9), A([U(13)])]), true],
        ["[10] GetFilteredDelegationsAndRewardAccounts", L([U(10), credSet([...stakeCreds, ownerCred])]), true],
        ["[11] GetGenesisConfig", L([U(11)]), false],
        ["[13] DebugChainDepState", L([U(13)]), true],
        ["[14] GetRewardProvenance", L([U(14)]), false],
        ["[16] GetStakePools", L([U(16)]), false],
        ["[17] GetStakePoolParams(pools)", L([U(17), poolSet()]), false],
        ["[19] GetPoolState(all)", L([U(19), A([])]), false],
        ["[19] GetPoolState(pools)", L([U(19), A([poolSet()])]), false],
        ["[20] GetStakeSnapshots(all)", L([U(20), A([])]), false],
        ["[20] GetStakeSnapshots(pools)", L([U(20), A([poolSet()])]), false],
        ["[21] GetPoolDistr(all)", L([U(21), A([])]), false],
        ["[21] GetPoolDistr(pools)", L([U(21), A([poolSet()])]), false],
        ["[22] GetStakeDelegDeposits", L([U(22), credSet([...stakeCreds, ownerCred])]), true],
        ["[23] GetConstitution", L([U(23)]), false],
        ["[24] GetGovState", L([U(24)]), true],
        ["[25] GetDRepState(all)", L([U(25), S([])]), true],
        ["[25] GetDRepState(some)", L([U(25), credSet(dreps)]), true],
        ["[26] GetDRepStakeDistr(all)", L([U(26), S([])]), false],
        ["[26] GetDRepStakeDistr(some)", L([U(26), sortSet(drepIds)]), false],
        ["[27] GetCommitteeMembersState(all)", L([U(27), S([]), S([]), S([])]), false],
        ["[27] GetCommitteeMembersState(cold)", L([U(27), credSet(colds), S([]), S([])]), false],
        ["[27] GetCommitteeMembersState(hot)", L([U(27), S([]), credSet(hots), S([])]), false],
        ["[27] GetCommitteeMembersState(active)", L([U(27), S([]), S([]), S([U(0)])]), false],
        ["[27] GetCommitteeMembersState(expired)", L([U(27), S([]), S([]), S([U(1)])]), false],
        ["[28] GetFilteredVoteDelegatees(all)", L([U(28), S([])]), true],
        ["[28] GetFilteredVoteDelegatees(some)", L([U(28), credSet([...stakeCreds, ownerCred])]), true],
        ["[29] GetAccountState", L([U(29)]), true],
        ["[30] GetSPOStakeDistr(all)", L([U(30), S([])]), false],
        ["[30] GetSPOStakeDistr(pools)", L([U(30), poolSet()]), false],
        ["[31] GetProposals(all)", L([U(31), S([])]), false],
        ["[31] GetProposals(some)", L([U(31), sortSet(proposals)]), false],
        ["[32] GetRatifyState", L([U(32)]), false],
        ["[33] GetFuturePParams", L([U(33)]), false],
        ["[34] GetLedgerPeerSnapshot(all)", L([U(34), U(0)]), false],
        ["[34] GetLedgerPeerSnapshot(big)", L([U(34), U(1)]), false],
        ["[34] GetLedgerPeerSnapshot(legacy)", L([U(34)]), false],
        ["[35] QueryStakePoolDefaultVote", L([U(35), B(pools[0]!)]), false],
        ["[36] GetPoolDistr2(all)", L([U(36), A([])]), false],
        ["[36] GetPoolDistr2(pools)", L([U(36), A([poolSet()])]), false],
        ["[37] GetStakeDistribution2", L([U(37)]), true],
        ["[38] GetMaxMajorProtocolVersion", L([U(38)]), false],
        ["[39] GetDRepDelegations(all)", L([U(39), S([])]), true],
        ["[39] GetDRepDelegations(some)", L([U(39), sortSet(drepIds)]), true],
        ["wrong era: GetEpochNo(Babbage)", L([U(1)], 5), false],
        ["wrong era: GetStakePools(Babbage)", L([U(16)], 5), false],
    ];
    if (opts.extra) queries.push(
        ["DebugLedgerConfig", A([U(4)]), false],
        ["[2] GetNonMyopicMemberRewards(stakes, credentials)", L([U(2), memberSet([100_000_000n, 10_000_000_000n, 1_000_000_000_000n], [ownerCred, ...stakeCreds])]), true],
        ["[18] GetRewardInfoPools", L([U(18)]), true],
    );
    if (opts.huge) queries.push(["[7] GetUTxOWhole", L([U(7)]), true], ["[8] DebugEpochState", L([U(8)]), true], ["[12] DebugNewEpochState", L([U(12)]), true]);
    return queries;
}

/**
 * Ask both sides every query and compare the raw answers. Live answers (they move with every
 * block) are retried up to `liveAttempts` times when the two sides are not on one block. A query
 * error ends the run: a cardano-node drops the connection on a query it cannot decode.
 */
export async function compareQueries(ours: LsqClient, ref: LsqClient, queries: CompareQuery[], opts: { shared: boolean; liveAttempts?: number; retryWaitMs?: number; onResult?: (r: QueryResult) => void; onDiff?: (name: string, ours: Uint8Array, ref: Uint8Array) => void }): Promise<QueryResult[]> {
    const out: QueryResult[] = [];
    for (const [name, q, live] of queries) {
        let a = "", b = "", err = "";
        const attempts = live && !opts.shared ? (opts.liveAttempts ?? 5) : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, opts.retryWaitMs ?? 3000)); // no wait after the last try (was 3 s per DIFF)
            try { [a, b] = await Promise.all([ours.queryRaw(q).then(hex), ref.queryRaw(q).then(hex)]); } catch (e) { err = (e as Error).message; break; }
            if (a === b) break;
        }
        if (err) { const r: QueryResult = { name, same: false, ours: 0, ref: 0, err }; out.push(r); opts.onResult?.(r); break; }
        const r: QueryResult = { name, same: a === b, ours: a.length / 2, ref: b.length / 2 };
        if (!r.same) { let i = 0; while (i < a.length && a[i] === b[i]) i++; r.firstDiff = i >> 1; r.excerpt = `ours …${a.slice(Math.max(0, i - 16), i + 32)} ref …${b.slice(Math.max(0, i - 16), i + 32)}`; opts.onDiff?.(name, Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
        out.push(r); opts.onResult?.(r);
    }
    return out;
}

/** One output line per query, as n2c-compare prints it. */
export function formatResult(r: QueryResult): string {
    if (r.err) return `ERR   ${r.name.padEnd(44)} ${r.err}`;
    return `${r.same ? "SAME " : "DIFF "} ${r.name.padEnd(44)} ours ${r.ours} B, ref ${r.ref} B${r.same ? "" : ` first difference at byte ${r.firstDiff}: ${r.excerpt}`}`;
}
