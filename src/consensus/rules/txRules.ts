/**
 * Shelley → Conway transaction rules over resolved inputs. Pure: no DB, no
 * crypto (signatures arrive as the set of proven key hashes / bootstrap roots).
 *
 * Every rule either fails (a strict node halts) or reports (a check whose
 * inputs this node cannot yet evaluate exactly, logged but not enforced).
 * Anything computed from re-encoded CBOR sizes is a report, never a failure:
 * a byte of difference would otherwise halt an honest chain.
 */
import type { ResolvedUtxo } from "./resolvedUtxo";
import { effectiveRedeemers } from "./alonzoRules";
import { typedCredHexOf } from "../../db/stakeCred";
import { ledgerInputs, utxoRefOf } from "./resolvedUtxo";
import { addAll, addUnit, alonzoMinUtxo, diffUnits, maryMinUtxo, unitsEqual, unitsOf, type UnitMap } from "./value";
import { evalNativeScript, nativeScriptTreeOf } from "./nativeScript";
import { parseStoredAddress, requiredWitnesses } from "./requiredSigners";
import { ByronAddress, Script } from "@harmoniclabs/cardano-ledger-ts";
import { evaluateAlonzoRules } from "./alonzoRules";
import { bodyOutputBytes, scriptLanguageOfCbor, witnessScriptHashes } from "./scriptDataHash";

/** Flip once a from-genesis run on the final reward rules shows no withdrawal disagreement. */
export const WITHDRAWALS_STRICT = false;

/** Flip once the tiered reference-script fee has been checked against real Conway transactions. */
export const REF_SCRIPT_FEE_VERIFIED = false;

/**
 * Conway `tierRefScriptFee`: the first 25 600 bytes cost `base` per byte, each
 * further 25 600-byte range costs 1.2× the previous one; the total is floored.
 */
export function tierRefScriptFee(totalBytes: number, basePerByte: number, sizeIncrement = 25600, multiplier: [bigint, bigint] = [6n, 5n]): bigint {
    // exact rational arithmetic: price = base · (num/den)^tier
    let num = BigInt(Math.round(basePerByte * 1_000_000)), den = 1_000_000n;
    let accNum = 0n, accDen = 1n;
    let remaining = BigInt(totalBytes);
    const inc = BigInt(sizeIncrement);
    while (remaining > 0n) {
        const n = remaining < inc ? remaining : inc;
        // acc += n · num/den
        accNum = accNum * den + n * num * accDen;
        accDen = accDen * den;
        remaining -= n;
        num *= multiplier[0];
        den *= multiplier[1];
    }
    return accNum / accDen;
}

export interface TxRuleParams {
    minFeeA: bigint;
    minFeeB: bigint;
    keyDeposit: bigint;
    poolDeposit: bigint;
    maxTxSize: number;
    /** Shelley–Alonzo `minUTxOValue`; null when the era uses per-byte pricing. */
    minUtxoValue: bigint | null;
    /** Babbage+ `coinsPerUTxOByte`; null before. */
    coinsPerUtxoByte: bigint | null;
    /** Alonzo `coinsPerUTxOWord`; null outside Alonzo. */
    coinsPerUtxoWord: bigint | null;
    /** Conway `minFeeRefScriptCostPerByte`; null before. */
    minFeeRefScriptCostPerByte: number | null;
    /** The stored parameter record (cost models for the script data hash / Plutus evaluation). */
    raw?: Record<string, unknown> | null;
    /** Alonzo+ execution unit prices (rational, as floats from the params source). */
    priceMem: number | null;
    priceStep: number | null;
    network: "mainnet" | "testnet";
    /** Alonzo+ */
    collateralPercent: number;
    maxCollateralInputs: number | null;
    maxTxExMem: bigint | null;
    maxTxExSteps: bigint | null;
}

export interface TxRuleInput {
    era: number;
    body: any;
    witnessSet: any;
    /** Slot of the block that carries the tx. */
    slot: bigint;
    resolved: Map<string, ResolvedUtxo>;
    /** Key hashes proven by verified vkey witnesses. */
    provenKeys: ReadonlySet<string>;
    /** Byron address roots proven by verified bootstrap witnesses. */
    provenRoots: ReadonlySet<string>;
    /** Pools already registered before this tx (re-registration takes no deposit). */
    isPoolRegistered: (poolHex: string) => boolean;
    params: TxRuleParams;
    /** Byte length of the whole tx as received, when known. */
    txSizeBytes: number | null;
    /** Local reward balances (hex credential → lovelace) for the withdrawn accounts, when tracked. */
    rewardBalances?: Map<string, bigint>;
}

export interface TxRuleOutcome {
    failures: string[];
    reports: string[];
}

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

export function evaluateTxRules(tx: TxRuleInput): TxRuleOutcome {
    const failures: string[] = [];
    const reports: string[] = [];
    const body = tx.body;

    // 1. inputs
        const inputs: any[] = ledgerInputs(body.inputs ?? [], tx.era);
    if (inputs.length === 0) failures.push("no inputs");
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const i of inputs) {
        const r = utxoRefOf(i);
        if (!r) {
            failures.push("malformed input");
            continue;
        }
        if (seen.has(r)) failures.push(`duplicate input ${r}`);
        seen.add(r);
        refs.push(r);
    }
    const missing = refs.filter((r) => !tx.resolved.has(r));
    if (missing.length) failures.push(`spends ${missing.length} input(s) not in the UTxO set: ${missing.slice(0, 3).join(", ")}`);

    // 2. value conservation: consumed = inputs + mint + withdrawals + refunds; produced = outputs + fee + deposits (+ donation)
    const consumed: UnitMap = new Map();
    for (const r of refs) {
        const u = tx.resolved.get(r);
        if (u) addAll(consumed, u.value);
    }
    if (body.mint) addAll(consumed, unitsOf(body.mint));
    for (const w of (body.withdrawals?.map ?? []) as any[]) addUnit(consumed, "lovelace", BigInt(w.amount ?? 0));
    const produced: UnitMap = new Map();
    for (const o of (body.outputs ?? []) as any[]) addAll(produced, unitsOf(o.value));
    addUnit(produced, "lovelace", BigInt(body.fee ?? 0));
    if (body.donation != null) addUnit(produced, "lovelace", BigInt(body.donation));
    for (const p of (body.proposalProcedures ?? []) as any[]) addUnit(produced, "lovelace", BigInt(p.deposit ?? 0));
    let depositsExact = true;
    for (const c of (body.certs ?? []) as any[]) {
        const t = Number(c.certType);
        if (t === 0) addUnit(produced, "lovelace", tx.params.keyDeposit);
        else if (t === 1) addUnit(consumed, "lovelace", tx.params.keyDeposit);
        else if (t === 3) {
            const pool = hex(c.poolParams?.operator);
            if (!tx.isPoolRegistered(pool)) addUnit(produced, "lovelace", tx.params.poolDeposit);
        } else if (t === 7 || t === 11 || t === 12 || t === 13) addUnit(produced, "lovelace", BigInt(c.deposit ?? c.coin ?? 0));
        else if (t === 8) addUnit(consumed, "lovelace", BigInt(c.deposit ?? c.coin ?? 0));
        else if (t === 16) addUnit(produced, "lovelace", BigInt(c.coin ?? 0));
        else if (t === 17) addUnit(consumed, "lovelace", BigInt(c.coin ?? 0));
    }
    if (missing.length === 0) {
        if (!unitsEqual(consumed, produced)) {
            const msg = `value not conserved: ${diffUnits(consumed, produced)}`;
            if (depositsExact) failures.push(msg);
            else reports.push(msg);
        }
    }
    for (const o of (body.outputs ?? []) as any[]) {
        const v = unitsOf(o.value);
        for (const [u, q] of v) if (q < 0n) failures.push(`negative output quantity for ${u.slice(0, 16)}`);
    }

    // 3. fee: minFeeA·size + minFeeB (+ ExUnits × prices in Alonzo+; ref-script tier omitted → lower bound)
    const fee = BigInt(body.fee ?? 0);
    if (tx.txSizeBytes != null) {
        let minFee = tx.params.minFeeA * BigInt(tx.txSizeBytes) + tx.params.minFeeB;
        const redeemers = effectiveRedeemers((tx.witnessSet?.redeemers ?? []) as any[], Number(tx.era));
        if (tx.params.priceMem != null && tx.params.priceStep != null && redeemers.length) {
            let mem = 0n, steps = 0n;
            for (const r of redeemers) {
                mem += BigInt(r.execUnits?.mem ?? r.exUnits?.mem ?? 0);
                steps += BigInt(r.execUnits?.steps ?? r.exUnits?.steps ?? 0);
            }
            minFee += BigInt(Math.ceil(Number(mem) * tx.params.priceMem + Number(steps) * tx.params.priceStep));
        }
        // Conway: reference scripts carried by spent and reference inputs are priced by tier.
        let refFee = 0n;
        if (tx.era >= 7 && tx.params.minFeeRefScriptCostPerByte != null) {
            let refBytes = 0;
            for (const i of [...(body.inputs ?? []), ...(body.refInputs ?? [])] as any[]) {
                const r = utxoRefOf(i);
                const u = r ? tx.resolved.get(r) : null;
                if (u?.referenceScriptCbor) refBytes += u.referenceScriptCbor.length / 2;
            }
            if (refBytes > 0) refFee = tierRefScriptFee(refBytes, tx.params.minFeeRefScriptCostPerByte);
        }
        if (fee < minFee) failures.push(`fee ${fee} below minimum ${minFee} (size ${tx.txSizeBytes})`);
        else if (fee < minFee + refFee) {
            const msg = `fee ${fee} below minimum ${minFee + refFee} with reference-script fee ${refFee}`;
            if (REF_SCRIPT_FEE_VERIFIED) failures.push(msg);
            else reports.push(msg);
        }
    } else {
        reports.push("fee not checked: tx size unknown (re-encoded)");
    }

    // 4. validity interval
    if (body.ttl != null && tx.slot > BigInt(body.ttl)) failures.push(`expired: ttl ${body.ttl} < slot ${tx.slot}`);
    if (body.validityIntervalStart != null && tx.slot < BigInt(body.validityIntervalStart)) failures.push(`not yet valid: start ${body.validityIntervalStart} > slot ${tx.slot}`);

    // 5. min UTxO per output
    let bodyOutputSlices: Uint8Array[] | null | undefined;
    for (let i = 0; i < (body.outputs ?? []).length; i++) {
        const o = body.outputs[i];
        const lovelace = unitsOf(o.value).get("lovelace") ?? 0n;
        if (tx.params.coinsPerUtxoByte != null) {
            let size: number | null = o.cborRef?.toBuffer?.()?.length ?? o.cborRef?.length ?? null;
            let original = true;
            if (size == null) {
                // slice the output out of the body's original bytes
                if (bodyOutputSlices === undefined) {
                    const bb = body?.cborRef?.toBuffer?.() ?? null;
                    bodyOutputSlices = bb ? bodyOutputBytes(bb) : null;
                }
                const sl = bodyOutputSlices?.[i];
                if (sl) size = sl.length;
            }
            if (size == null) {
                // No sub-slice kept by the decoder (legacy array-form outputs): the
                // re-encoding is the same bytes for canonical outputs, but a violation
                // measured on re-encoded bytes is a report, not a halt.
                original = false;
                try {
                    size = o.toCborBytes?.()?.length ?? null;
                } catch {
                    size = null;
                }
            }
            if (size != null) {
                const min = tx.params.coinsPerUtxoByte * BigInt(160 + size);
                if (lovelace < min) (original ? failures : reports).push(`output ${i} below min UTxO: ${lovelace} < ${min}${original ? "" : " (re-encoded size)"}`);
            } else {
                reports.push(`output ${i}: min UTxO not checked (no bytes)`);
            }
        } else if (tx.params.coinsPerUtxoWord != null) {
            // Alonzo: utxoEntrySize (27 + size(v) + 10 for a datum hash) × coinsPerUTxOWord
            const min = alonzoMinUtxo(unitsOf(o.value), tx.params.coinsPerUtxoWord, o.datum != null || o.datumHash != null);
            if (lovelace < min) failures.push(`output ${i} below min UTxO: ${lovelace} < ${min}`);
        } else if (tx.params.minUtxoValue != null) {
            // Shelley/Allegra: minUTxOValue; Mary: scaled by the value size
            const min = maryMinUtxo(unitsOf(o.value), tx.params.minUtxoValue);
            if (lovelace < min) failures.push(`output ${i} below min UTxO: ${lovelace} < ${min}`);
        }
    }

    // 6. size
    if (tx.txSizeBytes != null && tx.txSizeBytes > tx.params.maxTxSize) failures.push(`tx size ${tx.txSizeBytes} > max ${tx.params.maxTxSize}`);

    // 7. network id on outputs (and body.network when present)
    const wantNet = tx.params.network;
    for (const o of (body.outputs ?? []) as any[]) {
        const a = o.address;
        // ledger-ts decodes a bootstrap address inside a Shelley-era output as an
        // `Address` of type "byron" whose `network` is meaningless (mainnet epoch 208,
        // tx 2b240c39…: a Ddz… output reported as "testnet").
        if (a instanceof ByronAddress || String(a?.type ?? "").toLowerCase() === "byron") continue;
        const net = a?.network;
        if (net && net !== wantNet) failures.push(`output address on ${net}, node is on ${wantNet}`);
    }
    if (body.network && String(body.network) !== wantNet) failures.push(`tx body network ${body.network} ≠ ${wantNet}`);

    // 8. witnesses: required keys ⊆ proven, bootstrap roots ⊆ proven roots, scripts provided + native scripts hold
    const req = requiredWitnesses(body, tx.resolved);
    for (const p of req.problems) reports.push(p);
    const missingKeys = [...req.keyHashes].filter((k) => !tx.provenKeys.has(k));
    if (missingKeys.length) failures.push(`missing vkey witness for ${missingKeys.length} key(s): ${missingKeys.slice(0, 2).map((k) => k.slice(0, 12) + "…").join(", ")}`);
    const missingRoots = [...req.bootstrapRoots].filter((r) => !tx.provenRoots.has(r));
    if (missingRoots.length) failures.push(`missing bootstrap witness for ${missingRoots.length} Byron address(es)`);

    const provided = new Map<string, { kind: "native" | "plutus"; script: any }>();
    const ws = tx.witnessSet ?? {};
    for (const s of (ws.nativeScripts ?? []) as any[]) provided.set(hex(s.hash), { kind: "native", script: s });
    for (const key of ["plutusV1Scripts", "plutusV2Scripts", "plutusV3Scripts"]) {
        for (const s of (ws[key] ?? []) as any[]) provided.set(hex(s.hash), { kind: "plutus", script: s });
    }
    // The ledger hashes witness scripts over their bytes as given (a double CBOR wrap
    // included); add those hashes from the original witness-set bytes.
    const wsBytes = witnessSetBytesOf(ws);
    if (wsBytes) {
        for (const [h, w] of witnessScriptHashes(wsBytes)) {
            if (!provided.has(h)) provided.set(h, { kind: w.kind, script: w.kind === "native" ? (ws.nativeScripts ?? []).find((n: any) => hex(n.hash) === h) ?? null : null });
        }
    }
    // reference scripts carried by spent or referenced outputs
    const refInputs: any[] = [...(body.refInputs ?? []), ...inputs];
    for (const i of refInputs) {
        const r = utxoRefOf(i);
        const u = r ? tx.resolved.get(r) : null;
        if (u?.referenceScriptHash) {
            // A reference script may be native (`[0, script]`): it is then evaluated like a
            // witness native script and needs no redeemer.
            const refCbor = u.referenceScriptCbor ?? null;
            const isNative = !!refCbor && scriptLanguageOfCbor(refCbor) === null && refCbor.startsWith("8200");
            let native: any = null;
            if (isNative && refCbor) {
                try {
                    native = Script.fromCbor(refCbor);
                } catch {
                    native = null;
                }
            }
            provided.set(u.referenceScriptHash, isNative ? { kind: "native", script: native } : { kind: "plutus", script: null });
        }
    }
    const timelock = { signers: tx.provenKeys, validFrom: body.validityIntervalStart ?? null, validTo: body.ttl ?? null };
    const plutusScripts = new Set<string>();
    const nativeScriptHashes = new Set<string>();
    for (const [h, p] of provided) (p.kind === "plutus" ? plutusScripts : nativeScriptHashes).add(h);
    for (const h of req.scriptHashes) {
        const p = provided.get(h);
        if (!p) {
            failures.push(`script ${h.slice(0, 12)}… required but not provided`);
            continue;
        }
        if (p.kind === "native") {
            const ns = nativeScriptTreeOf(p.script);
            if (!ns) reports.push(`native script ${h.slice(0, 12)}…: cannot decode for evaluation`);
            else if (!evalNativeScript(ns, timelock)) failures.push(`native script ${h.slice(0, 12)}… not satisfied`);
        }
        // Plutus scripts: phase-2 execution is Phase 3 of the plan; presence is enforced here.
    }

    // 8b. withdrawals must take the whole reward balance (strict once per-account rewards are exact from genesis)
    if (tx.rewardBalances) {
        for (const w of (body.withdrawals?.map ?? []) as any[]) {
            const cred = typedCredHexOf(w.rewardAccount?.credentials) ?? hex(w.rewardAccount?.credentials?.hash ?? w.rewardAccount?.credentials);
            const bal = tx.rewardBalances.get(cred);
            const amt = BigInt(w.amount ?? 0);
            // Report-only until a from-genesis run on the final reward rules shows zero
            // disagreements: per-account rewards still differ by a few hundred lovelace where a
            // pool's re-registration timing changed its leader/member split.
            const msg = bal == null ? `withdrawal from ${cred.slice(0, 12)}…: no local reward balance` : bal !== amt ? `withdrawal ${amt} ≠ local reward balance ${bal} for ${cred.slice(0, 12)}…` : null;
            if (msg) (WITHDRAWALS_STRICT ? failures : reports).push(msg);
        }
    }

    // 9. Alonzo+ integrity: datums, collateral, ex units, redeemer ↔ purpose
    if (tx.era >= 5) {
        const a = evaluateAlonzoRules({
            witnessSetBytes: witnessSetBytesOf(tx.witnessSet),
            rawParams: tx.params.raw ?? null,
            era: tx.era,
            body,
            witnessSet: ws,
            resolved: tx.resolved,
            plutusScripts,
            nativeScripts: nativeScriptHashes,
            params: {
                collateralPercent: tx.params.collateralPercent,
                maxCollateralInputs: tx.params.maxCollateralInputs,
                maxTxExMem: tx.params.maxTxExMem,
                maxTxExSteps: tx.params.maxTxExSteps,
            },
        });
        failures.push(...a.failures);
        reports.push(...a.reports);
    }

    return { failures, reports };
}

/** Byron addresses among the resolved inputs, by ref (for the Byron witness rule). */
export function byronAddressOf(u: ResolvedUtxo | undefined): ByronAddress | null {
    if (!u) return null;
    const a = parseStoredAddress(u.address);
    return a instanceof ByronAddress ? a : null;
}

function witnessSetBytesOf(ws: any): Uint8Array | null {
    const ref = ws?.cborRef;
    try {
        if (ref?.toBuffer) return ref.toBuffer();
    } catch {
        /* */
    }
    return null;
}
