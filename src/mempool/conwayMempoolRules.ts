/**
 * Mempool admission rules for a Conway transaction, in cardano-ledger's rule structure
 * (MEMPOOL → LEDGER → CERTS / UTXOW → UTXO → UTXOS) so a rejection carries the same predicate
 * failures, in the same order, as cardano-node's (`applyTxErr.ts` has the wire format).
 *
 * The verdict also runs the node's block rules on the same inputs — `evaluateTxRules`
 * (txRules.ts, which calls alonzoRules) and `checkCertificateSequence` (certificateRules.ts);
 * phase 2 (plutusEval) runs afterwards, off the main thread, in `ValidatingMempool`. A block-rule
 * failure the structured pass does not model is carried as a `ConwayMempoolFailure` text, so
 * no transaction the block rules reject is ever admitted.
 *
 * Checks, in execution order (source: cardano-ledger-conway 1.22.1.0 / babbage / alonzo rules):
 *   mempool measure: MaxTxSizeUTxO, ExUnitsTooBigUTxO, ConwayTxRefScriptsSizeTooBig (alone, first)
 *   MEMPOOL: "All inputs are spent…" (then nothing else)
 *   LEDGER:  ConwayTxRefScriptsSizeTooBig; CERTS (stake registration state)
 *   UTXOW:   ScriptWitnessNotValidating, Extraneous/MissingScriptWitnesses, UnspendableUTxONoDatumHash,
 *            MissingRequiredDatums, NotAllowedSupplementalDatums, ExtraRedeemers, InvalidWitnesses,
 *            MissingVKeyWitnesses, metadata hash, script integrity hash
 *   UTXO:    OutsideValidityInterval, InputSetEmpty, FeeTooSmall + collateral (ScriptsNotPaid,
 *            CollateralContainsNonADA, InsufficientCollateral, IncorrectTotalCollateralField,
 *            NoCollateralInputs), BadInputs, ValueNotConserved, BabbageOutputTooSmall, OutputTooBig,
 *            WrongNetwork, WrongNetworkWithdrawal, WrongNetworkInTxBody, MaxTxSize, ExUnitsTooBig,
 *            TooManyCollateralInputs
 * Not modelled (block rules still reject them, as a text failure): MissingRedeemers, GOV,
 * treasury value, withdrawal amounts/DRep delegation, OutsideForecast, bootstrap attribute size.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt, CborNegInt, type CborObj } from "@harmoniclabs/cbor";
import { Address, ByronAddress, CredentialType, Script } from "@harmoniclabs/cardano-ledger-ts";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { EpochBodyParams } from "../consensus/epochParams";
import { checkCertificateSequence, credKey, type CertView } from "../consensus/certificateRules";
import { ruleParams } from "../consensus/rules/blockRulesPure";
import { effectiveRedeemers } from "../consensus/rules/alonzoRules";
import { evalNativeScript, nativeScriptTreeOf } from "../consensus/rules/nativeScript";
import { parseStoredAddress, requiredWitnesses } from "../consensus/rules/requiredSigners";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import { costModelArrays, languageViews, scriptLanguageOfCbor, witnessDatumBytes, witnessScriptHashes, witnessSlices, type PlutusLanguage } from "../consensus/rules/scriptDataHash";
import { evaluateTxRules, tierRefScriptFee, type TxRuleParams } from "../consensus/rules/txRules";
import { addAll, addUnit, unitsEqual, unitsOf, type UnitMap } from "../consensus/rules/value";
import { toFraction } from "../network/n2c/pparamsCbor";
import {
    ALL_INPUTS_SPENT, CertsF, compareRewardAccounts, LedgerF, RuleRun, UtxoF, UtxowF, type TxOutParts,
} from "./applyTxErr";
import type { MempoolTx } from "./mempoolTx";

/** Conway `maxRefScriptSizePerTx` (a constant in cardano-ledger-conway, not a protocol parameter). */
export const MAX_REF_SCRIPT_SIZE_PER_TX = 200 * 1024;
/** Conway `maxRefScriptSizePerBlock`. */
export const MAX_REF_SCRIPT_SIZE_PER_BLOCK = 1024 * 1024;

/** The ledger state a transaction is validated against (the tip ticked to the next slot). */
export interface MempoolLedgerState {
    /** Tip slot + 1: cardano-node ticks the mempool's ledger state to the successor slot. */
    slot: bigint;
    params: EpochBodyParams;
    genesis: any;
    network: "mainnet" | "testnet";
}

/** What the transaction reads from the ledger (after earlier mempool transactions). */
export interface MempoolLookups {
    /** Every referenced input that exists (inputs, collateral, reference inputs). */
    resolved: Map<string, ResolvedUtxo>;
    pools: Set<string>;
    rewardBalances?: Map<string, bigint>;
    /** Stake credentials registered / delegated (keys: `credKey`), for the certificate sequence; null skips it. */
    stake?: { registered: Set<string>; delegated: Map<string, string> } | null;
}

/** Signature verdicts (computed once per transaction; a revalidation reuses them). */
export interface WitnessVerdict {
    /** Key hashes of vkey witnesses whose signature verified. */
    provenKeys: Set<string>;
    /** Byron roots proven by verified bootstrap witnesses. */
    provenRoots: Set<string>;
    /** Every vkey witness's key hash, verified or not (`witsVKeyHashes`), plus bootstrap witness roots. */
    allKeyHashes: Set<string>;
    /** Vkeys whose signature did not verify (InvalidWitnessesUTXOW), in key-hash order. */
    invalidVkeys: Uint8Array[];
}

export interface MempoolRuleOutcome {
    /** Predicate failures, MEMPOOL-ordered; empty = phase 1 passes. */
    failures: CborObj[];
    /** Human-readable failure reasons (logs, HTTP answers). */
    reasons: string[];
    reports: string[];
    /** Phase 2 must run (redeemers present and phase 1 clean). */
    runsPlutus: boolean;
    /** Block-rule failures the structured pass did not model (carried as text). */
    unmodelled: string[];
    /** Structured failures the block rules did not flag (monitoring: the two should agree). */
    structuredOnly: number;
}

const hexOf = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();
const fromHexStr = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** Address bytes and payment credential of a stored address. */
function addrInfo(address: string): { bytes: Uint8Array | null; network: number | null; payment: { script: boolean; hash: string } | null; byron: ByronAddress | null } {
    const a = parseStoredAddress(address);
    if (!a) return { bytes: null, network: null, payment: null, byron: null };
    if (a instanceof ByronAddress) {
        let bytes: Uint8Array | null = null;
        try { bytes = (a as any).toCborBytes(); } catch { bytes = null; }
        return { bytes, network: null, payment: null, byron: a };
    }
    const pc: any = (a as Address).paymentCreds;
    const script = pc?.type === CredentialType.Script || pc?.type === "script" || pc?.type === 1;
    return { bytes: (a as Address).toBuffer(), network: (a as Address).network === "mainnet" ? 1 : 0, payment: { script, hash: hexOf(pc?.hash) }, byron: null };
}

/** A resolved UTxO as a ledger TxOut (for failures that carry UTxO entries). */
export function resolvedTxOut(u: ResolvedUtxo): TxOutParts {
    const info = addrInfo(u.address);
    return {
        address: info.bytes ?? new Uint8Array(0),
        value: u.value,
        datumHash: u.inlineDatumCbor ? null : u.datumHash ?? null,
        inlineDatumCbor: u.inlineDatumCbor ? fromHexStr(u.inlineDatumCbor) : null,
        scriptRefCbor: u.referenceScriptCbor ? fromHexStr(u.referenceScriptCbor) : null,
    };
}

function valueFromCbor(v: CborObj | undefined): UnitMap {
    const m: UnitMap = new Map();
    if (v instanceof CborUInt) { m.set("lovelace", v.num); return m; }
    if (v instanceof CborArray) {
        const coin = v.array[0];
        if (coin instanceof CborUInt) m.set("lovelace", coin.num);
        const ma = v.array[1];
        if (ma instanceof CborMap) {
            for (const { k: p, v: names } of ma.map) {
                if (!(p instanceof CborBytes) || !(names instanceof CborMap)) continue;
                for (const { k: n, v: q } of names.map) {
                    if (!(n instanceof CborBytes)) continue;
                    const qty = q instanceof CborUInt ? q.num : q instanceof CborNegInt ? q.num : 0n;
                    if (qty !== 0n) addUnit(m, toHex(p.bytes) + toHex(n.bytes), qty);
                }
            }
        }
    }
    return m;
}

/** A transaction output (original bytes) as ledger TxOut parts. */
export function txOutPartsFromBytes(slice: Uint8Array): TxOutParts {
    const o = Cbor.parse(slice);
    if (o instanceof CborArray) {
        const addr = o.array[0] instanceof CborBytes ? (o.array[0] as CborBytes).bytes : new Uint8Array(0);
        const dh = o.array[2] instanceof CborBytes ? toHex((o.array[2] as CborBytes).bytes) : null;
        return { address: addr, value: valueFromCbor(o.array[1]), datumHash: dh };
    }
    const parts: TxOutParts = { address: new Uint8Array(0), value: new Map() };
    if (o instanceof CborMap) {
        for (const { k, v } of o.map) {
            if (!(k instanceof CborUInt)) continue;
            const key = Number(k.num);
            if (key === 0 && v instanceof CborBytes) parts.address = v.bytes;
            else if (key === 1) parts.value = valueFromCbor(v);
            else if (key === 2 && v instanceof CborArray) {
                const kind = v.array[0] instanceof CborUInt ? Number((v.array[0] as CborUInt).num) : -1;
                const d = v.array[1];
                if (kind === 0 && d instanceof CborBytes) parts.datumHash = toHex(d.bytes);
                else if (kind === 1 && d instanceof CborTag && d.data instanceof CborBytes) parts.inlineDatumCbor = d.data.bytes;
            } else if (key === 3 && v instanceof CborTag && v.data instanceof CborBytes) parts.scriptRefCbor = v.data.bytes;
        }
    }
    return parts;
}

/** `originalBytesSize` of a reference script: the Plutus binary, or the timelock's bytes. */
export function refScriptSize(scriptCborHex: string): number {
    try {
        const bytes = fromHexStr(scriptCborHex);
        const arr = Cbor.parse(bytes);
        if (!(arr instanceof CborArray)) return bytes.length;
        const lang = arr.array[0] instanceof CborUInt ? Number((arr.array[0] as CborUInt).num) : -1;
        const payload = arr.array[1];
        if (lang >= 1 && payload instanceof CborBytes) return payload.bytes.length;
        if (lang === 0 && payload) return Cbor.encode(payload).toBuffer().length;
        return bytes.length;
    } catch {
        return scriptCborHex.length / 2;
    }
}

/** Non-distinct reference-script bytes over inputs ∪ reference inputs (a TxIn in both counts once). */
export function txRefScriptBytes(tx: MempoolTx, resolved: Map<string, ResolvedUtxo>): number {
    let total = 0;
    for (const r of new Set([...tx.refInputs, ...tx.inputs])) {
        const u = resolved.get(r);
        if (u?.referenceScriptCbor) total += refScriptSize(u.referenceScriptCbor);
    }
    return total;
}

export function totalExUnits(tx: MempoolTx): { mem: bigint; steps: bigint } {
    let mem = 0n, steps = 0n;
    for (const r of effectiveRedeemers((tx.witnessSet?.redeemers ?? []) as any[], 7)) {
        mem += BigInt(r.execUnits?.mem ?? r.exUnits?.mem ?? 0);
        steps += BigInt(r.execUnits?.steps ?? r.exUnits?.steps ?? r.execUnits?.cpu ?? 0);
    }
    return { mem, steps };
}

const big = (v: unknown, d: bigint): bigint => { try { return v == null ? d : BigInt(String(v)); } catch { return d; } };

/** Conway minimum fee: size·a + b + ⌈prices·exUnits⌉ + tiered reference-script fee (exact rationals). */
export function conwayMinFee(tx: MempoolTx, resolved: Map<string, ResolvedUtxo>, raw: Record<string, unknown>, p: TxRuleParams): bigint {
    let fee = p.minFeeA * BigInt(tx.size) + p.minFeeB;
    const { mem, steps } = totalExUnits(tx);
    if ((mem > 0n || steps > 0n) && raw.price_mem != null && raw.price_step != null) {
        const [mn, md] = toFraction(raw.price_mem), [sn, sd] = toFraction(raw.price_step);
        const num = mem * mn * sd + steps * sn * md, den = md * sd;
        fee += (num + den - 1n) / den;
    }
    const refBytes = txRefScriptBytes(tx, resolved);
    if (refBytes > 0 && p.minFeeRefScriptCostPerByte != null) fee += tierRefScriptFee(refBytes, p.minFeeRefScriptCostPerByte);
    return fee;
}

/** The mempool's own measure checks (cardano-node `txMeasure`): each fails alone, before the ledger rules run. */
export function mempoolMeasureFailure(tx: MempoolTx, resolved: Map<string, ResolvedUtxo>, params: EpochBodyParams): { failure: CborObj; reason: string } | null {
    const raw = params.raw ?? {};
    const max = BigInt(params.maxTxSize);
    if (BigInt(tx.size) > max) return { failure: LedgerF.utxow(UtxowF.utxo(UtxoF.maxTxSize(BigInt(tx.size), max))), reason: `tx size ${tx.size} > max ${max}` };
    const { mem, steps } = totalExUnits(tx);
    const maxMem = big(raw.max_tx_ex_mem, -1n), maxSteps = big(raw.max_tx_ex_steps, -1n);
    if (maxMem >= 0n && maxSteps >= 0n && (mem > maxMem || steps > maxSteps)) {
        return { failure: LedgerF.utxow(UtxowF.utxo(UtxoF.exUnitsTooBig([maxMem, maxSteps], [mem, steps]))), reason: `execution units (${mem}, ${steps}) > max (${maxMem}, ${maxSteps})` };
    }
    const refBytes = txRefScriptBytes(tx, resolved);
    if (refBytes > MAX_REF_SCRIPT_SIZE_PER_TX) return { failure: LedgerF.txRefScriptsSizeTooBig(refBytes, MAX_REF_SCRIPT_SIZE_PER_TX), reason: `reference scripts ${refBytes} B > max ${MAX_REF_SCRIPT_SIZE_PER_TX}` };
    return null;
}

function scriptCredOf(cred: any): { script: boolean; hash: string } | null {
    if (!cred) return null;
    const script = cred.type === CredentialType.Script || cred.type === 1 || cred.type === "script";
    const h = hexOf(cred.hash ?? cred);
    return h ? { script, hash: h } : null;
}

function certViews(body: any): CertView[] {
    return ((body.certs ?? []) as any[]).map((c) => {
        const cred = c.stakeCredential;
        const h = cred ? hexOf(cred.hash) : null;
        return { certType: Number(c.certType), credHex: h || null, credType: cred ? (scriptCredOf(cred)?.script ? 1 : 0) : null, poolHex: c.poolKeyHash ? hexOf(c.poolKeyHash) : null };
    });
}

/** Witness scripts (by hash over the bytes as carried) and reference scripts visible to the transaction. */
interface ScriptsProvided {
    witness: Map<string, { kind: "native" | "plutus"; language: PlutusLanguage | null; native: any | null }>;
    refs: Map<string, { kind: "native" | "plutus"; language: PlutusLanguage | null; native: any | null }>;
}
function scriptsProvided(tx: MempoolTx, resolved: Map<string, ResolvedUtxo>): ScriptsProvided {
    const witness: ScriptsProvided["witness"] = new Map();
    for (const [h, w] of witnessScriptHashes(tx.witnessSetBytes)) {
        let native: any = null;
        if (w.kind === "native") native = ((tx.witnessSet?.nativeScripts ?? []) as any[]).find((n) => hexOf(n.hash) === h) ?? (() => { try { return Script.fromCbor(Cbor.encode(new CborArray([new CborUInt(0), Cbor.parse(w.bytes)])).toBuffer()); } catch { return null; } })();
        witness.set(h, { kind: w.kind, language: w.language, native });
    }
    const refs: ScriptsProvided["refs"] = new Map();
    for (const r of new Set([...tx.refInputs, ...tx.inputs])) {
        const u = resolved.get(r);
        if (!u?.referenceScriptHash || !u.referenceScriptCbor) continue;
        const lang = scriptLanguageOfCbor(u.referenceScriptCbor);
        const isNative = lang === null && u.referenceScriptCbor.startsWith("8200");
        let native: any = null;
        if (isNative) { try { native = Script.fromCbor(u.referenceScriptCbor); } catch { native = null; } }
        refs.set(u.referenceScriptHash.toLowerCase(), { kind: isNative ? "native" : "plutus", language: lang, native });
    }
    return { witness, refs };
}

/** Plutus script purposes the transaction needs, as `[tag, index]` redeemer pointers, with the script hash. */
function neededPlutusPurposes(tx: MempoolTx, resolved: Map<string, ResolvedUtxo>, isPlutus: (h: string) => boolean): Array<{ tag: number; index: number; hash: string }> {
    const out: Array<{ tag: number; index: number; hash: string }> = [];
    const body = tx.body;
    [...tx.inputs].sort((a, b) => { const [ta, ia] = a.split(":"), [tb, ib] = b.split(":"); return ta! < tb! ? -1 : ta! > tb! ? 1 : Number(ia) - Number(ib); }).forEach((ref, i) => {
        const u = resolved.get(ref);
        const pc = u ? addrInfo(u.address).payment : null;
        if (pc?.script && isPlutus(pc.hash)) out.push({ tag: 0, index: i, hash: pc.hash });
    });
    ((body.mint?.map ?? []) as any[]).map((e) => hexOf(e.policy)).filter(Boolean).sort().forEach((p, i) => { if (isPlutus(p)) out.push({ tag: 1, index: i, hash: p }); });
    const NO_WITNESS = new Set([0, 3, 4, 5, 6]);
    ((body.certs ?? []) as any[]).forEach((c, i) => {
        if (NO_WITNESS.has(Number(c.certType))) return;
        const sc = scriptCredOf(c.stakeCredential ?? c.drepCredential ?? c.coldCredential);
        if (sc?.script && isPlutus(sc.hash)) out.push({ tag: 2, index: i, hash: sc.hash });
    });
    // Rewarding purposes index the withdrawals map, which is ordered by reward account.
    [...tx.withdrawals].sort((a, b) => compareRewardAccounts(a.account, b.account)).forEach((w, i) => {
        if (w.credType === 1 && isPlutus(w.credHex)) out.push({ tag: 3, index: i, hash: w.credHex });
    });
    // Voting purposes index the voters map: committee, then DRep, then pool voters; script
    // credentials before key hashes (Credential's constructor order), then by hash.
    const voters = votersInLedgerOrder(body);
    voters.forEach((v, i) => { if (v.script && isPlutus(v.hash)) out.push({ tag: 4, index: i, hash: v.hash }); });
    // Proposing purposes: a proposal guarded by the constitution's policy script.
    ((body.proposalProcedures ?? []) as any[]).forEach((pp, i) => {
        const h = hexOf(pp?.govAction?.policyHash);
        if (h && isPlutus(h)) out.push({ tag: 5, index: i, hash: h });
    });
    return out;
}

/** The voters of `voting_procedures` in the ledger's `Map Voter` order. */
function votersInLedgerOrder(body: any): Array<{ group: number; script: boolean; hash: string }> {
    const vs: Array<{ group: number; script: boolean; hash: string }> = [];
    for (const e of (body.votingProcedures?.procedures ?? []) as any[]) {
        const kind = Number(e?.voter?.kind);
        const hash = hexOf(e?.voter?.hash);
        if (!hash || !Number.isFinite(kind)) continue;
        vs.push({ group: kind <= 1 ? 0 : kind <= 3 ? 1 : 2, script: kind === 1 || kind === 3, hash });
    }
    vs.sort((a, b) => a.group - b.group || (a.script === b.script ? 0 : a.script ? -1 : 1) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return vs;
}

/** Script hashes the ledger needs beyond `requiredWitnesses`: proposal policies (guardrail script). */
function proposalPolicyHashes(body: any): string[] {
    return ((body.proposalProcedures ?? []) as any[]).map((pp) => hexOf(pp?.govAction?.policyHash)).filter(Boolean);
}

/** Metadata well-formedness (pv > 2): no text or byte string longer than 64 bytes. */
function metadataValid(aux: Uint8Array): boolean {
    const walk = (o: CborObj, depth: number): boolean => {
        if (depth > 64) return true;
        if (o instanceof CborBytes) return o.bytes.length <= 64;
        if ((o as any).text !== undefined && typeof (o as any).text === "string") return Buffer.byteLength((o as any).text, "utf8") <= 64;
        if (o instanceof CborArray) return o.array.every((x) => walk(x, depth + 1));
        if (o instanceof CborMap) return o.map.every(({ k, v }) => walk(k, depth + 1) && walk(v, depth + 1));
        if (o instanceof CborTag) return walk(o.data, depth + 1);
        return true;
    };
    try {
        const root = Cbor.parse(aux);
        // Shelley form: the metadata map itself; Allegra: [metadata, scripts]; Alonzo+: tag 259 {0: metadata, …}
        let md: CborObj | undefined = root;
        if (root instanceof CborArray) md = root.array[0];
        else if (root instanceof CborTag && root.data instanceof CborMap) md = root.data.map.find((e) => e.k instanceof CborUInt && Number((e.k as CborUInt).num) === 0)?.v;
        if (!(md instanceof CborMap)) return true;
        return md.map.every(({ v }) => walk(v, 0));
    } catch {
        return true;
    }
}

/**
 * Phase 1 of mempool admission. `resolved` must already reflect earlier mempool transactions
 * (their spent inputs removed, their outputs added).
 */
export function evaluateMempoolPhase1(tx: MempoolTx, state: MempoolLedgerState, look: MempoolLookups, wits: WitnessVerdict): MempoolRuleOutcome {
    const reasons: string[] = [];
    const out: MempoolRuleOutcome = { failures: [], reasons, reports: [], runsPlutus: false, unmodelled: [], structuredOnly: 0 };
    const { resolved } = look;
    const raw = state.params.raw ?? {};
    const p = ruleParams(state.params, state.genesis, 7, state.network);
    const pv = Number(state.params.protocolMajor ?? raw.protocol_major_ver ?? 0);
    const netId = state.network === "mainnet" ? 1 : 0;
    const body = tx.body;

    const measure = mempoolMeasureFailure(tx, resolved, state.params);
    if (measure) { out.failures = [measure.failure]; reasons.push(measure.reason); return out; }

    const mempool = new RuleRun();
    // MEMPOOL: a transaction none of whose inputs is unspent is probably already on chain.
    if (!tx.inputs.some((r) => resolved.has(r))) {
        mempool.fail(LedgerF.mempoolFailure(ALL_INPUTS_SPENT));
        out.failures = [...mempool.failures];
        reasons.push("all inputs are spent (already included?)");
        return out;
    }

    const ledger = new RuleRun();
    const refBytes = txRefScriptBytes(tx, resolved);
    if (refBytes > MAX_REF_SCRIPT_SIZE_PER_TX) { ledger.fail(LedgerF.txRefScriptsSizeTooBig(refBytes, MAX_REF_SCRIPT_SIZE_PER_TX)); reasons.push(`reference scripts ${refBytes} B > max`); }

    // Withdrawals (Conway LEDGER, protocol 10+): a key-hash reward account must be delegated to a
    // DRep, and (11+) must exist. Only unregistered accounts are judged here — an unregistered
    // account is certainly neither; DRep delegation and exact balances of registered accounts are
    // left to the block rules.
    const missingAccounts = look.stake ? tx.withdrawals.filter((w) => !look.stake!.registered.has(credKey(w.credType, w.credHex))) : [];
    if (pv >= 10 && missingAccounts.some((w) => w.credType === 0)) {
        ledger.fail(LedgerF.wdrlNotDelegatedToDRep(missingAccounts.filter((w) => w.credType === 0).map((w) => w.credHex)));
        reasons.push("withdrawal from a key account not delegated to a DRep");
    }
    if (pv >= 11 && missingAccounts.length) {
        ledger.fail(LedgerF.withdrawalsMissingAccounts(missingAccounts.map((w) => ({ account: w.account, amount: w.amount }))));
        reasons.push(`withdrawal from ${missingAccounts.length} unregistered reward account(s)`);
    }

    // CERTS: the certificate sequence against the registration state (certificateRules.ts);
    // before protocol 11 the withdrawal accounts are checked here (WithdrawalsNotInRewardsCERTS).
    const certsRun = new RuleRun(LedgerF.certs);
    if (look.stake && (body.certs ?? []).length) {
        const views = certViews(body);
        const verdict = checkCertificateSequence(views, new Set(look.stake.registered), new Map(look.stake.delegated));
        if (!verdict.ok) {
            const certs = certsRun;
            const m = /(already registered|not registered|unregistered)[^:]*: (\d):([0-9a-f]+)/.exec(verdict.reason);
            if (m) certs.fail(CertsF.deleg(m[1] === "already registered" ? CertsF.stakeKeyRegistered(Number(m[2]), m[3]!) : CertsF.stakeKeyNotRegistered(Number(m[2]), m[3]!)));
            else ledger.fail(LedgerF.mempoolFailure(verdict.reason));
            reasons.push(verdict.reason);
        }
    }
    if (pv < 11 && missingAccounts.length) {
        certsRun.fail(CertsF.withdrawalsNotInRewards(missingAccounts.map((w) => ({ account: w.account, amount: w.amount }))));
        reasons.push(`withdrawal from ${missingAccounts.length} unregistered reward account(s)`);
    }
    ledger.sub(certsRun);

    // ── UTXOW
    const utxow = new RuleRun(LedgerF.utxow);
    const req = requiredWitnesses(body, resolved);
    for (const h of proposalPolicyHashes(body)) req.scriptHashes.add(h);
    const provided = scriptsProvided(tx, resolved);
    const allProvided = new Map([...provided.refs, ...provided.witness]);
    const timelockCtx = { signers: wits.allKeyHashes, validFrom: body.validityIntervalStart != null ? BigInt(body.validityIntervalStart) : null, validTo: body.ttl != null ? BigInt(body.ttl) : null };
    const failedNative: string[] = [];
    for (const [h, s] of allProvided) {
        if (s.kind !== "native" || !req.scriptHashes.has(h)) continue;
        const tree = nativeScriptTreeOf(s.native);
        if (tree && !evalNativeScript(tree, timelockCtx)) failedNative.push(h);
    }
    if (failedNative.length) { utxow.fail(UtxowF.scriptWitnessNotValidating(failedNative)); reasons.push(`native script(s) not satisfied: ${failedNative.map((h) => h.slice(0, 12)).join(", ")}`); }
    const sRefs = new Set(provided.refs.keys()), sReceived = new Set(provided.witness.keys());
    const neededNonRefs = new Set([...req.scriptHashes].filter((h) => !sRefs.has(h)));
    const extraScripts = [...sReceived].filter((h) => !neededNonRefs.has(h));
    const missingScripts = [...neededNonRefs].filter((h) => !sReceived.has(h));
    {
        const errs: CborObj[] = [];
        if (extraScripts.length) { errs.push(UtxowF.extraneousScriptWitnesses(extraScripts)); reasons.push(`extraneous script witness(es) ${extraScripts.map((h) => h.slice(0, 12)).join(", ")}`); }
        if (missingScripts.length) { errs.push(UtxowF.missingScriptWitnesses(missingScripts)); reasons.push(`missing script witness(es) ${missingScripts.map((h) => h.slice(0, 12)).join(", ")}`); }
        utxow.fail(...errs);
    }
    // datums
    const isPlutus = (h: string) => allProvided.get(h)?.kind === "plutus";
    const witnessDatumHashes = new Set((witnessDatumBytes(tx.witnessSetBytes) ?? []).map((b) => toHex(blake2b_256(b))));
    {
        const inputHashes = new Set<string>();
        const noDatum: string[] = [];
        for (const ref of tx.inputs) {
            const u = resolved.get(ref);
            const pc = u ? addrInfo(u.address).payment : null;
            if (!u || !pc?.script || !isPlutus(pc.hash)) continue;
            if (u.inlineDatumCbor) continue;
            if (u.datumHash) inputHashes.add(u.datumHash.toLowerCase());
            else if (allProvided.get(pc.hash)?.language !== 3) noDatum.push(ref);
        }
        const allowed = new Set<string>();
        for (const s of tx.outputSlices) { const dh = txOutPartsFromBytes(s).datumHash; if (dh) allowed.add(dh); }
        for (const r of tx.refInputs) { const dh = resolved.get(r)?.datumHash; if (dh && !resolved.get(r)?.inlineDatumCbor) allowed.add(dh.toLowerCase()); }
        const unmatched = [...inputHashes].filter((h) => !witnessDatumHashes.has(h));
        const supplemental = [...witnessDatumHashes].filter((h) => !inputHashes.has(h));
        const notOk = supplemental.filter((h) => !allowed.has(h)), ok = supplemental.filter((h) => allowed.has(h));
        const errs: CborObj[] = [];
        if (noDatum.length) { errs.push(UtxowF.unspendableUtxoNoDatumHash(noDatum)); reasons.push(`script input(s) without datum: ${noDatum.join(", ")}`); }
        if (unmatched.length) { errs.push(UtxowF.missingRequiredDatums(unmatched, witnessDatumHashes)); reasons.push(`missing datum(s) ${unmatched.map((h) => h.slice(0, 12)).join(", ")}`); }
        if (notOk.length) { errs.push(UtxowF.notAllowedSupplementalDatums(notOk, ok)); reasons.push(`supplemental datum(s) not allowed ${notOk.map((h) => h.slice(0, 12)).join(", ")}`); }
        utxow.fail(...errs);
    }
    // redeemers: extra ones (missing ones are left to the block rules' text)
    const redeemers = effectiveRedeemers((tx.witnessSet?.redeemers ?? []) as any[], 7);
    const needed = neededPlutusPurposes(tx, resolved, isPlutus);
    {
        const neededKeys = new Set(needed.map((n) => `${n.tag}:${n.index}`));
        const extra = redeemers.map((r) => [Number(r.tag), Number(r.index)] as [number, number]).filter(([t, i]) => !neededKeys.has(`${t}:${i}`)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        if (extra.length) { utxow.fail(UtxowF.extraRedeemers(extra)); reasons.push(`extra redeemer(s) ${extra.map(([t, i]) => `${t}:${i}`).join(", ")}`); }
    }
    if (wits.invalidVkeys.length) { utxow.fail(UtxowF.invalidWitnesses(wits.invalidVkeys)); reasons.push(`${wits.invalidVkeys.length} invalid vkey witness signature(s)`); }
    const neededKeys = new Set([...req.keyHashes, ...req.bootstrapRoots]);
    const missingKeys = [...neededKeys].filter((k) => !wits.allKeyHashes.has(k));
    if (missingKeys.length) { utxow.fail(UtxowF.missingVKeyWitnesses(missingKeys)); reasons.push(`missing vkey witness(es) ${missingKeys.map((k) => k.slice(0, 12)).join(", ")}`); }
    // metadata
    if (tx.auxDataHash && !tx.auxBytes) { utxow.fail(UtxowF.missingTxMetadata(tx.auxDataHash)); reasons.push("auxiliary data hash without auxiliary data"); }
    else if (!tx.auxDataHash && tx.auxBytes) { const h = toHex(blake2b_256(tx.auxBytes)); utxow.fail(UtxowF.missingTxBodyMetadataHash(h)); reasons.push("auxiliary data without its hash in the body"); }
    else if (tx.auxDataHash && tx.auxBytes) {
        const h = toHex(blake2b_256(tx.auxBytes));
        if (h !== tx.auxDataHash) { utxow.fail(UtxowF.conflictingMetadataHash(tx.auxDataHash, h)); reasons.push("auxiliary data hash mismatch"); }
        else if (pv > 2 && !metadataValid(tx.auxBytes)) { utxow.fail(sumInvalidMetadata()); reasons.push("metadata string longer than 64 bytes"); }
    }
    // script integrity
    {
        const { redeemers: rBytes, datums: dBytes } = witnessSlices(tx.witnessSetBytes);
        const empty = (b: Uint8Array | null) => !b || b.length === 0 || (b.length === 1 && (b[0] === 0x80 || b[0] === 0xa0)) || (b.length === 2 && (b[0] === 0x9f || b[0] === 0xbf) && b[1] === 0xff);
        let expected: string | null = null, preimage: Uint8Array | null = null, computable = true;
        if (!(empty(rBytes) && empty(dBytes))) {
            const langs = new Set<PlutusLanguage>();
            for (const n of needed) { const l = allProvided.get(n.hash)?.language; if (l) langs.add(l); }
            const views = languageViews(costModelArrays(raw as any), langs);
            if (!views) computable = false;
            else {
                const r = empty(rBytes) ? new Uint8Array([0xa0]) : rBytes!;
                const d = empty(dBytes) ? new Uint8Array(0) : dBytes!;
                preimage = new Uint8Array(r.length + d.length + views.length);
                preimage.set(r, 0); preimage.set(d, r.length); preimage.set(views, r.length + d.length);
                expected = toHex(blake2b_256(preimage));
            }
        }
        if (computable && expected !== tx.scriptDataHash) {
            utxow.fail(pv >= 11 ? UtxowF.scriptIntegrityHashMismatch(tx.scriptDataHash, expected, preimage) : ppViewHashesDontMatch(tx.scriptDataHash, expected));
            reasons.push(`script integrity hash ${tx.scriptDataHash?.slice(0, 12) ?? "absent"} ≠ expected ${expected?.slice(0, 12) ?? "none"}`);
        }
    }

    // ── UTXO
    const utxo = new RuleRun(UtxowF.utxo);
    const slot = state.slot;
    // protocol 9–10 only: an input may not also be a reference input
    if (pv >= 9 && pv < 11) {
        const common = tx.inputs.filter((r) => tx.refInputs.includes(r));
        if (common.length) { utxo.fail(UtxoF.nonDisjointRefInputs(common)); reasons.push("input also used as reference input"); }
    }
    const start = body.validityIntervalStart != null ? BigInt(body.validityIntervalStart) : null;
    const ttl = body.ttl != null ? BigInt(body.ttl) : null;
    if ((start != null && slot < start) || (ttl != null && slot >= ttl)) { utxo.fail(UtxoF.outsideValidityInterval(start, ttl, slot)); reasons.push(`outside validity interval [${start ?? "-"}, ${ttl ?? "-"}) at slot ${slot}`); }
    if (tx.inputs.length === 0) { utxo.fail(UtxoF.inputSetEmpty()); reasons.push("no inputs"); }
    const fee = BigInt(body.fee ?? 0);
    {
        const errs: CborObj[] = [];
        const minFee = conwayMinFee(tx, resolved, raw, p);
        if (fee < minFee) { errs.push(UtxoF.feeTooSmall(minFee, fee)); reasons.push(`fee ${fee} < minimum ${minFee}`); }
        if (redeemers.length) {
            const coll = tx.collateral.filter((r) => resolved.has(r));
            const notPaid = coll.filter((r) => addrInfo(resolved.get(r)!.address).payment?.script);
            if (notPaid.length) { errs.push(UtxoF.scriptsNotPaid(notPaid.map((ref) => ({ ref, out: resolvedTxOut(resolved.get(ref)!) })))); reasons.push("collateral locked by a script"); }
            const collBalance: UnitMap = new Map();
            for (const r of coll) addAll(collBalance, resolved.get(r)!.value);
            const ret = tx.collateralReturnSlice ? txOutPartsFromBytes(tx.collateralReturnSlice) : null;
            const adaOnly = (m: UnitMap) => [...m].every(([u, q]) => u === "lovelace" || q === 0n);
            const net: UnitMap = new Map(collBalance);
            if (ret) addAll(net, ret.value, -1n);
            if (!((adaOnly(collBalance) && (!ret || adaOnly(ret.value))) || adaOnly(net))) {
                errs.push(UtxoF.collateralContainsNonAda(ret && adaOnly(collBalance) ? ret.value : collBalance));
                reasons.push("collateral carries non-ADA assets");
            }
            const bal = (collBalance.get("lovelace") ?? 0n) - (ret?.value.get("lovelace") ?? 0n);
            const pct = BigInt(p.collateralPercent);
            if (100n * bal < pct * fee) { const need = (pct * fee + 99n) / 100n; errs.push(UtxoF.insufficientCollateral(bal, need)); reasons.push(`collateral ${bal} < required ${need}`); }
            if (tx.totalCollateral != null && tx.totalCollateral !== bal) { errs.push(UtxoF.incorrectTotalCollateral(bal, tx.totalCollateral)); reasons.push(`total collateral ${tx.totalCollateral} ≠ ${bal}`); }
            if (coll.length === 0) { errs.push(UtxoF.noCollateralInputs()); reasons.push("no collateral inputs"); }
        }
        utxo.fail(...errs);
    }
    const bad = [...new Set([...tx.inputs, ...tx.collateral, ...tx.refInputs])].filter((r) => !resolved.has(r));
    if (bad.length) { utxo.fail(UtxoF.badInputs(bad)); reasons.push(`input(s) not in the UTxO set: ${bad.slice(0, 3).join(", ")}`); }
    {
        const consumed: UnitMap = new Map(), produced: UnitMap = new Map();
        for (const r of tx.inputs) { const u = resolved.get(r); if (u) addAll(consumed, u.value); }
        for (const w of (body.withdrawals?.map ?? []) as any[]) addUnit(consumed, "lovelace", BigInt(w.amount ?? 0));
        if (body.mint) for (const [u, q] of unitsOf(body.mint)) { if (q > 0n) addUnit(consumed, u, q); else if (q < 0n) addUnit(produced, u, -q); }
        for (const s of tx.outputSlices) addAll(produced, txOutPartsFromBytes(s).value);
        addUnit(produced, "lovelace", fee);
        if (body.donation != null) addUnit(produced, "lovelace", BigInt(body.donation));
        for (const pp of (body.proposalProcedures ?? []) as any[]) addUnit(produced, "lovelace", BigInt(pp.deposit ?? 0));
        for (const c of (body.certs ?? []) as any[]) {
            const t = Number(c.certType);
            if (t === 0) addUnit(produced, "lovelace", p.keyDeposit);
            else if (t === 1) addUnit(consumed, "lovelace", p.keyDeposit);
            else if (t === 3) { if (!look.pools.has(hexOf(c.poolParams?.operator))) addUnit(produced, "lovelace", p.poolDeposit); }
            else if (t === 7 || t === 11 || t === 12 || t === 13 || t === 16) addUnit(produced, "lovelace", BigInt(c.deposit ?? c.coin ?? 0));
            else if (t === 8 || t === 17) addUnit(consumed, "lovelace", BigInt(c.deposit ?? c.coin ?? 0));
        }
        for (const m of [consumed, produced]) for (const [u, q] of [...m]) if (q === 0n && u !== "lovelace") m.delete(u);
        if (!unitsEqual(consumed, produced)) { utxo.fail(UtxoF.valueNotConserved(consumed, produced)); reasons.push("value not conserved"); }
    }
    {
        const coinsPerByte = p.coinsPerUtxoByte ?? 4310n;
        const small: Array<{ out: TxOutParts; minCoin: bigint }> = [];
        const sized = [...tx.outputSlices, ...(tx.collateralReturnSlice ? [tx.collateralReturnSlice] : [])];
        for (const s of sized) {
            const parts = txOutPartsFromBytes(s);
            const minCoin = coinsPerByte * BigInt(160 + s.length);
            if ((parts.value.get("lovelace") ?? 0n) < minCoin || [...parts.value].some(([, q]) => q < 0n)) small.push({ out: parts, minCoin });
        }
        if (small.length) { utxo.fail(UtxoF.outputTooSmall(small)); reasons.push(`${small.length} output(s) below the minimum UTxO value`); }
        const maxVal = Number(raw.max_val_size ?? 5000);
        const tooBig: Array<{ size: number; max: number; out: TxOutParts }> = [];
        for (const s of sized) {
            const parts = txOutPartsFromBytes(s);
            const vs = Cbor.encode(valueCborLite(parts.value)).toBuffer().length;
            if (vs > maxVal) tooBig.push({ size: vs, max: maxVal, out: parts });
        }
        if (tooBig.length) { utxo.fail(UtxoF.outputTooBig(tooBig)); reasons.push("output value too big"); }
        const wrong: Uint8Array[] = [];
        for (const s of sized) {
            const a = txOutPartsFromBytes(s).address;
            const header = a[0] ?? 0;
            if ((header >> 4) === 8) continue; // bootstrap
            if ((header & 0x0f) !== netId) wrong.push(a);
        }
        if (wrong.length) { utxo.fail(UtxoF.wrongNetwork(netId, wrong)); reasons.push("output address on another network"); }
        const wrongWd: Uint8Array[] = [];
        for (const w of tx.withdrawals) if ((w.account[0]! & 0x0f) !== netId) wrongWd.push(w.account);
        if (wrongWd.length) { utxo.fail(UtxoF.wrongNetworkWithdrawal(netId, wrongWd)); reasons.push("withdrawal from another network"); }
        if (tx.networkId != null && tx.networkId !== netId) { utxo.fail(UtxoF.wrongNetworkInTxBody(netId, tx.networkId)); reasons.push(`body network id ${tx.networkId} ≠ ${netId}`); }
    }
    // (MaxTxSize and ExUnitsTooBig are caught by the measure above.)
    if (p.maxCollateralInputs != null && tx.collateral.length > p.maxCollateralInputs) { utxo.fail(UtxoF.tooManyCollateralInputs(p.maxCollateralInputs, tx.collateral.length)); reasons.push(`${tx.collateral.length} collateral inputs > max ${p.maxCollateralInputs}`); }

    utxow.sub(utxo);
    ledger.sub(utxow);
    mempool.sub(ledger);

    // The node's block rules on the same inputs: the verdict must never be laxer than theirs.
    const rules = evaluateTxRules({
        era: 7, body, witnessSet: tx.witnessSet, slot, resolved,
        provenKeys: wits.provenKeys, provenRoots: wits.provenRoots,
        isPoolRegistered: (h) => look.pools.has(h.toLowerCase()), params: p, txSizeBytes: tx.size, rewardBalances: look.rewardBalances,
    });
    out.reports.push(...rules.reports);
    if (rules.failures.length && !mempool.failing) {
        out.unmodelled = rules.failures.slice();
        mempool.fail(LedgerF.mempoolFailure(`Gerolamo block rules: ${rules.failures.join("; ")}`));
        reasons.push(...rules.failures);
    } else if (!rules.failures.length && mempool.failing) {
        out.structuredOnly = 1;
    }
    out.failures = [...mempool.failures];
    out.runsPlutus = !mempool.failing && redeemers.length > 0; // is_valid = false too: the ledger then requires the scripts to fail
    return out;
}

function sumInvalidMetadata(): CborObj { return new CborArray([new CborUInt(8)]); }
function ppViewHashesDontMatch(supplied: string | null, expected: string | null): CborObj {
    const sm = (h: string | null) => new CborArray(h ? [new CborBytes(fromHexStr(h))] : []);
    return new CborArray([new CborUInt(13), sm(supplied), sm(expected)]);
}
/** Value encoding for the size check only (coin or [coin, multiasset]). */
function valueCborLite(units: UnitMap): CborObj {
    const coin = units.get("lovelace") ?? 0n;
    const policies = new Map<string, Array<{ k: CborObj; v: CborObj }>>();
    for (const [u, q] of units) {
        if (u === "lovelace") continue;
        const list = policies.get(u.slice(0, 56)) ?? [];
        list.push({ k: new CborBytes(fromHexStr(u.slice(56))), v: q < 0n ? new CborNegInt(q) : new CborUInt(q) });
        policies.set(u.slice(0, 56), list);
    }
    if (!policies.size) return new CborUInt(coin);
    return new CborArray([new CborUInt(coin), new CborMap([...policies].map(([pol, names]) => ({ k: new CborBytes(fromHexStr(pol)), v: new CborMap(names) })))]);
}

/** Witness items for signature verification, and the key hashes / roots each proves. */
export function witnessKeyHashes(witnessSet: any): Set<string> {
    const out = new Set<string>();
    for (const w of (witnessSet?.vkeyWitnesses ?? []) as any[]) {
        try { const vk: Uint8Array = w.vkey?.toBuffer?.() ?? w.vkey; out.add(toHex(blake2b_224(vk))); } catch { /* */ }
    }
    return out;
}

export { credKey };
