/**
 * Runs Cardano Blueprint ledger conformance vectors through Gerolamo's block-validation entry points.
 *
 * Each vector is one transaction applied by cardano-ledger's Conway LEDGER rule to the vector's
 * `oldLedgerState`. Gerolamo has no "apply one transaction" API: a transaction reaches its rules
 * inside a block. The harness therefore wraps the transaction, byte for byte, in a one-transaction
 * Conway block and runs what the node runs for every block:
 *
 *   1. `runBlockRulesJob` (consensus/workers/validationJob.ts): the validation worker's job.
 *      `MultiEraBlock.fromCbor`, witnesses, UTXO / UTXOW / UTXOS rules, Plutus phase 2
 *      (`evaluateShelleyBlockWithInputs`).
 *   2. `checkBlockGovernance` (consensus/governance/govValidate.ts): GOV, GOVCERT, DELEG, POOL and
 *      the LEDGER governance checks, over a `GovLedgerView` built from the vector's state.
 *   3. `checkCertificateSequence` (consensus/certificateRules.ts): the body validator's stake
 *      registration sequence check.
 *
 * The rule inputs (`BlockRuleInputs`, `GovLedgerView`) are filled from the decoded old ledger state
 * the way the node fills them from its store (db/rulesQueries.ts, governance/govLedgerView.ts).
 * The verdict "accepted" means no failure from any of the three; it is compared with `success`.
 *
 * When the vector accepts the transaction, the harness also checks the resulting state: the old
 * UTxO set minus what the transaction spends plus what it creates (`shelleyBlockOverlay`, the effects
 * the node carries to the next block) must equal the vector's `newLedgerState` UTxO set, with the
 * same values, datums and reference scripts; the `fees` and `deposited` pots must move by what the
 * node computes; and the certificate / governance effects `GovBlockOverlay` carries (accounts, DRep
 * delegations, reward balances, DReps, pools, committee keys, proposals and their expiry) must equal
 * the new state's.
 *
 * Second entry point: `runVectorMempool` submits the transaction to `ValidatingMempool.addTx` (the
 * LocalTxSubmission / tx-submission path) over a view of the same state.
 */
import { Cbor, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { conwayPParamsToRaw } from "../../mithril/nesDecoder";
import { runBlockRulesJob } from "../../consensus/workers/validationJob";
import { shelleyBlockOverlay } from "../../consensus/rules/blockRulesPure";
import { rewardAccountKey, certDepositsAndRefunds } from "../../consensus/rules/ledgerChecks";
import { unitsEqual, unitsOf, diffUnits } from "../../consensus/rules/value";
import { utxoRefOf, type ResolvedUtxo } from "../../consensus/rules/resolvedUtxo";
import { checkBlockGovernance, govRuleParamsOf } from "../../consensus/governance/govValidate";
import { decodeGovTx } from "../../consensus/governance/govTxDecode";
import { checkGovTx, GovBlockOverlay, updateIsSecurityRelevant, type GovLedgerView, type ProposalView, type CommitteeCred } from "../../consensus/governance/govRules";
import { checkCertificateSequence, credKey, type CertView } from "../../consensus/certificateRules";
import type { EpochBodyParams } from "../../consensus/epochParams";
import { EPOCH_GEOMETRY, getEpochNetwork, setEpochNetwork, type EpochGeometry } from "../../utils/epochFromSlotCalculations";
import { decodeBlueprintLedgerState, pparamsArrayOf, type BlueprintLedgerState } from "./ledgerState";
import type { Proposal } from "../../mithril/nesDecoder";
import { ValidatingMempool, type MempoolLedgerView } from "../../mempool/ValidatingMempool";

/** One record of the corpus. */
export interface BlueprintVector {
    /** `eras/conway/impl/dump/<test>/<n>`. */
    path: string;
    /** The ImpSpec test (directory name). */
    test: string;
    /** Position of the transaction in its test (file name). */
    index: number;
    txHex: string;
    oldLedgerState: string;
    newLedgerState: string | null;
    success: boolean;
}

/** Rule family of a test path, as the coverage table groups it: `Conway.Imp.<Spec>.<RULE>…`. */
export function familyOf(test: string): { spec: string; rule: string } {
    const parts = test.split(".");
    const spec = (parts[2] ?? "?").replace(/^ConwayImpSpec - Version \d+$/, "ConwayImpSpec");
    return { spec, rule: parts[3] ?? "?" };
}

const DUMP = "eras/conway/impl/dump/";

/** The vectors of an extracted corpus (path → file bytes), grouped in test order. */
export function vectorsOf(files: Map<string, Uint8Array>): { vectors: BlueprintVector[]; pparams: Map<string, Uint8Array> } {
    const vectors: BlueprintVector[] = [];
    const pparams = new Map<string, Uint8Array>();
    const dec = new TextDecoder();
    for (const [path, bytes] of files) {
        if (!path.startsWith(DUMP)) continue;
        const rest = path.slice(DUMP.length);
        const slash = rest.lastIndexOf("/");
        if (slash < 0) continue;
        const dir = rest.slice(0, slash), name = rest.slice(slash + 1);
        if (dir === "pparams-by-hash") { pparams.set(name.toLowerCase(), bytes); continue; }
        const j = JSON.parse(dec.decode(bytes));
        vectors.push({ path, test: dir, index: Number(name), txHex: j.cbor, oldLedgerState: j.oldLedgerState, newLedgerState: j.newLedgerState ?? null, success: j.success === true });
    }
    vectors.sort((a, b) => (a.test < b.test ? -1 : a.test > b.test ? 1 : a.index - b.index));
    return { vectors, pparams };
}

// ───────────────────────────── the ImpSpec environment ─────────────────────────────

/**
 * Slot geometry of the ImpSpec runs that dumped the corpus (`initGenesis` of
 * Test.Cardano.Ledger.Shelley.ImpTest): system start 2017-09-23T21:44:51Z, 1-second slots,
 * 4320-slot epochs from slot 0. Plutus script contexts turn validity bounds into POSIX time with it.
 */
export const IMP_GEOMETRY: EpochGeometry = { systemStartUnix: 1_506_203_091n, byronSlotsPerEpoch: 4320n, shelleyStartSlot: 0n, shelleyStartEpoch: 0n, shelleySlotsPerEpoch: 4320n, stabilityWindow: 1296n };
export const IMP_EPOCH_LENGTH = 4320n;

/** Run `f` with the ImpSpec geometry as the process-wide "custom" network, restoring the previous one after. */
export async function withImpGeometry<T>(f: () => Promise<T>): Promise<T> {
    const prevNet = getEpochNetwork();
    const prevCustom = { ...EPOCH_GEOMETRY.custom };
    EPOCH_GEOMETRY.custom = { ...IMP_GEOMETRY };
    setEpochNetwork("custom");
    try { return await f(); }
    finally { EPOCH_GEOMETRY.custom = prevCustom; setEpochNetwork(prevNet); }
}

/**
 * The epoch the transaction ran in. The Blueprint export has no `NewEpochState` (no epoch number,
 * no slot, no treasury), so it is recovered from the state:
 *   - a proposal is stamped with the epoch it was submitted in (`gasProposedIn`), and a successful
 *     transaction's own proposals are in the new state: the epoch is at least that;
 *   - the DRep pulser of the current epoch E is serialised complete, and its `rsExpired` holds the
 *     actions with `gasExpiresAfter < E` (Conway RATIFY): the epoch is past their expiry.
 * Without either the ImpSpec starting epoch applies (899: ConwayImpSpec at protocol 10 starts there,
 * as every proposal of the corpus submitted before an epoch pass shows).
 */
export const IMP_START_EPOCH = 899;
export function epochEstimate(oldState: BlueprintLedgerState, newState: BlueprintLedgerState | null): number {
    let e = IMP_START_EPOCH;
    for (const s of [oldState, newState]) for (const p of s?.gov.proposals ?? []) e = Math.max(e, p.proposedIn);
    const expiry = new Map(oldState.gov.proposals.map((p) => [p.id, p.expiresAfter]));
    for (const id of oldState.gov.pulserExpired) { const x = expiry.get(id); if (x != null) e = Math.max(e, x + 1); }
    return e;
}

// ───────────────────────────── building the block ─────────────────────────────

/**
 * A real Conway header (consensus vectors, within_k_fork_v1, the second block of peer 0). The block rules read
 * only its protocol version (`checkHeaderProtVer`, mainnet only); nothing checks its signature here.
 */
const HEADER_HEX =
    "828a0104582035fa6f249a21a3c5271674f34ec9883153c67e24b495cc555b561e3f017e754d582002b424591732c334cdc0fe3cd4d6e259246b273bc0ab031077e0f48d392b3e505820f6ffa3a20762a32115ae4c86869c02869758ec5e5b984dd080b8913acc74f735825840659763674c39800afc1234ddfdc0accb2eb4d90eebc607985b30474952195dbdb33053de4102da90f33b55329ab265461ec024efee79344e7cad3537e95e242b5850d7afa897efeeaac588280182c1682c2d89f4cfc9e15c017ac86af7c487c93c39948bd0be938141a3071f85473d7d9a4504b4e13ca678c20654e1776eacfb40c470d8ea4381353d4e3b9a674636ea8e0a04582029571d16f081709b3c48651860077bebf9340abb3fc7133443c54f1f5a5edcf1845820a82789130fb915ca1f682a1553aac4f79174f317d72e2b65c9b4d87395c73a0e00005840165b897698e8e449902eaa50145e92f32ad9ddaf423a1aa11972cd722ce7a0e82e4014d4b33176dcc8af82fa08a59dde816109695b7e3d6af4daef2cc7f5400f820c005901c0121122f7f3c51c415765da77ab0e3229db67f2765e5f4c5a904c7779d3fc03694dd0b9c43d86c23077583f56eb2b71e2f17d67e1474429bcd42ff5fa8a22970e48337053043127f0f7f68c8f46e37e82c29459cfbd903fe20c2bdbeb723b214eac328feb5ae9c5a6b2fc6ce36c2e6c9140312cea701bd1c8dcf3f4787a3fc1869df351078a51424ccbb2c04761a40f3511350d97eba0fc21f23e33e22760683035bcf3b9cf2bdc95fcbc06f196d3978d50ea7f1e12cb6ed2411acca321146e7d64cc315757e95aa2e27251cf07f9acfaaafe0903ba5a9ff4e2d9957c6bc1380567a6949c74c3d54323791e1796b48a90184432fcddcb874332a3ede1c84801a9dd25b6fcda2677e7b13106121edc4d8489150b8786f4a38e80ec550f5852c93fc27ef1ab85ae4307a0b9046b39e99c9b4546b98c9227870136984a08c9a2bfa6f27aa4fbaf43cf2e5131016692742d9be1d6e18a64c2dca285d14decb636b7b07b2a1152a90fced42ce03ab56826014e26471f6ddbae1b4808cf130d9d1662eef65d1a350afa9f62bdbc98e5481b5b431532484fc0ea0fb1dc5674c06a630a494e50d82bd2a3f112da87df12520db7ab65f1fe308564ff9b0ffefe0a607c0a2e";

export interface TxParts { body: Uint8Array; witnesses: Uint8Array; isValid: boolean; aux: Uint8Array | null }

/** The four elements of a transaction, as their original bytes. */
export function txParts(tx: Uint8Array): TxParts {
    const l = Cbor.parseLazy(tx);
    if (!(l instanceof LazyCborArray) || (l.array.length !== 4 && l.array.length !== 3)) throw new Error("transaction is not a 3/4-element array");
    const [body, witnesses, third, fourth] = l.array as Uint8Array[];
    if (l.array.length === 3) return { body: body!, witnesses: witnesses!, isValid: true, aux: third![0] === 0xf6 ? null : third! };
    return { body: body!, witnesses: witnesses!, isValid: third![0] !== 0xf4, aux: fourth![0] === 0xf6 ? null : fourth! };
}

function cat(parts: Uint8Array[]): Uint8Array {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
}

/** `[7, [header, [body], [witnesses], {0: aux}, [0 if invalid]]]`: the transaction's bytes untouched. */
export function oneTxConwayBlock(t: TxParts): Uint8Array {
    const header = Uint8Array.from(Buffer.from(HEADER_HEX, "hex"));
    return cat([
        Uint8Array.of(0x82, 0x07, 0x85), header,
        Uint8Array.of(0x81), t.body,
        Uint8Array.of(0x81), t.witnesses,
        t.aux ? cat([Uint8Array.of(0xa1, 0x00), t.aux]) : Uint8Array.of(0xa0),
        t.isValid ? Uint8Array.of(0x80) : Uint8Array.of(0x81, 0x00),
    ]);
}

// ───────────────────────────── the views over the vector state ─────────────────────────────

/** The epoch parameters record the node builds from a stored parameter record (epochParams.ts `epochParamsFromRecord`). */
export function bodyParamsOf(epoch: number, raw: Record<string, unknown>): EpochBodyParams {
    const num = (v: unknown): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    const big = (v: unknown): bigint => { try { return v == null ? 0n : BigInt(String(v)); } catch { return 0n; } };
    return {
        epoch,
        minFeeA: big(raw.min_fee_a), minFeeB: big(raw.min_fee_b),
        maxTxSize: num(raw.max_tx_size) ?? 16384, maxBlockSize: num(raw.max_block_size) ?? 65536, maxBlockHeaderSize: num(raw.max_block_header_size) ?? 1100,
        collateralPercent: num(raw.collateral_percent), maxCollateralInputs: num(raw.max_collateral_inputs), maxValSize: num(raw.max_val_size),
        protocolMajor: num(raw.protocol_major_ver), raw,
    };
}

const kindType: Record<string, number> = { ParameterChange: 0, InitHardFork: 1, TreasuryWithdrawals: 2, NoConfidence: 3, UpdateCommittee: 4, NewConstitution: 5, Info: 6 };

function proposalView(p: Proposal): ProposalView {
    const type = kindType[p.action.kind] ?? 6;
    const keys = p.action.update ? p.action.update.map.map((e) => Number((e.k as CborUInt).num)) : [];
    return {
        id: p.id, type, prev: p.action.prev, expiresAfter: p.expiresAfter,
        ...(type === 1 ? { major: p.action.protocolVersion!.major, minor: p.action.protocolVersion!.minor } : {}),
        ...(type === 4 ? { ccAdd: (p.action.add ?? []).map((a) => (a.cred.type === 1 ? `01${a.cred.hash}` : a.cred.hash)) } : {}),
        ...(type === 0 ? { security: updateIsSecurityRelevant(keys) } : {}),
    };
}

/**
 * `GovLedgerView` over the vector's state, with the node's semantics (govLedgerView.ts
 * `buildGovLedgerView`): balances are exact (the vector's own), the deposit an account paid is not
 * tracked (the node's view answers null too), the treasury is unknown (not in a `LedgerState`).
 */
export function govViewOf(s: BlueprintLedgerState): GovLedgerView {
    const committeeCreds = new Map<string, CommitteeCred>();
    for (const [cold, a] of s.committeeState) committeeCreds.set(cold, "hot" in a ? { hot: a.hot, resigned: false } : { hot: null, resigned: true });
    const proposals = new Map<string, ProposalView>(s.gov.proposals.map((p) => [p.id, proposalView(p)]));
    const vrfs = new Set<string>([...s.pools.values(), ...s.futurePools.values()].map((p) => p.vrf));
    const roots = { pparams: s.gov.roots.pparams, hardfork: s.gov.roots.hardFork, committee: s.gov.roots.committee, constitution: s.gov.roots.constitution };
    return {
        accountRegistered: (c) => s.accounts.has(c),
        accountDeposit: () => null,
        accountBalance: (c) => s.accounts.get(c)?.reward ?? null,
        balancesExact: () => ({ exact: true, why: "" }),
        accountDRep: (c) => s.accounts.get(c)?.drep ?? null,
        poolRegistered: (p) => s.pools.has(p),
        poolVrf: (p) => s.pools.get(p)?.vrf ?? null,
        registeredVrfs: () => vrfs,
        drepRegistered: (c) => s.dreps.has(c),
        drepDeposit: (c) => s.dreps.get(c)?.deposit ?? null,
        committeeMembers: () => s.gov.committee?.members ?? null,
        committeeCreds: () => committeeCreds,
        proposals: () => proposals,
        roots: () => roots,
        constitutionScript: () => s.gov.constitution.script,
        treasury: () => null,
    };
}

// ───────────────────────────── running one vector ─────────────────────────────

export interface VectorOutcome {
    accepted: boolean;
    failures: string[];
    reports: string[];
    /** Resulting-state differences (accepted transactions the vector also accepts). */
    stateDiffs: string[];
    epoch: number;
    slot: bigint;
}

const hexOf = (v: unknown): string | null => {
    const b = (v as any)?.toBuffer?.() ?? v;
    if (b instanceof Uint8Array) return toHex(b);
    return typeof b === "string" && b.length > 0 ? b : null;
};

/** Run one vector (call inside `withImpGeometry`). */
export async function runVector(v: BlueprintVector, pparams: Map<string, Uint8Array>): Promise<VectorOutcome> {
    const oldState = decodeBlueprintLedgerState(v.oldLedgerState);
    const newState = v.newLedgerState ? decodeBlueprintLedgerState(v.newLedgerState) : null;
    const ppBytes = pparams.get(oldState.gov.curPParamsHash);
    if (!ppBytes) throw new Error(`pparams ${oldState.gov.curPParamsHash} not in the corpus`);
    const raw = conwayPParamsToRaw(pparamsArrayOf(ppBytes));
    const epoch = epochEstimate(oldState, newState);
    const slot = BigInt(epoch) * IMP_EPOCH_LENGTH;
    const params = bodyParamsOf(epoch, raw);

    const txBytes = Uint8Array.from(Buffer.from(v.txHex, "hex"));
    const parts = txParts(txBytes);
    const blockBytes = oneTxConwayBlock(parts);
    const failures: string[] = [], reports: string[] = [];

    // What the block reads, as rulesQueries.ts gathers it: the withdrawn accounts' balance, registration and DRep delegation.
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [r, u] of oldState.utxo) resolved.set(r, u.resolved);
    let block: MultiEraBlock | null = null;
    try { block = MultiEraBlock.fromCbor(blockBytes); } catch (e) { failures.push(`block does not decode: ${(e as Error).message}`); }
    const body: any = (block as any)?.block?.transactionBodies?.[0];
    const rewardBalances = new Map<string, bigint>(), stakeRegistered = new Map<string, boolean>(), drepDelegated = new Map<string, boolean>();
    for (const w of (body?.withdrawals?.map ?? []) as any[]) {
        const c = rewardAccountKey(w.rewardAccount);
        const a = oldState.accounts.get(c);
        if (a) rewardBalances.set(c, a.reward);
        stakeRegistered.set(c, !!a);
        drepDelegated.set(c, !!a?.drep);
    }

    if (block) {
        // 1. the validation worker's job
        const r = await runBlockRulesJob({
            kind: "blockRules", block: blockBytes, slot: slot.toString(), params, genesis: null, config: { network: "custom" },
            resolved, pools: new Set(oldState.pools.keys()), rewardBalances, drepDelegated, stakeRegistered, treasury: null,
            exactness: { exact: true, why: "" }, preVerified: null, phase: "both",
        });
        if (!r.outcome) failures.push(`block rules not evaluated: ${r.reason}`);
        else { failures.push(...r.outcome.failures); reports.push(...r.outcome.reports); }

        // 2. governance (validateBlock → validateBlockGovernance), phase-2-valid transactions only
        const gov = await checkBlockGovernance({
            slot: Number(slot), epoch, bodies: [{ bytes: parts.body, txId: toHex(blake2b_256(parts.body)) }],
            invalid: new Set(parts.isValid ? [] : [0]), raw, networkId: 0, view: govViewOf(oldState),
        });
        failures.push(...gov.failures); reports.push(...gov.reports);

        // 3. the body validator's certificate sequence (BlockBodyValidator.validateCertificatesValid)
        const certs: CertView[] = ((body?.certs ?? []) as any[]).map((c) => ({
            certType: Number(c.certType), credHex: hexOf(c.stakeCredential?.hash),
            credType: c.stakeCredential ? (Number(c.stakeCredential.type) === 1 ? 1 : 0) : null, poolHex: hexOf(c.poolKeyHash),
        }));
        if (certs.length) {
            const registered = new Set<string>(), delegated = new Map<string, string>();
            for (const [c, a] of oldState.accounts) {
                const key = credKey(c.length === 58 ? 1 : 0, c.length === 58 ? c.slice(2) : c);
                registered.add(key);
                if (a.pool) delegated.set(key, a.pool);
            }
            const verdict = checkCertificateSequence(certs, registered, delegated);
            if (!verdict.ok) failures.push(`certificates: ${verdict.reason}`);
        }
    }

    const accepted = failures.length === 0;
    const stateDiffs = accepted && newState && block ? compareResultingState(block, parts, oldState, newState, raw) : [];
    if (accepted && newState && parts.isValid) stateDiffs.push(...compareGovEffects(parts.body, oldState, newState, raw, epoch));
    return { accepted, failures, reports, stateDiffs, epoch, slot };
}

/** The UTxO set, the fee pot and the deposit pot after the transaction, as the node computes them, against the vector's new state. */
function compareResultingState(block: MultiEraBlock, parts: TxParts, oldState: BlueprintLedgerState, newState: BlueprintLedgerState, raw: Record<string, unknown>): string[] {
    const diffs: string[] = [];
    const ov = shelleyBlockOverlay(block);
    const expected = new Map<string, ResolvedUtxo>();
    for (const [r, u] of oldState.utxo) if (!ov.spent.has(r)) expected.set(r, u.resolved);
    for (const [r, u] of ov.created) expected.set(r, u);
    for (const [r, u] of newState.utxo) {
        const mine = expected.get(r);
        if (!mine) { diffs.push(`utxo ${r} created by the ledger, not by us`); continue; }
        if (!unitsEqual(mine.value, u.resolved.value)) diffs.push(`utxo ${r} value: ${diffUnits(mine.value, u.resolved.value)}`);
        if (mine.address !== u.resolved.address) diffs.push(`utxo ${r} address ${mine.address} ≠ ${u.resolved.address}`);
        if ((mine.datumHash ?? null) !== (u.resolved.datumHash ?? null) || (mine.inlineDatumCbor ?? null) !== (u.resolved.inlineDatumCbor ?? null)) diffs.push(`utxo ${r} datum differs`);
        if ((mine.referenceScriptHash ?? null) !== (u.resolved.referenceScriptHash ?? null)) diffs.push(`utxo ${r} reference script ${mine.referenceScriptHash} ≠ ${u.resolved.referenceScriptHash}`);
    }
    for (const r of expected.keys()) if (!newState.utxo.has(r)) diffs.push(`utxo ${r} kept or created by us, not by the ledger`);

    const body: any = (block as any).block.transactionBodies[0];
    let fee: bigint;
    if (parts.isValid) fee = BigInt(body.fee ?? 0);
    else {
        // phase-2 failure: the collateral pays (db.ts applyInvalidTransaction: total collateral, else inputs minus return)
        let coll = 0n;
        for (const c of (body.collateralInputs ?? []) as any[]) { const r = utxoRefOf(c); const u = r ? oldState.utxo.get(r) : null; coll += u?.resolved.value.get("lovelace") ?? 0n; }
        const ret = body.collateralReturn ? (unitsOf(body.collateralReturn.value).get("lovelace") ?? 0n) : 0n;
        fee = body.totCollateral != null ? BigInt(body.totCollateral) : coll - ret;
    }
    if (newState.fees - oldState.fees !== fee) diffs.push(`fees moved by ${newState.fees - oldState.fees}, we charge ${fee}`);
    if (parts.isValid) {
        const cd = certDepositsAndRefunds((body.certs ?? []) as any[], { keyDeposit: BigInt(String(raw.key_deposit)), poolDeposit: BigInt(String(raw.pool_deposit)), drepDeposit: BigInt(String(raw.drep_deposit)) }, (p) => oldState.pools.has(p.toLowerCase()));
        let props = 0n;
        for (const p of (body.proposalProcedures ?? []) as any[]) props += BigInt(p.deposit ?? 0);
        const net = cd.deposits + props - cd.refunds;
        if (newState.deposited - oldState.deposited !== net) diffs.push(`deposits moved by ${newState.deposited - oldState.deposited}, we compute ${net} (deposits ${cd.deposits + props}, refunds ${cd.refunds})`);
    }
    return diffs;
}

// ───────────────────────────── the mempool admission path ─────────────────────────────

/**
 * `MempoolLedgerView` over the vector's state, with the node's store semantics (ledgerViewDb.ts):
 * the ledger tip one slot before the transaction's, reward balances by the credential asked for
 * (zero when there is no account), stake registration and pool delegation by `credKey`.
 */
export function mempoolViewOf(s: BlueprintLedgerState, slot: bigint, params: EpochBodyParams): MempoolLedgerView {
    const gov = govViewOf(s);
    return {
        tip: async () => ({ slot: slot - 1n, hash: "00".repeat(32) }),
        state: async (at) => ({ slot: at, params, genesis: null, network: "testnet" }),
        resolve: async (refs) => { const m = new Map<string, ResolvedUtxo>(); for (const r of refs) { const u = s.utxo.get(r); if (u) m.set(r, u.resolved); } return m; },
        pools: async (ids) => new Set(ids.filter((p) => s.pools.has(p))),
        rewardBalances: async (creds) => (creds.length ? new Map(creds.map((c) => [c, s.accounts.get(c)?.reward ?? 0n])) : undefined),
        stake: async (creds) => {
            const registered = new Set<string>(), delegated = new Map<string, string>();
            for (const c of creds) {
                const a = s.accounts.get(c.type === 1 ? `01${c.hex}` : c.hex);
                if (!a) continue;
                registered.add(credKey(c.type, c.hex));
                if (a.pool) delegated.set(credKey(c.type, c.hex), a.pool);
            }
            return { registered, delegated };
        },
        epochNetwork: () => "custom",
        exactness: () => ({ exact: true, why: "" }),
        govLedgerView: async () => gov,
    };
}

/** Submit the vector's transaction to an empty `ValidatingMempool` over its state (call inside `withImpGeometry`). */
export async function runVectorMempool(v: BlueprintVector, pparams: Map<string, Uint8Array>): Promise<{ accepted: boolean; reasons: string[] }> {
    const oldState = decodeBlueprintLedgerState(v.oldLedgerState);
    const newState = v.newLedgerState ? decodeBlueprintLedgerState(v.newLedgerState) : null;
    const raw = conwayPParamsToRaw(pparamsArrayOf(pparams.get(oldState.gov.curPParamsHash)!));
    const epoch = epochEstimate(oldState, newState);
    const slot = BigInt(epoch) * IMP_EPOCH_LENGTH;
    const mempool = new ValidatingMempool({ view: mempoolViewOf(oldState, slot, bodyParamsOf(epoch, raw)), rejectFailedPlutus: true, rejectUncheckedPlutus: false });
    const r = await mempool.addTx(Uint8Array.from(Buffer.from(v.txHex, "hex")), "conformance");
    return r.ok ? { accepted: true, reasons: [] } : { accepted: false, reasons: r.reasons };
}

/**
 * The certificate and governance effects the node carries to the next transaction of a block
 * (`GovBlockOverlay`, filled by `checkGovTx`) against the vector's new state: account registration,
 * DRep delegation and reward balance (withdrawals drained), DRep registration and deposit, pool
 * registration, committee hot keys and resignations, and the live proposals with their expiry.
 */
function compareGovEffects(body: Uint8Array, oldState: BlueprintLedgerState, newState: BlueprintLedgerState, raw: Record<string, unknown>, epoch: number): string[] {
    const diffs: string[] = [];
    const ov = new GovBlockOverlay(govViewOf(oldState));
    checkGovTx(decodeGovTx(body), govRuleParamsOf(raw, epoch, 0), ov);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const c of new Set([...oldState.accounts.keys(), ...newState.accounts.keys()])) {
        const want = newState.accounts.get(c);
        if (ov.accountRegistered(c) !== !!want) { diffs.push(`account ${c.slice(0, 12)}… registered: ${ov.accountRegistered(c)}, ledger ${!!want}`); continue; }
        if (!want) continue;
        if (!same(ov.accountDRep(c) ?? null, want.drep)) diffs.push(`account ${c.slice(0, 12)}… DRep delegation ${JSON.stringify(ov.accountDRep(c))}, ledger ${JSON.stringify(want.drep)}`);
        if (ov.accountBalance(c) !== want.reward) diffs.push(`account ${c.slice(0, 12)}… balance ${ov.accountBalance(c)}, ledger ${want.reward}`);
    }
    for (const c of new Set([...oldState.dreps.keys(), ...newState.dreps.keys()])) {
        const want = newState.dreps.get(c);
        if (ov.drepRegistered(c) !== !!want) diffs.push(`DRep ${c.slice(0, 12)}… registered: ${ov.drepRegistered(c)}, ledger ${!!want}`);
        else if (want && ov.drepDeposit(c) !== want.deposit) diffs.push(`DRep ${c.slice(0, 12)}… deposit ${ov.drepDeposit(c)}, ledger ${want.deposit}`);
    }
    for (const p of new Set([...oldState.pools.keys(), ...newState.pools.keys(), ...newState.futurePools.keys()])) {
        const want = newState.pools.has(p) || newState.futurePools.has(p);
        if (ov.poolRegistered(p) !== want) diffs.push(`pool ${p.slice(0, 12)}… registered: ${ov.poolRegistered(p)}, ledger ${want}`);
    }
    const creds = ov.committeeCreds();
    for (const [cold, a] of newState.committeeState) {
        const mine = creds.get(cold);
        const want = "hot" in a ? { hot: a.hot, resigned: false } : { hot: null, resigned: true };
        if (!mine || mine.resigned !== want.resigned || (mine.hot ?? null) !== want.hot) diffs.push(`committee ${cold.slice(0, 12)}…: ${JSON.stringify(mine)}, ledger ${JSON.stringify(want)}`);
    }
    const mine = ov.proposals();
    for (const p of newState.gov.proposals) {
        const m = mine.get(p.id);
        if (!m) diffs.push(`proposal ${p.id.slice(0, 12)}… recorded by the ledger, not by us`);
        else if (m.expiresAfter !== p.expiresAfter) diffs.push(`proposal ${p.id.slice(0, 12)}… expires after ${m.expiresAfter}, ledger ${p.expiresAfter}`);
    }
    for (const id of mine.keys()) if (!newState.gov.proposals.some((p) => p.id === id)) diffs.push(`proposal ${id.slice(0, 12)}… recorded by us, not by the ledger`);
    return diffs;
}
