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
import { ledgerInputs, utxoRefOf } from "./resolvedUtxo";
import { isDijkstraEra, dijkstraBatchValue, checkDijkstraTx, plutusLegacyMode, dijkstraRefScriptParams } from "./dijkstraRules";
import { addAll, addUnit, alonzoMinUtxo, diffUnits, maryMinUtxo, unitsEqual, unitsOf, type UnitMap } from "./value";
import { evalNativeScript, nativeScriptTreeOf } from "./nativeScript";
import { parseStoredAddress, requiredWitnesses } from "./requiredSigners";
import { ByronAddress, Script } from "@harmoniclabs/cardano-ledger-ts";
import { evaluateAlonzoRules } from "./alonzoRules";
import { bodyFieldBytes, bodyOutputBytes, maxPlutusLanguage, scriptLanguageOfCbor, witnessScriptHashes, type PlutusLanguage, type WitnessScript } from "./scriptDataHash";
import { checkScriptsWellFormed } from "./scriptsWellFormed";
import {
    certDepositsAndRefunds, checkAuxiliaryData, checkWithdrawalAccounts, checkBadCollateralAndRefInputs, checkBootAddrAttrs, checkDisjointRefInputs, checkOutputsTooBig, checkScriptWitnesses,
    checkTreasuryValue, checkTxRefScriptsSize, checkValidityInterval, checkWithdrawalNetwork, checkWithdrawalsDelegated, minFeeTx, rationalOf, tierRefScriptFeeExact, txRefScriptsSize,
    datumHashesOf, rewardAccountKey, type RuleSink,
} from "./ledgerChecks";
import { extractLedgerTxOutMetadata } from "../../db/minibf/txOutMetadata";

/**
 * Withdrawals must take the whole local reward balance (`ConwayIncompleteWithdrawals`, before
 * PV 11 `WithdrawalsNotInRewardsCERTS`/`DELEGS`). Strict whenever the balances come from an exact
 * ledger store (`TxRuleInput.exactness`: lmdb mode on a store imported from a NewEpochState, bug 272);
 * this constant forces it everywhere. Not set: the SQLite balances drifted by a few lovelace on
 * thousands of withdrawals in the from-genesis replays of node 3036 (2026-09-07/08) and on the
 * producer's SQLite-seeded store (2026-10-01), so sqlite / dual mode and SQLite-seeded stores report.
 */
export const WITHDRAWALS_STRICT = false;

/**
 * Strict since 2026-09-28: the exact minimum fee (rational ex-unit prices, reference-script
 * bytes counted as the ledger's `originalBytesSize` over `refInputs ∪ inputs`) was replayed
 * over every Babbage and Conway transaction of preview with zero shortfalls; the 15 reports
 * of 2026-09-23 came from counting the `[lang, bytes]` wrapper (bug 170).
 */
export const REF_SCRIPT_FEE_VERIFIED = true;

/**
 * Withdrawals from unregistered accounts (`ConwayWithdrawalsMissingAccounts` /
 * `WithdrawalsNotInRewardsDELEGS`). Registration state is what the strict certificate rule
 * already trusts; strict since the preview replay of 2026-09-28 (bug 180).
 */
export const WITHDRAWAL_ACCOUNTS_STRICT = true;

/**
 * `current_treasury_value` against the local treasury: strict when the pots come from an exact ledger
 * store (GetAccountState byte-identical with cardano-node from the snapshot-imported LMDB store, bug 273);
 * this constant forces it everywhere.
 */
export const TREASURY_VALUE_STRICT = false;

/**
 * Conway `tierRefScriptFee`: the first 25 600 bytes cost `base` per byte, each
 * further 25 600-byte range costs 1.2× the previous one; the total is floored.
 * `basePerByte` is read back as the exact rational it stands for (see `rationalOf`).
 */
export function tierRefScriptFee(totalBytes: number, basePerByte: number, sizeIncrement = 25600, multiplier: [bigint, bigint] = [6n, 5n]): bigint {
    const base = rationalOf(basePerByte);
    if (!base) return 0n;
    return tierRefScriptFeeExact(totalBytes, base, sizeIncrement, { num: multiplier[0], den: multiplier[1] });
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
    /** Protocol major version of the epoch (gates: disjoint ref inputs 9–10, DRep-delegated withdrawals ≥ 10, metadata ≥ 3); null when unknown. */
    protocolMajor?: number | null;
    /** Alonzo+ `maxValSize` (bytes of a serialised output value). */
    maxValSize?: number | null;
    /** Conway `drepDeposit`. */
    drepDeposit?: bigint | null;
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
    /** Original bytes of the tx's auxiliary data; null = the tx carries none; undefined = not known (metadata rules skipped). */
    auxDataBytes?: Uint8Array | null;
    /** Conway: is this key-hash reward account (typed hex) delegated to a DRep before the tx? null = unknown. */
    drepDelegated?: (typedCredHex: string) => boolean | null;
    /** Deposit held for a registered stake credential (typed hex), null when not registered; default: see `certDepositsAndRefunds`. */
    stakeDeposit?: (typedCredHex: string) => bigint | null;
    /** Is this stake credential (typed hex) registered before the tx? null = unknown. */
    stakeRegistered?: (typedCredHex: string) => boolean | null;
    /** Treasury at the start of the epoch, for `current_treasury_value`; null/undefined = unknown (report). */
    treasury?: bigint | null;
    /** Pre-computed `txNonDistinctRefScriptsSize` (the block rule computes it anyway). */
    refScriptBytes?: number;
    /** Are `rewardBalances` and `treasury` exact (nodeLedgerStore `ledgerStateExact`)? The withdrawal-amount and treasury rules are strict only then; `why` goes into the report otherwise. */
    exactness?: { exact: boolean; why: string };
}

export interface TxRuleOutcome {
    failures: string[];
    reports: string[];
}

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

export function evaluateTxRules(tx: TxRuleInput): TxRuleOutcome {
    const failures: string[] = [];
    const reports: string[] = [];
    const sink: RuleSink = { failures, reports };
    const body = tx.body;
    const era = Number(tx.era);
    const pv = tx.params.protocolMajor ?? null;

    // 1. inputs (spent inputs here; collateral and reference inputs by the era's `allInputs`)
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
    checkBadCollateralAndRefInputs(sink, body, era, tx.resolved);
    checkDisjointRefInputs(sink, body, pv, era);

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
    // Certificate deposits from the protocol parameters, refunds from the held deposit
    // (bug 176): the ledger's balance never takes a certificate's own deposit field.
    const cd = certDepositsAndRefunds((body.certs ?? []) as any[], { keyDeposit: tx.params.keyDeposit, poolDeposit: tx.params.poolDeposit, drepDeposit: era >= 7 ? tx.params.drepDeposit ?? null : null }, tx.isPoolRegistered, tx.stakeDeposit);
    addUnit(produced, "lovelace", cd.deposits);
    addUnit(consumed, "lovelace", cd.refunds);
    let batchMissing = 0;
    if (isDijkstraEra(era)) {
        // Dijkstra UTXO (bug 428): consumed / produced cover the sub-transactions and the direct deposits
        const bv = dijkstraBatchValue(body, { resolved: tx.resolved, keyDeposit: tx.params.keyDeposit, poolDeposit: tx.params.poolDeposit, drepDeposit: tx.params.drepDeposit ?? null, isPoolRegistered: tx.isPoolRegistered, stakeDeposit: tx.stakeDeposit });
        addAll(consumed, bv.consumed);
        addAll(produced, bv.produced);
        batchMissing = bv.missing.length;
        if (bv.missing.length) failures.push(`sub-transactions spend ${bv.missing.length} input(s) not in the UTxO set before the batch: ${bv.missing.slice(0, 3).join(", ")}`);
    }
    if (missing.length === 0 && batchMissing === 0 && !unitsEqual(consumed, produced)) failures.push(`value not conserved: ${diffUnits(consumed, produced)}`);
    for (const o of (body.outputs ?? []) as any[]) {
        const v = unitsOf(o.value);
        for (const [u, q] of v) if (q < 0n) failures.push(`negative output quantity for ${u.slice(0, 16)}`);
    }

    // 3. fee: a·size + b + ⌈ExUnits · prices⌉ (Alonzo+) + tiered reference-script fee (Conway), all exact
    const fee = BigInt(body.fee ?? 0);
    const refScriptBytes = era >= 7 ? (tx.refScriptBytes ?? txRefScriptsSize(body, (r) => tx.resolved.get(r))) : 0;
    // Dijkstra: the limits and the tier price come from the protocol parameters (Conway: constants)
    const dRef = isDijkstraEra(era) ? dijkstraRefScriptParams(tx.params.raw) : null;
    checkTxRefScriptsSize(sink, era, refScriptBytes, dRef?.maxPerTx ?? undefined);
    if (tx.txSizeBytes != null) {
        let mem = 0n, steps = 0n;
        for (const r of effectiveRedeemers((tx.witnessSet?.redeemers ?? []) as any[], era)) {
            mem += BigInt(r.execUnits?.mem ?? r.exUnits?.mem ?? 0);
            steps += BigInt(r.execUnits?.steps ?? r.exUnits?.steps ?? 0);
        }
        const f = minFeeTx({
            minFeeA: tx.params.minFeeA,
            minFeeB: tx.params.minFeeB,
            priceMem: rationalOf(tx.params.priceMem),
            priceStep: rationalOf(tx.params.priceStep),
            refScriptCostPerByte: era >= 7 ? rationalOf(tx.params.minFeeRefScriptCostPerByte) : null,
            refScriptStride: dRef?.stride ?? undefined,
            refScriptMultiplier: dRef?.multiplier ?? undefined,
        }, era, tx.txSizeBytes, { mem, steps }, refScriptBytes);
        const baseMin = f.sizeFee + f.scriptFee;
        if (fee < baseMin) failures.push(`fee ${fee} below minimum ${baseMin} (size ${tx.txSizeBytes})`);
        else if (fee < f.total) {
            const msg = `fee ${fee} below minimum ${f.total} with reference-script fee ${f.refScriptFee} (${refScriptBytes} B)`;
            if (REF_SCRIPT_FEE_VERIFIED) failures.push(msg);
            else reports.push(msg);
        }
    } else {
        reports.push("fee not checked: tx size unknown (re-encoded)");
    }

    // 4. validity interval (Allegra+: the upper bound is exclusive)
    checkValidityInterval(sink, era, body, tx.slot);

    // 5. outputs: min UTxO, max value size, bootstrap attributes. Babbage+ checks the
    // collateral return like any output (`allSizedOutputsTxBodyF`).
    let bodyOutputSlices: Uint8Array[] | null | undefined;
    const outputBytesAt = (i: number, o: any): Uint8Array | null => {
        const own: Uint8Array | null = o?.cborRef?.toBuffer?.() ?? null;
        if (own) return own;
        if (bodyOutputSlices === undefined) {
            const bb = body?.cborRef?.toBuffer?.() ?? null;
            bodyOutputSlices = bb ? bodyOutputBytes(bb) : null;
        }
        return bodyOutputSlices?.[i] ?? null;
    };
    const outs: Array<{ label: string; o: any; bytes: Uint8Array | null }> = ((body.outputs ?? []) as any[]).map((o, i) => ({ label: `output ${i}`, o, bytes: outputBytesAt(i, o) }));
    if (era >= 6 && body.collateralReturn) {
        // ledger-ts keeps no slice for the collateral return; take body key 16's original bytes
        let bytes: Uint8Array | null = null;
        try { bytes = body.collateralReturn.cborRef?.toBuffer?.() ?? null; } catch { bytes = null; }
        if (!bytes) bytes = bodyFieldBytes(body, 16);
        outs.push({ label: "collateral return", o: body.collateralReturn, bytes });
    }
    for (const { label, o, bytes } of outs) {
        const lovelace = unitsOf(o.value).get("lovelace") ?? 0n;
        if (tx.params.coinsPerUtxoByte != null) {
            let size: number | null = bytes?.length ?? null;
            let original = size != null;
            if (size == null) {
                // No original slice (legacy array-form output without a sub-slice): the
                // re-encoding is the same bytes for canonical outputs, but a violation
                // measured on re-encoded bytes is a report, not a halt.
                try {
                    size = o.toCborBytes?.()?.length ?? null;
                } catch {
                    size = null;
                }
            }
            if (size != null) {
                const min = tx.params.coinsPerUtxoByte * BigInt(160 + size);
                if (lovelace < min) (original ? failures : reports).push(`${label} below min UTxO: ${lovelace} < ${min}${original ? "" : " (re-encoded size)"}`);
            } else {
                reports.push(`${label}: min UTxO not checked (no bytes)`);
            }
        } else if (tx.params.coinsPerUtxoWord != null) {
            // Alonzo: utxoEntrySize (27 + size(v) + 10 for a datum hash) × coinsPerUTxOWord
            const min = alonzoMinUtxo(unitsOf(o.value), tx.params.coinsPerUtxoWord, o.datum != null || o.datumHash != null);
            if (lovelace < min) failures.push(`${label} below min UTxO: ${lovelace} < ${min}`);
        } else if (tx.params.minUtxoValue != null) {
            // Shelley/Allegra: minUTxOValue; Mary: scaled by the value size
            const min = maryMinUtxo(unitsOf(o.value), tx.params.minUtxoValue);
            if (lovelace < min) failures.push(`${label} below min UTxO: ${lovelace} < ${min}`);
        }
    }
    checkOutputsTooBig(sink, era, tx.params.maxValSize, outs.map(({ label, o }) => ({ label, units: unitsOf(o.value) })));
    checkBootAddrAttrs(sink, outs.map(({ label, bytes }) => ({ label, bytes })));

    // 6. size
    if (tx.txSizeBytes != null && tx.txSizeBytes > tx.params.maxTxSize) failures.push(`tx size ${tx.txSizeBytes} > max ${tx.params.maxTxSize}`);

    // 7. network id on outputs (collateral return included), withdrawals and body.network
    const wantNet = tx.params.network;
    for (const { o } of outs) {
        const a = o.address;
        // ledger-ts decodes a bootstrap address inside a Shelley-era output as an
        // `Address` of type "byron" whose `network` is meaningless (mainnet epoch 208,
        // tx 2b240c39…: a Ddz… output reported as "testnet").
        if (a instanceof ByronAddress || String(a?.type ?? "").toLowerCase() === "byron") continue;
        const net = a?.network;
        if (net && net !== wantNet) failures.push(`output address on ${net}, node is on ${wantNet}`);
    }
    checkWithdrawalNetwork(sink, body, wantNet);
    if (body.network && String(body.network) !== wantNet) failures.push(`tx body network ${body.network} ≠ ${wantNet}`);

    // 8. witnesses: required keys ⊆ proven, bootstrap roots ⊆ proven roots, scripts provided + native scripts hold
    const req = requiredWitnesses(body, tx.resolved);
    // Dijkstra guards (key 14): key hashes are in `requiredSigners`; script guards need their script
    if (isDijkstraEra(era)) for (const g of (body.scriptGuards ?? []) as any[]) req.scriptHashes.add(hex(g.hash));
    for (const p of req.problems) reports.push(p);
    const missingKeys = [...req.keyHashes].filter((k) => !tx.provenKeys.has(k));
    if (missingKeys.length) failures.push(`missing vkey witness for ${missingKeys.length} key(s): ${missingKeys.slice(0, 2).map((k) => k.slice(0, 12) + "…").join(", ")}`);
    const missingRoots = [...req.bootstrapRoots].filter((r) => !tx.provenRoots.has(r));
    if (missingRoots.length) failures.push(`missing bootstrap witness for ${missingRoots.length} Byron address(es)`);

    const provided = new Map<string, { kind: "native" | "plutus"; script: any }>();
    /** Plutus language per script hash (witness set or reference script): V3 spends may omit the datum. */
    const plutusLanguages = new Map<string, PlutusLanguage>();
    const ws = tx.witnessSet ?? {};
    for (const s of (ws.nativeScripts ?? []) as any[]) provided.set(hex(s.hash), { kind: "native", script: s });
    const scriptLists: ReadonlyArray<readonly [string, PlutusLanguage]> = isDijkstraEra(era)
        ? [["plutusV1Scripts", 1], ["plutusV2Scripts", 2], ["plutusV3Scripts", 3], ["plutusV4Scripts", 4]]
        : [["plutusV1Scripts", 1], ["plutusV2Scripts", 2], ["plutusV3Scripts", 3]];
    for (const [key, lang] of scriptLists) {
        for (const s of (ws[key] ?? []) as any[]) {
            provided.set(hex(s.hash), { kind: "plutus", script: s });
            plutusLanguages.set(hex(s.hash), lang);
        }
    }
    // The ledger hashes witness scripts over their bytes as given (a double CBOR wrap
    // included); add those hashes from the original witness-set bytes.
    const wsBytes = witnessSetBytesOf(ws);
    /** `scriptTxWitsL`: the witness set's scripts keyed by the hash of their original bytes. */
    const witnessHashes = new Set<string>();
    const witnessScripts = wsBytes ? witnessScriptHashes(wsBytes, maxPlutusLanguage(era)) : new Map<string, WitnessScript>();
    if (wsBytes) {
        for (const [h, w] of witnessScripts) {
            witnessHashes.add(h);
            if (!provided.has(h)) provided.set(h, { kind: w.kind, script: w.kind === "native" ? (ws.nativeScripts ?? []).find((n: any) => hex(n.hash) === h) ?? null : null });
            if (w.kind === "plutus" && w.language && !plutusLanguages.has(h)) plutusLanguages.set(h, w.language);
        }
    }
    // reference scripts carried by spent or referenced outputs
    const refScriptHashes = new Set<string>();
    const refInputs: any[] = [...(body.refInputs ?? []), ...inputs];
    for (const i of refInputs) {
        const r = utxoRefOf(i);
        const u = r ? tx.resolved.get(r) : null;
        if (u?.referenceScriptHash) {
            refScriptHashes.add(u.referenceScriptHash);
            // A reference script may be native (`[0, script]`): it is then evaluated like a
            // witness native script and needs no redeemer.
            const refCbor = u.referenceScriptCbor ?? null;
            const isNative = !!refCbor && scriptLanguageOfCbor(refCbor, maxPlutusLanguage(era)) === null && refCbor.startsWith("8200");
            let native: any = null;
            if (isNative && refCbor) {
                try {
                    native = Script.fromCbor(refCbor);
                } catch {
                    native = null;
                }
            }
            // Babbage `getBabbageScriptsProvided`: reference scripts ∪ witness scripts (left-biased: the reference script)
            provided.set(u.referenceScriptHash, isNative ? { kind: "native", script: native } : { kind: "plutus", script: null });
            if (!isNative && refCbor) {
                const lang = scriptLanguageOfCbor(refCbor, maxPlutusLanguage(era));
                if (lang && !plutusLanguages.has(u.referenceScriptHash)) plutusLanguages.set(u.referenceScriptHash, lang);
            }
        }
    }
    const timelock = { signers: tx.provenKeys, validFrom: body.validityIntervalStart ?? null, validTo: body.ttl ?? null };
    const plutusScripts = new Set<string>();
    const nativeScriptHashes = new Set<string>();
    for (const [h, p] of provided) (p.kind === "plutus" ? plutusScripts : nativeScriptHashes).add(h);
    if (wsBytes) checkScriptWitnesses(sink, era, req.scriptHashes, witnessHashes, refScriptHashes);
    else {
        for (const h of req.scriptHashes) if (!provided.has(h)) failures.push(`script ${h.slice(0, 12)}… required but not provided`);
        if ([...provided.keys()].some((h) => !req.scriptHashes.has(h) && !refScriptHashes.has(h))) reports.push("ExtraneousScriptWitnessesUTXOW not checked: no witness-set bytes");
    }
    for (const h of req.scriptHashes) {
        const p = provided.get(h);
        if (p?.kind === "native") {
            const ns = nativeScriptTreeOf(p.script);
            if (!ns) reports.push(`native script ${h.slice(0, 12)}…: cannot decode for evaluation`);
            else if (!evalNativeScript(ns, timelock)) failures.push(`native script ${h.slice(0, 12)}… not satisfied`);
        }
        // Plutus scripts: phase-2 execution is Phase 3 of the plan; presence is enforced here.
    }

    // 8a. Babbage UTXOW: Plutus witness scripts and output reference scripts deserialise (bug 400)
    checkScriptsWellFormed(sink, era, pv, witnessScripts, outs.map(({ bytes }) => bytes));

    // 8b. withdrawals must take the whole reward balance, as of the state before the tx's certificates
    // (strict when the balances are exact; unregistered accounts are WithdrawalsMissingAccounts below)
    const balancesStrict = WITHDRAWALS_STRICT || tx.exactness?.exact === true;
    if (tx.rewardBalances && !isDijkstraEra(era)) {
        const rule = era >= 7 && (pv ?? 0) >= 11 ? "ConwayIncompleteWithdrawals" : era >= 7 ? "WithdrawalsNotInRewardsCERTS" : "WithdrawalsNotInRewardsDELEGS";
        for (const w of (body.withdrawals?.map ?? []) as any[]) {
            const cred = rewardAccountKey(w.rewardAccount);
            const bal = tx.rewardBalances.get(cred);
            const amt = BigInt(w.amount ?? 0);
            const msg = bal == null ? `withdrawal from ${cred.slice(0, 12)}…: no local reward balance` : bal !== amt ? `${rule}: withdrawal ${amt} ≠ reward balance ${bal} for ${cred.slice(0, 12)}…` : null;
            if (msg) { if (balancesStrict) failures.push(msg); else reports.push(`${msg} (report-only: ${tx.exactness?.why || "reward balances not proven exact"})`); }
        }
    }
    // 8c. Conway LEDGER: DRep-delegated withdrawals (protocol ≥ 10), treasury value
    checkWithdrawalAccounts(sink, body, era, tx.stakeRegistered, WITHDRAWAL_ACCOUNTS_STRICT);
    if (!isDijkstraEra(era)) checkWithdrawalsDelegated(sink, body, era, pv, tx.drepDelegated); // removed in Dijkstra
    if (era >= 7) checkTreasuryValue(sink, body, tx.treasury, TREASURY_VALUE_STRICT || tx.exactness?.exact === true, tx.exactness?.why);

    // 8d. auxiliary data: hash binding and metadatum sizes
    checkAuxiliaryData(sink, body, tx.auxDataBytes, pv);

    // 8e. Dijkstra: guards, direct deposits, account balance intervals, partial withdrawals (bug 428)
    if (isDijkstraEra(era)) {
        checkDijkstraTx(sink, {
            body,
            network: wantNet,
            rewardBalances: tx.rewardBalances,
            stakeRegistered: tx.stakeRegistered,
            providedScripts: provided,
            legacyMode: plutusLegacyMode(req.scriptHashes, plutusLanguages),
            strict: balancesStrict,
            why: tx.exactness?.why,
        });
    }

    // 9. Alonzo+ integrity: datums, collateral, ex units, redeemer ↔ purpose
    if (era >= 5) {
        // Datum hashes a witness datum may match without being needed: outputs of the tx
        // (Babbage: collateral return too) and, from Babbage, outputs of reference inputs.
        const supplementalAllowed = new Set<string>();
        for (const { label, o } of outs) {
            if (era < 6 && label === "collateral return") continue;
            const dh = extractLedgerTxOutMetadata(o).datumHash;
            if (dh) supplementalAllowed.add(dh.toLowerCase());
        }
        if (era >= 6) for (const h of datumHashesOf((body.refInputs ?? []) as any[], tx.resolved)) supplementalAllowed.add(h);
        const a = evaluateAlonzoRules({
            witnessSetBytes: wsBytes,
            rawParams: tx.params.raw ?? null,
            era: tx.era,
            body,
            witnessSet: ws,
            resolved: tx.resolved,
            plutusScripts,
            plutusLanguages,
            nativeScripts: nativeScriptHashes,
            supplementalAllowed,
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
