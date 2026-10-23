/**
 * pragma-org node-diversity-conformance, scenario `ledger-rules`: one raw Conway transaction applied
 * to a declared ledger state, with the expected outcome `Pass`, a cardano-ledger predicate failure
 * (by constructor name) or a decoding failure.
 *
 * The fixture's state is turned into the views Gerolamo's rules read (the same shapes the Blueprint
 * harness fills, src/conformance/blueprint/harness.ts) and the transaction bytes, untouched, go
 * through two entry points:
 *
 *   1. the mempool (`ValidatingMempool.addTx`): MEMPOOL → LEDGER → CERTS / UTXOW → UTXO → UTXOS as
 *      cardano-node's ApplyTxErr wire CBOR (src/mempool/applyTxErr.ts), then GOV / GOVCERT / DELEG /
 *      POOL (governance/govRules.ts, failures named by the ledger constructor) and phase 2. The wire
 *      CBOR is decoded back to constructor names (`applyTxErrNames`).
 *   2. the block path, for what the mempool carries only as text or not at all: the transaction in a
 *      one-transaction Conway block through `runBlockRulesJob` (the validation worker's job), with
 *      `checkBlockGovernance` and `checkCertificateSequence`, as the body validator runs them. Its
 *      failures are text, mapped to constructor names by `blockFailureName`.
 *
 * The verdict is the union of both paths' named failures. A fixture conforms when the transaction is
 * accepted and `Pass` is expected, when the expected predicate is among the failures (cardano-node
 * reports every failure of a rejected transaction, not only the first), or when a decoding failure
 * is expected and the bytes do not decode.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { Cbor, CborArray, CborBytes, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { MultiEraBlock, TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { runBlockRulesJob } from "../../consensus/workers/validationJob";
import { outputLike } from "../../consensus/rules/blockRulesPure";
import { rewardAccountKey } from "../../consensus/rules/ledgerChecks";
import type { ResolvedUtxo } from "../../consensus/rules/resolvedUtxo";
import { checkBlockGovernance } from "../../consensus/governance/govValidate";
import type { GovLedgerView, ProposalView, CommitteeCred, Purpose } from "../../consensus/governance/govRules";
import { typedOf, type DRepTarget, type TypedCred } from "../../consensus/governance/govTxDecode";
import { checkCertificateSequence, credKey, type CertView } from "../../consensus/certificateRules";
import { EPOCH_GEOMETRY, getEpochNetwork, setEpochNetwork, type EpochGeometry } from "../../utils/epochFromSlotCalculations";
import { ValidatingMempool, type MempoolLedgerView } from "../../mempool/ValidatingMempool";
import { parseMempoolTx } from "../../mempool/mempoolTx";
import { bodyParamsOf, oneTxConwayBlock, txParts } from "../blueprint/harness";

// ───────────────────────────── fixtures ─────────────────────────────

export type Expected = { kind: "pass" } | { kind: "fail"; predicate: string; description?: string } | { kind: "decoding" };

export interface EraHistory {
    stability_window: number;
    eras: Array<{ start: { time: number; slot: number; epoch: number }; end: null | { time: number; slot: number; epoch: number }; params: { epoch_size_slots: number; slot_length: number; era_name: string } }>;
}

export interface NdcFixture {
    /** Five-digit id (file name prefix). */
    id: string;
    file: string;
    title: string;
    category: string;
    network: string;
    eraHistory: EraHistory;
    /** The protocol parameters after `$override` (JSON, fixture vocabulary). */
    pparams: Record<string, any>;
    state: Record<string, any>;
    point: { slot: number; transaction_index: number };
    txHex: string;
    expected: Expected;
}

/** The `fixtures/` directory of the scenario, given it or its `scenarios/` subdirectory. */
export function fixturesRoot(dir: string): string {
    return basename(dir) === "scenarios" && existsSync(join(dirname(dir), "protocol-parameters")) ? dirname(dir) : dir;
}

/** `common/<kind>/<file>` → `<fixtures>/<kind>/<file>`, then the `$override` shallow-merged. */
function resolveRef(root: string, v: any): any {
    if (!v || typeof v !== "object" || typeof v.$ref !== "string") return v;
    const rel = String(v.$ref).replace(/^common\//, "");
    const doc = JSON.parse(readFileSync(join(root, rel), "utf8"));
    return v.$override && typeof v.$override === "object" ? { ...doc, ...v.$override } : doc;
}

export function expectedOf(e: any): Expected {
    if (e === "Pass" || e?.predicate === "Pass") return { kind: "pass" };
    if (e && e.decoding_failure === true) return { kind: "decoding" };
    if (e && typeof e.predicate === "string") return { kind: "fail", predicate: e.predicate, ...(e.description ? { description: String(e.description) } : {}) };
    throw new Error(`unrecognised expectation ${JSON.stringify(e)}`);
}

export function loadFixture(path: string, root: string): NdcFixture {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const m = /^(\d{5})-/.exec(basename(path));
    if (!m) throw new Error(`${path}: file name must start with a five-digit id`);
    return {
        id: m[1]!, file: basename(path), title: String(j.title ?? ""), category: String(j.category ?? ""),
        network: String(j.network), eraHistory: resolveRef(root, j.era_history), pparams: resolveRef(root, j.protocol_parameters),
        state: j.initial_state ?? {}, point: j.point, txHex: String(j.transaction), expected: expectedOf(j.expected),
    };
}

export function loadFixtures(dir: string): NdcFixture[] {
    const root = fixturesRoot(dir);
    const scen = existsSync(join(root, "scenarios")) && statSync(join(root, "scenarios")).isDirectory() ? join(root, "scenarios") : root;
    return readdirSync(scen).filter((f) => /^\d{5}-.*\.json$/.test(f)).sort().map((f) => loadFixture(join(scen, f), root));
}

// ───────────────────────────── network, time, parameters ─────────────────────────────

/** systemStart (unix seconds) of the named network: the fixture's era history counts time from it. */
const SYSTEM_START: Record<string, bigint> = { mainnet: 1_506_203_091n, preprod: 1_655_769_600n, preview: 1_666_656_000n };
export const networkIdOf = (network: string): number => (network === "mainnet" ? 1 : 0);

/** The epoch of `slot` under the fixture's era history. */
export function epochOfSlot(h: EraHistory, slot: number): number {
    for (const e of h.eras) {
        if (slot < e.start.slot) continue;
        if (e.end && slot >= e.end.slot) continue;
        return e.start.epoch + Math.floor((slot - e.start.slot) / e.params.epoch_size_slots);
    }
    const last = h.eras[h.eras.length - 1]!;
    return last.start.epoch + Math.floor((slot - last.start.slot) / last.params.epoch_size_slots);
}

/**
 * The slot geometry Gerolamo's Plutus context and epoch arithmetic read: the network's system start,
 * the fixture's single Shelley-style era from its first summary (the corpus has one Conway era from
 * slot 0) and its stability window.
 */
export function geometryOf(f: NdcFixture): EpochGeometry {
    const e = f.eraHistory.eras[0]!;
    const start = (SYSTEM_START[f.network] ?? SYSTEM_START.preprod!) + BigInt(Math.floor(e.start.time));
    return {
        systemStartUnix: start - BigInt(Math.floor(e.start.slot * e.params.slot_length / 1000)),
        byronSlotsPerEpoch: BigInt(e.params.epoch_size_slots), shelleyStartSlot: BigInt(e.start.slot), shelleyStartEpoch: BigInt(e.start.epoch),
        shelleySlotsPerEpoch: BigInt(e.params.epoch_size_slots), shelleySlotMs: BigInt(e.params.slot_length), stabilityWindow: BigInt(f.eraHistory.stability_window),
    };
}

/** Run `fn` with the fixture's geometry as the process-wide "custom" network, restoring the previous one after. */
export async function withFixtureGeometry<T>(f: NdcFixture, fn: () => Promise<T>): Promise<T> {
    const prevNet = getEpochNetwork();
    const prevCustom = { ...EPOCH_GEOMETRY.custom };
    EPOCH_GEOMETRY.custom = geometryOf(f);
    setEpochNetwork("custom");
    try { return await fn(); }
    finally { EPOCH_GEOMETRY.custom = prevCustom; setEpochNetwork(prevNet); }
}

const ratio = (r: any): number => Number(r.numerator) / Number(r.denominator);

/** The fixture's protocol parameters as the raw record Gerolamo's rules read (`conwayPParamsToRaw` field names). */
export function rawParamsOf(pp: Record<string, any>): Record<string, unknown> {
    const cm = pp.plutus_cost_models ?? {};
    const costModels: Record<string, number[]> = {};
    if (cm.plutus_v1) costModels.PlutusV1 = cm.plutus_v1;
    if (cm.plutus_v2) costModels.PlutusV2 = cm.plutus_v2;
    if (cm.plutus_v3) costModels.PlutusV3 = cm.plutus_v3;
    const spo = pp.stake_pool_voting_thresholds ?? {}, drep = pp.delegate_representative_voting_thresholds ?? {};
    const coinsPerByte = String(pp.min_utxo_deposit_coefficient);
    return {
        min_fee_a: pp.min_fee_coefficient, min_fee_b: pp.min_fee_constant,
        max_tx_size: pp.max_transaction_size, max_block_size: pp.max_block_body_size, max_block_header_size: pp.max_block_header_size,
        protocol_major_ver: pp.version.major, protocol_minor_ver: pp.version.minor, decentralisation_param: 0,
        key_deposit: pp.stake_credential_deposit, pool_deposit: pp.stake_pool_deposit,
        min_utxo: coinsPerByte, coins_per_utxo_word: coinsPerByte, coins_per_utxo_size: coinsPerByte,
        e_max: pp.stake_pool_retirement_epoch_bound, n_opt: pp.desired_number_of_stake_pools,
        a0: ratio(pp.stake_pool_pledge_influence), rho: ratio(pp.monetary_expansion), tau: ratio(pp.treasury_expansion),
        min_pool_cost: pp.min_stake_pool_cost, extra_entropy: null,
        price_mem: ratio(pp.script_execution_prices.mem_price), price_step: ratio(pp.script_execution_prices.step_price),
        max_tx_ex_mem: String(pp.max_execution_units_per_transaction.mem), max_tx_ex_steps: String(pp.max_execution_units_per_transaction.steps),
        max_block_ex_mem: String(pp.max_execution_units_per_block.mem), max_block_ex_steps: String(pp.max_execution_units_per_block.steps),
        max_val_size: String(pp.max_value_size), collateral_percent: pp.collateral_percentage, max_collateral_inputs: pp.max_collateral_inputs,
        cost_models: costModels,
        pvt_motion_no_confidence: ratio(spo.motion_no_confidence), pvt_committee_normal: ratio(spo.committee_normal), pvt_committee_no_confidence: ratio(spo.committee_no_confidence),
        pvt_hard_fork_initiation: ratio(spo.hard_fork_initiation), pvt_p_p_security_group: ratio(spo.security_voting_threshold),
        dvt_motion_no_confidence: ratio(drep.motion_no_confidence), dvt_committee_normal: ratio(drep.committee_normal), dvt_committee_no_confidence: ratio(drep.committee_no_confidence),
        dvt_update_to_constitution: ratio(drep.update_constitution), dvt_hard_fork_initiation: ratio(drep.hard_fork_initiation), dvt_p_p_network_group: ratio(drep.pp_network_group),
        dvt_p_p_economic_group: ratio(drep.pp_economic_group), dvt_p_p_technical_group: ratio(drep.pp_technical_group), dvt_p_p_gov_group: ratio(drep.pp_governance_group),
        dvt_treasury_withdrawal: ratio(drep.treasury_withdrawal),
        committee_min_size: pp.constitutional_committee_min_size, committee_max_term_length: pp.constitutional_committee_max_term_length,
        gov_action_lifetime: pp.governance_action_lifetime, gov_action_deposit: pp.governance_action_deposit,
        drep_deposit: String(pp.delegate_representative_deposit), drep_activity: pp.delegate_representative_max_idle_time,
        min_fee_ref_script_cost_per_byte: ratio(pp.min_fee_reference_scripts.base),
        // Conway's `maxRefScriptSizePerTx` is a ledger constant (200 KiB); the corpus varies it as a parameter.
        ...(pp.max_reference_scripts_size != null ? { max_ref_script_size_per_tx: pp.max_reference_scripts_size } : {}),
    };
}

// ───────────────────────────── the initial state ─────────────────────────────

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export interface FixtureAccount { reward: bigint; deposit: bigint; pool: string | null; drep: DRepTarget | null }

export interface FixtureState {
    utxo: Map<string, ResolvedUtxo>;
    accounts: Map<TypedCred, FixtureAccount>;
    pools: Set<string>;
    dreps: Map<TypedCred, { deposit: bigint; validUntil: number }>;
    /** Enacted committee: members holding a term (cold → expiry epoch). */
    committee: Map<TypedCred, number>;
    /** Committee members listed without a term (see `govViewOf`). */
    unelected: TypedCred[];
    committeeCreds: Map<TypedCred, CommitteeCred>;
    proposals: Map<string, ProposalView>;
    roots: Record<Purpose, string | null>;
    guardrail: string | null;
    treasury: bigint | null;
}

/** A StakeCredential `[0|1, hash]` (hex CBOR) as a typed credential. */
export function typedCredOfCbor(hex: string): TypedCred {
    const o = Cbor.parse(fromHex(hex));
    if (!(o instanceof CborArray) || !(o.array[0] instanceof CborUInt) || !(o.array[1] instanceof CborBytes)) throw new Error(`credential ${hex}: expected [type, hash]`);
    return typedOf(Number(o.array[0].num), toHex(o.array[1].bytes));
}

function drepOfCbor(hex: string): DRepTarget {
    const o = Cbor.parse(fromHex(hex));
    if (!(o instanceof CborArray) || !(o.array[0] instanceof CborUInt)) throw new Error(`drep ${hex}: expected [tag, …]`);
    const t = Number(o.array[0].num);
    if (t === 0 || t === 1) return { kind: "cred", cred: typedOf(t, toHex((o.array[1] as CborBytes).bytes)) };
    return t === 2 ? { kind: "abstain" } : { kind: "noConfidence" };
}

/** `TransactionInput` hex CBOR → `txid:ix`. */
export function refOfInputCbor(hex: string): string {
    const o = Cbor.parse(fromHex(hex));
    if (!(o instanceof CborArray) || !(o.array[0] instanceof CborBytes) || !(o.array[1] instanceof CborUInt)) throw new Error(`input ${hex}: expected [txid, ix]`);
    return `${toHex(o.array[0].bytes)}:${Number(o.array[1].num)}`;
}

/** A transaction output (any era's form, hex CBOR) as the rules read a resolved input. */
export function resolvedOfOutputCbor(ref: string, hex: string): ResolvedUtxo {
    const o = outputLike(TxOut.fromCbor(fromHex(hex)));
    return { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null };
}

const actionIdOf = (p: { transaction_id: string; proposal_index: number }) => `${String(p.transaction_id).toLowerCase()}:${Number(p.proposal_index)}`;

/** A `ProposalKind` of the corpus as the GOV rule's proposal view. */
function proposalViewOf(id: string, kind: string, expiresAfter: number): ProposalView {
    const hf = /^HardFork\((\d+)\.(\d+)\)$/.exec(kind);
    if (hf) return { id, type: 1, prev: null, expiresAfter, major: Number(hf[1]), minor: Number(hf[2]) };
    if (kind === "ProtocolParameters") return { id, type: 0, prev: null, expiresAfter, security: false };
    if (kind === "ProtocolParameters(security-group)") return { id, type: 0, prev: null, expiresAfter, security: true };
    if (kind === "ConstitutionalCommittee") return { id, type: 4, prev: null, expiresAfter, ccAdd: [] };
    if (kind === "Constitution") return { id, type: 5, prev: null, expiresAfter };
    if (kind === "TreasuryWithdrawals") return { id, type: 2, prev: null, expiresAfter };
    // Information, and Orphan: an action with no lineage (the votes on it are the point)
    return { id, type: 6, prev: null, expiresAfter };
}

/**
 * Committee members the corpus lists without a term (`valid_until` absent) are recognised by GOVCERT
 * (they may authorise a hot key or resign) but are not elected (from protocol 11 their hot keys may
 * not vote). In cardano-ledger that is a cold credential that is not a member of the enacted committee
 * but is named by a pending UpdateCommittee proposal (`isPotentialFutureMember`); they are carried as
 * such a proposal, under an id no transaction can reference.
 */
export const UNELECTED_PROPOSAL_ID = `${"00".repeat(32)}:65535`;

export function fixtureStateOf(f: NdcFixture): FixtureState {
    const s = f.state;
    const utxo = new Map<string, ResolvedUtxo>();
    for (const u of (s.utxo ?? []) as Array<{ input: string; output: string }>) { const ref = refOfInputCbor(u.input); utxo.set(ref, resolvedOfOutputCbor(ref, u.output)); }
    const accounts = new Map<TypedCred, FixtureAccount>();
    for (const a of (s.accounts ?? []) as any[]) {
        accounts.set(typedCredOfCbor(a.credential), { reward: BigInt(a.rewards ?? 0), deposit: BigInt(a.deposit ?? 0), pool: a.pool?.id ? String(a.pool.id).toLowerCase() : null, drep: a.drep?.id ? drepOfCbor(a.drep.id) : null });
    }
    const pools = new Set<string>(((s.pools ?? []) as string[]).map((p) => p.toLowerCase()));
    const dreps = new Map<TypedCred, { deposit: bigint; validUntil: number }>();
    for (const d of (s.dreps ?? []) as any[]) dreps.set(typedCredOfCbor(d.credential), { deposit: BigInt(d.deposit ?? 0), validUntil: Number(d.valid_until ?? 0) });
    const committee = new Map<TypedCred, number>(), unelected: TypedCred[] = [];
    const committeeCreds = new Map<TypedCred, CommitteeCred>();
    for (const m of (s.committee ?? []) as any[]) {
        const cold = typedCredOfCbor(m.cold_credential);
        if (m.valid_until != null) committee.set(cold, Number(m.valid_until)); else unelected.push(cold);
        if (m.status === "resigned") committeeCreds.set(cold, { hot: null, resigned: true });
        else if (typeof m.status === "string" && m.status) committeeCreds.set(cold, { hot: typedCredOfCbor(m.status), resigned: false });
    }
    const proposals = new Map<string, ProposalView>();
    for (const [pid, kind, expires] of (s.proposals ?? []) as Array<[any, string, number]>) { const id = actionIdOf(pid); proposals.set(id, proposalViewOf(id, kind, Number(expires))); }
    if (unelected.length) proposals.set(UNELECTED_PROPOSAL_ID, { id: UNELECTED_PROPOSAL_ID, type: 4, prev: null, expiresAfter: Number.MAX_SAFE_INTEGER, ccAdd: unelected });
    const r = s.proposals_roots ?? {};
    const roots: Record<Purpose, string | null> = {
        pparams: r.protocol_parameters ? actionIdOf(r.protocol_parameters) : null, hardfork: r.hard_fork ? actionIdOf(r.hard_fork) : null,
        committee: r.constitutional_committee ? actionIdOf(r.constitutional_committee) : null, constitution: r.constitution ? actionIdOf(r.constitution) : null,
    };
    return {
        utxo, accounts, pools, dreps, committee, unelected, committeeCreds, proposals, roots,
        guardrail: s.guardrail_script ? String(s.guardrail_script).toLowerCase() : null,
        treasury: s.pots?.treasury != null ? BigInt(s.pots.treasury) : null,
    };
}

/** `GovLedgerView` over the fixture's state (exact: the fixture declares the whole state). */
export function govViewOf(s: FixtureState): GovLedgerView {
    return {
        accountRegistered: (c) => s.accounts.has(c),
        accountDeposit: (c) => s.accounts.get(c)?.deposit ?? null,
        accountBalance: (c) => s.accounts.get(c)?.reward ?? null,
        balancesExact: () => ({ exact: true, why: "" }),
        accountDRep: (c) => s.accounts.get(c)?.drep ?? null,
        poolRegistered: (p) => s.pools.has(p.toLowerCase()),
        poolVrf: () => null,
        registeredVrfs: () => null,
        drepRegistered: (c) => s.dreps.has(c),
        drepDeposit: (c) => s.dreps.get(c)?.deposit ?? null,
        committeeMembers: () => s.committee,
        committeeCreds: () => s.committeeCreds,
        proposals: () => s.proposals,
        roots: () => s.roots,
        constitutionScript: () => s.guardrail,
        treasury: () => s.treasury,
    };
}

/** `MempoolLedgerView` over the fixture's state: the tip one slot before the fixture's point. */
export function mempoolViewOf(f: NdcFixture, s: FixtureState): MempoolLedgerView {
    const raw = rawParamsOf(f.pparams);
    const slot = BigInt(f.point.slot);
    const params = bodyParamsOf(epochOfSlot(f.eraHistory, f.point.slot), raw);
    const gov = govViewOf(s);
    const network = networkIdOf(f.network) === 1 ? "mainnet" : "testnet";
    return {
        tip: async () => ({ slot: slot - 1n, hash: "00".repeat(32) }),
        state: async (at) => ({ slot: at, params, genesis: null, network }),
        resolve: async (refs) => { const m = new Map<string, ResolvedUtxo>(); for (const r of refs) { const u = s.utxo.get(r); if (u) m.set(r, u); } return m; },
        pools: async (ids) => new Set(ids.filter((p) => s.pools.has(p.toLowerCase()))),
        rewardBalances: async (creds) => (creds.length ? new Map(creds.map((c) => [c, s.accounts.get(c)?.reward ?? 0n])) : undefined),
        stake: async (creds) => {
            const registered = new Set<string>(), delegated = new Map<string, string>();
            for (const c of creds) {
                const a = s.accounts.get(typedOf(c.type, c.hex));
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

// ───────────────────────────── ApplyTxErr → constructor names ─────────────────────────────

/** Conway `ConwayLedgerPredFailure` and the rules under it, by wire tag (cardano-ledger-conway 1.22 / protocol 11 additions). */
const LEDGER = ["?", "ConwayUtxowFailure", "ConwayCertsFailure", "ConwayGovFailure", "ConwayWdrlNotDelegatedToDRep", "ConwayTreasuryValueMismatch", "ConwayTxRefScriptsSizeTooBig", "ConwayMempoolFailure", "ConwayWithdrawalsMissingAccounts", "ConwayIncompleteWithdrawals"];
const UTXOW = ["UtxoFailure", "InvalidWitnessesUTXOW", "MissingVKeyWitnessesUTXOW", "MissingScriptWitnessesUTXOW", "ScriptWitnessNotValidatingUTXOW", "MissingTxBodyMetadataHash", "MissingTxMetadata", "ConflictingMetadataHash", "InvalidMetadata", "ExtraneousScriptWitnessesUTXOW", "MissingRedeemers", "MissingRequiredDatums", "NotAllowedSupplementalDatums", "PPViewHashesDontMatch", "UnspendableUTxONoDatumHash", "ExtraRedeemers", "MalformedScriptWitnesses", "MalformedReferenceScripts", "ScriptIntegrityHashMismatch"];
const UTXO = ["UtxosFailure", "BadInputsUTxO", "OutsideValidityIntervalUTxO", "MaxTxSizeUTxO", "InputSetEmptyUTxO", "FeeTooSmallUTxO", "ValueNotConservedUTxO", "WrongNetwork", "WrongNetworkWithdrawal", "OutputTooSmallUTxO", "OutputBootAddrAttrsTooBig", "OutputTooBigUTxO", "InsufficientCollateral", "ScriptsNotPaidUTxO", "ExUnitsTooBigUTxO", "CollateralContainsNonADA", "WrongNetworkInTxBody", "OutsideForecast", "TooManyCollateralInputs", "NoCollateralInputs", "IncorrectTotalCollateralField", "BabbageOutputTooSmallUTxO", "BabbageNonDisjointRefInputs"];
const UTXOS = ["ValidationTagMismatch", "CollectErrors"];
const CERTS = ["WithdrawalsNotInRewardsCERTS", "CertFailure"];
const CERT = ["?", "DelegFailure", "PoolFailure", "GovCertFailure"];
const DELEG = ["?", "IncorrectDepositDELEG", "StakeKeyRegisteredDELEG", "StakeKeyNotRegisteredDELEG", "StakeKeyHasNonZeroRewardAccountBalanceDELEG", "DelegateeDRepNotRegisteredDELEG", "DelegateeStakePoolNotRegisteredDELEG", "DepositIncorrectDELEG", "RefundIncorrectDELEG"];
const POOL = ["StakePoolNotRegisteredOnKeyPOOL", "StakePoolRetirementWrongEpochPOOL", "WrongCertificateTypePOOL", "StakePoolCostTooLowPOOL", "WrongNetworkPOOL", "PoolMedataHashTooBig", "VRFKeyHashAlreadyRegistered"];
const GOVCERT = ["ConwayDRepAlreadyRegistered", "ConwayDRepNotRegistered", "ConwayDRepIncorrectDeposit", "ConwayCommitteeHasPreviouslyResigned", "ConwayDRepIncorrectRefund", "ConwayCommitteeIsUnknown"];
const GOV = ["GovActionsDoNotExist", "MalformedProposal", "ProposalProcedureNetworkIdMismatch", "TreasuryWithdrawalsNetworkIdMismatch", "ProposalDepositIncorrect", "DisallowedVoters", "ConflictingCommitteeUpdate", "ExpirationEpochTooSmall", "InvalidPrevGovActionId", "VotingOnExpiredGovAction", "ProposalCantFollow", "InvalidPolicyHash", "DisallowedProposalDuringBootstrap", "DisallowedVotesDuringBootstrap", "VotersDoNotExist", "ZeroTreasuryWithdrawals", "ProposalReturnAccountDoesNotExist", "TreasuryWithdrawalReturnAccountsDoNotExist", "UnelectedCommitteeVoters"];

/** One named predicate failure: the constructor, and (ValidationTagMismatch) which way round. */
export interface NamedFailure { name: string; description?: string; text?: string }

const tagOf = (o: CborObj | undefined): number | null => (o instanceof CborArray && o.array[0] instanceof CborUInt ? Number(o.array[0].num) : null);
const at = (o: CborObj, i: number): CborObj | undefined => (o instanceof CborArray ? o.array[i] : undefined);
const named = (table: string[], t: number | null, rule: string): string => (t != null && table[t] && table[t] !== "?" ? table[t]! : `${rule}#${t}`);

function utxosName(o: CborObj): NamedFailure {
    const t = tagOf(o);
    if (t === 0) {
        // ValidationTagMismatch isValid (PassedUnexpectedly | FailedUnexpectedly …)
        const desc = tagOf(at(o, 2));
        return { name: "ValidationTagMismatch", description: desc === 0 ? "PassedUnexpectedly" : desc === 1 ? "FailedUnexpectedly" : undefined };
    }
    return { name: named(UTXOS, t, "UTXOS") };
}
function utxoName(o: CborObj): NamedFailure { const t = tagOf(o); return t === 0 ? utxosName(at(o, 1)!) : { name: named(UTXO, t, "UTXO") }; }
function utxowName(o: CborObj): NamedFailure { const t = tagOf(o); return t === 0 ? utxoName(at(o, 1)!) : { name: named(UTXOW, t, "UTXOW") }; }
function certsName(o: CborObj): NamedFailure {
    const t = tagOf(o);
    if (t !== 1) return { name: named(CERTS, t, "CERTS") };
    const cert = at(o, 1)!, ct = tagOf(cert), inner = at(cert, 1)!;
    if (ct === 1) return { name: named(DELEG, tagOf(inner), "DELEG") };
    if (ct === 2) return { name: named(POOL, tagOf(inner), "POOL") };
    if (ct === 3) return { name: named(GOVCERT, tagOf(inner), "GOVCERT") };
    return { name: named(CERT, ct, "CERT") };
}

/** A `ConwayLedgerPredFailure` (one element of the ApplyTxErr list) as its innermost constructor name. */
export function ledgerFailureName(o: CborObj): NamedFailure {
    const t = tagOf(o);
    switch (t) {
        case 1: return utxowName(at(o, 1)!);
        case 2: return certsName(at(o, 1)!);
        case 3: return { name: named(GOV, tagOf(at(o, 1)), "GOV") };
        case 7: { const x = at(o, 1); const text = x instanceof CborText ? x.text : ""; return textFailureName(text) ?? { name: "ConwayMempoolFailure", text }; }
        default: return { name: named(LEDGER, t, "LEDGER") };
    }
}

/** Every predicate failure of a MsgRejectTx payload / an ApplyTxErr list, in wire order. */
export function applyTxErrNames(failures: readonly CborObj[]): NamedFailure[] {
    return failures.map(ledgerFailureName);
}

/** Decode `[listLen 1, [6, [failure…]]]` (the HFC-wrapped ApplyTxErr) or a bare failure list. */
export function applyTxErrBytesNames(bytes: Uint8Array): NamedFailure[] {
    let o: CborObj = Cbor.parse(bytes);
    if (o instanceof CborArray && o.array.length === 2 && o.array[0] instanceof CborUInt && Number(o.array[0].num) === 2) o = o.array[1]!; // MsgRejectTx
    if (o instanceof CborArray && o.array.length === 1 && o.array[0] instanceof CborArray && (o.array[0] as CborArray).array[0] instanceof CborUInt) o = o.array[0]!;
    if (o instanceof CborArray && o.array.length === 2 && o.array[0] instanceof CborUInt && o.array[1] instanceof CborArray) o = o.array[1]!; // [era, failures]
    if (!(o instanceof CborArray)) throw new Error("ApplyTxErr: expected a failure list");
    return applyTxErrNames(o.array);
}

// ───────────────────────────── text failures → constructor names ─────────────────────────────

/** Block-rule and governance failure texts (they start with, or carry, the constructor name). */
const TEXT_RULES: Array<[RegExp, string]> = [
    [/\b(?:GOV|GOVCERT|DELEG|POOL|LEDGER) ([A-Z][A-Za-z]+)/, "$1"],
    [/\b(BabbageNonDisjointRefInputs|BadInputsUTxO|OutputTooBigUTxO|OutputBootAddrAttrsTooBig|WrongNetworkWithdrawal|OutsideValidityIntervalUTxO|ConwayTxRefScriptsSizeTooBig|DijkstraTxRefScriptsSizeTooBig|MissingScriptWitnessesUTXOW|ExtraneousScriptWitnessesUTXOW|NotAllowedSupplementalDatums|MissingTxMetadata|MissingTxBodyMetadataHash|ConflictingMetadataHash|InvalidMetadata|MalformedScriptWitnesses|MalformedReferenceScripts|IncorrectTotalCollateralField|OutsideForecast|ConwayTreasuryValueMismatch|ConwayWdrlNotDelegatedToDRep|WithdrawalsNotInRewardsCERTS|ValidationTagMismatch|PPViewHashesDontMatch|ScriptIntegrityHashMismatch|MissingRedeemers|ExtraRedeemers|UnspendableUTxONoDatumHash|MissingRequiredDatums)\b/, "$1"],
    [/marked invalid \(phase-2\) but carries no redeemers/, "ValidationTagMismatch"],
    [/spends \d+ input\(s\) not in the UTxO set|collateral input .* not in the UTxO set/, "BadInputsUTxO"],
    [/value not conserved/, "ValueNotConservedUTxO"],
    [/^no inputs$|: no inputs$/, "InputSetEmptyUTxO"],
    [/fee \d+ below minimum|reference-script fee/, "FeeTooSmallUTxO"],
    [/below min UTxO|negative output quantity/, "BabbageOutputTooSmallUTxO"],
    [/tx size \d+ > max/, "MaxTxSizeUTxO"],
    [/output address on \w+, node is on/, "WrongNetwork"],
    [/tx body network .* ≠/, "WrongNetworkInTxBody"],
    [/missing vkey witness|missing bootstrap witness/, "MissingVKeyWitnessesUTXOW"],
    [/(?:vkey|bootstrap) witness .* has an invalid signature/, "InvalidWitnessesUTXOW"],
    [/script .* required but not provided/, "MissingScriptWitnessesUTXOW"],
    [/native script .* not satisfied/, "ScriptWitnessNotValidatingUTXOW"],
    [/execution (?:memory|steps) \d+ > max/, "ExUnitsTooBigUTxO"],
    [/Plutus scripts without collateral inputs/, "NoCollateralInputs"],
    [/collateral inputs > max/, "TooManyCollateralInputs"],
    [/collateral input .* is a script address/, "ScriptsNotPaidUTxO"],
    [/collateral carries non-ADA/, "CollateralContainsNonADA"],
    [/collateral -?\d+ < required/, "InsufficientCollateral"],
    [/carries no datum/, "UnspendableUTxONoDatumHash"],
    [/not in the witness set/, "MissingRequiredDatums"],
    [/Stake credential already registered/, "StakeKeyRegisteredDELEG"],
    [/Stake credential not registered|Cannot delegate unregistered stake credential/, "StakeKeyNotRegisteredDELEG"],
    [/withdrawal .*(?:not registered|unregistered)|no local reward balance/i, "WithdrawalsNotInRewardsCERTS"],
    [/withdraw(?:s|al)? .*(?:≠|differs from|does not drain|balance)/i, "WithdrawalsNotInRewardsCERTS"],
    [/All inputs are spent/, "ConwayMempoolFailure"],
];

/** The constructor a failure text names, when it names one. */
export function textFailureName(text: string): NamedFailure | null {
    // A mempool text carrying the block rules' failures names the first of them.
    const t = text.replace(/^Gerolamo block rules: /, "");
    for (const [re, rep] of TEXT_RULES) {
        const m = re.exec(t);
        if (m) return { name: rep.startsWith("$") ? m[Number(rep.slice(1))]! : rep, text };
    }
    return null;
}

export function blockFailureName(text: string): NamedFailure {
    return textFailureName(text.replace(/^tx\[\d+\](?:\.sub\[\d+\])?(?: [0-9a-f]{12}…)?: /, "")) ?? { name: "Unnamed", text };
}

// ───────────────────────────── the corpus vocabulary ─────────────────────────────

/**
 * Where the corpus names a cardano-ledger constructor differently (it drops the rule suffix or the
 * `Conway` prefix of some, and names a few after their meaning). Keys: cardano-ledger constructor;
 * values: the corpus name. Used only to compare and to report; the decoder speaks cardano-ledger.
 */
export const CORPUS_NAMES: Record<string, string> = {
    StakeKeyRegisteredDELEG: "StakeKeyRegistered",
    StakeKeyNotRegisteredDELEG: "StakeCredentialInvalidPoolDelegation",
    StakeKeyHasNonZeroRewardAccountBalanceDELEG: "StakeKeyHasNonZeroAccountBalance",
    StakeKeyHasNonZeroAccountBalanceDELEG: "StakeKeyHasNonZeroAccountBalance",
    DelegateeDRepNotRegisteredDELEG: "DelegateeDRepNotRegistered",
    DelegateeStakePoolNotRegisteredDELEG: "DelegateeStakePoolNotRegistered",
    ConwayDRepAlreadyRegistered: "DRepAlreadyRegistered",
    ConwayCommitteeHasPreviouslyResigned: "CommitteeHasPreviouslyResigned",
    ConwayCommitteeIsUnknown: "CommitteeIsUnknown",
    InvalidPolicyHash: "InvalidGuardrailsScriptHash",
    ZeroTreasuryWithdrawals: "TreasuryWithdrawalsAllZeros",
    WrongNetwork: "WrongNetworkInTxOutput",
    MissingVKeyWitnessesUTXOW: "MissingVerificationKeyWitnessesUTXOW",
    // Protocol 11: a committee hot key whose cold credential is not elected (cardano-ledger
    // `UnelectedCommitteeVoters`) is, for the corpus, a voter that does not exist.
    UnelectedCommitteeVoters: "VotersDoNotExist",
    // A Byron output address with attributes over 64 bytes (cardano-ledger `OutputBootAddrAttrsTooBig`):
    // the corpus files it under the output-size predicate.
    OutputBootAddrAttrsTooBig: "OutputTooBigUTxO",
};
export const corpusName = (n: string): string => CORPUS_NAMES[n] ?? n;

// ───────────────────────────── running one fixture ─────────────────────────────

export interface FixtureOutcome {
    id: string;
    expected: Expected;
    /** The bytes decode as a Conway transaction (mempool parse and the block decoder). */
    decoded: boolean;
    decodeError?: string;
    accepted: boolean;
    /** Named failures, mempool path first (wire order), then what only the block path reports. */
    failures: Array<NamedFailure & { path: "mempool" | "block" }>;
    /**
     * The report's `result`, the observed outcome in the corpus vocabulary: `pass` when the
     * transaction was accepted, `DecodingFailure` when the bytes do not decode, else the predicate
     * failure observed — the expected one when it is among the observed failures, otherwise the
     * first observed. The site compares it with the fixture's expectation; `conforms` is the same
     * comparison done here (stricter only in that a `description` must agree too).
     */
    result: string;
    conforms: boolean;
    /** Raw failure texts of both paths (diagnostics). */
    details: { mempool: string[]; block: string[]; reports: string[] };
}

/** The observed result for a transaction that was accepted / whose bytes do not decode. */
export const PASS = "pass";
export const DECODING_FAILURE = "DecodingFailure";

export async function runFixture(f: NdcFixture): Promise<FixtureOutcome> {
    return withFixtureGeometry(f, () => runFixtureInner(f));
}

async function runFixtureInner(f: NdcFixture): Promise<FixtureOutcome> {
    const txBytes = fromHex(f.txHex);
    const details = { mempool: [] as string[], block: [] as string[], reports: [] as string[] };
    const finish = (o: Omit<FixtureOutcome, "result" | "conforms" | "details" | "id" | "expected">): FixtureOutcome => {
        const { conforms, result } = judge(f.expected, o);
        return { id: f.id, expected: f.expected, ...o, result, conforms, details };
    };

    // Decoding: the mempool's parse (ledger-ts ConwayTx) and the block decoder must both take the bytes.
    let decodeError: string | null = null;
    try { parseMempoolTx(txBytes); } catch (e) { decodeError = (e as Error).message; }
    let parts: ReturnType<typeof txParts> | null = null;
    let block: any = null;
    if (!decodeError) {
        try { parts = txParts(txBytes); block = MultiEraBlock.fromCbor(oneTxConwayBlock(parts)); }
        catch (e) { decodeError = `block decoder: ${(e as Error).message}`; }
    }
    if (decodeError) return finish({ decoded: false, decodeError, accepted: false, failures: [] });

    const state = fixtureStateOf(f);
    const raw = rawParamsOf(f.pparams);
    const epoch = epochOfSlot(f.eraHistory, f.point.slot);
    const slot = BigInt(f.point.slot);
    const params = bodyParamsOf(epoch, raw);
    const networkId = networkIdOf(f.network);
    const failures: FixtureOutcome["failures"] = [];

    // 1. the mempool
    const mempool = new ValidatingMempool({ view: mempoolViewOf(f, state), rejectFailedPlutus: true, rejectUncheckedPlutus: true });
    const r = await mempool.addTx(txBytes, "ndc-ledger-rules");
    if (!r.ok) {
        details.mempool.push(...r.reasons);
        for (const n of applyTxErrNames(r.failures)) failures.push({ ...n, path: "mempool" });
    }

    // 2. the block path
    const body: any = block.block?.transactionBodies?.[0];
    const rewardBalances = new Map<string, bigint>(), stakeRegistered = new Map<string, boolean>(), drepDelegated = new Map<string, boolean>();
    for (const w of (body?.withdrawals?.map ?? []) as any[]) {
        const c = rewardAccountKey(w.rewardAccount);
        const a = state.accounts.get(c);
        if (a) rewardBalances.set(c, a.reward);
        stakeRegistered.set(c, !!a);
        drepDelegated.set(c, !!a?.drep);
    }
    const blockTexts: string[] = [];
    const br = await runBlockRulesJob({
        kind: "blockRules", block: oneTxConwayBlock(parts!), slot: slot.toString(), params, genesis: null, config: { network: "custom" },
        resolved: new Map(state.utxo), pools: new Set(state.pools), rewardBalances, drepDelegated, stakeRegistered, treasury: state.treasury,
        exactness: { exact: true, why: "" }, preVerified: null, phase: "both",
    } as any);
    if (!br.outcome) blockTexts.push(`block rules not evaluated: ${br.reason}`);
    else { blockTexts.push(...br.outcome.failures); details.reports.push(...br.outcome.reports); }
    const gov = await checkBlockGovernance({
        slot: Number(slot), epoch, bodies: [{ bytes: parts!.body, txId: toHex(blake2b_256(parts!.body)) }],
        invalid: new Set(parts!.isValid ? [] : [0]), raw, networkId, view: govViewOf(state),
    });
    blockTexts.push(...gov.failures); details.reports.push(...gov.reports);
    const certs: CertView[] = ((body?.certs ?? []) as any[]).map((c) => ({
        certType: Number(c.certType), credHex: c.stakeCredential ? toHex(c.stakeCredential.hash.toBuffer()) : null,
        credType: c.stakeCredential ? (Number(c.stakeCredential.type) === 1 ? 1 : 0) : null, poolHex: c.poolKeyHash ? toHex(c.poolKeyHash.toBuffer()) : null,
    }));
    if (certs.length && parts!.isValid) {
        const registered = new Set<string>(), delegated = new Map<string, string>();
        for (const [c, a] of state.accounts) {
            const key = credKey(c.length === 58 ? 1 : 0, c.length === 58 ? c.slice(2) : c);
            registered.add(key);
            if (a.pool) delegated.set(key, a.pool);
        }
        const v = checkCertificateSequence(certs, registered, delegated);
        if (!v.ok) blockTexts.push(`certificates: ${v.reason}`);
    }
    details.block.push(...blockTexts);
    const have = new Set(failures.map((x) => x.name));
    for (const t of blockTexts) {
        const n = blockFailureName(t);
        if (!have.has(n.name)) { have.add(n.name); failures.push({ ...n, path: "block" }); }
    }
    return finish({ decoded: true, accepted: failures.length === 0 && r.ok, failures });
}

/** The observed `result` (see FixtureOutcome) and whether it conforms to the fixture's expectation. */
export function judge(e: Expected, o: { decoded: boolean; accepted: boolean; failures: NamedFailure[] }): { conforms: boolean; result: string } {
    if (!o.decoded) return { conforms: e.kind === "decoding", result: DECODING_FAILURE };
    if (o.accepted) return { conforms: e.kind === "pass", result: PASS };
    if (e.kind === "fail") {
        const hit = o.failures.some((x) => corpusName(x.name) === e.predicate && (!e.description || !x.description || x.description === e.description));
        if (hit) return { conforms: true, result: e.predicate };
    }
    return { conforms: false, result: corpusName(o.failures[0]?.name ?? "Unnamed") };
}

// ───────────────────────────── the report ─────────────────────────────

/** scenarios/ledger-rules/schema.json; `implementation.version/commit`, `corpus` and `totals` are extras the schema leaves open. */
export interface LedgerRulesReport {
    version: "1";
    scenario: "ledger-rules";
    generated_at: string;
    implementation: { name: string; version: string; commit: string };
    corpus: string;
    totals: { passed: number; failed: number; total: number };
    scenarios: Array<{ id: string; result: string }>;
}

export function reportOf(outcomes: FixtureOutcome[], meta: { version: string; commit: string; corpus: string; generatedAt?: string }): LedgerRulesReport {
    const passed = outcomes.filter((o) => o.conforms).length;
    return {
        version: "1", scenario: "ledger-rules", generated_at: meta.generatedAt ?? new Date().toISOString(),
        implementation: { name: "gerolamo", version: meta.version, commit: meta.commit },
        corpus: meta.corpus,
        totals: { passed, failed: outcomes.length - passed, total: outcomes.length },
        scenarios: outcomes.map((o) => ({ id: o.id, result: o.result })),
    };
}

/** The `result` vocabulary of the scenario schema (the `oneOf` of constants), or null when the schema has none. */
export function ledgerResultEnum(schema: any): Set<string> | null {
    const alts = schema?.properties?.scenarios?.items?.properties?.result?.oneOf;
    if (!Array.isArray(alts)) return null;
    return new Set(alts.map((a: any) => a?.const).filter((c: unknown): c is string => typeof c === "string"));
}

/** Rows whose `result` the schema does not enumerate: an observed failure the corpus has no name for, to be looked at, never dropped. */
export function unknownResults(report: LedgerRulesReport, allowed: ReadonlySet<string>): Array<{ id: string; result: string }> {
    return report.scenarios.filter((s) => !allowed.has(s.result));
}

export async function runAll(fixtures: NdcFixture[], onEach?: (f: NdcFixture, o: FixtureOutcome) => void): Promise<FixtureOutcome[]> {
    const out: FixtureOutcome[] = [];
    for (const f of fixtures) {
        let o: FixtureOutcome;
        try { o = await runFixture(f); }
        catch (e) {
            const msg = (e as Error).message;
            o = { id: f.id, expected: f.expected, decoded: true, accepted: false, failures: [{ name: "HarnessError", text: msg, path: "block" }], result: "HarnessError", conforms: false, details: { mempool: [], block: [msg], reports: [] } };
        }
        out.push(o);
        onEach?.(f, o);
    }
    return out;
}
