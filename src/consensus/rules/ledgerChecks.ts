/**
 * Single-rule UTXO / UTXOW / LEDGER / BBODY checks, Shelley → Conway, one function per
 * cardano-ledger predicate failure so the block rules and the mempool can share them.
 * Semantics and protocol-version gates follow cardano-ledger master (the source cited
 * next to each rule); the failure messages start with the ledger constructor's name.
 *
 * Every function is pure: ledger state arrives as arguments (resolved UTxO, lookups).
 * A check whose state is unknown reports instead of failing (`sink.reports`).
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborText, CborUInt } from "@harmoniclabs/cbor";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { utxoRefOf } from "./resolvedUtxo";
import type { UnitMap } from "./value";
import { typedCredHexOf } from "../../db/stakeCred";

export interface RuleSink {
    failures: string[];
    reports: string[];
}

export const newSink = (): RuleSink => ({ failures: [], reports: [] });

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

// ---------------------------------------------------------------- exact rationals

export interface Rational { num: bigint; den: bigint }

/**
 * Exact rational of a protocol-parameter value. The parameter sources keep unit-interval
 * prices as JS numbers (`Number(num) / Number(den)`); the shortest decimal that round-trips
 * the double is the decimal the chain carried (577/10000 → 0.0577, 721/10⁷ → 0.0000721), so
 * it is read back digit by digit, never through float arithmetic. "a/b" strings and
 * `{ num, den }` / `{ numerator, denominator }` objects are taken as they are.
 */
export function rationalOf(v: unknown): Rational | null {
    if (v == null) return null;
    if (typeof v === "bigint") return { num: v, den: 1n };
    if (typeof v === "object") {
        const o = v as any;
        const n = o.num ?? o.numerator, d = o.den ?? o.denominator;
        if (n == null || d == null) return null;
        try {
            const den = BigInt(d);
            return den === 0n ? null : reduce(BigInt(n), den);
        } catch {
            return null;
        }
    }
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v).trim();
    if (!s) return null;
    const slash = s.indexOf("/");
    if (slash > 0) {
        try {
            const den = BigInt(s.slice(slash + 1).trim());
            return den === 0n ? null : reduce(BigInt(s.slice(0, slash).trim()), den);
        } catch {
            return null;
        }
    }
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
    const frac = m[3] ?? "";
    let num = BigInt((m[2] || "0") + frac);
    let den = 10n ** BigInt(frac.length);
    const exp = Number(m[4] ?? 0);
    if (exp > 0) num *= 10n ** BigInt(exp);
    else if (exp < 0) den *= 10n ** BigInt(-exp);
    if (m[1] === "-") num = -num;
    return reduce(num, den);
}

function gcd(a: bigint, b: bigint): bigint {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
}

function reduce(num: bigint, den: bigint): Rational {
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den) || 1n;
    return { num: num / g, den: den / g };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a <= 0n ? -((-a) / b) : (a + b - 1n) / b);

// ---------------------------------------------------------------- fees

/** Alonzo `txscriptfee`: ⌈mem · prMem + steps · prSteps⌉, computed exactly. */
export function scriptExecutionFee(mem: bigint, steps: bigint, priceMem: Rational, priceStep: Rational): bigint {
    const num = mem * priceMem.num * priceStep.den + steps * priceStep.num * priceMem.den;
    return ceilDiv(num, priceMem.den * priceStep.den);
}

/**
 * Conway `tierRefScriptFee` (Cardano.Ledger.Conway.Tx): every full `stride` bytes cost the
 * current tier price per byte, the price grows by `multiplier` per tier, the remainder is
 * priced at the last tier and the sum is floored once. Exact rational arithmetic.
 */
export function tierRefScriptFeeExact(totalBytes: number, base: Rational, stride = 25_600, multiplier: Rational = { num: 6n, den: 5n }): bigint {
    let accNum = 0n, accDen = 1n;
    let pNum = base.num, pDen = base.den;
    let n = BigInt(totalBytes);
    const inc = BigInt(stride);
    while (n >= inc) {
        accNum = accNum * pDen + inc * pNum * accDen;
        accDen *= pDen;
        pNum *= multiplier.num;
        pDen *= multiplier.den;
        n -= inc;
        const g = gcd(accNum, accDen) || 1n;
        accNum /= g; accDen /= g;
    }
    accNum = accNum * pDen + n * pNum * accDen;
    accDen *= pDen;
    return accNum / accDen;
}

export interface MinFeeParams {
    minFeeA: bigint;
    minFeeB: bigint;
    priceMem: Rational | null;
    priceStep: Rational | null;
    /** Conway `minFeeRefScriptCostPerByte`; null before Conway. */
    refScriptCostPerByte: Rational | null;
}

export interface MinFee { total: bigint; sizeFee: bigint; scriptFee: bigint; refScriptFee: bigint }

/**
 * `getMinFeeTxUtxo`: Shelley `a·size + b`, Alonzo+ plus `txscriptfee` of the total ex units
 * (effective redeemers), Conway plus the tiered fee of the non-distinct reference-script
 * bytes (`txNonDistinctRefScriptsSize`).
 */
export function minFeeTx(p: MinFeeParams, era: number, txSize: number, exUnits: { mem: bigint; steps: bigint }, refScriptBytes: number): MinFee {
    const sizeFee = p.minFeeA * BigInt(txSize) + p.minFeeB;
    const scriptFee = era >= 5 && p.priceMem && p.priceStep && (exUnits.mem > 0n || exUnits.steps > 0n) ? scriptExecutionFee(exUnits.mem, exUnits.steps, p.priceMem, p.priceStep) : 0n;
    const refScriptFee = era >= 7 && p.refScriptCostPerByte && refScriptBytes > 0 ? tierRefScriptFeeExact(refScriptBytes, p.refScriptCostPerByte) : 0n;
    return { total: sizeFee + scriptFee + refScriptFee, sizeFee, scriptFee, refScriptFee };
}

// ---------------------------------------------------------------- reference-script sizes

/** Conway `ppMaxRefScriptSizePerTxG` / `ppMaxRefScriptSizePerBlockG` (constants in Conway). */
export const MAX_REF_SCRIPT_SIZE_PER_TX = 200 * 1024;
export const MAX_REF_SCRIPT_SIZE_PER_BLOCK = 1024 * 1024;

/** Length of a CBOR byte-string payload at `off` (definite or chunked), or null. */
function cborBytesPayloadLength(b: Uint8Array, off: number): number | null {
    const ib = b[off];
    if (ib == null || ib >> 5 !== 2) return null;
    const ai = ib & 0x1f;
    if (ai < 24) return ai;
    if (ai === 24) return b[off + 1] ?? null;
    if (ai === 25) return off + 2 < b.length ? (b[off + 1]! << 8) | b[off + 2]! : null;
    if (ai === 26) return off + 4 < b.length ? ((b[off + 1]! << 24) >>> 0) + (b[off + 2]! << 16) + (b[off + 3]! << 8) + b[off + 4]! : null;
    if (ai === 31) {
        try {
            const obj = Cbor.parse(b.subarray(off));
            return obj instanceof CborBytes ? obj.bytes.length : null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * `originalBytesSize` of a reference script given the `[lang, script]` wrapper carried by
 * `script_ref` (what the UTxO stores as `referenceScriptCbor`): a native script's own CBOR
 * (the wrapper minus `82 00`), a Plutus script's flat bytes (the byte-string payload). The
 * wrapper itself is never counted.
 */
export function refScriptOriginalSize(wrapper: string | Uint8Array | null | undefined): number {
    if (!wrapper) return 0;
    const b = typeof wrapper === "string" ? Buffer.from(wrapper, "hex") : wrapper;
    if (b.length < 3 || b[0] !== 0x82) return 0;
    const lang = b[1]!;
    if (lang === 0) return b.length - 2;
    if (lang >= 1 && lang <= 4) return cborBytesPayloadLength(b, 2) ?? 0;
    return 0;
}

/**
 * Conway `txNonDistinctRefScriptsSize`: the reference scripts of the outputs behind
 * `refInputs ∪ inputs` (a set: an input listed in both counts once; two inputs carrying
 * the same script count twice). Unresolved refs contribute nothing (bad inputs fail on
 * their own).
 */
export function txRefScriptsSize(body: any, lookup: (ref: string) => { referenceScriptCbor?: string | null } | null | undefined): number {
    const refs = new Set<string>();
    for (const i of [...((body?.refInputs ?? []) as any[]), ...((body?.inputs ?? []) as any[])]) {
        const r = utxoRefOf(i);
        if (r) refs.add(r);
    }
    let total = 0;
    for (const r of refs) total += refScriptOriginalSize(lookup(r)?.referenceScriptCbor ?? null);
    return total;
}

/** Conway LEDGER `ConwayTxRefScriptsSizeTooBig` (phase-2-valid transactions only). */
export function checkTxRefScriptsSize(sink: RuleSink, era: number, size: number): void {
    if (era >= 7 && size > MAX_REF_SCRIPT_SIZE_PER_TX) sink.failures.push(`ConwayTxRefScriptsSizeTooBig: reference scripts ${size} B > ${MAX_REF_SCRIPT_SIZE_PER_TX} B`);
}

/**
 * Conway BBODY `BodyRefScriptsSizeTooBig` accumulator (`totalRefScriptSizeInBlock`): every
 * transaction counts, valid or not. Up to protocol 10 each is measured against the UTxO
 * at the start of the block; from protocol 11 the outputs of earlier transactions of the
 * block (collateral return for a phase-2-invalid one) are visible too, and nothing is
 * removed by spending.
 */
export class BlockRefScriptSize {
    total = 0;
    private readonly created = new Map<string, { referenceScriptCbor?: string | null }>();
    constructor(private readonly start: ReadonlyMap<string, { referenceScriptCbor?: string | null }>, private readonly protocolMajor: number | null) {}

    add(body: any, invalid: boolean, txHashHex: string, createdOutputs: Array<{ referenceScriptCbor?: string | null }>): void {
        const accumulate = this.protocolMajor != null && this.protocolMajor >= 11;
        this.total += txRefScriptsSize(body, (r) => this.start.get(r) ?? (accumulate ? this.created.get(r) : undefined));
        if (!accumulate || !txHashHex) return;
        const base = invalid ? (body?.outputs ?? []).length : 0;
        createdOutputs.forEach((o, i) => { const ref = `${txHashHex}:${base + i}`; if (!this.created.has(ref)) this.created.set(ref, o); });
    }

    check(sink: RuleSink, era: number): void {
        if (era >= 7 && this.total > MAX_REF_SCRIPT_SIZE_PER_BLOCK) sink.failures.push(`BodyRefScriptsSizeTooBig: block reference scripts ${this.total} B > ${MAX_REF_SCRIPT_SIZE_PER_BLOCK} B`);
    }
}

// ---------------------------------------------------------------- inputs

/**
 * Babbage `disjointRefInputs`: inputs ∩ reference inputs = ∅, enforced for protocol
 * versions 9 and 10 only (`pvMajor > eraProtVerHigh @Babbage && pvMajor < 11`).
 */
export function checkDisjointRefInputs(sink: RuleSink, body: any, protocolMajor: number | null, era: number): void {
    const refs = (body?.refInputs ?? []) as any[];
    if (!refs.length || era < 7) return;
    const spend = new Set(((body?.inputs ?? []) as any[]).map(utxoRefOf).filter(Boolean) as string[]);
    const common = refs.map(utxoRefOf).filter((r): r is string => !!r && spend.has(r));
    if (!common.length) return;
    const msg = `BabbageNonDisjointRefInputs: ${common.length} input(s) also referenced: ${common.slice(0, 2).join(", ")}`;
    if (protocolMajor == null) sink.reports.push(`${msg} (protocol version unknown)`);
    else if (protocolMajor >= 9 && protocolMajor <= 10) sink.failures.push(msg);
}

/**
 * Shelley `validateBadInputsUTxO` over what the era's rule covers beyond the spent inputs:
 * collateral from Alonzo (`txins ∪ collateral`), reference inputs from Babbage
 * (`allInputs`). The spent inputs are checked by the caller.
 */
export function checkBadCollateralAndRefInputs(sink: RuleSink, body: any, era: number, resolved: ReadonlyMap<string, unknown>): void {
    const missing: string[] = [];
    if (era >= 5) for (const c of (body?.collateralInputs ?? []) as any[]) { const r = utxoRefOf(c); if (r && !resolved.has(r)) missing.push(r); }
    if (era >= 6) for (const c of (body?.refInputs ?? []) as any[]) { const r = utxoRefOf(c); if (r && !resolved.has(r)) missing.push(r); }
    if (missing.length) sink.failures.push(`BadInputsUTxO: ${missing.length} collateral/reference input(s) not in the UTxO set: ${missing.slice(0, 3).join(", ")}`);
}

// ---------------------------------------------------------------- outputs

const cborHeadSize = (n: bigint | number): number => { const v = BigInt(n); return v < 24n ? 1 : v < 256n ? 2 : v < 65536n ? 3 : v < 4294967296n ? 5 : 9; };

/**
 * Byte length of the ledger's own encoding of a Mary value (`serialize (pvMajor pv) v`):
 * a bare coin when there are no assets, else `[coin, {policy: {name: qty}}]`. Map order
 * does not change the size; zero quantities are never part of a decoded value.
 */
export function serializedValueSize(units: UnitMap): number {
    const coin = units.get("lovelace") ?? 0n;
    const policies = new Map<string, Array<{ nameLen: number; q: bigint }>>();
    for (const [u, q] of units) {
        if (u === "lovelace" || q === 0n) continue;
        const p = u.slice(0, 56);
        let l = policies.get(p);
        if (!l) policies.set(p, (l = []));
        l.push({ nameLen: (u.length - 56) / 2, q });
    }
    const coinSize = cborHeadSize(coin < 0n ? -coin - 1n : coin);
    if (policies.size === 0) return coinSize;
    let size = 1 + coinSize + cborHeadSize(policies.size);
    for (const assets of policies.values()) {
        size += 2 + 28 + cborHeadSize(assets.length);
        for (const a of assets) size += cborHeadSize(a.nameLen) + a.nameLen + cborHeadSize(a.q < 0n ? -a.q - 1n : a.q);
    }
    return size;
}

/** Alonzo `validateOutputTooBigUTxO`: `serSize (getValue out) ≤ maxValSize` (Babbage+: collateral return too). */
export function checkOutputsTooBig(sink: RuleSink, era: number, maxValSize: number | null | undefined, values: Array<{ label: string; units: UnitMap }>): void {
    if (era < 5 || maxValSize == null) return;
    for (const v of values) {
        const size = serializedValueSize(v.units);
        if (size > maxValSize) sink.failures.push(`OutputTooBigUTxO: ${v.label} value is ${size} B > maxValSize ${maxValSize}`);
    }
}

/**
 * `bootstrapAddressAttrsSize` of a Byron address (Cardano.Ledger.Address): the HD derivation
 * path payload (attribute 1, a CBOR-wrapped bytestring) plus every unknown attribute's raw
 * value; the network magic (attribute 2) is not counted. Null when not a Byron address.
 */
export function bootstrapAddressAttrsSize(addressBytes: Uint8Array): number | null {
    if (addressBytes.length === 0 || addressBytes[0]! >> 4 !== 8) return null;
    try {
        const outer = Cbor.parse(addressBytes);
        if (!(outer instanceof CborArray)) return null;
        const tagged = outer.array[0];
        const payloadBytes = tagged instanceof CborTag && tagged.data instanceof CborBytes ? tagged.data.bytes : null;
        if (!payloadBytes) return null;
        const payload = Cbor.parse(payloadBytes);
        if (!(payload instanceof CborArray)) return null;
        const attrs = payload.array[1];
        if (!(attrs instanceof CborMap)) return 0;
        let size = 0;
        for (const { k, v } of attrs.map) {
            const key = k instanceof CborUInt ? Number(k.num) : -1;
            const raw = v instanceof CborBytes ? v.bytes : null;
            if (!raw) continue;
            if (key === 1) {
                const inner = Cbor.parse(raw);
                size += inner instanceof CborBytes ? inner.bytes.length : 0;
            } else if (key !== 2) size += raw.length;
        }
        return size;
    } catch {
        return null;
    }
}

/** Address bytes of a transaction output from its original CBOR (array or map form). */
export function outputAddressBytes(outBytes: Uint8Array): Uint8Array | null {
    try {
        const o = Cbor.parse(outBytes);
        if (o instanceof CborArray) return o.array[0] instanceof CborBytes ? o.array[0].bytes : null;
        if (o instanceof CborMap) for (const { k, v } of o.map) if (k instanceof CborUInt && Number(k.num) === 0) return v instanceof CborBytes ? v.bytes : null;
    } catch {
        /* */
    }
    return null;
}

/** Shelley `validateOutputBootAddrAttrsTooBig`: a bootstrap output address carries ≤ 64 bytes of attributes. */
export function checkBootAddrAttrs(sink: RuleSink, outputs: Array<{ label: string; bytes: Uint8Array | null }>): void {
    for (const o of outputs) {
        if (!o.bytes) continue;
        // cheap pre-filter: Byron address bytes start 82 d8 18 inside the output
        const addr = outputAddressBytes(o.bytes);
        if (!addr || addr[0]! >> 4 !== 8) continue;
        const size = bootstrapAddressAttrsSize(addr);
        if (size != null && size > 64) sink.failures.push(`OutputBootAddrAttrsTooBig: ${o.label} bootstrap address attributes ${size} B > 64`);
    }
}

/** Shelley `validateWrongNetworkWithdrawal`: every reward account is on the node's network. */
export function checkWithdrawalNetwork(sink: RuleSink, body: any, network: "mainnet" | "testnet"): void {
    for (const w of (body?.withdrawals?.map ?? []) as any[]) {
        const net = w?.rewardAccount?.network;
        if (net && net !== network) sink.failures.push(`WrongNetworkWithdrawal: reward account on ${net}, node is on ${network}`);
    }
}

// ---------------------------------------------------------------- validity interval

/**
 * Shelley `validateTimeToLive` (`ttl ≥ slot`) and Allegra+ `inInterval` (`start ≤ slot < ttl`):
 * from Allegra the upper bound is exclusive.
 */
export function checkValidityInterval(sink: RuleSink, era: number, body: any, slot: bigint): void {
    if (body?.ttl != null) {
        const ttl = BigInt(body.ttl);
        if (era <= 2 ? ttl < slot : slot >= ttl) sink.failures.push(`expired: ttl ${ttl} ${era <= 2 ? "<" : "≤"} slot ${slot} (OutsideValidityIntervalUTxO)`);
    }
    if (body?.validityIntervalStart != null && slot < BigInt(body.validityIntervalStart)) sink.failures.push(`not yet valid: start ${body.validityIntervalStart} > slot ${slot} (OutsideValidityIntervalUTxO)`);
}

// ---------------------------------------------------------------- certificate deposits

export interface DepositParams {
    keyDeposit: bigint;
    poolDeposit: bigint;
    /** Conway `ppDRepDeposit`; null before Conway (the certificate's own amount is used then). */
    drepDeposit?: bigint | null;
}

/**
 * Deposits and refunds of a transaction's certificates, as the balance rule computes them
 * (Shelley `shelleyTotalDepositsTxCerts` / `shelleyTotalRefundsTxCerts`, Conway
 * `conwayTotalDepositsTxCerts` / `conwayTotalRefundsTxCerts`):
 *
 *   deposits — `keyDeposit` per stake registration (0, 7, 11, 12, 13: the protocol
 *              parameter, not the certificate's field), `poolDeposit` once per pool that
 *              is neither registered nor registered earlier in the same tx, `drepDeposit`
 *              per DRep registration (16).
 *   refunds  — per stake deregistration (1, 8): `keyDeposit` when the credential was
 *              registered earlier in the same tx, else the deposit stored for it
 *              (`stakeDeposit`); DRep deregistration (17) refunds the certificate's amount.
 *
 * `stakeDeposit` returns the deposit held for a typed credential, or null when it is not
 * registered (no refund). Without a lookup, the certificate's refund field stands in for
 * unreg_cert (8; DELEG requires it to equal the stored deposit) and `keyDeposit` for the
 * Shelley deregistration (1).
 */
export function certDepositsAndRefunds(certs: readonly any[], p: DepositParams, isPoolRegistered: (poolHex: string) => boolean, stakeDeposit?: (typedCredHex: string) => bigint | null): { deposits: bigint; refunds: bigint } {
    let deposits = 0n, refunds = 0n;
    const newPools = new Set<string>();
    const regInTx = new Set<string>();
    for (const c of certs) {
        const t = Number(c?.certType);
        const cred = c?.stakeCredential ? credId(c.stakeCredential) : null;
        switch (t) {
            case 0: case 7: case 11: case 12: case 13:
                deposits += p.keyDeposit;
                if (cred) regInTx.add(cred);
                break;
            case 1: case 8: {
                if (cred && regInTx.has(cred)) { regInTx.delete(cred); refunds += p.keyDeposit; break; }
                if (stakeDeposit && cred) { refunds += stakeDeposit(cred) ?? 0n; break; }
                refunds += t === 8 ? BigInt(c?.deposit ?? c?.coin ?? p.keyDeposit) : p.keyDeposit;
                break;
            }
            case 3: {
                const pool = hex(c?.poolParams?.operator);
                if (!isPoolRegistered(pool) && !newPools.has(pool)) { newPools.add(pool); deposits += p.poolDeposit; }
                break;
            }
            case 16:
                deposits += p.drepDeposit ?? BigInt(c?.coin ?? c?.deposit ?? 0);
                break;
            case 17:
                refunds += BigInt(c?.coin ?? c?.deposit ?? 0);
                break;
            default:
                break;
        }
    }
    return { deposits, refunds };
}

/** Typed stake-credential key (`typedCredHexOf`), the form the ledger store keys accounts by. */
function credId(cred: any): string | null {
    return typedCredHexOf(cred) ?? (hex(cred?.hash) || null);
}

// ---------------------------------------------------------------- withdrawals (Conway LEDGER)

/**
 * Typed-hex account key of a withdrawal's reward account. ledger-ts decodes both kinds of
 * reward address with a `StakeKeyHash` credential object and marks scripts only in the
 * address `type` ("script" / "stakeKey"), so `typedCredHexOf` cannot type it (bug 180).
 */
export function rewardAccountKey(rewardAccount: any): string {
    const creds = rewardAccount?.credentials;
    const typed = typedCredHexOf(creds);
    if (typed) return typed;
    const h = hex(creds?.hash ?? creds);
    return rewardAccount?.type === "script" && /^[0-9a-f]{56}$/.test(h) ? `01${h}` : h;
}

export const isScriptRewardAccount = (rewardAccount: any): boolean => rewardAccountKey(rewardAccount).length === 58;

/**
 * Conway LEDGER `validateWithdrawalsDelegated` (`ConwayWdrlNotDelegatedToDRep`): outside the
 * bootstrap phase (protocol ≥ 10) every *key-hash* reward account a transaction withdraws
 * from must be delegated to a DRep (any DRep, AlwaysAbstain or AlwaysNoConfidence) in the
 * state before the transaction's own certificates. Script accounts are exempt.
 * `drepDelegated(typedCredHex)` answers true / false, or null when unknown (report).
 */
export function checkWithdrawalsDelegated(sink: RuleSink, body: any, era: number, protocolMajor: number | null, drepDelegated: ((typedCredHex: string) => boolean | null) | undefined): void {
    const wd = (body?.withdrawals?.map ?? []) as any[];
    if (era < 7 || !wd.length) return;
    if (protocolMajor != null && protocolMajor < 10) return;
    const missing: string[] = [];
    for (const w of wd) {
        const key = rewardAccountKey(w?.rewardAccount);
        if (key.length === 58) continue; // script account
        const d = drepDelegated ? drepDelegated(key) : null;
        if (d === null) { sink.reports.push(`ConwayWdrlNotDelegatedToDRep not checked for ${key.slice(0, 12)}…: DRep delegation unknown`); continue; }
        if (!d) missing.push(key);
    }
    if (!missing.length) return;
    const msg = `ConwayWdrlNotDelegatedToDRep: ${missing.length} withdrawal account(s) not delegated to a DRep: ${missing.slice(0, 2).map((k) => k.slice(0, 14) + "…").join(", ")}`;
    if (protocolMajor == null) sink.reports.push(`${msg} (protocol version unknown)`);
    else sink.failures.push(msg);
}

/**
 * Withdrawals name registered accounts (LEDGER `testIncompleteAndMissingWithdrawals`:
 * `ShelleyWithdrawalsMissingAccounts` / `ConwayWithdrawalsMissingAccounts`), against the
 * state before the tx's certificates in every era: a tx may withdraw from an account and
 * deregister it (preview slot 3 836 003, tx 42, Babbage). `registered(typedHex)` answers
 * for the state before the tx; null = unknown (report).
 */
export function checkWithdrawalAccounts(sink: RuleSink, body: any, era: number, registered: ((typedCredHex: string) => boolean | null) | undefined, strict: boolean): void {
    const wd = (body?.withdrawals?.map ?? []) as any[];
    if (!wd.length) return;
    const missing: string[] = [];
    for (const w of wd) {
        const key = rewardAccountKey(w?.rewardAccount);
        const r = registered ? registered(key) : null;
        if (r === null) { sink.reports.push(`withdrawal account ${key.slice(0, 12)}…: registration unknown`); continue; }
        if (!r) missing.push(key);
    }
    if (!missing.length) return;
    const msg = `${era >= 7 ? "Conway" : "Shelley"}WithdrawalsMissingAccounts: ${missing.length} withdrawal(s) from unregistered account(s): ${missing.slice(0, 2).map((k) => k.slice(0, 14) + "…").join(", ")}`;
    (strict ? sink.failures : sink.reports).push(msg);
}

/** Conway LEDGER `validateTreasuryValue` (`ConwayTreasuryValueMismatch`). Unknown treasury: report. */
export function checkTreasuryValue(sink: RuleSink, body: any, treasury: bigint | null | undefined, strict: boolean, why?: string): void {
    if (body?.currentTreasuryValue == null) return;
    const claimed = BigInt(body.currentTreasuryValue);
    if (treasury == null) { sink.reports.push(`ConwayTreasuryValueMismatch not checked: treasury unknown (tx claims ${claimed})`); return; }
    if (claimed === treasury) return;
    const msg = `ConwayTreasuryValueMismatch: tx claims treasury ${claimed}, ledger has ${treasury}`;
    if (strict) sink.failures.push(msg); else sink.reports.push(`${msg} (report-only: ${why || "treasury not proven exact"})`);
}

// ---------------------------------------------------------------- UTXOW: scripts, datums, metadata

/**
 * `ExtraneousScriptWitnessesUTXOW` / `MissingScriptWitnessesUTXOW`. Up to Alonzo
 * (`validateMissingScripts`) the witness scripts must be exactly the needed ones; from
 * Babbage (`babbageMissingScripts`) needed scripts available as reference scripts
 * (`refInputs ∪ inputs`) must not be repeated in the witness set:
 *   missing = (needed − refs) − witness,  extraneous = witness − (needed − refs).
 */
export function checkScriptWitnesses(sink: RuleSink, era: number, needed: ReadonlySet<string>, witness: ReadonlySet<string>, refScripts: ReadonlySet<string>): void {
    const neededNonRefs = new Set<string>();
    for (const h of needed) if (era < 6 || !refScripts.has(h)) neededNonRefs.add(h);
    const missing = [...neededNonRefs].filter((h) => !witness.has(h));
    const extra = [...witness].filter((h) => !neededNonRefs.has(h));
    if (missing.length) sink.failures.push(`MissingScriptWitnessesUTXOW: ${missing.slice(0, 3).map((h) => h.slice(0, 12) + "…").join(", ")}`);
    if (extra.length) sink.failures.push(`ExtraneousScriptWitnessesUTXOW: ${extra.slice(0, 3).map((h) => h.slice(0, 12) + "…").join(", ")}`);
}

/**
 * Alonzo `missingRequiredDatums`, supplemental half (`NotAllowedSupplementalDatums`): a
 * witness datum whose hash no spent Plutus-locked input needs must be the datum hash of
 * an output of the transaction (Babbage: collateral return included) or, from Babbage,
 * of an output a reference input points to.
 */
export function checkSupplementalDatums(sink: RuleSink, witnessDatumHashes: ReadonlySet<string>, inputDatumHashes: ReadonlySet<string>, allowed: ReadonlySet<string>): void {
    const bad = [...witnessDatumHashes].filter((h) => !inputDatumHashes.has(h) && !allowed.has(h));
    if (bad.length) sink.failures.push(`NotAllowedSupplementalDatums: ${bad.length} witness datum(s) neither needed nor produced: ${bad.slice(0, 2).map((h) => h.slice(0, 12) + "…").join(", ")}`);
}

/**
 * Shelley `validateMetadata`: the body's auxiliary-data hash and the auxiliary data come
 * together (`MissingTxBodyMetadataHash`, `MissingTxMetadata`), the hash is blake2b-256 of
 * the data's original bytes (`ConflictingMetadataHash`), and from protocol 3 every
 * metadatum text / bytes is at most 64 bytes (`InvalidMetadata`).
 */
export function checkAuxiliaryData(sink: RuleSink, body: any, auxBytes: Uint8Array | null | undefined, protocolMajor: number | null): void {
    if (auxBytes === undefined) return; // unknown: caller has no aux slice
    const declared = body?.auxDataHash != null ? hex(body.auxDataHash) : null;
    if (!auxBytes) {
        if (declared) sink.failures.push(`MissingTxMetadata: body declares auxiliary data ${declared.slice(0, 12)}… but the tx carries none`);
        return;
    }
    const actual = toHex(blake2b_256(auxBytes));
    if (!declared) sink.failures.push(`MissingTxBodyMetadataHash: auxiliary data ${actual.slice(0, 12)}… without a body hash`);
    else if (declared !== actual) sink.failures.push(`ConflictingMetadataHash: body ${declared.slice(0, 12)}… ≠ data ${actual.slice(0, 12)}…`);
    if (protocolMajor != null && protocolMajor <= 2) return;
    const bad = invalidMetadatum(auxBytes);
    if (bad) sink.failures.push(`InvalidMetadata: ${bad}`);
}

/** First metadatum over 64 bytes in auxiliary data (Shelley map, Allegra `[md, scripts]`, Alonzo tag 259 `{0: md}`), or null. */
export function invalidMetadatum(auxBytes: Uint8Array): string | null {
    let root: any;
    try {
        root = Cbor.parse(auxBytes);
    } catch {
        return null;
    }
    let md: any = null;
    if (root instanceof CborMap) md = root;
    else if (root instanceof CborArray) md = root.array[0] ?? null;
    else if (root instanceof CborTag && root.data instanceof CborMap) {
        for (const { k, v } of root.data.map) if (k instanceof CborUInt && Number(k.num) === 0) md = v;
    }
    if (!(md instanceof CborMap)) return null;
    const walk = (x: any): string | null => {
        if (x instanceof CborBytes) return x.bytes.length > 64 ? `bytes of ${x.bytes.length} B` : null;
        if (x instanceof CborText) { const n = Buffer.byteLength(x.text, "utf8"); return n > 64 ? `text of ${n} B` : null; }
        if (x instanceof CborArray) { for (const e of x.array) { const r = walk(e); if (r) return r; } return null; }
        if (x instanceof CborMap) { for (const { k, v } of x.map) { const r = walk(k) ?? walk(v); if (r) return r; } return null; }
        return null;
    };
    for (const { v } of md.map) { const r = walk(v); if (r) return r; }
    return null;
}

/** Datum hashes the outputs behind `refs` carry (for the supplemental-datum allowance). */
export function datumHashesOf(refs: readonly any[], resolved: ReadonlyMap<string, ResolvedUtxo>): Set<string> {
    const out = new Set<string>();
    for (const i of refs) {
        const r = utxoRefOf(i);
        const dh = r ? resolved.get(r)?.datumHash : null;
        if (dh) out.add(dh.toLowerCase());
    }
    return out;
}

// ---------------------------------------------------------------- header (BBODY)

/**
 * Conway BBODY `HeaderProtVerTooHigh`, mainnet only: the header's protocol major may be at
 * most one above the ledger's current major.
 */
export function checkHeaderProtVer(sink: RuleSink, era: number, network: string, headerMajor: number | null, currentMajor: number | null): void {
    if (era < 7 || network !== "mainnet" || headerMajor == null || currentMajor == null) return;
    if (headerMajor > currentMajor + 1) sink.failures.push(`HeaderProtVerTooHigh: header protocol ${headerMajor} > ${currentMajor + 1}`);
}
