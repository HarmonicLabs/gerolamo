/**
 * Alonzo+ integrity rules (cardano-ledger UTXOW / UTXOS, minus script
 * execution, which is rules/plutusEval.ts):
 *
 *   datums     — every spent Plutus-script output must have its datum available
 *                (witness datum matching the hash, or an inline datum)
 *   collateral — collateral inputs are key-address outputs; ADA-only unless a
 *                collateral return is present; Σ ≥ ⌈fee · collateralPercent/100⌉;
 *                `total_collateral`, when set, equals Σ collateral − return
 *   ex units   — Σ redeemer units ≤ max per tx (block totals in blockRules)
 *   redeemers  — one redeemer per script purpose that needs one, none extra
 *   integrity  — script data hash (report-only: language views are byte-sensitive)
 */
import { hashData } from "@harmoniclabs/plutus-data";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { ledgerInputs, utxoRefOf } from "./resolvedUtxo";
import { parseStoredAddress } from "./requiredSigners";
import { unitsOf, type UnitMap } from "./value";
import { Address, ByronAddress, CredentialType } from "@harmoniclabs/cardano-ledger-ts";
import { costModelArrays, expectedScriptDataHash, scriptLanguageOfCbor, witnessDatumBytes, type PlutusLanguage } from "./scriptDataHash";
import { blake2b_256 } from "@harmoniclabs/crypto";

/** Strict: the recomputation matched 8/8 real preprod Babbage transactions (V1 and V2, with and without datums). */
export const SCRIPT_DATA_HASH_STRICT = true;

export interface AlonzoParams {
    collateralPercent: number;
    maxCollateralInputs: number | null;
    maxTxExMem: bigint | null;
    maxTxExSteps: bigint | null;
}

export interface AlonzoRuleInput {
    era: number;
    /** Only the collateral rules (transactions the block marks phase-2 invalid). */
    collateralOnly?: boolean;
    /** Original witness-set bytes and the parameter record, for the script data hash. */
    witnessSetBytes?: Uint8Array | null;
    rawParams?: Record<string, unknown> | null;
    body: any;
    witnessSet: any;
    resolved: Map<string, ResolvedUtxo>;
    /** Script hashes known to be Plutus (witness set or reference scripts). */
    plutusScripts: Set<string>;
    /** Plutus language per script hash where known: PlutusV3 spends may omit the datum (CIP-69). */
    plutusLanguages?: Map<string, PlutusLanguage>;
    /** Script hashes known to be native (witness set). */
    nativeScripts: Set<string>;
    params: AlonzoParams;
}

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

function paymentCredOf(address: string): { kind: "key" | "script" | "byron"; hash: string } | null {
    const a = parseStoredAddress(address);
    if (!a) return null;
    if (a instanceof ByronAddress) return { kind: "byron", hash: toHex(a.rootHash) };
    const pc: any = (a as Address).paymentCreds;
    const isScript = pc?.type === CredentialType.Script || pc?.type === 1 || pc?.type === "script";
    return { kind: isScript ? "script" : "key", hash: hex(pc?.hash) };
}

/** Sort inputs the way the ledger indexes them for redeemers (tx id, then index). */
export function sortedInputRefs(inputs: any[]): string[] {
    return inputs
        .map((i) => utxoRefOf(i))
        .filter((r): r is string => !!r)
        .sort((a, b) => {
            const [ai, ax] = a.split(":"), [bi, bx] = b.split(":");
            return ai! < bi! ? -1 : ai! > bi! ? 1 : Number(ax) - Number(bx);
        });
}

export function evaluateAlonzoRules(tx: AlonzoRuleInput): { failures: string[]; reports: string[] } {
    const failures: string[] = [];
    const reports: string[] = [];
    const body = tx.body;
    const ws = tx.witnessSet ?? {};
    const redeemersRaw: any[] = ws.redeemers ?? [];
    // Pre-Conway the list is decoded with Map.fromList: the last redeemer per purpose is
    // the effective one for ex-unit limits and fees (preview slot 12925989 lists one mint
    // redeemer six times).
    const redeemers: any[] = effectiveRedeemers(redeemersRaw, Number(tx.era));
    if (tx.collateralOnly) {
        // A phase-2-invalid transaction must actually run Plutus scripts …
        if (redeemers.length === 0) failures.push("marked invalid (phase-2) but carries no redeemers");
        // … and its collateral is what the ledger consumes, so it must be well-formed.
        checkCollateral(tx, failures, true);
        return { failures, reports };
    }

    // --- witness datums by hash: the ledger hashes the datum's *original bytes*, so
    // take them from the witness-set slice; re-encoding (hashData) is the fallback.
    const datumHashes = new Set<string>();
    const rawDatums = tx.witnessSetBytes ? witnessDatumBytes(tx.witnessSetBytes) : null;
    if (rawDatums) {
        for (const bytes of rawDatums) datumHashes.add(toHex(blake2b_256(bytes)));
    } else {
        for (const d of (ws.datums ?? []) as any[]) {
            try {
                datumHashes.add(toHex(hashData(d)));
            } catch {
                reports.push("witness datum could not be hashed");
            }
        }
    }

    // --- spent script inputs: datum available, redeemer present
    const spendRefs = sortedInputRefs(ledgerInputs(body.inputs ?? [], tx.era));
    /** Hashes of the Plutus scripts this transaction runs (the language view covers exactly these). */
    const neededHashes = new Set<string>();
    const neededSpend = new Set<number>();
    spendRefs.forEach((ref, idx) => {
        const u = tx.resolved.get(ref);
        if (!u) return;
        const pc = paymentCredOf(u.address);
        if (pc?.kind !== "script") return;
        if (tx.nativeScripts.has(pc.hash)) return; // native: no redeemer, no datum
        neededSpend.add(idx);
        neededHashes.add(pc.hash);
        const inline = !!u.inlineDatumCbor;
        const dh = u.datumHash;
        if (!inline && !dh) {
            // Conway (CIP-69): a PlutusV3 spending script takes an optional datum, so an output
            // without one is spendable. V1/V2 spends still need a datum.
            const lang = tx.plutusLanguages?.get(pc.hash) ?? null;
            if (lang === 3) { /* datum optional */ }
            else if (lang == null) reports.push(`input ${ref} is locked by a Plutus script of unknown version and carries no datum`);
            else failures.push(`input ${ref} is locked by a PlutusV${lang} script but carries no datum`);
        }
        else if (!inline && dh && !datumHashes.has(dh)) failures.push(`input ${ref}: datum ${dh.slice(0, 12)}… not in the witness set`);
    });

    // --- mint policies that are Plutus
    const mintPolicies: string[] = [];
    for (const e of (body.mint?.map ?? []) as any[]) {
        const p = hex(e.policy);
        if (p) mintPolicies.push(p);
    }
    mintPolicies.sort();
    const neededMint = new Set<number>();
    mintPolicies.forEach((p, idx) => {
        if (tx.plutusScripts.has(p)) { neededMint.add(idx); neededHashes.add(p); }
    });

    // --- certificates / withdrawals with script credentials
    const neededCert = new Set<number>();
    // Certificates that need no witness from their credential carry no redeemer either:
    // plain stake registration (0), pool registration/retirement (3, 4; witnessed by
    // pool keys), genesis delegation (5) and MIR (6).
    const NO_CERT_WITNESS = new Set([0, 3, 4, 5, 6]);
    ((body.certs ?? []) as any[]).forEach((c, idx) => {
        if (NO_CERT_WITNESS.has(Number(c.certType))) return;
        const cred = c.stakeCredential ?? c.drepCredential ?? c.coldCredential;
        const isScript = cred?.type === CredentialType.Script || cred?.type === 1 || cred?.type === "script";
        if (isScript && tx.plutusScripts.has(hex(cred.hash))) { neededCert.add(idx); neededHashes.add(hex(cred.hash)); }
    });
    const wdAccounts = ((body.withdrawals?.map ?? []) as any[]).map((w) => w.rewardAccount);
    const neededWd = new Set<number>();
    wdAccounts.forEach((acc: any, idx: number) => {
        const isScript = acc?.type === "script" || String(acc?.credentials?.constructor?.name ?? "").includes("Validator");
        if (isScript && tx.plutusScripts.has(hex(acc?.credentials?.hash ?? acc?.credentials))) { neededWd.add(idx); neededHashes.add(hex(acc?.credentials?.hash ?? acc?.credentials)); }
    });

    // --- Conway: votes cast by script credentials (CC / DRep scripts) and proposals guarded
    // by a policy script (the constitution's guardrail script) run Plutus scripts too.
    for (const entry of ((body.votingProcedures?.procedures ?? []) as any[])) {
        const kind = Number(entry?.voter?.kind);
        if (kind === 1 || kind === 3) { // ConstitutionalCommitteeScript, DRepScript
            const h = hex(entry.voter?.hash);
            if (h && tx.plutusScripts.has(h)) neededHashes.add(h);
        }
    }
    for (const pp of ((body.proposalProcedures ?? []) as any[])) {
        const h = hex(pp?.govAction?.policyHash);
        if (h && tx.plutusScripts.has(h)) neededHashes.add(h);
    }

    // --- redeemers ↔ purposes
    // The list form of the redeemers is decoded with Map.fromList in every era (a later entry
    // for the same purpose silently replaces an earlier one; preprod slot 24837046 carries six
    // for mint 0, preview slot 61206431 two for reward 0 under Conway). Conway's map form
    // cannot carry duplicate keys, so a duplicate here is never a failure.
    const seen = new Set<string>();
    for (const r of redeemersRaw) {
        const tag = Number(r.tag), idx = Number(r.index);
        const key = `${tag}:${idx}`;
        if (seen.has(key)) {
            reports.push(`duplicate redeemer for purpose ${key} (list form: last one wins)`);
            continue;
        }
        seen.add(key);
        const needed = tag === 0 ? neededSpend : tag === 1 ? neededMint : tag === 2 ? neededCert : tag === 3 ? neededWd : null;
        if (needed && !needed.has(idx)) failures.push(`extra redeemer: ${["spend", "mint", "cert", "withdraw"][tag]} index ${idx} needs no Plutus script`);
    }
    for (const [tag, needed] of [[0, neededSpend], [1, neededMint], [2, neededCert], [3, neededWd]] as const) {
        for (const idx of needed) {
            if (!seen.has(`${tag}:${idx}`)) failures.push(`missing redeemer: ${["spend", "mint", "cert", "withdraw"][tag]} index ${idx}`);
        }
    }

    // --- ex units
    let mem = 0n, steps = 0n;
    for (const r of redeemers) {
        mem += BigInt(r.execUnits?.mem ?? r.exUnits?.mem ?? 0);
        steps += BigInt(r.execUnits?.steps ?? r.exUnits?.steps ?? r.execUnits?.cpu ?? 0);
    }
    if (tx.params.maxTxExMem != null && mem > tx.params.maxTxExMem) failures.push(`execution memory ${mem} > max ${tx.params.maxTxExMem}`);
    if (tx.params.maxTxExSteps != null && steps > tx.params.maxTxExSteps) failures.push(`execution steps ${steps} > max ${tx.params.maxTxExSteps}`);

    const runsPlutus = neededSpend.size + neededMint.size + neededCert.size + neededWd.size > 0 || redeemers.length > 0;
    checkCollateral(tx, failures, runsPlutus);
    if (!redeemers.length && runsPlutus) failures.push("Plutus scripts needed but no redeemers");

    // --- script data hash: byte-exact recomputation from the witness set and the language views
    if (redeemers.length > 0 && !body.scriptDataHash) failures.push("redeemers present but no script_data_hash");
    if (redeemers.length === 0 && (ws.datums?.length ?? 0) === 0 && body.scriptDataHash) reports.push("script_data_hash present without redeemers or datums");
    if (tx.witnessSetBytes) {
        const langs = scriptDataLanguages(neededHashes, tx.plutusLanguages, ws, body, tx.resolved);
        const expected = expectedScriptDataHash({ witnessSetBytes: tx.witnessSetBytes, languages: langs, models: costModelArrays(tx.rawParams), alonzoForm: tx.era <= 6 });
        const actual = body.scriptDataHash ? hex(body.scriptDataHash) : null;
        if (expected.reason) reports.push(`script_data_hash not checked: ${expected.reason}`);
        else if (expected.hash && expected.hash !== actual) {
            const msg = `script_data_hash ${actual?.slice(0, 12) ?? "absent"} ≠ expected ${expected.hash.slice(0, 12)}… (languages ${[...langs].map((l) => `V${l}`).join(",") || "none"})`;
            if (SCRIPT_DATA_HASH_STRICT) failures.push(msg);
            else reports.push(msg);
        }
    }

    return { failures, reports };
}

/** Collateral rules (UTXO `collateralContainsNonADA`, `insufficientCollateral`, `TooManyCollateralInputs`, `IncorrectTotalCollateralField`). */
function checkCollateral(tx: AlonzoRuleInput, failures: string[], runsPlutus: boolean): void {
    if (!runsPlutus) return;
    const body = tx.body;
    const colls: any[] = body.collateralInputs ?? [];
    if (colls.length === 0) failures.push("Plutus scripts without collateral inputs");
    if (tx.params.maxCollateralInputs != null && colls.length > tx.params.maxCollateralInputs) failures.push(`${colls.length} collateral inputs > max ${tx.params.maxCollateralInputs}`);
    const total: UnitMap = new Map();
    for (const c of colls) {
        const ref = utxoRefOf(c);
        const u = ref ? tx.resolved.get(ref) : null;
        if (!u) {
            failures.push(`collateral input ${ref ?? "?"} not in the UTxO set`);
            continue;
        }
        const pc = paymentCredOf(u.address);
        if (pc?.kind === "script") failures.push(`collateral input ${ref} is a script address`);
        for (const [unit, q] of u.value) total.set(unit, (total.get(unit) ?? 0n) + q);
    }
    const ret = body.collateralReturn ? unitsOf(body.collateralReturn.value) : null;
    const net: UnitMap = new Map(total);
    if (ret) for (const [unit, q] of ret) net.set(unit, (net.get(unit) ?? 0n) - q);
    for (const [unit, q] of net) if (unit !== "lovelace" && q !== 0n) failures.push(`collateral carries non-ADA assets (${unit.slice(0, 12)}…) without a matching return`);
    const netAda = net.get("lovelace") ?? 0n;
    const fee = BigInt(body.fee ?? 0);
    const need = (fee * BigInt(tx.params.collateralPercent) + 99n) / 100n;
    if (colls.length && netAda < need) failures.push(`collateral ${netAda} < required ${need} (fee ${fee} × ${tx.params.collateralPercent}%)`);
    if (body.totCollateral != null && BigInt(body.totCollateral) !== netAda) failures.push(`total_collateral ${body.totCollateral} ≠ collateral − return ${netAda}`);
}

/**
 * Languages the script data hash's language view covers: those of the Plutus scripts
 * the transaction *needs* (spends, mints, certificates, withdrawals), not of every
 * script it can see. A reference input may carry an unrelated PlutusV2 script next
 * to a V3 spend; including it changed the hash (preview slot 68390403, bug 61).
 * Without a language map (older callers) fall back to witness-set and reference
 * script languages.
 */
export function scriptDataLanguages(
    neededHashes: Set<string>,
    plutusLanguages: Map<string, PlutusLanguage> | undefined,
    ws: any,
    body: any,
    resolved: Map<string, { referenceScriptCbor?: string | null }>,
): Set<PlutusLanguage> {
    const langs = new Set<PlutusLanguage>();
    if (plutusLanguages) {
        for (const h of neededHashes) {
            const l = plutusLanguages.get(h);
            if (l) langs.add(l);
        }
        if (langs.size > 0 || ((ws.redeemers?.length ?? 0) === 0 && !(ws.redeemers instanceof Map))) return langs;
        // Redeemers but no needed script recognised (a purpose this rule does not model yet):
        // the witness-set scripts are the ledger's best available answer rather than "none".
    }
    if ((ws.plutusV1Scripts?.length ?? 0) > 0) langs.add(1);
    if ((ws.plutusV2Scripts?.length ?? 0) > 0) langs.add(2);
    if ((ws.plutusV3Scripts?.length ?? 0) > 0) langs.add(3);
    for (const i of [...(body.inputs ?? []), ...(body.refInputs ?? [])] as any[]) {
        const r = utxoRefOf(i);
        const u = r ? resolved.get(r) : null;
        if (u?.referenceScriptCbor) {
            const l = scriptLanguageOfCbor(u.referenceScriptCbor);
            if (l) langs.add(l);
        }
    }
    return langs;
}

/**
 * The redeemers the ledger actually keeps: the witness-set *list* form is decoded with
 * Map.fromList in every era, so a later entry for the same (tag, index) replaces an
 * earlier one (preview slot 61206431, protocol 9, lists the same reward redeemer twice).
 * Conway's map form cannot carry duplicate keys at all, so collapsing is always right.
 */
export function effectiveRedeemers(redeemers: readonly any[], _era: number): any[] {
    const byKey = new Map<string, any>();
    for (const r of redeemers) byKey.set(`${Number(r.tag)}:${Number(r.index)}`, r);
    return [...byKey.values()];
}
