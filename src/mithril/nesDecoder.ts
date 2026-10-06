/**
 * Decoder for the `ledger/<slot>/state` file of a Mithril `cardano-database` artifact: the
 * node's serialised `ExtLedgerState` (ledger state + header state) at the last immutable slot,
 * without the UTxO set (UTxO-HD keeps it in `tables/`, see `importUtxo.ts`).
 *
 * Pinned to the encoding written by cardano-node 11.0.x (cardano-ledger with the merged
 * stake/delegation snapshot maps, `StakePoolState` with deposit and delegator set, and the
 * DRep delegator sets; ouroboros-consensus Praos state with eight fields). Every section is
 * navigated with shape assertions that name the path, so a different node version fails loudly
 * instead of importing garbage. Verified field by field against the replay-6 preview ledger at
 * epoch 1415 (docs/PLAN_SNAPSHOT_BOOTSTRAP.md, phase C).
 *
 * Layout (index paths into the CBOR):
 *   [1, [ledger, header]]
 *   ledger = telescope of 7 era states; [6] = [bound, [2, ShelleyLedgerState]]
 *   ShelleyLedgerState = [tip, NewEpochState, transition, tables]
 *   NewEpochState = [epoch, blocksPrev, blocksCur, EpochState, rewardUpdate, poolDistr, avvm]
 *   EpochState = [[treasury, reserves], [CertState, UTxOState], [mark, set, go, fee], NonMyopic]
 *   CertState = [VState [dreps, committeeState, dormant], PState [vrfs, pools, future, retiring],
 *                DState [umap, futureGenDelegs, genDelegs, irwd]]
 *   UTxOState = [utxo (empty), deposited, fees, GovState, incrementalStake, donation]
 *   GovState = [proposals, committee, constitution, curPParams, prevPParams, futurePParams,
 *               drepPulsing (always the completed form: [PulsingSnapshot, RatifyState])]
 *   header = [[[eraIx, [slot, hash, blockNo]]], telescope; [6] = [bound, [0, PraosState]]]
 */
import { nonMyopicOfLedgerState } from "../consensus/nonMyopicSeed";
import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, CborObj, CborSimple, CborTag, CborText, CborUInt } from "@harmoniclabs/cbor";
import { toHex } from "@harmoniclabs/uint8array-utils";

export class LedgerSnapshotFormatError extends Error {}

/** A stake / DRep / committee credential: 0 = key hash, 1 = script hash; `hash` hex. */
export interface Cred { type: 0 | 1; hash: string }
/** The typed hex used as key in our tables (db/stakeCred.ts): hash, or "01" + hash for scripts. */
export function typedHex(c: Cred): string { return c.type === 1 ? `01${c.hash}` : c.hash; }

export type DRep = { kind: 0 | 1; hash: string } | { kind: 2 } | { kind: 3 };
export function drepKey(d: DRep): string { return d.kind <= 1 ? `${d.kind}:${(d as { hash: string }).hash}` : `${d.kind}:`; }

export interface Anchor { url: string; hash: string }

export interface UMapEntry { cred: Cred; reward: bigint; deposit: bigint; pool: string | null; drep: DRep | null }

export interface PoolState {
    vrf: string; pledge: bigint; cost: bigint; marginNum: bigint; marginDen: bigint;
    rewardAccount: Cred; owners: string[]; relays: CborObj[]; metadata: Anchor | null;
    deposit: bigint; delegators: Cred[];
}

/** One pool in a stake snapshot (the node precomputes what the reward calculation needs). */
export interface SnapshotPool {
    stake: bigint; ratioNum: bigint; ratioDen: bigint; owners: string[]; ownerStake: bigint;
    vrf: string; pledge: bigint; cost: bigint; marginNum: bigint; marginDen: bigint;
    delegators: number; rewardAccount: Cred;
}
export interface StakeSnapshot {
    /** typed credential hex → stake (UTxO + rewards) and the pool it delegates to */
    stake: Map<string, { stake: bigint; pool: string }>;
    pools: Map<string, SnapshotPool>;
}

export interface DRepState { cred: Cred; expiry: number; anchor: Anchor | null; deposit: bigint; delegators: Cred[] }

export type CommitteeAuth = { hot: Cred } | { resigned: true; anchor: Anchor | null };

export type ActionKind = "ParameterChange" | "InitHardFork" | "TreasuryWithdrawals" | "NoConfidence" | "UpdateCommittee" | "NewConstitution" | "Info";
export interface GovAction {
    kind: ActionKind;
    prev: string | null;
    /** ParameterChange: the update map as encoded (index → value) */
    update?: CborMap;
    policy?: string | null;
    protocolVersion?: { major: number; minor: number };
    withdrawals?: Array<{ account: Cred; amount: bigint }>;
    remove?: Cred[];
    add?: Array<{ cred: Cred; expires: number }>;
    threshold?: { num: bigint; den: bigint };
    constitution?: { anchor: Anchor; script: string | null };
}
export interface Proposal {
    /** "txid:index" */
    id: string;
    ccVotes: Map<string, number>;   // typed hot credential → 0 No | 1 Yes | 2 Abstain
    drepVotes: Map<string, number>; // typed DRep credential → vote
    spoVotes: Map<string, number>;  // pool id → vote
    deposit: bigint;
    returnAccount: Cred;
    action: GovAction;
    anchor: Anchor;
    proposedIn: number;
    expiresAfter: number;
}

export interface Roots { pparams: string | null; hardFork: string | null; committee: string | null; constitution: string | null }

export interface GovStateDecoded {
    roots: Roots;
    proposals: Proposal[];
    committee: { members: Map<string, number>; thresholdNum: bigint; thresholdDen: bigint } | null; // typed cold cred → expiry epoch
    constitution: { anchor: Anchor; script: string | null };
    curPParams: CborArray;
    prevPParams: CborArray;
    futurePParams: { kind: "none" } | { kind: "definite" | "potential"; pparams: CborArray };
    pulsing: {
        proposalIds: string[];
        drepDistr: Map<string, bigint>;  // drepKey → stake
        drepStateCount: number;
        poolDistr: Map<string, bigint>;
        enacted: string[];
        expired: string[];
        delayed: boolean;
    };
}

export interface PraosState {
    lastSlot: number | null;
    ocertCounters: Map<string, number>;
    evolving: string | null;
    candidate: string | null;
    epochNonce: string | null;
    /** Observed on node 11.0.1: the previous epoch's nonce (eighth Praos field). */
    previousEpochNonce: string | null;
    /** Nonce of the last applied block: its previous-hash field. */
    lab: string | null;
    /** The lab nonce frozen at the last epoch transition (η_h of the next TICKN). */
    lastEpochBlock: string | null;
}

export interface LedgerSnapshot {
    slot: number; blockHash: string; blockNo: number;
    epoch: number;
    blocksPrev: Map<string, number>;
    blocksCur: Map<string, number>;
    treasury: bigint; reserves: bigint;
    umap: UMapEntry[];
    genDelegs: Map<string, { delegate: string; vrf: string }>;
    irwdEmpty: boolean;
    pools: Map<string, PoolState>;
    futurePools: Map<string, PoolState>;
    retiring: Map<string, number>;
    dreps: DRepState[];
    committeeState: Map<string, CommitteeAuth>;
    dormantEpochs: number;
    deposited: bigint; fees: bigint; donation: bigint;
    incrementalStake: Map<string, bigint>;
    gov: GovStateDecoded;
    snapshots: { mark: StakeSnapshot; set: StakeSnapshot; go: StakeSnapshot; fee: bigint };
    poolDistr: { pools: Map<string, { stake: bigint; vrf: string }>; total: bigint };
    nonMyopicRewardPot: bigint;
    /** `esNonMyopic`'s per-pool likelihoods (100 Float log-weights each), for the pool-ranking queries. */
    nonMyopicLikelihoods: Map<string, Float32Array>;
    stashedAvvm: boolean;
    praos: PraosState;
}

// ───────────────────────────── CBOR helpers ─────────────────────────────

function fail(path: string, what: string, o?: CborObj): never {
    const got = o == null ? "nothing" : o.constructor?.name ?? typeof o;
    throw new LedgerSnapshotFormatError(`ledger state: ${path}: expected ${what}, got ${got}`);
}
function arr(o: CborObj | undefined, path: string, len?: number): CborObj[] {
    if (!(o instanceof CborArray)) fail(path, "array", o);
    if (len != null && o.array.length !== len) throw new LedgerSnapshotFormatError(`ledger state: ${path}: expected ${len} items, got ${o.array.length}`);
    return o.array;
}
function map(o: CborObj | undefined, path: string): Array<{ k: CborObj; v: CborObj }> {
    if (!(o instanceof CborMap)) fail(path, "map", o);
    return o.map;
}
function bytes(o: CborObj | undefined, path: string, len?: number): string {
    if (!(o instanceof CborBytes)) fail(path, "bytes", o);
    if (len != null && o.bytes.length !== len) throw new LedgerSnapshotFormatError(`ledger state: ${path}: expected ${len} bytes, got ${o.bytes.length}`);
    return toHex(o.bytes);
}
function big(o: CborObj | undefined, path: string): bigint {
    if (o instanceof CborUInt) return o.num;
    if (o instanceof CborNegInt) return o.num;
    return fail(path, "integer", o);
}
function int(o: CborObj | undefined, path: string): number { return Number(big(o, path)); }
function text(o: CborObj | undefined, path: string): string {
    if (!(o instanceof CborText)) fail(path, "text", o);
    return o.text;
}
function isNull(o: CborObj | undefined): boolean { return o instanceof CborSimple && o.simple === null; }
function bool(o: CborObj | undefined, path: string): boolean {
    if (o instanceof CborSimple && typeof o.simple === "boolean") return o.simple;
    return fail(path, "boolean", o);
}
/** A set: tag 258 around an array, or a bare array (older encoders). */
function set(o: CborObj | undefined, path: string): CborObj[] {
    if (o instanceof CborTag && Number(o.tag) === 258) return arr(o.data, path);
    return arr(o, path);
}
function rational(o: CborObj | undefined, path: string): { num: bigint; den: bigint } {
    if (!(o instanceof CborTag) || Number(o.tag) !== 30) fail(path, "tag 30 rational", o);
    const a = arr(o.data, path, 2);
    return { num: big(a[0], path), den: big(a[1], path) };
}
function cred(o: CborObj | undefined, path: string): Cred {
    const a = arr(o, path, 2);
    const t = int(a[0], path);
    if (t !== 0 && t !== 1) throw new LedgerSnapshotFormatError(`ledger state: ${path}: credential type ${t}`);
    return { type: t, hash: bytes(a[1], path, 28) };
}
function drep(o: CborObj | undefined, path: string): DRep {
    const a = arr(o, path);
    const k = int(a[0], path);
    if (k === 0 || k === 1) return { kind: k, hash: bytes(a[1], path, 28) };
    if (k === 2 || k === 3) return { kind: k };
    throw new LedgerSnapshotFormatError(`ledger state: ${path}: DRep kind ${k}`);
}
function anchor(o: CborObj | undefined, path: string): Anchor {
    const a = arr(o, path, 2);
    return { url: text(a[0], path), hash: bytes(a[1], path, 32) };
}
/** StrictMaybe as a list: [] = nothing, [x] = just. */
function maybe<T>(o: CborObj | undefined, path: string, f: (x: CborObj) => T): T | null {
    const a = arr(o, path);
    if (a.length === 0) return null;
    if (a.length === 1) return f(a[0]!);
    throw new LedgerSnapshotFormatError(`ledger state: ${path}: StrictMaybe with ${a.length} items`);
}
function nonce(o: CborObj | undefined, path: string): string | null {
    const a = arr(o, path);
    if (int(a[0], path) === 0) return null;
    return bytes(a[1], path, 32);
}
function govActionId(o: CborObj | undefined, path: string): string {
    const a = arr(o, path, 2);
    return `${bytes(a[0], path, 32)}:${int(a[1], path)}`;
}
function rewardAccount(o: CborObj | undefined, path: string): Cred {
    const h = bytes(o, path, 29);
    const header = parseInt(h.slice(0, 2), 16);
    const kind = header >> 4;
    if (kind !== 0xe && kind !== 0xf) throw new LedgerSnapshotFormatError(`ledger state: ${path}: reward account header ${header.toString(16)}`);
    return { type: kind === 0xf ? 1 : 0, hash: h.slice(2) };
}
function poolStateOf(o: CborObj | undefined, path: string): PoolState {
    const a = arr(o, path, 10);
    const margin = rational(a[3], `${path}.margin`);
    return {
        vrf: bytes(a[0], `${path}.vrf`, 32), pledge: big(a[1], `${path}.pledge`), cost: big(a[2], `${path}.cost`),
        marginNum: margin.num, marginDen: margin.den,
        rewardAccount: cred(a[4], `${path}.rewardAccount`),
        owners: set(a[5], `${path}.owners`).map((x, i) => bytes(x, `${path}.owners[${i}]`, 28)),
        relays: arr(a[6], `${path}.relays`),
        metadata: maybe(a[7], `${path}.metadata`, (x) => anchor(x, `${path}.metadata`)),
        deposit: big(a[8], `${path}.deposit`),
        delegators: set(a[9], `${path}.delegators`).map((x, i) => cred(x, `${path}.delegators[${i}]`)),
    };
}
function snapshotOf(o: CborObj | undefined, path: string): StakeSnapshot {
    const a = arr(o, path, 2);
    const stake = new Map<string, { stake: bigint; pool: string }>();
    for (const { k, v } of map(a[0], `${path}.stake`)) {
        const c = cred(k, `${path}.stake.key`);
        const e = arr(v, `${path}.stake.value`, 2);
        stake.set(typedHex(c), { stake: big(e[0], `${path}.stake.coin`), pool: bytes(e[1], `${path}.stake.pool`, 28) });
    }
    const pools = new Map<string, SnapshotPool>();
    for (const { k, v } of map(a[1], `${path}.pools`)) {
        const id = bytes(k, `${path}.pools.key`, 28);
        const p = arr(v, `${path}.pools.${id.slice(0, 8)}`, 10);
        const ratio = rational(p[1], `${path}.pools.ratio`), margin = rational(p[7], `${path}.pools.margin`);
        pools.set(id, {
            stake: big(p[0], `${path}.pools.stake`), ratioNum: ratio.num, ratioDen: ratio.den,
            owners: set(p[2], `${path}.pools.owners`).map((x) => bytes(x, `${path}.pools.owner`, 28)),
            ownerStake: big(p[3], `${path}.pools.ownerStake`), vrf: bytes(p[4], `${path}.pools.vrf`, 32),
            pledge: big(p[5], `${path}.pools.pledge`), cost: big(p[6], `${path}.pools.cost`),
            marginNum: margin.num, marginDen: margin.den, delegators: int(p[8], `${path}.pools.delegators`),
            rewardAccount: cred(p[9], `${path}.pools.rewardAccount`),
        });
    }
    return { stake, pools };
}
function votesOf(o: CborObj | undefined, path: string, key: (k: CborObj) => string): Map<string, number> {
    const out = new Map<string, number>();
    for (const { k, v } of map(o, path)) out.set(key(k), int(v, `${path}.vote`));
    return out;
}
function actionOf(o: CborObj | undefined, path: string): GovAction {
    const a = arr(o, path);
    const tag = int(a[0], path);
    const prev = (i: number) => (isNull(a[i]) ? null : govActionId(a[i], `${path}.prev`));
    const policy = (i: number) => (isNull(a[i]) || a[i] == null ? null : bytes(a[i], `${path}.policy`, 28));
    switch (tag) {
        case 0: {
            if (!(a[2] instanceof CborMap)) fail(`${path}.update`, "map", a[2]);
            return { kind: "ParameterChange", prev: prev(1), update: a[2], policy: policy(3) };
        }
        case 1: { const pv = arr(a[2], `${path}.protocolVersion`, 2); return { kind: "InitHardFork", prev: prev(1), protocolVersion: { major: int(pv[0], path), minor: int(pv[1], path) } }; }
        case 2: {
            const withdrawals = map(a[1], `${path}.withdrawals`).map(({ k, v }) => ({ account: rewardAccount(k, `${path}.withdrawals.account`), amount: big(v, `${path}.withdrawals.amount`) }));
            return { kind: "TreasuryWithdrawals", prev: null, withdrawals, policy: policy(2) };
        }
        case 3: return { kind: "NoConfidence", prev: prev(1) };
        case 4: {
            const thr = rational(a[4], `${path}.threshold`);
            return {
                kind: "UpdateCommittee", prev: prev(1),
                remove: set(a[2], `${path}.remove`).map((x) => cred(x, `${path}.remove`)),
                add: map(a[3], `${path}.add`).map(({ k, v }) => ({ cred: cred(k, `${path}.add.cred`), expires: int(v, `${path}.add.epoch`) })),
                threshold: thr,
            };
        }
        case 5: { const c = arr(a[2], `${path}.constitution`, 2); return { kind: "NewConstitution", prev: prev(1), constitution: { anchor: anchor(c[0], `${path}.constitution.anchor`), script: isNull(c[1]) ? null : bytes(c[1], `${path}.constitution.script`, 28) } }; }
        case 6: return { kind: "Info", prev: null };
        default: throw new LedgerSnapshotFormatError(`ledger state: ${path}: governance action tag ${tag}`);
    }
}
function proposalOf(o: CborObj | undefined, path: string): Proposal {
    const a = arr(o, path, 7);
    const id = govActionId(a[0], `${path}.id`);
    const p = `${path}.${id.slice(0, 8)}`;
    const proc = arr(a[4], `${p}.procedure`, 4);
    return {
        id,
        ccVotes: votesOf(a[1], `${p}.ccVotes`, (k) => typedHex(cred(k, `${p}.ccVotes.key`))),
        drepVotes: votesOf(a[2], `${p}.drepVotes`, (k) => typedHex(cred(k, `${p}.drepVotes.key`))),
        spoVotes: votesOf(a[3], `${p}.spoVotes`, (k) => bytes(k, `${p}.spoVotes.key`, 28)),
        deposit: big(proc[0], `${p}.deposit`),
        returnAccount: rewardAccount(proc[1], `${p}.returnAccount`),
        action: actionOf(proc[2], `${p}.action`),
        anchor: anchor(proc[3], `${p}.anchor`),
        proposedIn: int(a[5], `${p}.proposedIn`),
        expiresAfter: int(a[6], `${p}.expiresAfter`),
    };
}
function rootsOf(o: CborObj | undefined, path: string): Roots {
    const a = arr(o, path, 4);
    const r = (i: number) => maybe(a[i], `${path}[${i}]`, (x) => govActionId(x, `${path}[${i}]`));
    return { pparams: r(0), hardFork: r(1), committee: r(2), constitution: r(3) };
}
function constitutionOf(o: CborObj | undefined, path: string): { anchor: Anchor; script: string | null } {
    const a = arr(o, path, 2);
    return { anchor: anchor(a[0], `${path}.anchor`), script: isNull(a[1]) ? null : bytes(a[1], `${path}.script`, 28) };
}

// ───────────────────────────── the decoder ─────────────────────────────

/** Decode the `state` file. Throws `LedgerSnapshotFormatError` on any unexpected shape. */
export function decodeLedgerSnapshot(stateBytes: Uint8Array): LedgerSnapshot {
    const top = arr(Cbor.parse(stateBytes), "top", 2);
    const version = int(top[0], "top.version");
    if (version !== 1) throw new LedgerSnapshotFormatError(`ledger state: ExtLedgerState version ${version} (expected 1)`);
    const root = arr(top[1], "ext", 2);
    const telescope = arr(root[0], "ledger.telescope", 7);
    const current = arr(telescope[6], "ledger.conway", 2);
    const sls = arr(current[1], "ledger.conway.state", 2);
    const slsVersion = int(sls[0], "ledger.conway.state.version");
    if (slsVersion !== 2) throw new LedgerSnapshotFormatError(`ledger state: ShelleyLedgerState version ${slsVersion} (expected 2)`);
    const shelley = arr(sls[1], "shelleyLedgerState", 4);
    const tipArr = arr(shelley[0], "shelleyLedgerState.tip", 1);
    const tip = arr(tipArr[0], "shelleyLedgerState.tip.point", 3);
    const nes = arr(shelley[1], "nes", 7);

    const epoch = int(nes[0], "nes.epoch");
    const blocksMade = (o: CborObj | undefined, path: string) => { const m = new Map<string, number>(); for (const { k, v } of map(o, path)) m.set(bytes(k, `${path}.pool`, 28), int(v, `${path}.count`)); return m; };
    const es = arr(nes[3], "nes.epochState", 4);
    const account = arr(es[0], "epochState.account", 2);
    const ls = arr(es[1], "epochState.ledgerState", 2);
    const certState = arr(ls[0], "certState", 3);
    const vstate = arr(certState[0], "vstate", 3);
    const pstate = arr(certState[1], "pstate", 4);
    const dstate = arr(certState[2], "dstate", 4);
    const utxoState = arr(ls[1], "utxoState", 6);

    // DState
    const umap: UMapEntry[] = [];
    for (const { k, v } of map(dstate[0], "dstate.umap")) {
        const c = cred(k, "dstate.umap.key");
        const e = arr(v, `dstate.umap.${c.hash.slice(0, 8)}`, 4);
        umap.push({
            cred: c, reward: big(e[0], "umap.reward"), deposit: big(e[1], "umap.deposit"),
            pool: isNull(e[2]) ? null : bytes(e[2], "umap.pool", 28),
            drep: isNull(e[3]) ? null : drep(e[3], "umap.drep"),
        });
    }
    if (map(dstate[1], "dstate.futureGenDelegs").length) throw new LedgerSnapshotFormatError("ledger state: future genesis delegations present (not supported)");
    const genDelegs = new Map<string, { delegate: string; vrf: string }>();
    for (const { k, v } of map(dstate[2], "dstate.genDelegs")) { const a = arr(v, "genDelegs.value", 2); genDelegs.set(bytes(k, "genDelegs.key", 28), { delegate: bytes(a[0], "genDelegs.delegate", 28), vrf: bytes(a[1], "genDelegs.vrf", 32) }); }
    const irwd = arr(dstate[3], "dstate.irwd", 4);
    const irwdEmpty = map(irwd[0], "irwd.reserves").length === 0 && map(irwd[1], "irwd.treasury").length === 0 && big(irwd[2], "irwd.deltaR") === 0n && big(irwd[3], "irwd.deltaT") === 0n;

    // PState
    const poolMap = (o: CborObj | undefined, path: string) => { const m = new Map<string, PoolState>(); for (const { k, v } of map(o, path)) { const id = bytes(k, `${path}.key`, 28); m.set(id, poolStateOf(v, `${path}.${id.slice(0, 8)}`)); } return m; };
    const pools = poolMap(pstate[1], "pstate.pools");
    const futurePools = poolMap(pstate[2], "pstate.future");
    const retiring = new Map<string, number>();
    for (const { k, v } of map(pstate[3], "pstate.retiring")) retiring.set(bytes(k, "retiring.key", 28), int(v, "retiring.epoch"));

    // VState
    const dreps: DRepState[] = [];
    for (const { k, v } of map(vstate[0], "vstate.dreps")) {
        const c = cred(k, "dreps.key");
        const a = arr(v, `dreps.${c.hash.slice(0, 8)}`, 4);
        dreps.push({ cred: c, expiry: int(a[0], "dreps.expiry"), anchor: maybe(a[1], "dreps.anchor", (x) => anchor(x, "dreps.anchor")), deposit: big(a[2], "dreps.deposit"), delegators: set(a[3], "dreps.delegators").map((x) => cred(x, "dreps.delegator")) });
    }
    const committeeState = new Map<string, CommitteeAuth>();
    for (const { k, v } of map(vstate[1], "vstate.committeeState")) {
        const cold = typedHex(cred(k, "committeeState.key"));
        const a = arr(v, `committeeState.${cold.slice(0, 8)}`);
        const t = int(a[0], "committeeState.tag");
        if (t === 0) committeeState.set(cold, { hot: cred(a[1], "committeeState.hot") });
        else if (t === 1) committeeState.set(cold, { resigned: true, anchor: a[1] == null || isNull(a[1]) ? null : anchor(a[1], "committeeState.anchor") });
        else throw new LedgerSnapshotFormatError(`ledger state: committeeState tag ${t}`);
    }
    const dormantEpochs = int(vstate[2], "vstate.dormant");

    // UTxOState
    if (map(utxoState[0], "utxoState.utxo").length) throw new LedgerSnapshotFormatError("ledger state: in-memory UTxO present (expected UTxO-HD tables)");
    const incrementalStake = new Map<string, bigint>();
    for (const { k, v } of map(utxoState[4], "utxoState.incrementalStake")) incrementalStake.set(typedHex(cred(k, "incrementalStake.key")), big(v, "incrementalStake.coin"));
    const govArr = arr(utxoState[3], "govState", 7);
    const proposalsArr = arr(govArr[0], "govState.proposals", 2);
    const proposals = arr(proposalsArr[1], "govState.proposals.list").map((p, i) => proposalOf(p, `proposals[${i}]`));
    const committee = maybe(govArr[1], "govState.committee", (x) => {
        const a = arr(x, "govState.committee", 2);
        const members = new Map<string, number>();
        for (const { k, v } of map(a[0], "committee.members")) members.set(typedHex(cred(k, "committee.members.key")), int(v, "committee.members.expiry"));
        const thr = rational(a[1], "committee.threshold");
        return { members, thresholdNum: thr.num, thresholdDen: thr.den };
    });
    const constitution = constitutionOf(govArr[2], "govState.constitution");
    const pparamsArr = (o: CborObj | undefined, path: string): CborArray => { if (!(o instanceof CborArray)) fail(path, "array", o); if (o.array.length !== 31) throw new LedgerSnapshotFormatError(`ledger state: ${path}: ${o.array.length} parameters (expected 31, Conway)`); return o; };
    const curPParams = pparamsArr(govArr[3], "govState.curPParams");
    const prevPParams = pparamsArr(govArr[4], "govState.prevPParams");
    const fut = arr(govArr[5], "govState.futurePParams");
    const futTag = int(fut[0], "govState.futurePParams.tag");
    const futurePParams: GovStateDecoded["futurePParams"] = futTag === 0 ? { kind: "none" } : futTag === 1 ? { kind: "definite", pparams: pparamsArr(fut[1], "futurePParams.definite") } : futTag === 2 ? { kind: "potential", pparams: pparamsArr(fut[1], "futurePParams.potential") } : (() => { throw new LedgerSnapshotFormatError(`ledger state: futurePParams tag ${futTag}`); })();
    const pulsingArr = arr(govArr[6], "govState.drepPulsing", 2);
    const snap = arr(pulsingArr[0], "drepPulsing.snapshot", 4);
    const ratify = arr(pulsingArr[1], "drepPulsing.ratifyState", 4);
    const drepDistr = new Map<string, bigint>();
    for (const { k, v } of map(snap[1], "pulsing.drepDistr")) drepDistr.set(drepKey(drep(k, "pulsing.drepDistr.key")), big(v, "pulsing.drepDistr.coin"));
    const poolDistrPulse = new Map<string, bigint>();
    for (const { k, v } of map(snap[3], "pulsing.poolDistr")) poolDistrPulse.set(bytes(k, "pulsing.poolDistr.key", 28), big(v, "pulsing.poolDistr.coin"));
    const pulsing: GovStateDecoded["pulsing"] = {
        proposalIds: arr(snap[0], "pulsing.proposals").map((p, i) => govActionId(arr(p, `pulsing.proposals[${i}]`)[0], `pulsing.proposals[${i}].id`)),
        drepDistr, drepStateCount: map(snap[2], "pulsing.drepState").length, poolDistr: poolDistrPulse,
        enacted: arr(ratify[1], "ratify.enacted").map((p, i) => govActionId(arr(p, `ratify.enacted[${i}]`)[0], `ratify.enacted[${i}].id`)),
        expired: set(ratify[2], "ratify.expired").map((x) => govActionId(x, "ratify.expired")),
        delayed: bool(ratify[3], "ratify.delayed"),
    };
    const gov: GovStateDecoded = { roots: rootsOf(proposalsArr[0], "govState.proposals.roots"), proposals, committee, constitution, curPParams, prevPParams, futurePParams, pulsing };

    // Snapshots, pool distribution, non-myopic
    const snaps = arr(es[2], "epochState.snapshots", 4);
    const snapshots = { mark: snapshotOf(snaps[0], "snapshots.mark"), set: snapshotOf(snaps[1], "snapshots.set"), go: snapshotOf(snaps[2], "snapshots.go"), fee: big(snaps[3], "snapshots.fee") };
    const pd = arr(nes[5], "nes.poolDistr", 2);
    const pdPools = new Map<string, { stake: bigint; vrf: string }>();
    for (const { k, v } of map(pd[0], "poolDistr.pools")) { const a = arr(v, "poolDistr.value", 3); pdPools.set(bytes(k, "poolDistr.key", 28), { stake: big(a[1], "poolDistr.stake"), vrf: bytes(a[2], "poolDistr.vrf", 32) }); }
    const nonMyopic = arr(es[3], "epochState.nonMyopic", 2);
    // The likelihoods are CBOR float32s, which @harmoniclabs/cbor decodes in the platform's byte order
    // (uint8array-utils readFloat32BE fills a Float32Array: little-endian on x86), i.e. byte-swapped, and
    // not recoverable where the swapped bits form a NaN. Read them from the raw bytes (bug 371); the
    // object tree only checks the shape.
    const nmRaw = nonMyopicOfLedgerState(stateBytes);
    const nonMyopicLikelihoods = nmRaw.likelihoods;
    let nmPools = 0;
    for (const { k, v } of map(nonMyopic[0], "nonMyopic.likelihoods")) {
        const id = bytes(k, "nonMyopic.pool", 28), ws = arr(v, "nonMyopic.likelihood");
        for (const x of ws) if (!(x instanceof CborSimple) || typeof x.simple !== "number") fail("nonMyopic.likelihood", "float", x);
        if (nonMyopicLikelihoods.get(id)?.length !== ws.length) throw new LedgerSnapshotFormatError(`ledger state: likelihood of pool ${id} not read from the raw bytes`);
        nmPools++;
    }
    if (nmPools !== nonMyopicLikelihoods.size || nmRaw.epoch !== epoch || nmRaw.rewardPot !== big(nonMyopic[1], "nonMyopic.rewardPot")) throw new LedgerSnapshotFormatError("ledger state: raw NonMyopic read disagrees with the decoded state");

    // Header state
    const header = arr(root[1], "header", 2);
    const hTipArr = arr(header[0], "header.tip", 1);
    const hTip = arr(hTipArr[0], "header.tip.point", 2);
    const hTipPoint = arr(hTip[1], "header.tip.point.value", 3);
    if (int(hTipPoint[0], "header.tip.slot") !== int(tip[0], "ledger.tip.slot")) throw new LedgerSnapshotFormatError("ledger state: header tip and ledger tip differ");
    const chainDep = arr(header[1], "header.chainDepState", 7);
    const praosCurrent = arr(chainDep[6], "header.chainDepState.conway", 2);
    const praosVersioned = arr(praosCurrent[1], "praos.versioned", 2);
    if (int(praosVersioned[0], "praos.version") !== 0) throw new LedgerSnapshotFormatError("ledger state: Praos state version");
    const pr = arr(praosVersioned[1], "praos", 8);
    const lastSlotArr = arr(pr[0], "praos.lastSlot");
    const ocertCounters = new Map<string, number>();
    for (const { k, v } of map(pr[1], "praos.ocertCounters")) ocertCounters.set(bytes(k, "ocert.key", 28), int(v, "ocert.counter"));
    const praos: PraosState = {
        lastSlot: int(lastSlotArr[0], "praos.lastSlot.tag") === 0 ? null : int(lastSlotArr[1], "praos.lastSlot"),
        ocertCounters,
        evolving: nonce(pr[2], "praos.evolving"), candidate: nonce(pr[3], "praos.candidate"), epochNonce: nonce(pr[4], "praos.epoch"),
        previousEpochNonce: nonce(pr[5], "praos.previousEpoch"), lab: nonce(pr[6], "praos.lab"), lastEpochBlock: nonce(pr[7], "praos.lastEpochBlock"),
    };

    return {
        slot: int(tip[0], "tip.slot"), blockNo: int(tip[1], "tip.blockNo"), blockHash: bytes(tip[2], "tip.hash", 32),
        epoch,
        blocksPrev: blocksMade(nes[1], "nes.blocksPrev"), blocksCur: blocksMade(nes[2], "nes.blocksCur"),
        treasury: big(account[0], "account.treasury"), reserves: big(account[1], "account.reserves"),
        umap, genDelegs, irwdEmpty, pools, futurePools, retiring, dreps, committeeState, dormantEpochs,
        deposited: big(utxoState[1], "utxoState.deposited"), fees: big(utxoState[2], "utxoState.fees"), donation: big(utxoState[5], "utxoState.donation"),
        incrementalStake, gov, snapshots,
        poolDistr: { pools: pdPools, total: big(pd[1], "poolDistr.total") },
        nonMyopicRewardPot: big(nonMyopic[1], "nonMyopic.rewardPot"),
        nonMyopicLikelihoods,
        stashedAvvm: !isNull(nes[6]),
        praos,
    };
}

// ───────────────────────────── protocol parameters ─────────────────────────────

const POOL_THRESHOLDS = ["pvt_motion_no_confidence", "pvt_committee_normal", "pvt_committee_no_confidence", "pvt_hard_fork_initiation", "pvt_p_p_security_group"];
const DREP_THRESHOLDS = ["dvt_motion_no_confidence", "dvt_committee_normal", "dvt_committee_no_confidence", "dvt_update_to_constitution", "dvt_hard_fork_initiation", "dvt_p_p_network_group", "dvt_p_p_economic_group", "dvt_p_p_technical_group", "dvt_p_p_gov_group", "dvt_treasury_withdrawal"];

/**
 * The Conway `PParams` record (31 fields) as the raw record `epoch_params` stores
 * (Blockfrost field names; the same shapes `pparams.ts` derives at boundaries).
 */
export function conwayPParamsToRaw(pp: CborArray): Record<string, unknown> {
    const a = pp.array;
    const p = "pparams";
    const dec = (o: CborObj | undefined, path: string): number => { const r = rational(o, path); return Number(r.num) / Number(r.den); };
    const pv = arr(a[12], `${p}.protocolVersion`, 2);
    const costModels: Record<string, number[]> = {};
    for (const { k, v } of map(a[15], `${p}.costModels`)) costModels[`PlutusV${int(k, `${p}.costModels.lang`) + 1}`] = arr(v, `${p}.costModels.values`).map((x) => int(x, `${p}.costModels.value`));
    const prices = arr(a[16], `${p}.prices`, 2), txEx = arr(a[17], `${p}.maxTxExUnits`, 2), blockEx = arr(a[18], `${p}.maxBlockExUnits`, 2);
    const poolThr = arr(a[22], `${p}.poolVotingThresholds`, 5), drepThr = arr(a[23], `${p}.drepVotingThresholds`, 10);
    const out: Record<string, unknown> = {
        min_fee_a: int(a[0], `${p}.minFeeA`), min_fee_b: int(a[1], `${p}.minFeeB`),
        max_tx_size: int(a[3], `${p}.maxTxSize`), max_block_size: int(a[2], `${p}.maxBlockBodySize`), max_block_header_size: int(a[4], `${p}.maxBlockHeaderSize`),
        protocol_major_ver: int(pv[0], `${p}.major`), decentralisation_param: 0,
        key_deposit: int(a[5], `${p}.keyDeposit`), pool_deposit: int(a[6], `${p}.poolDeposit`),
        min_utxo: String(big(a[14], `${p}.coinsPerUTxOByte`)), protocol_minor_ver: int(pv[1], `${p}.minor`),
        e_max: int(a[7], `${p}.eMax`), n_opt: int(a[8], `${p}.nOpt`),
        a0: dec(a[9], `${p}.a0`), rho: dec(a[10], `${p}.rho`), tau: dec(a[11], `${p}.tau`),
        min_pool_cost: int(a[13], `${p}.minPoolCost`), extra_entropy: null,
        coins_per_utxo_word: String(big(a[14], `${p}.coinsPerUTxOByte`)), coins_per_utxo_size: String(big(a[14], `${p}.coinsPerUTxOByte`)),
        price_mem: dec(prices[0], `${p}.priceMem`), price_step: dec(prices[1], `${p}.priceStep`),
        max_tx_ex_mem: String(big(txEx[0], p)), max_tx_ex_steps: String(big(txEx[1], p)),
        max_block_ex_mem: String(big(blockEx[0], p)), max_block_ex_steps: String(big(blockEx[1], p)),
        max_val_size: String(big(a[19], `${p}.maxValSize`)), collateral_percent: int(a[20], `${p}.collateralPercentage`), max_collateral_inputs: int(a[21], `${p}.maxCollateralInputs`),
        cost_models: costModels,
    };
    POOL_THRESHOLDS.forEach((k, i) => { out[k] = dec(poolThr[i], `${p}.${k}`); });
    DREP_THRESHOLDS.forEach((k, i) => { out[k] = dec(drepThr[i], `${p}.${k}`); });
    out.committee_min_size = int(a[24], `${p}.committeeMinSize`);
    out.committee_max_term_length = int(a[25], `${p}.committeeMaxTermLength`);
    out.gov_action_lifetime = int(a[26], `${p}.govActionLifetime`);
    out.gov_action_deposit = int(a[27], `${p}.govActionDeposit`);
    out.drep_deposit = String(big(a[28], `${p}.drepDeposit`));
    out.drep_activity = int(a[29], `${p}.drepActivity`);
    out.min_fee_ref_script_cost_per_byte = dec(a[30], `${p}.minFeeRefScriptCostPerByte`);
    return out;
}
