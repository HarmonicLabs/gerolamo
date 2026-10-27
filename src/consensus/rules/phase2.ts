/**
 * Plutus phase-2 validation (the ledger's UTXOS `evalScripts`): every redeemer's script runs
 * against its script context within the redeemer's declared execution units, and the verdict
 * must equal the transaction's `is_valid` flag.
 *
 * Entry points:
 * - `evaluatePhase2` — evaluate one transaction (block replay, shadow, tests);
 * - `checkBlockTxPhase2` — the block rule: an is_valid=true transaction whose scripts fail, or an
 *   is_valid=false transaction whose scripts all pass, makes the block invalid;
 * - `checkMempoolTxPhase2` — the mempool rule: the ledger's `ValidationTagMismatch` /
 *   `CollectErrors` rejections, for the transaction-submission path.
 *
 * Everything is derived from the transaction's bytes and the resolved inputs (context.ts),
 * evaluated by the CEK machine in src/consensus/plutus (cek.ts). A verdict is only given when
 * the evaluation could be carried out; `error` marks the cases where it could not (a missing
 * script or datum, an unresolvable input — phase-1 matters — or an evaluator limitation), which
 * callers must treat as "no verdict", never as a script failure.
 */
import { settings } from "../../config/settings";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { parseCbor } from "../plutus/cbor";
import { ContextError, TxContext, type Purpose } from "../plutus/context";
import { DConstr, type Data } from "../plutus/data";
import { costTable, type Lang } from "../plutus/costs";
import { applyData, decodeProgram, FlatError, type Program } from "../plutus/flat";
import { evaluate } from "../plutus/cek";
import { T, VCon } from "../plutus/values";
import { costModelArrays } from "./scriptDataHash";
import type { EpochBodyParams } from "../epochParams";
import type { ResolvedUtxo } from "./resolvedUtxo";
import { normalizeEpochNetwork, slotToUnixTime } from "../../utils/epochFromSlotCalculations";

export interface Phase2Input {
    era: number;
    bodyBytes: Uint8Array;
    witnessSetBytes: Uint8Array;
    resolved: Map<string, ResolvedUtxo>;
    params: EpochBodyParams | null;
    /** The transaction's is_valid flag is false. */
    markedInvalid: boolean;
    /** Keep script trace messages (diagnostics). */
    traces?: boolean;
    /** Network whose slot geometry turns validity bounds into POSIX time (default: the process-wide one). */
    network?: string;
    /** Run every script with this budget instead of its redeemer's declared units (UTxO RPC EvalTx, Blockfrost / Ogmios evaluate measure the cost). */
    budget?: { mem: bigint; cpu: bigint };
}

export interface RedeemerOutcome {
    tag: number; index: number;
    scriptHash: string | null;
    language: Lang | null;
    declared: { mem: bigint; cpu: bigint };
    spent?: { mem: bigint; cpu: bigint };
    ok: boolean;
    reason?: string;
    logs?: string[];
    ms?: number;
}

export interface Phase2Result {
    /** Every script ran and succeeded within its declared units (meaningful only when `error` is null). */
    ok: boolean;
    /**
     * No verdict: the evaluation could not be carried out. `collect` is a ledger collect error
     * (the transaction cannot be translated: invalid whatever its is_valid flag says).
     */
    error: string | null;
    collect?: boolean;
    redeemers: RedeemerOutcome[];
}

// ── scripts ──
const programCache = new Map<string, Program | FlatError>();
function program(hash: string, lang: Lang, pv: number, scriptBytes: Uint8Array): Program {
    // decoding depends on the protocol version up to 11 (bounds, builtins) and at 12 (Plutus Core 1.2.0, V4)
    const key = `${hash}:${lang}:${pv >= 12 ? 12 : pv >= 11 ? 11 : pv}`;
    let p = programCache.get(key);
    if (!p) {
        try { p = decodeProgram(unwrapFlat(scriptBytes), lang, pv); } catch (e) { p = e instanceof FlatError ? e : new FlatError(String((e as Error)?.message ?? e)); }
        programCache.set(key, p);
        if (programCache.size > 1024) programCache.delete(programCache.keys().next().value!);
    }
    if (p instanceof FlatError) throw p;
    return p;
}
/** Protocol version each Plutus language is introduced in (`ledgerLanguageIntroducedIn`). */
const LANGUAGE_INTRODUCED_IN: Record<Lang, number> = { 1: 5, 2: 7, 3: 9, 4: 12 }; // V4: Dijkstra (bug 433)

const wellFormedCache = new Map<string, string | null>();
/**
 * plutus-ledger-api `deserialiseScript` as the Babbage UTXOW `validateScriptsWellFormed` uses it
 * (`isValidPlutusScript`): the language exists at protocol `pv`, the bytes are one CBOR bytestring
 * (nothing after it from Plutus V3 on: `RemainderError`) holding a flat program that decodes at `pv`
 * (builtins and constant bounds of the language at that protocol version). The Plutus Core version's
 * availability and the term's scoping are evaluation checks (`mkTermToEvaluate`, phase 2), not
 * checked here: preview carries Plutus V2 reference scripts of version 1.1.0 from protocol 8.
 * Returns null when the script is well formed, else why not.
 */
export function plutusScriptMalformed(hash: string, lang: Lang, pv: number, scriptBytes: Uint8Array): string | null {
    const key = `${hash}:${lang}:${pv}`;
    const hit = wellFormedCache.get(key);
    if (hit !== undefined) return hit;
    const why = scriptMalformed(lang, pv, scriptBytes);
    wellFormedCache.set(key, why);
    if (wellFormedCache.size > 4096) wellFormedCache.delete(wellFormedCache.keys().next().value!);
    return why;
}
function scriptMalformed(lang: Lang, pv: number, scriptBytes: Uint8Array): string | null {
    if (pv < LANGUAGE_INTRODUCED_IN[lang]) return `Plutus V${lang} is not available at protocol ${pv}`;
    let n: ReturnType<typeof parseCbor>;
    try { n = parseCbor(scriptBytes); } catch (e) { return `not CBOR: ${(e as Error).message}`; }
    if (n.t !== "b") return "script is not a CBOR bytestring";
    if (lang >= 3 && n.e !== scriptBytes.length) return `${scriptBytes.length - n.e} byte(s) after the script bytestring`;
    try { decodeProgram(n.v, lang, pv, { deserialiseOnly: true }); } catch (e) { return e instanceof FlatError ? e.message : String((e as Error)?.message ?? e); }
    return null;
}

/** A Plutus script's bytes are a CBOR bytestring holding the flat program. */
function unwrapFlat(b: Uint8Array): Uint8Array {
    const n = parseCbor(b);
    if (n.t !== "b") throw new FlatError("script is not a CBOR bytestring");
    return n.v;
}
function scriptsOf(ctx: TxContext, resolved: Map<string, ResolvedUtxo>): Map<string, { lang: Lang; bytes: Uint8Array }> {
    const out = new Map<string, { lang: Lang; bytes: Uint8Array }>(ctx.witnessScripts);
    for (const ref of [...ctx.inputs, ...ctx.refInputs]) {
        const u = resolved.get(`${toHex(ref[0])}:${ref[1]}`);
        if (!u?.referenceScriptCbor) continue;
        try {
            const n = parseCbor(Buffer.from(u.referenceScriptCbor, "hex"));
            if (n.t !== "a" || n.v[0]?.t !== "u" || n.v[1]?.t !== "b") continue;
            const lang = Number(n.v[0].v);
            if (lang < 1 || lang > (ctx.era >= 8 ? 4 : 3)) continue; // tag 4 (Plutus V4) from Dijkstra
            const hash = u.referenceScriptHash?.toLowerCase();
            if (hash) out.set(hash, { lang: lang as Lang, bytes: n.v[1].v });
        } catch { /* not a script */ }
    }
    return out;
}

/** Body keys only Dijkstra has (14 as credentials, 23..27): their V1..V3 translation is not ported. */
function dijkstraOnlyBodyKeys(ctx: TxContext): number[] {
    const out: number[] = [];
    const body: any = (ctx as any).body;
    for (const e of Array.isArray(body) ? body : []) {
        const k = Number(e?.[0]?.v ?? -1);
        if (k >= 23 && k <= 27) out.push(k);
    }
    return out;
}


export function slotToPosixMs(slot: bigint, network?: string): bigint {
    // Only a name the geometry table knows selects a clock; anything else ("testnet" in the config
    // files) would be normalised to preprod (bug 168) — use the process-wide network instead.
    const n = String(network ?? "").trim().toLowerCase();
    const known = n === "mainnet" || n === "preview" || n === "preprod" || n === "custom";
    return BigInt(known ? slotToUnixTime(slot, normalizeEpochNetwork(n)) : slotToUnixTime(slot)) * 1000n;
}

export async function evaluatePhase2(input: Phase2Input): Promise<Phase2Result> { return evaluatePhase2Sync(input); }

export function evaluatePhase2Sync(input: Phase2Input): Phase2Result {
    const pv = Number(input.params?.protocolMajor ?? 0);
    let ctx: TxContext;
    try {
        ctx = new TxContext({ era: input.era, pv, bodyBytes: input.bodyBytes, witnessSetBytes: input.witnessSetBytes, resolved: input.resolved, slotToPosixMs: (s) => slotToPosixMs(s, input.network) });
    } catch (e) {
        return { ok: false, error: `transaction decoding failed: ${(e as Error).message}`, redeemers: [] };
    }
    const models = costModelArrays(input.params?.raw ?? {});
    const scripts = scriptsOf(ctx, input.resolved);
    const outcomes: RedeemerOutcome[] = [];
    // collect (the ledger's collectPlutusScriptsWithContext): every redeemer's script, context and arguments
    const jobs: Array<{ out: RedeemerOutcome; term: Program; lang: Lang; arr: ReadonlyArray<number | bigint> }> = [];
    for (const r of ctx.redeemers) {
        const out: RedeemerOutcome = { tag: r.tag, index: r.index, scriptHash: null, language: null, declared: { mem: r.mem, cpu: r.cpu }, ok: false };
        outcomes.push(out);
        if (ctx.era >= 8 && r.tag > 5) return { ok: false, error: `redeemer tag ${r.tag} (guarding) is not supported yet (bug 435)`, redeemers: outcomes };
        const p: Purpose | null = ctx.purposeOf(r);
        if (!p) return { ok: false, error: `redeemer ${r.tag}:${r.index} points to nothing`, redeemers: outcomes };
        const hash = ctx.scriptHashOf(p);
        out.scriptHash = hash;
        if (!hash) return { ok: false, error: `redeemer ${r.tag}:${r.index} is not for a script-locked item`, redeemers: outcomes };
        const script = scripts.get(hash);
        if (!script) return { ok: false, error: `script ${hash.slice(0, 12)}… for redeemer ${r.tag}:${r.index} not found (or not Plutus)`, redeemers: outcomes };
        out.language = script.lang;
        // Dijkstra (bug 435): the Plutus V4 script context and the V1..V3 contexts of transactions
        // using Dijkstra-only fields are not built yet: no verdict (reported, never a failure)
        if (ctx.era >= 8 && script.lang === 4) return { ok: false, error: "Plutus V4 script context is not implemented yet (bug 435)", redeemers: outcomes };
        if (ctx.era >= 8 && dijkstraOnlyBodyKeys(ctx).length) return { ok: false, error: `Plutus V${script.lang} context of a Dijkstra transaction with body keys ${dijkstraOnlyBodyKeys(ctx).join(", ")} is not built yet (bug 435)`, redeemers: outcomes };
        const arr = models[script.lang];
        if (!arr) return { ok: false, error: `no cost model for Plutus V${script.lang}`, collect: true, redeemers: outcomes };
        let prog: Program;
        try { prog = program(hash, script.lang, pv, script.bytes); }
        catch (e) { return { ok: false, error: `script ${hash.slice(0, 12)}… does not decode: ${(e as Error).message}`, redeemers: outcomes }; }
        let term: Program;
        try {
            const info = ctx.txInfo(script.lang as 1 | 2 | 3); // V4 returned "no verdict" above
            if (script.lang === 3) {
                term = applyData(prog, [new DConstr(0n, [info, r.data, ctx.scriptInfoData(p)])]);
            } else {
                const sc = new DConstr(0n, [info, ctx.purposeData(p, script.lang)]);
                const args: Data[] = [];
                if (p.tag === 0) {
                    const d = ctx.spendingDatum(p);
                    if (!d) return { ok: false, error: `no datum for spend redeemer ${r.index}`, redeemers: outcomes };
                    args.push(d);
                }
                args.push(r.data, sc);
                term = applyData(prog, args);
            }
        } catch (e) {
            if (e instanceof ContextError) return { ok: false, error: `script context: ${e.message}`, collect: true, redeemers: outcomes };
            return { ok: false, error: `script context build failed: ${(e as Error).message}`, redeemers: outcomes };
        }
        jobs.push({ out, term, lang: script.lang, arr });
    }
    // evaluate
    let allOk = true;
    for (const j of jobs) {
        const costs = costTable(j.lang, j.arr, pv);
        const t0 = performance.now();
        const budget = input.budget ?? j.out.declared;
        const res = evaluate(j.term, costs, { cpu: Number(budget.cpu), mem: Number(budget.mem) }, { logs: !!input.traces, pv });
        j.out.ms = performance.now() - t0;
        j.out.spent = { cpu: BigInt(res.cpu), mem: BigInt(res.mem) };
        if (input.traces) j.out.logs = res.logs;
        let ok = res.ok;
        if (ok && j.lang === 3 && !(res.result instanceof VCon && res.result.type === T.unit)) { ok = false; j.out.reason = "a Plutus V3 script must return unit"; }
        else if (!ok) j.out.reason = res.error;
        if (!ok && res.error?.startsWith("evaluator limit")) return { ok: false, error: `redeemer ${j.out.tag}:${j.out.index}: ${res.error}`, redeemers: outcomes };
        j.out.ok = ok;
        if (!ok) allOk = false;
    }
    return { ok: allOk, error: null, redeemers: outcomes };
}

// ── rules ──

/**
 * How phase 2 runs (`--plutus-phase2`): `enforce` — every Plutus transaction is evaluated
 * in the block rules and a verdict mismatch fails the block; `report` — evaluated in the
 * detached shadow job, mismatches only logged and counted; `off`. "No verdict" cases are
 * reported in every mode, never failed.
 */
export type Phase2Mode = "enforce" | "report" | "off";
export const PHASE2_DEFAULT_MODE: Phase2Mode = "enforce"; // zero mismatches over the whole preview history (bug 214); `report` for a preprod/mainnet proving run
export function phase2Mode(): Phase2Mode {
    const v = settings().plutusPhase2;
    return v === "enforce" || v === "report" || v === "off" ? v : PHASE2_DEFAULT_MODE;
}

export type Phase2Verdict =
    | { kind: "ok" }
    /** Scripts failed although is_valid = true, or all passed although is_valid = false. */
    | { kind: "tag-mismatch"; detail: string }
    /** The transaction cannot be translated for its scripts (invalid whatever the flag). */
    | { kind: "collect-error"; detail: string }
    /** No verdict could be computed (treat as unknown, never as invalid). */
    | { kind: "unknown"; detail: string };

function describeFailure(r: Phase2Result): string {
    return r.redeemers.filter((x) => !x.ok && x.spent).map((x) => `redeemer ${x.tag}:${x.index} (V${x.language}) ${x.reason ?? "failed"} [cpu ${x.spent!.cpu}/${x.declared.cpu}, mem ${x.spent!.mem}/${x.declared.mem}]`).join("; ");
}

export function verdictOf(input: Phase2Input, r: Phase2Result): Phase2Verdict {
    if (r.error) return r.collect ? { kind: "collect-error", detail: r.error } : { kind: "unknown", detail: r.error };
    if (!input.markedInvalid && !r.ok) return { kind: "tag-mismatch", detail: `is_valid = true but ${describeFailure(r)}` };
    if (input.markedInvalid && r.ok) return { kind: "tag-mismatch", detail: "is_valid = false but every script succeeded" };
    return { kind: "ok" };
}

/** Block rule for one transaction with redeemers. */
export function checkBlockTxPhase2(input: Phase2Input): { verdict: Phase2Verdict; result: Phase2Result } {
    const result = evaluatePhase2Sync(input);
    return { verdict: verdictOf(input, result), result };
}

/**
 * Mempool rule (for the transaction-submission path): the ledger's failure for a submitted
 * transaction, or null when phase 2 accepts it. `ValidationTagMismatch` covers both directions
 * (`FailedUnexpectedly` with the PlutusFailure details, `PassedUnexpectedly`); `CollectErrors`
 * a context that cannot be built. `unknown` means no verdict could be computed: the caller
 * decides (the cautious choice is to keep the transaction out of the mempool).
 */
/**
 * Mempool entry point on a whole transaction (`[body, witnesses, is_valid, auxiliary_data]` CBOR,
 * as submitted): splits the original body and witness bytes and runs `checkMempoolTxPhase2`.
 * `resolved` must hold every spending, collateral and reference input.
 */
export function checkMempoolTxBytesPhase2(txBytes: Uint8Array, era: number, resolved: Map<string, ResolvedUtxo>, params: EpochBodyParams | null) {
    const n = parseCbor(txBytes);
    if (n.t !== "a" || n.v.length < 3) throw new Error("not a transaction");
    const [body, wits, flag] = n.v as [any, any, any];
    const markedInvalid = flag.t === "simple" && flag.v === false;
    return checkMempoolTxPhase2({ era, bodyBytes: txBytes.subarray(body.s, body.e), witnessSetBytes: txBytes.subarray(wits.s, wits.e), resolved, params, markedInvalid });
}

export function checkMempoolTxPhase2(input: Phase2Input): { failure: null | { kind: "ValidationTagMismatch" | "CollectErrors" | "Unknown"; isValid: boolean; detail: string; redeemers: RedeemerOutcome[] } } {
    const r = evaluatePhase2Sync(input);
    const v = verdictOf(input, r);
    const isValid = !input.markedInvalid;
    if (v.kind === "ok") return { failure: null };
    if (v.kind === "tag-mismatch") return { failure: { kind: "ValidationTagMismatch", isValid, detail: v.detail, redeemers: r.redeemers } };
    if (v.kind === "collect-error") return { failure: { kind: "CollectErrors", isValid, detail: v.detail, redeemers: r.redeemers } };
    return { failure: { kind: "Unknown", isValid, detail: v.detail, redeemers: r.redeemers } };
}
