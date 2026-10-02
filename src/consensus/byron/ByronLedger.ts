import { Cbor, CborArray, CborBytes, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { byronKeyHash as byronKeyHashRaw, sliceByronMainHeader, verifyByronDelegationCert, type ByronDelegationCertificate } from "./ByronCrypto";
import {
    byronProtocolParametersFromGenesis,
    decodeByronHeaderUpdateFields,
    decodeByronUpdatePayload,
    type ByronProtocolParameters,
    type ByronProtocolVersion,
    type ByronUpdatePayload,
} from "./byronUpdateCodec";
import { epochTransition, initialByronUpdateState, pvKey, registerUpdate, type ByronUpdateState } from "./ByronUpdate";

/**
 * The Byron chain-validation state cardano-node keeps beside the UTxO set (cardano-ledger-byron
 * `ChainValidationState` minus `cvsUtxo` / `cvsPreviousHash`, plus ouroboros-consensus'
 * `byronLedgerTipBlockNo` and `ByronTransition`), driven exactly the way a node drives it:
 *
 *   every block    `applyChainTick` (Byron.API.Validation): UPIEC epoch transition with the slot
 *                  of the last block, then `tickDelegation` (activate due delegations, prune);
 *   main block     `validateBlock`: header size ≤ ppMaxHeaderSize, block size ≤ ppMaxBlockSize
 *                  (adopted parameters after the tick), `updateDelegation` (schedule the block's
 *                  certificates, tick), BUPI with the delegation map *after the tick, before the
 *                  block's certificates*, `cvsLastSlot` := slot; then the consensus transition
 *                  info (candidate version → block number in which it became a candidate);
 *   boundary (EBB) `validateBoundary`: size ≤ 2·10⁶, `cvsLastSlot` := epoch · 10k.
 *
 * Two differences from the CHAIN rule (`Block.Validation.updateBlock`) the standalone replay used
 * to follow, both from the node path: the delegation state is ticked to the block's slot before the
 * update rules read it, and an EBB moves `cvsLastSlot` (so the epoch transition of an epoch that
 * opens with an EBB runs at the EBB's tick; same adoption either way).
 *
 * The UTxO side (tx size, fee policy) lives in rules/byronTxRules.ts and reads
 * `adoptedProtocolParameters` of the ticked state.
 */

// ───────────────────────────── config ─────────────────────────────

export interface ByronLedgerConfig {
    protocolMagic: number;
    k: number;
    /** `configEpochSlots` = 10k. */
    epochSlots: bigint;
    /** `configGenesisKeyHashes` (the allowed delegators). */
    genesisKeys: ReadonlySet<string>;
    genesisParams: ByronProtocolParameters;
    /** Genesis `heavyDelegation` certificates (applied at slot 0 with k = 0, `DI.initialState`). */
    genesisCerts: ByronDelegationCertificate[];
    /** Skip ed25519 checks of proposals, votes and delegation certificates (rebuilds over already-validated blocks). */
    skipSignatures?: boolean;
}

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

export function byronLedgerConfigFromGenesis(genesis: any, opts: { k?: number; skipSignatures?: boolean } = {}): ByronLedgerConfig {
    const k = opts.k ?? Number(genesis.protocolConsts.k);
    const heavy = (genesis.heavyDelegation ?? {}) as Record<string, { omega: number; issuerPk: string; delegatePk: string; cert: string }>;
    const keys = genesis.bootStakeholders ? Object.keys(genesis.bootStakeholders) : Object.keys(heavy);
    return {
        protocolMagic: Number(genesis.protocolConsts.protocolMagic),
        k,
        epochSlots: BigInt(10 * k),
        genesisKeys: new Set(keys),
        genesisParams: byronProtocolParametersFromGenesis(genesis.blockVersionData),
        genesisCerts: Object.values(heavy).map((d) => ({ epoch: BigInt(d.omega), issuerXPub: b64(d.issuerPk), delegateXPub: b64(d.delegatePk), signature: Uint8Array.from(Buffer.from(d.cert, "hex")) })),
        skipSignatures: opts.skipSignatures,
    };
}

// ───────────────────────────── state ─────────────────────────────

export interface ScheduledDelegation { slot: bigint; delegator: string; delegate: string }

/** `Delegation.Interface.State`: activation (map + slots) and scheduling (queue + epoch pairs). */
export interface ByronDelegationState {
    /** `Activation.delegationMap` (a bijection): genesis key hash → delegate key hash. */
    map: Map<string, string>;
    /** `Activation.delegationSlots`: slot of each delegator's last activation. */
    slots: Map<string, bigint>;
    /** `Scheduling.scheduledDelegations`, in scheduling order. */
    scheduled: ScheduledDelegation[];
    /** `Scheduling.keyEpochDelegations` as `${epoch}|${delegator}`. */
    keyEpochs: Set<string>;
}

export interface ByronLedgerState {
    /** `cvsLastSlot` (0 at genesis; an EBB sets its epoch's first slot). */
    lastSlot: bigint;
    /** `byronLedgerTipBlockNo` (null = Origin). */
    tipBlockNo: bigint | null;
    update: ByronUpdateState;
    delegation: ByronDelegationState;
    /** `ByronTransitionInfo`: pvKey of a candidate → block number in which it became one. */
    transition: Map<string, bigint>;
}

export class ByronLedgerError extends Error {}

/** Byron KeyHash (pure-TS sha3 + blake2b) memoised: a chain has a handful of issuer / delegate keys and every block names one. */
const keyHashMemo = new Map<string, string>();
function byronKeyHash(xpub: Uint8Array): string {
    const k = Buffer.from(xpub).toString("hex");
    let h = keyHashMemo.get(k);
    if (h === undefined) {
        h = byronKeyHashRaw(xpub);
        if (keyHashMemo.size > 4096) keyHashMemo.clear();
        keyHashMemo.set(k, h);
    }
    return h;
}

// ───────────────────────────── delegation (Delegation.Validation.*) ─────────────────────────────

interface DelegationEnv {
    protocolMagic: number;
    allowedDelegators: ReadonlySet<string>;
    k: number;
    currentEpoch: bigint;
    currentSlot: bigint;
    skipSignatures?: boolean;
}

function cloneDelegation(d: ByronDelegationState): ByronDelegationState {
    return { map: new Map(d.map), slots: new Map(d.slots), scheduled: [...d.scheduled], keyEpochs: new Set(d.keyEpochs) };
}

/** `Scheduling.scheduleCertificate` (SDELEG). Mutates `st`; throws on a rule failure. */
function scheduleCertificate(env: DelegationEnv, st: ByronDelegationState, cert: ByronDelegationCertificate): void {
    const delegator = byronKeyHash(cert.issuerXPub);
    const delegate = byronKeyHash(cert.delegateXPub);
    if (!env.allowedDelegators.has(delegator)) throw new ByronLedgerError(`ChainValidationDelegationSchedulingError NonGenesisDelegator ${delegator}`);
    if (!(env.currentEpoch <= cert.epoch && cert.epoch <= env.currentEpoch + 1n)) throw new ByronLedgerError(`ChainValidationDelegationSchedulingError WrongEpoch current ${env.currentEpoch}, certificate ${cert.epoch}`);
    if (st.keyEpochs.has(`${cert.epoch}|${delegator}`)) throw new ByronLedgerError(`ChainValidationDelegationSchedulingError MultipleDelegationsForEpoch ${cert.epoch} ${delegator}`);
    const activationSlot = env.currentSlot + BigInt(2 * env.k); // addSlotCount (kSlotSecurityParam k)
    if (st.scheduled.some((sd) => sd.slot === activationSlot && sd.delegator === delegator)) throw new ByronLedgerError(`ChainValidationDelegationSchedulingError MultipleDelegationsForSlot ${env.currentSlot} ${delegator}`);
    if (!env.skipSignatures && !verifyByronDelegationCert(cert, env.protocolMagic)) throw new ByronLedgerError(`ChainValidationDelegationSchedulingError InvalidCertificate ${delegator}`);
    st.scheduled.push({ slot: activationSlot, delegator, delegate });
    st.keyEpochs.add(`${cert.epoch}|${delegator}`);
}

/** `Activation.activateDelegation`: the delegate must not delegate for anyone yet, and the slot must move forward. */
function activateDelegation(st: ByronDelegationState, sd: ScheduledDelegation): void {
    for (const d of st.map.values()) if (d === sd.delegate) return; // notMemberR
    const prev = st.slots.get(sd.delegator) ?? 0n;
    if (!(prev < sd.slot || sd.slot === 0n)) return;
    st.map.set(sd.delegator, sd.delegate); // Bimap insert (the delegate is in no other pair)
    st.slots.set(sd.delegator, sd.slot);
}

/** `Interface.tickDelegation`: activate everything due by `slot`, then prune. Copy-on-write. */
export function tickDelegation(currentEpoch: bigint, currentSlot: bigint, st: ByronDelegationState): ByronDelegationState {
    const due = st.scheduled.some((sd) => sd.slot <= currentSlot);
    const staleEpoch = [...st.keyEpochs].some((ke) => BigInt(ke.slice(0, ke.indexOf("|"))) < currentEpoch);
    if (!due && !staleEpoch) return st;
    const out = cloneDelegation(st);
    for (const sd of st.scheduled) if (sd.slot <= currentSlot) activateDelegation(out, sd);
    out.scheduled = out.scheduled.filter((sd) => currentSlot + 1n <= sd.slot);
    out.keyEpochs = new Set([...out.keyEpochs].filter((ke) => BigInt(ke.slice(0, ke.indexOf("|"))) >= currentEpoch));
    return out;
}

/** `Interface.updateDelegation`: schedule the certificates, then tick. Throws on a rule failure (input untouched). */
export function updateDelegation(env: DelegationEnv, st: ByronDelegationState, certs: readonly ByronDelegationCertificate[]): ByronDelegationState {
    let cur = st;
    if (certs.length) {
        cur = cloneDelegation(st);
        for (const c of certs) scheduleCertificate(env, cur, c);
    }
    return tickDelegation(env.currentEpoch, env.currentSlot, cur);
}

/** `Interface.initialState`: identity map at slot 0, then the genesis certificates with k = 0. */
export function initialDelegationState(cfg: ByronLedgerConfig): ByronDelegationState {
    const st: ByronDelegationState = { map: new Map(), slots: new Map(), scheduled: [], keyEpochs: new Set() };
    for (const g of cfg.genesisKeys) { st.map.set(g, g); st.slots.set(g, 0n); }
    return updateDelegation({ protocolMagic: cfg.protocolMagic, allowedDelegators: cfg.genesisKeys, k: 0, currentEpoch: 0n, currentSlot: 0n, skipSignatures: cfg.skipSignatures }, st, cfg.genesisCerts);
}

/** `lookupR` on the delegation map: delegate → genesis key. */
export function delegatorOf(st: ByronDelegationState, delegate: string): string | undefined {
    for (const [g, d] of st.map) if (d === delegate) return g;
    return undefined;
}

// ───────────────────────────── ledger ─────────────────────────────

export function initialByronLedgerState(cfg: ByronLedgerConfig): ByronLedgerState {
    return { lastSlot: 0n, tipBlockNo: null, update: initialByronUpdateState(cfg.genesisParams), delegation: initialDelegationState(cfg), transition: new Map() };
}

/** `applyChainTick`: epoch transition of the update state, then the delegation tick. */
export function tickByronLedger(cfg: ByronLedgerConfig, st: ByronLedgerState, slot: bigint): ByronLedgerState {
    const update = epochTransition(cfg.k, st.update, st.lastSlot, slot);
    const delegation = tickDelegation(slot / cfg.epochSlots, slot, st.delegation);
    return update === st.update && delegation === st.delegation ? st : { ...st, update, delegation };
}

/** The fields of a Byron main block the chain-validation state reads. */
export interface ByronMainBlockFacts {
    slot: bigint;
    blockNo: bigint;
    /** `headerLength` / `blockLength`: bytes of the header and of the whole `[header, body, extra]` encoding. */
    headerSize: number;
    blockSize: number;
    protocolVersion: ByronProtocolVersion;
    /** `hashKey (blockIssuer b)`: the delegate key that signed. */
    issuerKeyHash: string;
    payload: ByronUpdatePayload;
    certs: ByronDelegationCertificate[];
}

export interface ByronBoundaryFacts { slot: bigint; blockNo: bigint; blockSize: number }

export interface ByronApplyResult {
    state: ByronLedgerState;
    /** cardano-node's `ChainValidationError`s for the block (empty when valid). */
    errors: string[];
}

/** `ByronTransitionInfo` after a block: keep the entries still candidates, add the new ones at `blockNo`. */
function nextTransition(old: Map<string, bigint>, update: ByronUpdateState, blockNo: bigint): Map<string, bigint> {
    const ifNew = new Map<string, bigint>();
    for (const c of update.candidateProtocolUpdates) ifNew.set(pvKey(c.protocolVersion), blockNo);
    const out = new Map<string, bigint>();
    for (const [v, bno] of ifNew) out.set(v, old.get(v) ?? bno);
    if (out.size === old.size && [...out].every(([v, b]) => old.get(v) === b)) return old;
    return out;
}

/**
 * `validateBlock` on an already ticked state (`tickByronLedger(cfg, st, b.slot)`). Rule failures
 * are returned, not thrown: the state then carries the block's tick, slot and block number but
 * none of its delegation or update effects (a strict node never applies it).
 */
export function applyByronMainBlock(cfg: ByronLedgerConfig, ticked: ByronLedgerState, b: ByronMainBlockFacts): ByronApplyResult {
    const errors: string[] = [];
    const pp = ticked.update.adoptedProtocolParameters;
    if (BigInt(b.headerSize) > pp.maxHeaderSize) errors.push(`ChainValidationHeaderTooLarge ${pp.maxHeaderSize} ${b.headerSize}`);
    if (BigInt(b.blockSize) > pp.maxBlockSize) errors.push(`ChainValidationBlockTooLarge ${pp.maxBlockSize} ${b.blockSize}`);
    const currentEpoch = b.slot / cfg.epochSlots;
    let delegation = ticked.delegation;
    try {
        delegation = updateDelegation({ protocolMagic: cfg.protocolMagic, allowedDelegators: cfg.genesisKeys, k: cfg.k, currentEpoch, currentSlot: b.slot, skipSignatures: cfg.skipSignatures }, ticked.delegation, b.certs);
    } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
    }
    let update = ticked.update;
    try {
        update = registerUpdate(
            { protocolMagic: cfg.protocolMagic, k: cfg.k, currentSlot: b.slot, numGenKeys: cfg.genesisKeys.size, delegationMap: ticked.delegation.map, skipSignatures: cfg.skipSignatures },
            ticked.update,
            { payload: b.payload, protocolVersion: b.protocolVersion, issuerKeyHash: b.issuerKeyHash },
        );
    } catch (err) {
        errors.push(`ChainValidationUpdateError ${b.slot} ${err instanceof Error ? err.message : String(err)}`);
    }
    if (errors.length) return { state: { ...ticked, lastSlot: b.slot, tipBlockNo: b.blockNo }, errors };
    return { state: { lastSlot: b.slot, tipBlockNo: b.blockNo, update, delegation, transition: nextTransition(ticked.transition, update, b.blockNo) }, errors };
}

/** `applyChainTick` + `validateBoundary` for an EBB. */
export function applyByronBoundary(cfg: ByronLedgerConfig, st: ByronLedgerState, b: ByronBoundaryFacts): ByronApplyResult {
    const ticked = tickByronLedger(cfg, st, b.slot);
    const errors = b.blockSize > 2_000_000 ? [`ChainValidationBoundaryTooLarge ${b.blockSize}`] : [];
    return { state: { ...ticked, lastSlot: b.slot, tipBlockNo: b.blockNo }, errors };
}

/**
 * ouroboros-consensus `byronTransition` (ByronHFC) over `Byron.Inspect.protocolUpdates`: the epoch
 * in which the era ends, from the newest candidate whose major is `shelleyMajor`, once it is stable
 * — 2k slots past its endorsement slot, or k blocks past the block that made it a candidate.
 * The epoch is `succ (epoch (slot + 4k))`. Null while no such candidate is stable.
 */
export function byronTransitionEpoch(cfg: ByronLedgerConfig, st: ByronLedgerState, shelleyMajor: number): bigint | null {
    const k = BigInt(cfg.k);
    for (const c of st.update.candidateProtocolUpdates) {
        if (c.protocolVersion.major !== shelleyMajor) continue;
        const adoptedIn = (c.slot + 4n * k) / cfg.epochSlots + 1n;
        if (st.lastSlot >= c.slot && st.lastSlot - c.slot >= 2n * k) return adoptedIn; // UpdateStableCandidate
        const bno = st.transition.get(pvKey(c.protocolVersion));
        if (bno === undefined) continue;
        const distance = st.tipBlockNo === null ? bno + 1n : st.tipBlockNo - bno;
        if (distance >= k) return adoptedIn;
    }
    return null;
}

// ───────────────────────────── decoding ─────────────────────────────

function difficultyOf(raw: Uint8Array, what: string): bigint {
    const d = Cbor.parse(raw);
    if (!(d instanceof CborArray) || d.array.length !== 1 || !(d.array[0] instanceof CborUInt)) throw new ByronLedgerError(`${what}: ChainDifficulty is not [u64]`);
    return d.array[0].num;
}

/** Heavyweight delegation certificates of a main body's `dlg` element (`[* [epoch, issuer, delegate, sig]]`). */
export function decodeByronDlgPayload(raw: Uint8Array): ByronDelegationCertificate[] {
    const dlg = Cbor.parse(raw);
    if (!(dlg instanceof CborArray)) throw new ByronLedgerError("dlg payload is not an array");
    return dlg.array.map((c, i) => {
        if (!(c instanceof CborArray) || c.array.length !== 4 || !(c.array[0] instanceof CborUInt) || !(c.array[1] instanceof CborBytes) || !(c.array[2] instanceof CborBytes) || !(c.array[3] instanceof CborBytes)) {
            throw new ByronLedgerError(`dlg certificate ${i} malformed`);
        }
        return { epoch: c.array[0].num, issuerXPub: c.array[1].bytes, delegateXPub: c.array[2].bytes, signature: c.array[3].bytes };
    });
}

/** Facts of a raw Byron main block (`[header, body, extra]`, no era wrapper). */
export function byronMainBlockFacts(rawBlock: Uint8Array, epochSlots: bigint): ByronMainBlockFacts {
    const blk = Cbor.parseLazy(rawBlock);
    if (!(blk instanceof LazyCborArray) || blk.array.length !== 3) throw new ByronLedgerError("Byron main block is not [header, body, extra]");
    const rawHeader = blk.array[0]!, rawBody = blk.array[1]!;
    const h = decodeByronHeaderUpdateFields(rawHeader, epochSlots);
    const body = Cbor.parseLazy(rawBody);
    if (!(body instanceof LazyCborArray) || body.array.length !== 4) throw new ByronLedgerError("Byron main body is not [txs, ssc, dlg, upd]");
    return {
        slot: h.slot,
        blockNo: difficultyOf(sliceByronMainHeader(rawHeader).difficulty, "main header"),
        headerSize: rawHeader.length,
        blockSize: rawBlock.length,
        protocolVersion: h.protocolVersion,
        issuerKeyHash: byronKeyHash(h.issuerXPub),
        payload: decodeByronUpdatePayload(body.array[3]!),
        certs: decodeByronDlgPayload(body.array[2]!),
    };
}

/** Facts of a raw Byron boundary block (`[header, body, extra]`; header consensus = `[epoch, difficulty]`). */
export function byronBoundaryFacts(rawBlock: Uint8Array, epochSlots: bigint): ByronBoundaryFacts {
    const blk = Cbor.parseLazy(rawBlock);
    if (!(blk instanceof LazyCborArray) || blk.array.length !== 3) throw new ByronLedgerError("Byron boundary block is not [header, body, extra]");
    const header = Cbor.parseLazy(blk.array[0]!);
    if (!(header instanceof LazyCborArray) || header.array.length !== 5) throw new ByronLedgerError("Byron boundary header is not a 5-element array");
    const cons = Cbor.parseLazy(header.array[3]!);
    if (!(cons instanceof LazyCborArray) || cons.array.length !== 2) throw new ByronLedgerError("Byron boundary consensus data is not [epoch, difficulty]");
    const e = Cbor.parse(cons.array[0]!);
    if (!(e instanceof CborUInt)) throw new ByronLedgerError("Byron boundary epoch is not a uint");
    return { slot: e.num * epochSlots, blockNo: difficultyOf(cons.array[1]!, "boundary header"), blockSize: rawBlock.length };
}

// ───────────────────────────── persistence form ─────────────────────────────

function replacer(_k: string, v: unknown): unknown {
    if (typeof v === "bigint") return { $n: v.toString() };
    if (v instanceof Map) return { $map: [...v] };
    if (v instanceof Set) return { $set: [...v] };
    return v;
}

function reviver(_k: string, v: any): unknown {
    if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("$n" in v) return BigInt(v.$n);
        if ("$map" in v) return new Map(v.$map);
        if ("$set" in v) return new Set(v.$set);
    }
    return v;
}

/**
 * The part of the state that changes only when a block carries update / delegation effects or an
 * epoch adopts a version (JSON, bigints / Maps / Sets tagged). `lastSlot` and `tipBlockNo` move
 * with every block and are stored apart (`encodeByronLedgerTip`), so a block without effects
 * writes a few bytes, not the parameter set.
 */
export function encodeByronLedgerCore(st: ByronLedgerState): string {
    return JSON.stringify({ v: 1, update: st.update, delegation: st.delegation, transition: st.transition }, replacer);
}

export function encodeByronLedgerTip(st: ByronLedgerState): string {
    return `${st.lastSlot}|${st.tipBlockNo ?? ""}`;
}

export function decodeByronLedger(core: string, tip: string): ByronLedgerState {
    const c = JSON.parse(core, reviver) as { v: number; update: ByronUpdateState; delegation: ByronDelegationState; transition: Map<string, bigint> };
    if (c.v !== 1) throw new ByronLedgerError(`Byron ledger record version ${c.v} unknown`);
    const [slot = "0", bno = ""] = tip.split("|");
    return { lastSlot: BigInt(slot || "0"), tipBlockNo: bno ? BigInt(bno) : null, update: c.update, delegation: c.delegation, transition: c.transition };
}
