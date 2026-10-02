/**
 * CEK machine for Plutus phase-2 evaluation (plutus-core `UntypedPlutusCore.Evaluation.Machine.Cek`).
 *
 * Replaces plutus-machine's evaluator on the validation path: that one cloned the environment
 * array on every lambda, delay and application frame, cloned every value on each variable
 * lookup, kept every binding alive in a global heap, and charged the budget in BigInt objects
 * — about 1000× slower than cardano-node. Here environments are persistent linked lists,
 * frames are a plain array, the budget is two Numbers (exact below 2^53, far above any budget),
 * and builtins run on the evaluator's own values (builtins.ts).
 *
 * Semantics follow the specification: every step charges its machine cost, a builtin takes
 * exactly its forces and then its arguments, its cost is charged before it runs, and exceeding
 * the budget is a failure. The verdict equals the reference machine's (which charges steps in
 * batches of 200): costs only accumulate, so a run that ends within budget never exceeded it.
 */
import { TK, type Term } from "./flat";
import { Env, T_LIST_DATA, UNIT, VBuiltin, VCon, VConstr, VDelay, VLam, VPair, listHead, listIsEmpty, listTail, mkListFromArray, type Value } from "./values";
import { DK } from "./data";
import { EvalFailure, EvalUnsupported, SIGNATURE, callBuiltin, newBnCek, type BuiltinCtx } from "./builtins";
import { clampNum, type CostTable } from "./costs";
import { costModelV3ToBuiltinCosts, legacyIntegerCosts } from "@harmoniclabs/plutus-machine/dist/Machine/BuiltinCosts/BuiltinCosts.js";
import { defaultV3Costs } from "@harmoniclabs/cardano-costmodels-ts";

export class BudgetExceeded extends Error { constructor(readonly cpu: number, readonly mem: number) { super("execution budget exceeded"); } }

export interface EvalResult {
    ok: boolean;
    /** Units consumed (up to the point of failure when not ok). */
    cpu: number;
    mem: number;
    error?: string;
    budgetExceeded?: boolean;
    logs: string[];
    result?: Value;
}

const enum FK { Force = 0, Arg = 1, Fun = 2, Constr = 3, Case = 4, ApplyTo = 5 }
interface Frame { k: FK; t?: any; env?: Env | null; v?: Value; tag?: number; done?: Value[]; i?: number }

/** BigInt cost lookup for the builtins delegated to plutus-machine (same named parameters). */
function bigLookup(costs: CostTable): (tag: number) => any {
    const anyCosts = costs as any;
    if (anyCosts._big) return anyCosts._big;
    const v3: Record<string, number> = { ...(defaultV3Costs as any) };
    for (const [k, v] of costs.named) if (k in v3) v3[k] = clampNum(v);
    let lookup: (tag: number) => any = costModelV3ToBuiltinCosts(v3 as any);
    if (costs.lang !== 3) { const legacy: Record<string, number> = {}; for (const [k, v] of costs.named) legacy[k] = clampNum(v); lookup = legacyIntegerCosts(legacy, lookup); }
    Object.defineProperty(anyCosts, "_big", { value: lookup, enumerable: false });
    return lookup;
}

/**
 * Evaluate `term` (a program body applied to its arguments) within `budget`.
 * `logs`: collect trace messages (diagnostics).
 */
export function evaluate(term: Term, costs: CostTable, budget: { cpu: number; mem: number }, opts: { logs?: boolean; pv?: number } = {}): EvalResult {
    // `case` on a builtin constant: from van Rossem (protocol 11) except on Data, which Dijkstra (12) adds
    const pv = opts.pv ?? 0;
    const M = costs.machine;
    const [cVar, mVar] = M.var, [cConst, mConst] = M.constant, [cLam, mLam] = M.lam, [cDelay, mDelay] = M.delay;
    const [cForce, mForce] = M.force, [cApply, mApply] = M.apply, [cBuiltin, mBuiltin] = M.builtin, [cConstr, mConstr] = M.constr, [cCase, mCase] = M.case;
    const maxCpu = budget.cpu, maxMem = budget.mem;
    let cpu = M.startup[0], mem = M.startup[1];
    const logs: string[] = [];
    const ctx: BuiltinCtx = {
        spend(c: number, m: number) { cpu += c; mem += m; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); },
        costs, legacy: costs.lang !== 3, textByBytes: costs.variant === "D" || costs.variant === "E", bounded: costs.variant === "D" || costs.variant === "E",
        logs: opts.logs ? logs : null, bnCek: null,
    };
    let bn: any = null;
    Object.defineProperty(ctx, "bnCek", { get: () => (bn ??= newBnCek(ctx, bigLookup(costs))) });

    const stack: Frame[] = [];
    let env: Env | null = null;
    let value: Value = UNIT;
    let t: Term = term;
    try {
        if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
        compute: for (;;) {
            // ── compute mode: t, env ──
            let returning = false;
            switch (t.k) {
                case TK.Var: {
                    cpu += cVar; mem += mVar;
                    let e = env, i = t.i;
                    while (--i > 0 && e) e = e.next;
                    if (!e) throw new EvalFailure("unbound variable");
                    value = e.v; returning = true; break;
                }
                case TK.Const: cpu += cConst; mem += mConst; value = t.v; returning = true; break;
                case TK.Lam: cpu += cLam; mem += mLam; value = new VLam(t.b, env!); returning = true; break;
                case TK.Delay: cpu += cDelay; mem += mDelay; value = new VDelay(t.b, env!); returning = true; break;
                case TK.Force: cpu += cForce; mem += mForce; stack.push({ k: FK.Force }); t = t.b; break;
                case TK.Apply: cpu += cApply; mem += mApply; stack.push({ k: FK.Arg, t: t.a, env }); t = t.f; break;
                case TK.Builtin: {
                    cpu += cBuiltin; mem += mBuiltin;
                    const s = SIGNATURE[t.fn];
                    if (!s) throw new EvalFailure(`builtin ${t.fn} is not supported`);
                    value = t.cached ??= new VBuiltin(t.fn, s[0], []);
                    returning = true; break;
                }
                case TK.Error: throw new EvalFailure("error term evaluated");
                case TK.Constr:
                    cpu += cConstr; mem += mConstr;
                    if (t.fields.length === 0) { value = new VConstr(t.tag, []); returning = true; break; }
                    stack.push({ k: FK.Constr, tag: t.tag, t: t.fields, i: 1, done: [], env });
                    t = t.fields[0]!; break;
                case TK.Case: cpu += cCase; mem += mCase; stack.push({ k: FK.Case, t: t.bs, env }); t = t.s; break;
            }
            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
            if (!returning) continue;
            // ── return mode: value ──
            for (;;) {
                const f = stack.pop();
                if (f === undefined) break compute;
                switch (f.k) {
                    case FK.Arg: stack.push({ k: FK.Fun, v: value }); t = f.t; env = f.env!; continue compute;
                    case FK.Fun: case FK.ApplyTo: {
                        // Fun: the frame holds the function, `value` is the argument; ApplyTo (case
                        // branches): the frame holds the argument, `value` is the function.
                        const fn = f.k === FK.Fun ? f.v! : value, arg = f.k === FK.Fun ? value : f.v!;
                        if (fn instanceof VLam) { env = new Env(arg, fn.env); t = fn.body; continue compute; }
                        if (fn instanceof VBuiltin) {
                            if (fn.forces > 0) throw new EvalFailure("builtin applied to a term before its forces");
                            const arity = SIGNATURE[fn.fn]![1];
                            const args = fn.args.length === 0 ? [arg] : [...fn.args, arg];
                            if (args.length < arity) { value = new VBuiltin(fn.fn, 0, args); continue; }
                            value = callBuiltin(ctx, fn.fn, args);
                            continue;
                        }
                        throw new EvalFailure("application of a non-function");
                    }
                    case FK.Force: {
                        if (value instanceof VDelay) { env = value.env; t = value.body; continue compute; }
                        if (value instanceof VBuiltin && value.forces > 0) {
                            if (value.args.length > 0) throw new EvalFailure("builtin forced after an argument");
                            value = new VBuiltin(value.fn, value.forces - 1, value.args);
                            continue;
                        }
                        throw new EvalFailure("force of a non-delayed value");
                    }
                    case FK.Constr: {
                        f.done!.push(value);
                        const terms = f.t as Term[];
                        if (f.i! < terms.length) { t = terms[f.i!++]!; env = f.env!; stack.push(f); continue compute; }
                        value = new VConstr(f.tag!, f.done!);
                        continue;
                    }
                    case FK.Case: {
                        const bs = f.t as Term[];
                        if (value instanceof VCon) {
                            // caseBuiltinDefault / caseBuiltinNoData (PlutusCore.Default.Universe)
                            if (pv < 11) throw new EvalFailure("case on a builtin constant is not available before protocol 11");
                            const v = value as VCon, n = bs.length;
                            let branch: Term | undefined, spine: VCon[] = [];
                            switch (v.type.tag) {
                                case 3: if (n === 1) branch = bs[0]; break;
                                case 4: if (v.v === false && (n === 1 || n === 2)) branch = bs[0]; else if (v.v === true && n === 2) branch = bs[1]; break;
                                case 0: if (v.v >= 0n && v.v < BigInt(n)) branch = bs[Number(v.v)]; break;
                                case 5: {
                                    const empty = listIsEmpty(v.v);
                                    if (n === 1 && empty) throw new EvalFailure("case on an empty list with one branch");
                                    if (n === 1 || n === 2) { if (empty) branch = bs[1]; else { branch = bs[0]; spine = [new VCon(v.type.a!, listHead(v.v)), new VCon(v.type, listTail(v.v))]; } }
                                    break;
                                }
                                case 6: if (n === 1) { branch = bs[0]; spine = [new VCon(v.type.a!, (v.v as VPair).fst), new VCon(v.type.b!, (v.v as VPair).snd)]; } break;
                                case 8: {
                                    if (pv < 12) throw new EvalFailure("case on Data is not available before protocol 12");
                                    const d = v.v;
                                    if (d.k !== DK.Constr) throw new EvalFailure("case on Data only supports Constr values");
                                    if (d.tag >= 0n && d.tag < BigInt(n)) { branch = bs[Number(d.tag)]; spine = [new VCon(T_LIST_DATA, mkListFromArray(d.fields))]; }
                                    break;
                                }
                                default: throw new EvalFailure(`case on a ${v.type.key} constant is not supported`);
                            }
                            if (!branch) throw new EvalFailure("case on a builtin constant: out of bounds for the given branches");
                            for (let i = spine.length - 1; i >= 0; i--) stack.push({ k: FK.ApplyTo, v: spine[i] });
                            t = branch; env = f.env!;
                            continue compute;
                        }
                        if (!(value instanceof VConstr)) throw new EvalFailure("case on a non-constructor value");
                        if (value.tag >= bs.length) throw new EvalFailure(`case: no branch for constructor ${value.tag}`);
                        // the branch is applied to the fields in order (transferArgStack): first field on top
                        const fs = value.fields;
                        for (let i = fs.length - 1; i >= 0; i--) stack.push({ k: FK.ApplyTo, v: fs[i] });
                        t = bs[value.tag]!; env = f.env!;
                        continue compute;
                    }
                }
            }
        }
        return { ok: true, cpu, mem, logs, result: value };
    } catch (e) {
        if (e instanceof BudgetExceeded) return { ok: false, cpu: e.cpu, mem: e.mem, error: "budget exceeded", budgetExceeded: true, logs };
        if (e instanceof EvalUnsupported) return { ok: false, cpu, mem, error: `evaluator limit: ${e.message}`, logs };
        if (e instanceof EvalFailure) return { ok: false, cpu, mem, error: e.message, logs };
        if (e instanceof RangeError) return { ok: false, cpu, mem, error: `evaluator limit: ${e.message}`, logs };
        throw e;
    }
}
