import {
    BYRON_PP_FIELDS,
    LOVELACE_PORTION_DENOMINATOR,
    byronProtocolParametersFromGenesis,
    byronUpdatePayloadOfBody,
    decodeByronHeaderUpdateFields,
    decodeByronUpdatePayload,
    verifyProposalSignature,
    verifyVoteSignature,
    type ByronProposal,
    type ByronProtocolParameters,
    type ByronProtocolParametersUpdate,
    type ByronProtocolVersion,
    type ByronSoftwareVersion,
    type ByronUpdatePayload,
    type ByronVote,
} from "./byronUpdateCodec";
import { byronKeyHash as byronKeyHashRaw } from "./ByronCrypto";

/**
 * Byron update interface (cardano-ledger-byron `Cardano.Chain.Update.Validation.Interface`,
 * the BUPI / UPIREG / UPIVOTES / UPIEND / UPIEC rules), transcribed function by function:
 *
 *   registerProposal    ← Interface.registerProposal + Registration.registerProposal
 *                          (registerProposalComponents, registerProtocolUpdate, pvCanFollow,
 *                           canUpdate, registerSoftwareUpdate, svCanFollow)
 *   registerVotes       ← Interface.registerVotes / registerVote + Voting.registerVoteWithConfirmation
 *   registerEndorsement ← Interface.registerEndorsement + Endorsement.register
 *                          (updateCandidateProtocolUpdates = FADS)
 *   registerEpoch       ← Interface.registerEpoch + ProtocolVersionBump.tryBumpVersion
 *   epochTransition     ← Cardano.Chain.Block.Validation.epochTransition
 *   ByronUpdateTracker  ← Block.Validation.updateBlock / updateBody (the per-block driver)
 *
 * Thresholds, exactly as the Haskell code computes them:
 *   upAdptThd  = ⌊ srMinThd/1e15 · numGenKeys ⌋  — used for BOTH vote confirmation and
 *                endorsement adoption (`ppUpdateVoteThd`/`ppUpdateProposalThd` are unused).
 *                Mainnet/preprod: ⌊0.6 · 7⌋ = 4.
 *   stable confirmation: confirmedSlot + 2k ≤ currentSlot          (kSlotSecurityParam)
 *   adoption: candidate slot + 4k ≤ first slot of the new epoch    (kUpdateStabilityParam)
 *   expiry:   a proposal survives while currentSlot ≤ regSlot + ppUpdateProposalTTL, or once confirmed
 *   epoch = 10k slots                                               (kEpochSlots)
 *
 * Key hashes are Byron `KeyHash` hex (ByronCrypto.byronKeyHash). The delegation map is the
 * ledger's `Delegation.Map`: genesis key hash → delegate key hash.
 */

// ───────────────────────────── types ─────────────────────────────

export interface ByronUpdateEnv {
    protocolMagic: number;
    k: number;
    currentSlot: bigint;
    numGenKeys: number;
    /** genesis key hash → delegate key hash. */
    delegationMap: ReadonlyMap<string, string>;
    /** Skip ed25519 checks (tests / trusted replays). Default: verify. */
    skipSignatures?: boolean;
}

export interface ProtocolUpdateProposal {
    protocolVersion: ByronProtocolVersion;
    protocolParameters: ByronProtocolParameters;
}

export interface SoftwareUpdateProposal {
    softwareVersion: ByronSoftwareVersion;
    metadata: Map<string, string>;
}

export interface ApplicationVersion {
    version: number;
    slot: bigint;
    metadata: Map<string, string>;
}

export interface CandidateProtocolUpdate {
    slot: bigint;
    protocolVersion: ByronProtocolVersion;
    protocolParameters: ByronProtocolParameters;
}

export interface Endorsement {
    protocolVersion: ByronProtocolVersion;
    /** Genesis key hash (the delegator of the block issuer). */
    keyHash: string;
}

/** `Interface.State` minus `currentEpoch` (never updated by the Haskell rules either). */
export interface ByronUpdateState {
    adoptedProtocolVersion: ByronProtocolVersion;
    adoptedProtocolParameters: ByronProtocolParameters;
    /** Newest first (FADS prepends). */
    candidateProtocolUpdates: CandidateProtocolUpdate[];
    appVersions: Map<string, ApplicationVersion>;
    registeredProtocolUpdateProposals: Map<string, ProtocolUpdateProposal>;
    registeredSoftwareUpdateProposals: Map<string, SoftwareUpdateProposal>;
    confirmedProposals: Map<string, bigint>;
    proposalVotes: Map<string, Set<string>>;
    /** Keyed by `${pvKey}|${keyHash}` (a Set of Endorsement). */
    registeredEndorsements: Map<string, Endorsement>;
    proposalRegistrationSlot: Map<string, bigint>;
}

export type ByronUpdateErrorKind = "Registration" | "Voting" | "Endorsement";

/** A rule failure: cardano-node would reject the block (`ChainValidationUpdateError`). */
export class ByronUpdateError extends Error {
    constructor(
        readonly kind: ByronUpdateErrorKind,
        readonly code: string,
        detail: string,
    ) {
        super(`${kind}.${code}: ${detail}`);
    }
}

// ───────────────────────────── helpers ─────────────────────────────

/** Byron KeyHash (sha3 + blake2b in pure TS) memoised: a chain has a handful of distinct keys. */
const keyHashMemo = new Map<string, string>();
function byronKeyHash(xpub: Uint8Array): string {
    const hex = Buffer.from(xpub).toString("hex");
    let kh = keyHashMemo.get(hex);
    if (kh === undefined) {
        kh = byronKeyHashRaw(xpub);
        if (keyHashMemo.size > 4096) keyHashMemo.clear();
        keyHashMemo.set(hex, kh);
    }
    return kh;
}

export const pvKey = (pv: ByronProtocolVersion): string => `${pv.major}.${pv.minor}.${pv.alt}`;

/** Derived `Ord ProtocolVersion`: lexicographic (major, minor, alt). */
export function comparePV(a: ByronProtocolVersion, b: ByronProtocolVersion): number {
    return a.major - b.major || a.minor - b.minor || a.alt - b.alt;
}

const pvEq = (a: ByronProtocolVersion, b: ByronProtocolVersion) => comparePV(a, b) === 0;

export function ppEquals(a: ByronProtocolParameters, b: ByronProtocolParameters): boolean {
    for (const f of BYRON_PP_FIELDS) {
        const x = a[f] as unknown, y = b[f] as unknown;
        if (typeof x === "object" && x && typeof y === "object" && y) {
            const xo = x as Record<string, bigint>, yo = y as Record<string, bigint>;
            for (const key of Object.keys(xo)) if (xo[key] !== yo[key]) return false;
        } else if (x !== y) return false;
    }
    return true;
}

/** `PPU.apply`: every Just field replaces the adopted value. */
export function applyPPUpdate(ppu: ByronProtocolParametersUpdate, pp: ByronProtocolParameters): ByronProtocolParameters {
    const out: Record<string, unknown> = { ...pp };
    for (const f of BYRON_PP_FIELDS) if (ppu[f] !== undefined) out[f] = ppu[f];
    return out as unknown as ByronProtocolParameters;
}

/** `ProtocolParameters.upAdptThd`: ⌊ lovelacePortionToRational (srMinThd softforkRule) · numGenKeys ⌋. */
export function upAdptThd(numGenKeys: number, pp: ByronProtocolParameters): number {
    return Number((pp.softforkRule.minThd * BigInt(numGenKeys)) / LOVELACE_PORTION_DENOMINATOR);
}

/** `Registration.pvCanFollow` (Word16 arithmetic). */
export function pvCanFollow(newPV: ByronProtocolVersion, adoptedPV: ByronProtocolVersion): boolean {
    if (!(comparePV(adoptedPV, newPV) < 0)) return false;
    switch ((newPV.major - adoptedPV.major) & 0xffff) {
        case 0:
            return newPV.minor === ((adoptedPV.minor + 1) & 0xffff);
        case 1:
            return newPV.minor === 0;
        default:
            return false;
    }
}

/** `Registration.svCanFollow` (NumSoftwareVersion = Word32). */
export function svCanFollow(avs: ReadonlyMap<string, ApplicationVersion>, sv: ByronSoftwareVersion): boolean {
    const cur = avs.get(sv.appName);
    if (!cur) return sv.number === 0 || sv.number === 1;
    return sv.number === ((cur.version + 1) >>> 0);
}

/** `T.length` counts code points; `isAscii` is `< 128`. */
const textLength = (s: string) => [...s].length;
const allAscii = (s: string) => [...s].every((c) => c.codePointAt(0)! < 128);

/** `Delegation.lookupR`: delegate → genesis key (the map is a bijection). */
function lookupR(map: ReadonlyMap<string, string>, delegate: string): string | undefined {
    for (const [g, d] of map) if (d === delegate) return g;
    return undefined;
}

export function initialByronUpdateState(genesisParams: ByronProtocolParameters): ByronUpdateState {
    return {
        adoptedProtocolVersion: { major: 0, minor: 0, alt: 0 },
        adoptedProtocolParameters: genesisParams,
        candidateProtocolUpdates: [],
        appVersions: new Map(),
        registeredProtocolUpdateProposals: new Map(),
        registeredSoftwareUpdateProposals: new Map(),
        confirmedProposals: new Map(),
        proposalVotes: new Map(),
        registeredEndorsements: new Map(),
        proposalRegistrationSlot: new Map(),
    };
}

export function cloneByronUpdateState(s: ByronUpdateState): ByronUpdateState {
    return {
        adoptedProtocolVersion: s.adoptedProtocolVersion,
        adoptedProtocolParameters: s.adoptedProtocolParameters,
        candidateProtocolUpdates: [...s.candidateProtocolUpdates],
        appVersions: new Map(s.appVersions),
        registeredProtocolUpdateProposals: new Map(s.registeredProtocolUpdateProposals),
        registeredSoftwareUpdateProposals: new Map(s.registeredSoftwareUpdateProposals),
        confirmedProposals: new Map(s.confirmedProposals),
        proposalVotes: new Map([...s.proposalVotes].map(([k, v]) => [k, new Set(v)])),
        registeredEndorsements: new Map(s.registeredEndorsements),
        proposalRegistrationSlot: new Map(s.proposalRegistrationSlot),
    };
}

function restrictKeys<V>(m: Map<string, V>, keep: Set<string>): Map<string, V> {
    const out = new Map<string, V>();
    for (const [k, v] of m) if (keep.has(k)) out.set(k, v);
    return out;
}

// ───────────────────────────── UPIREG ─────────────────────────────

/**
 * `Interface.registerProposal` (UPIREG): Registration.registerProposal, then record the
 * registration slot. Mutates `st`.
 */
export function registerProposal(env: ByronUpdateEnv, st: ByronUpdateState, p: ByronProposal): void {
    const R = (code: string, d: string) => new ByronUpdateError("Registration", code, d);
    // Delegation.memberR proposerId delegationMap: the proposer must be a current delegate.
    const proposerId = byronKeyHash(p.issuer);
    if (![...env.delegationMap.values()].includes(proposerId)) throw R("InvalidProposer", proposerId);
    if (!env.skipSignatures && !verifyProposalSignature(p, env.protocolMagic)) throw R("InvalidSignature", p.upId);

    // registerProposalComponents
    const adoptedPV = st.adoptedProtocolVersion, adoptedPP = st.adoptedProtocolParameters;
    const newPP = applyPPUpdate(p.ppUpdate, adoptedPP);
    const cur = st.appVersions.get(p.softwareVersion.appName);
    const softwareVersionChanged = !cur || cur.version !== p.softwareVersion.number;
    const protocolVersionChanged = !(pvEq(p.protocolVersion, adoptedPV) && ppEquals(newPP, adoptedPP));
    // Staging-network (magic 633343913) null-update exemptions, kept for completeness.
    const nullUpdateExemption = env.protocolMagic === 633343913 && (env.currentSlot === 969188n || env.currentSlot === 1915231n);
    if (!(protocolVersionChanged || softwareVersionChanged || nullUpdateExemption)) throw R("NullUpdateProposal", p.upId);

    let pups = st.registeredProtocolUpdateProposals;
    if (protocolVersionChanged) {
        // registerProtocolUpdate (UPPVV)
        const newPV = p.protocolVersion;
        for (const pup of pups.values()) if (pvEq(pup.protocolVersion, newPV)) throw R("DuplicateProtocolVersion", pvKey(newPV));
        if (!pvCanFollow(newPV, adoptedPV)) throw R("InvalidProtocolVersion", `${pvKey(newPV)} cannot follow adopted ${pvKey(adoptedPV)}`);
        // canUpdate
        const size = BigInt(p.bytes.length);
        if (!(size <= adoptedPP.maxProposalSize)) throw R("ProposalTooLarge", `${size} > ${adoptedPP.maxProposalSize}`);
        if (!(newPP.maxBlockSize <= 2n * adoptedPP.maxBlockSize)) throw R("MaxBlockSizeTooLarge", `${newPP.maxBlockSize} > 2 × ${adoptedPP.maxBlockSize}`);
        if (!(newPP.maxTxSize < newPP.maxBlockSize)) throw R("MaxTxSizeTooLarge", `${newPP.maxTxSize} ≥ maxBlockSize ${newPP.maxBlockSize}`);
        // Word16 difference: 0 ≤ diff always holds; a decrease wraps and fails `≤ 1`.
        if (!(((newPP.scriptVersion - adoptedPP.scriptVersion) & 0xffff) <= 1)) {
            throw R("InvalidScriptVersion", `${adoptedPP.scriptVersion} → ${newPP.scriptVersion}`);
        }
        pups = new Map(pups).set(p.upId, { protocolVersion: newPV, protocolParameters: newPP });
    }

    let sups = st.registeredSoftwareUpdateProposals;
    if (softwareVersionChanged) {
        // registerSoftwareUpdate (UPSVV)
        const sv = p.softwareVersion;
        for (const tag of p.metadata.keys()) {
            if (textLength(tag) > 10) throw R("SystemTagError", `SystemTagTooLong ${JSON.stringify(tag)}`);
            if (!allAscii(tag)) throw R("SystemTagError", `SystemTagNotAscii ${JSON.stringify(tag)}`);
        }
        for (const sup of sups.values()) if (sup.softwareVersion.appName === sv.appName) throw R("DuplicateSoftwareVersion", `${sv.appName}:${sv.number}`);
        if (textLength(sv.appName) > 12) throw R("SoftwareVersionError", `ApplicationNameTooLong ${JSON.stringify(sv.appName)}`);
        if (!allAscii(sv.appName)) throw R("SoftwareVersionError", `ApplicationNameNotAscii ${JSON.stringify(sv.appName)}`);
        if (!svCanFollow(st.appVersions, sv)) throw R("InvalidSoftwareVersion", `${sv.appName}:${sv.number}`);
        sups = new Map(sups).set(p.upId, { softwareVersion: sv, metadata: p.metadata });
    }

    st.registeredProtocolUpdateProposals = pups;
    st.registeredSoftwareUpdateProposals = sups;
    st.proposalRegistrationSlot.set(p.upId, env.currentSlot);
}

// ───────────────────────────── UPIVOTES ─────────────────────────────

/** `Interface.registerVote` → `Voting.registerVoteWithConfirmation` (UPIVOTE / ADDVOTE). Mutates `st`. */
export function registerVote(env: ByronUpdateEnv, st: ByronUpdateState, v: ByronVote): void {
    const V = (code: string, d: string) => new ByronUpdateError("Voting", code, d);
    const upId = v.proposalId;
    if (!st.proposalRegistrationSlot.has(upId)) throw V("VotingProposalNotRegistered", upId);
    const voter = byronKeyHash(v.voterVK);
    const delegator = lookupR(env.delegationMap, voter);
    if (delegator === undefined) throw V("VotingVoterNotDelegate", voter);
    if (st.proposalVotes.get(upId)?.has(delegator)) throw V("VotingVoteAlreadyCast", delegator);
    if (!env.skipSignatures && !verifyVoteSignature(v, env.protocolMagic)) throw V("VotingInvalidSignature", upId);
    const votes = new Set(st.proposalVotes.get(upId) ?? []).add(delegator);
    st.proposalVotes.set(upId, votes);
    // pastThreshold && not confirmed → confirm at the current slot
    const threshold = upAdptThd(env.numGenKeys, st.adoptedProtocolParameters);
    if (votes.size >= threshold && !st.confirmedProposals.has(upId)) st.confirmedProposals.set(upId, env.currentSlot);
}

/**
 * `Interface.registerVotes` (UPIVOTES): fold the votes, then promote every confirmed software
 * proposal into `appVersions` (at the current slot) and drop it from the registered set.
 */
export function registerVotes(env: ByronUpdateEnv, st: ByronUpdateState, votes: readonly ByronVote[]): void {
    for (const v of votes) registerVote(env, st, v);
    // M.fromList over the (UpId-ordered) confirmed SUPs; later entries win, then union-left over the old map.
    const confirmedSups = [...st.registeredSoftwareUpdateProposals]
        .filter(([id]) => st.confirmedProposals.has(id))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (confirmedSups.length === 0) return;
    const appVersions = new Map(st.appVersions);
    for (const [, sup] of confirmedSups) {
        appVersions.set(sup.softwareVersion.appName, { version: sup.softwareVersion.number, slot: env.currentSlot, metadata: sup.metadata });
    }
    st.appVersions = appVersions;
    const sups = new Map(st.registeredSoftwareUpdateProposals);
    for (const id of st.confirmedProposals.keys()) sups.delete(id);
    st.registeredSoftwareUpdateProposals = sups;
}

// ───────────────────────────── UPIEND ─────────────────────────────

/**
 * `Interface.registerEndorsement` (UPIEND): `Endorsement.register`, then drop expired
 * proposals (TTL) and the endorsements of versions no longer proposed. `issuerKeyHash` is
 * `hashKey (blockIssuer b)` — the delegate that signed the block. Mutates `st`.
 */
export function registerEndorsement(
    env: ByronUpdateEnv,
    st: ByronUpdateState,
    endorsement: { protocolVersion: ByronProtocolVersion; issuerKeyHash: string },
): void {
    const pv = endorsement.protocolVersion;
    const k2 = BigInt(2 * env.k);
    const matching = [...st.registeredProtocolUpdateProposals].filter(([, pup]) => pvEq(pup.protocolVersion, pv));
    if (matching.length > 1) throw new ByronUpdateError("Endorsement", "MultipleProposalsForProtocolVersion", pvKey(pv));
    if (matching.length === 1) {
        const [upId, pup] = matching[0]!;
        const confirmedAt = st.confirmedProposals.get(upId);
        // isConfirmedAndStable: confirmed at s with s + 2k ≤ currentSlot; otherwise the endorsement is ignored.
        if (confirmedAt !== undefined && confirmedAt + k2 <= env.currentSlot) {
            const endorsements = new Map(st.registeredEndorsements);
            const delegator = lookupR(env.delegationMap, endorsement.issuerKeyHash);
            if (delegator !== undefined) endorsements.set(`${pvKey(pv)}|${delegator}`, { protocolVersion: pv, keyHash: delegator });
            let count = 0;
            for (const e of endorsements.values()) if (pvEq(e.protocolVersion, pv)) count++;
            if (count >= upAdptThd(env.numGenKeys, st.adoptedProtocolParameters)) {
                // FADS: prepend only when strictly newer than the newest candidate.
                const head = st.candidateProtocolUpdates[0];
                if (!head || comparePV(head.protocolVersion, pv) < 0) {
                    st.candidateProtocolUpdates = [{ slot: env.currentSlot, protocolVersion: pv, protocolParameters: pup.protocolParameters }, ...st.candidateProtocolUpdates];
                }
            }
            st.registeredEndorsements = endorsements;
        }
    }

    // pidsKeep = nonExpired ∪ confirmed, u = ppUpdateProposalTTL (of the adopted parameters)
    const u = st.adoptedProtocolParameters.updateProposalTTL;
    const keep = new Set<string>(st.confirmedProposals.keys());
    for (const [id, s] of st.proposalRegistrationSlot) if (env.currentSlot <= s + u) keep.add(id);
    st.registeredProtocolUpdateProposals = restrictKeys(st.registeredProtocolUpdateProposals, keep);
    st.registeredSoftwareUpdateProposals = restrictKeys(st.registeredSoftwareUpdateProposals, keep);
    st.proposalVotes = restrictKeys(st.proposalVotes, keep);
    st.proposalRegistrationSlot = restrictKeys(st.proposalRegistrationSlot, keep);
    const vsKeep = new Set([...st.registeredProtocolUpdateProposals.values()].map((p) => pvKey(p.protocolVersion)));
    const ends = new Map<string, Endorsement>();
    for (const [key, e] of st.registeredEndorsements) if (vsKeep.has(pvKey(e.protocolVersion))) ends.set(key, e);
    st.registeredEndorsements = ends;
}

// ───────────────────────────── BUPI ─────────────────────────────

export interface ByronUpdateSignal {
    payload: ByronUpdatePayload;
    protocolVersion: ByronProtocolVersion;
    issuerKeyHash: string;
}

/**
 * `Interface.registerUpdate` (BUPI): proposal, votes, endorsement, in that order. Returns a new
 * state; on a rule failure throws `ByronUpdateError` and the input state is untouched.
 */
export function registerUpdate(env: ByronUpdateEnv, st: ByronUpdateState, sig: ByronUpdateSignal): ByronUpdateState {
    const next = cloneByronUpdateState(st);
    if (sig.payload.proposal) registerProposal(env, next, sig.payload.proposal);
    registerVotes(env, next, sig.payload.votes);
    registerEndorsement(env, next, { protocolVersion: sig.protocolVersion, issuerKeyHash: sig.issuerKeyHash });
    return next;
}

// ───────────────────────────── UPIEC ─────────────────────────────

/**
 * `Interface.registerEpoch` + `tryBumpVersion` (PVBUMP): adopt the newest candidate whose
 * endorsement slot + 4k ≤ the first slot of `lastSeenEpoch`, clearing the proposal state.
 */
export function registerEpoch(k: number, st: ByronUpdateState, lastSeenEpoch: bigint): ByronUpdateState {
    const firstSlot = lastSeenEpoch * BigInt(10 * k);
    const k4 = BigInt(4 * k);
    const newestStable = st.candidateProtocolUpdates.find((c) => c.slot + k4 <= firstSlot);
    if (!newestStable || pvEq(newestStable.protocolVersion, st.adoptedProtocolVersion)) return st;
    return {
        ...initialByronUpdateState(newestStable.protocolParameters),
        adoptedProtocolVersion: newestStable.protocolVersion,
        // appVersions survive an adoption
        appVersions: st.appVersions,
    };
}

/**
 * `Block.Validation.epochTransition`: called before every main block with the slot of the last
 * applied main block (`cvsLastSlot`, 0 at genesis; EBBs do not move it).
 */
export function epochTransition(k: number, st: ByronUpdateState, lastSlot: bigint, blockSlot: bigint): ByronUpdateState {
    const epochSlots = BigInt(10 * k);
    const currentEpoch = lastSlot / epochSlots;
    const nextEpoch = blockSlot / epochSlots;
    return nextEpoch > currentEpoch ? registerEpoch(k, st, nextEpoch) : st;
}

// ───────────────────────────── driver ─────────────────────────────

export type ByronUpdateEvent =
    | { type: "adopted"; slot: bigint; epoch: bigint; protocolVersion: ByronProtocolVersion; changed: string[] }
    | { type: "proposal"; slot: bigint; upId: string; protocolVersion: ByronProtocolVersion; softwareVersion: ByronSoftwareVersion; ppUpdate: string[] }
    | { type: "vote"; slot: bigint; upId: string; voter: string }
    | { type: "confirmed"; slot: bigint; upId: string }
    | { type: "candidate"; slot: bigint; protocolVersion: ByronProtocolVersion }
    | { type: "expired"; slot: bigint; upId: string }
    | { type: "app-version"; slot: bigint; appName: string; version: number }
    | { type: "error"; slot: bigint; error: string };

export interface ByronUpdateTrackerOptions {
    protocolMagic: number;
    k: number;
    /** Number of genesis keys (`configGenesisKeyHashes`). */
    numGenKeys: number;
    genesisParams: ByronProtocolParameters;
    skipSignatures?: boolean;
}

/** JSON-safe snapshot (bigints as strings), for persistence across restarts. */
export type ByronUpdateSnapshot = { lastSlot: string; state: unknown };

/**
 * Per-block driver mirroring `updateBlock`: epochTransition with the previous main-block slot,
 * then BUPI with the block's payload, header protocol version and issuer. Report-only: a rule
 * failure is returned as an `error` event and the block's update effects are discarded
 * (cardano-node would have rejected the block), the tracker never throws on a bad block.
 */
export class ByronUpdateTracker {
    readonly opts: ByronUpdateTrackerOptions;
    state: ByronUpdateState;
    /** `cvsLastSlot`: slot of the last applied main block (0 at genesis). */
    lastSlot = 0n;
    readonly counters = { blocks: 0, proposals: 0, votes: 0, confirmed: 0, adoptions: 0, errors: 0 };

    constructor(opts: ByronUpdateTrackerOptions) {
        this.opts = opts;
        this.state = initialByronUpdateState(opts.genesisParams);
    }

    static fromGenesis(genesis: any, opts: { k?: number; skipSignatures?: boolean } = {}): ByronUpdateTracker {
        const keys = genesis?.bootStakeholders ? Object.keys(genesis.bootStakeholders) : Object.keys(genesis?.heavyDelegation ?? {});
        return new ByronUpdateTracker({
            protocolMagic: Number(genesis.protocolConsts.protocolMagic),
            k: opts.k ?? Number(genesis.protocolConsts.k),
            numGenKeys: keys.length,
            genesisParams: byronProtocolParametersFromGenesis(genesis.blockVersionData),
            skipSignatures: opts.skipSignatures,
        });
    }

    adoptedProtocolParameters(): ByronProtocolParameters {
        return this.state.adoptedProtocolParameters;
    }

    adoptedProtocolVersion(): ByronProtocolVersion {
        return this.state.adoptedProtocolVersion;
    }

    /**
     * `applyChainTick` (ouroboros-consensus Byron ledger): run the epoch transition for `slot`
     * without applying a block; `lastSlot` is not moved. This is how the Byron→Shelley boundary
     * sees the protocol version adopted at the first slot of the next epoch.
     */
    tick(slot: bigint): ByronUpdateEvent[] {
        const before = this.state;
        this.state = epochTransition(this.opts.k, before, this.lastSlot, slot);
        if (this.state === before) return [];
        this.counters.adoptions++;
        return [{ type: "adopted", slot, epoch: slot / BigInt(10 * this.opts.k), protocolVersion: this.state.adoptedProtocolVersion, changed: changedFields(before.adoptedProtocolParameters, this.state.adoptedProtocolParameters) }];
    }

    /** Apply a decoded main block. */
    applyMainBlock(
        block: { slot: bigint; protocolVersion: ByronProtocolVersion; issuerKeyHash: string; payload: ByronUpdatePayload },
        delegationMap: ReadonlyMap<string, string>,
    ): ByronUpdateEvent[] {
        const events: ByronUpdateEvent[] = [];
        const { slot } = block;
        const epochSlots = BigInt(10 * this.opts.k);
        this.counters.blocks++;

        const before = this.state;
        const ticked = epochTransition(this.opts.k, before, this.lastSlot, slot);
        if (ticked !== before) {
            this.counters.adoptions++;
            events.push({ type: "adopted", slot, epoch: slot / epochSlots, protocolVersion: ticked.adoptedProtocolVersion, changed: changedFields(before.adoptedProtocolParameters, ticked.adoptedProtocolParameters) });
        }
        this.state = ticked;
        this.lastSlot = slot;

        const env: ByronUpdateEnv = {
            protocolMagic: this.opts.protocolMagic,
            k: this.opts.k,
            currentSlot: slot,
            numGenKeys: this.opts.numGenKeys,
            delegationMap,
            skipSignatures: this.opts.skipSignatures,
        };
        let next: ByronUpdateState;
        try {
            next = registerUpdate(env, ticked, { payload: block.payload, protocolVersion: block.protocolVersion, issuerKeyHash: block.issuerKeyHash });
        } catch (err) {
            this.counters.errors++;
            events.push({ type: "error", slot, error: err instanceof Error ? err.message : String(err) });
            return events;
        }

        const p = block.payload.proposal;
        if (p && next.proposalRegistrationSlot.has(p.upId)) {
            this.counters.proposals++;
            events.push({ type: "proposal", slot, upId: p.upId, protocolVersion: p.protocolVersion, softwareVersion: p.softwareVersion, ppUpdate: Object.keys(p.ppUpdate) });
        }
        for (const v of block.payload.votes) {
            this.counters.votes++;
            events.push({ type: "vote", slot, upId: v.proposalId, voter: byronKeyHash(v.voterVK) });
        }
        for (const id of next.confirmedProposals.keys()) {
            if (!ticked.confirmedProposals.has(id)) {
                this.counters.confirmed++;
                events.push({ type: "confirmed", slot, upId: id });
            }
        }
        for (const [name, av] of next.appVersions) {
            if (ticked.appVersions.get(name) !== av) events.push({ type: "app-version", slot, appName: name, version: av.version });
        }
        if (next.candidateProtocolUpdates[0] && next.candidateProtocolUpdates[0] !== ticked.candidateProtocolUpdates[0]) {
            events.push({ type: "candidate", slot, protocolVersion: next.candidateProtocolUpdates[0].protocolVersion });
        }
        for (const id of ticked.proposalRegistrationSlot.keys()) {
            if (!next.proposalRegistrationSlot.has(id)) events.push({ type: "expired", slot, upId: id });
        }
        this.state = next;
        return events;
    }

    /** Apply a raw Byron main block (header + `[txPayload, ssc, dlg, upd]` body). */
    applyRawMainBlock(rawHeader: Uint8Array, rawBody: Uint8Array, delegationMap: ReadonlyMap<string, string>): ByronUpdateEvent[] {
        let decoded: { slot: bigint; protocolVersion: ByronProtocolVersion; issuerKeyHash: string; payload: ByronUpdatePayload };
        let slot = 0n;
        try {
            const h = decodeByronHeaderUpdateFields(rawHeader, BigInt(10 * this.opts.k));
            slot = h.slot;
            decoded = { slot, protocolVersion: h.protocolVersion, issuerKeyHash: byronKeyHash(h.issuerXPub), payload: decodeByronUpdatePayload(byronUpdatePayloadOfBody(rawBody)) };
        } catch (err) {
            this.counters.errors++;
            return [{ type: "error", slot, error: `decode: ${err instanceof Error ? err.message : String(err)}` }];
        }
        return this.applyMainBlock(decoded, delegationMap);
    }

    snapshot(): ByronUpdateSnapshot {
        return { lastSlot: this.lastSlot.toString(), state: JSON.parse(JSON.stringify(this.state, snapshotReplacer)) };
    }

    restore(s: ByronUpdateSnapshot): void {
        this.lastSlot = BigInt(s.lastSlot);
        this.state = JSON.parse(JSON.stringify(s.state), snapshotReviver) as ByronUpdateState;
    }
}

/** Names of the parameters that differ between two parameter sets. */
export function changedFields(a: ByronProtocolParameters, b: ByronProtocolParameters): string[] {
    return BYRON_PP_FIELDS.filter((f) => !ppEquals({ ...a, [f]: b[f] } as ByronProtocolParameters, a));
}

function snapshotReplacer(_k: string, v: unknown): unknown {
    if (typeof v === "bigint") return { $n: v.toString() };
    if (v instanceof Map) return { $map: [...v] };
    if (v instanceof Set) return { $set: [...v] };
    return v;
}

function snapshotReviver(_k: string, v: any): unknown {
    if (v && typeof v === "object") {
        if ("$n" in v) return BigInt(v.$n);
        if ("$map" in v) return new Map(v.$map);
        if ("$set" in v) return new Set(v.$set);
    }
    return v;
}

// ───────────────────────────── accessor ─────────────────────────────

let activeTracker: ByronUpdateTracker | null = null;

/** Register the tracker whose adopted parameters the Byron tx/body rules should use. */
export function setActiveByronUpdateTracker(t: ByronUpdateTracker | null): void {
    activeTracker = t;
}

/**
 * The currently adopted Byron protocol parameters (fee policy, maxTxSize, maxBlockSize,
 * maxHeaderSize, ...), or null when no tracker is active (callers fall back to genesis).
 */
export function currentByronProtocolParameters(): ByronProtocolParameters | null {
    return activeTracker?.adoptedProtocolParameters() ?? null;
}

export function currentByronProtocolVersion(): ByronProtocolVersion | null {
    return activeTracker?.adoptedProtocolVersion() ?? null;
}
