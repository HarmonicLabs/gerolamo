/**
 * CEK machine for Plutus phase-2 evaluation (plutus-core `UntypedPlutusCore.Evaluation.Machine.Cek`).
 *
 * Replaces plutus-machine's evaluator on the validation path: that one cloned the environment
 * array on every lambda, delay and application frame, cloned every value on each variable
 * lookup, kept every binding alive in a global heap, and charged the budget in BigInt objects
 * — about 1000× slower than cardano-node. Here environments are persistent linked lists, the
 * budget is two Numbers (exact below 2^53, far above any budget) kept in locals, and builtins
 * run on the evaluator's own values (builtins.ts).
 *
 * Shape of the loop:
 *  - the program is a `Code` (flat.ts): a term is a node index into two typed arrays (kind and
 *    operand), so reading a node is a bounds-checked load with no object shape to test, and the
 *    body of a lambda, delay or force — and the function of an application — is the next index;
 *    closures (`VLam`, `VDelay`) hold a node index. An object term (the text parser's) is
 *    compiled first;
 *  - the frame stack is three parallel arrays (kind, payload, environment) under one stack
 *    pointer, reused from one evaluation to the next: no frame object is allocated per step;
 *  - constants, constructors and builtins carry a numeric `kind` (values.ts) and closures are
 *    told apart by `instanceof` (values.ts explains why), so dispatch is a load and a compare;
 *  - atoms — variables, constants, lambdas, delays, builtins and `force` of a builtin — are
 *    evaluated in place when they are the function or the argument of an application or the
 *    body of a `force`, instead of through a frame, a return and a pop. Every step still charges
 *    its own cost, in the machine's order, with the budget checked after each charge, so every
 *    count, every failure point and every verdict equals the frame-by-frame machine's;
 *  - the value of a builtin term depends on its tag alone (unapplied builtins are immutable), so
 *    one table of `VBuiltin` values is shared by every program.
 *
 * Semantics follow the specification: every step charges its machine cost, a builtin takes
 * exactly its forces and then its arguments, its cost is charged before it runs, and exceeding
 * the budget is a failure. The verdict equals the reference machine's (which charges steps in
 * batches of 200): costs only accumulate, so a run that ends within budget never exceeded it.
 */
import { type Code, Program, TK, TK_APPLY_X, type Term, compileTerm } from "./flat";
import { Env, T_LIST_DATA, UNIT, VBuiltin, VCon, VConstr, VDelay, VLam, VPair, listHead, listIsEmpty, listTail, mkBuiltin, mkListFromArray, type Value } from "./values";
import { DK } from "./data";
import { ARITY, BudgetExceeded, BuiltinCtx, EvalFailure, EvalUnsupported, SIGNATURE, forceBuiltin, partialBuiltin, saturateBuiltin } from "./builtins";
import type { CostTable } from "./costs";

export { BudgetExceeded };

export interface EvalResult {
    ok: boolean;
    /** Units consumed (up to the point of failure when not ok). */
    cpu: number;
    mem: number;
    error?: string;
    budgetExceeded?: boolean;
    logs: string[];
    result?: Value;
    /** The program the result's closures refer to (`discharge` needs it). */
    code?: Code;
}

// Term kinds as literals: `TK` is a const enum of another module, which the transpiler cannot
// inline, and the switches below must compare against constants.
if ((TK.Var as number) !== 0 || (TK.Delay as number) !== 1 || (TK.Lam as number) !== 2 || (TK.Apply as number) !== 3 || (TK.Const as number) !== 4 || (TK.Force as number) !== 5 || (TK.Error as number) !== 6 || (TK.Builtin as number) !== 7 || (TK.Constr as number) !== 8 || (TK.Case as number) !== 9 || TK_APPLY_X !== 10) throw new Error("cek: term kind numbering changed");

/** Frame kinds (the `fk` stack). Payload (`fa`) / environment (`fe`) per kind are given at each push. */
const enum FK {
    /** force the returned value */
    Force = 0,
    /** fa: the argument node, fe: its environment; the returned value is the function */
    Arg = 1,
    /** fa: the function value; the returned value is the argument */
    Fun = 2,
    /** fa: a ConstrFrame, fe: its environment */
    Constr = 3,
    /** fa: the branch nodes, fe: the case's environment */
    Case = 4,
    /** fa: the argument value; the returned value is the function (case branches) */
    ApplyTo = 5,
    /** fa: the lambda's body node, fe: its environment; the returned value is bound (`[(lam M) N]`) */
    LamArg = 6,
}
interface ConstrFrame { tag: number; fields: readonly number[]; i: number; done: Value[] }

/** The value of each builtin term, by tag: created on first use, shared by every program (immutable). */
const BUILTIN_VALUES: Array<VBuiltin | undefined> = [];
function builtinValue(fn: number): VBuiltin {
    const v = BUILTIN_VALUES[fn];
    if (v !== undefined) return v;
    const s = SIGNATURE[fn];
    if (!s) throw new EvalFailure(`builtin ${fn} is not supported`);
    return (BUILTIN_VALUES[fn] = mkBuiltin(fn, s[0]));
}
/** `force` applied to a value that is not a delay. */
function forceNonDelay(v: Value): Value {
    if (v instanceof VBuiltin && v.forces > 0) {
        if ((v as VBuiltin).n > 0) throw new EvalFailure("builtin forced after an argument");
        return forceBuiltin(v as VBuiltin);
    }
    throw new EvalFailure("force of a non-delayed value");
}
function unbound(): never { throw new EvalFailure("unbound variable"); }

/**
 * The frame stack, shared by successive evaluations (an evaluation never nests another: builtins
 * do not evaluate terms). It grows to the deepest evaluation seen and is cleared of value
 * references on the way out, so nothing of one evaluation stays alive through the next.
 */
let SHARED_FK: Int32Array = new Int32Array(256), SHARED_FA: any[] = new Array(256).fill(null), SHARED_FE: any[] = new Array(256).fill(null);
let SHARED_BUSY = false;
/** Hand the stack back: references cleared (an evaluation that grew it far beyond the usual depth gives up the large arrays instead). */
function releaseShared(fk: Int32Array, fa: any[], fe: any[], cap: number): void {
    if (cap > 4096) { SHARED_FK = new Int32Array(256); SHARED_FA = new Array(256).fill(null); SHARED_FE = new Array(256).fill(null); }
    else { fa.fill(null, 0, cap); fe.fill(null, 0, cap); SHARED_FK = fk; SHARED_FA = fa; SHARED_FE = fe; }
    SHARED_BUSY = false;
}

/**
 * Evaluate a program (a decoded `Program`, or an object term, compiled here) within `budget`.
 * `logs`: collect trace messages (diagnostics).
 */
export function evaluate(program: Program | Term, costs: CostTable, budget: { cpu: number; mem: number }, opts: { logs?: boolean; pv?: number } = {}): EvalResult {
    const prog = program instanceof Program ? program : compileTerm(program);
    const code = prog.code;
    const K = code.K, A = code.A, consts = code.consts, ctrs = code.ctrs, cases = code.cases, xapps = code.xapps;
    // `case` on a builtin constant: from van Rossem (protocol 11) except on Data, which Dijkstra (12) adds
    const pv = opts.pv ?? 0;
    const M = costs.machine;
    // step costs by node kind (0 var, 1 delay, 2 lam, 3 apply, 4 const, 5 force, 6 error: none, 7 builtin, 8 constr, 9 case, 10 apply-x: an apply)
    const cStep = Float64Array.of(M.var[0], M.delay[0], M.lam[0], M.apply[0], M.constant[0], M.force[0], 0, M.builtin[0], M.constr[0], M.case[0], M.apply[0]);
    const mStep = Float64Array.of(M.var[1], M.delay[1], M.lam[1], M.apply[1], M.constant[1], M.force[1], 0, M.builtin[1], M.constr[1], M.case[1], M.apply[1]);
    const maxCpu = budget.cpu, maxMem = budget.mem;
    let cpu = M.startup[0], mem = M.startup[1];
    const logs: string[] = [];
    const ctx = new BuiltinCtx(costs, opts.logs ? logs : null);
    ctx.maxCpu = maxCpu; ctx.maxMem = maxMem;

    // frame stack: kind / payload / environment, `sp` slots in use (the shared one unless an evaluation is somehow active)
    const shared = !SHARED_BUSY;
    let fk = shared ? SHARED_FK : new Int32Array(256);
    let fa: any[] = shared ? SHARED_FA : new Array(256).fill(null);
    let fe: any[] = shared ? SHARED_FE : new Array(256).fill(null);
    let cap = fk.length;
    if (shared) SHARED_BUSY = true;
    let sp = 0;
    let env: Env | null = null;
    let value: Value = UNIT;
    let t = prog.root;
    try {
        if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
        compute: for (;;) {
            // ── compute mode: t, env → value ──
            const k = K[t]!;
            cpu += cStep[k]!; mem += mStep[k]!;
            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
            switch (k) {
                case 0: { // var
                    let e = env, i = A[t]!;
                    if (i < 0) unbound();
                    while (i > 2 && e !== null) { e = e.s2; i -= 2; }
                    while (--i > 0 && e !== null) e = e.next;
                    if (e === null) unbound();
                    value = e!.v;
                    break;
                }
                case 4: value = consts[A[t]!]!; break; // const
                case 2: value = new VLam(t + 1, env); break; // lam
                case 1: value = new VDelay(t + 1, env); break; // delay
                case 5: { // force
                    const b = t + 1, bk = K[b]!;
                    if (bk === 7) { // (force (builtin f)): the builtin step, then the force
                        cpu += cStep[7]!; mem += mStep[7]!;
                        if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                        value = forceNonDelay(builtinValue(A[b]!));
                        break;
                    }
                    if (bk === 0) { // (force x): the variable step, then the force
                        cpu += cStep[0]!; mem += mStep[0]!;
                        if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                        let e = env, i = A[b]!;
                        if (i < 0) unbound();
                        while (i > 2 && e !== null) { e = e.s2; i -= 2; }
                        while (--i > 0 && e !== null) e = e.next;
                        if (e === null) unbound();
                        const v = e!.v;
                        if (v instanceof VDelay) { env = v.env; t = v.body; continue compute; }
                        value = forceNonDelay(v);
                        break;
                    }
                    if (sp === cap) { cap <<= 1; const nk = new Int32Array(cap); nk.set(fk); fk = nk; for (let i = fa.length; i < cap; i++) { fa.push(null); fe.push(null); } }
                    fk[sp] = FK.Force; sp++;
                    t = b;
                    continue compute;
                }
                case 3: case 10: { // apply: the function is the next node and the operand its argument; apply-x (applyData) names both
                    let f: number, a: number;
                    if (k === 3) { f = t + 1; a = A[t]!; } else { const x = xapps[A[t]!]!; f = x.f; a = x.a; }
                    const fkind = K[f]!;
                    if (sp === cap) { cap <<= 1; const nk = new Int32Array(cap); nk.set(fk); fk = nk; for (let i = fa.length; i < cap; i++) { fa.push(null); fe.push(null); } }
                    // the function, when it is an atom
                    let fv: Value;
                    switch (fkind) {
                        case 2: { // [(lam M) N]: the lam step yields the closure (M, env); evaluate N, then bind
                            cpu += cStep[2]!; mem += mStep[2]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            fk[sp] = FK.LamArg; fa[sp] = f + 1; fe[sp] = env; sp++;
                            t = a;
                            continue compute;
                        }
                        case 0: {
                            cpu += cStep[0]!; mem += mStep[0]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            let e = env, i = A[f]!;
                            if (i < 0) unbound();
                            while (i > 2 && e !== null) { e = e.s2; i -= 2; }
                            while (--i > 0 && e !== null) e = e.next;
                            if (e === null) unbound();
                            fv = e!.v;
                            break;
                        }
                        case 7: {
                            cpu += cStep[7]!; mem += mStep[7]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            fv = builtinValue(A[f]!);
                            break;
                        }
                        case 4: {
                            cpu += cStep[4]!; mem += mStep[4]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            fv = consts[A[f]!]!;
                            break;
                        }
                        case 5: {
                            const b = f + 1;
                            if (K[b] !== 7) { fk[sp] = FK.Arg; fa[sp] = a; fe[sp] = env; sp++; t = f; continue compute; }
                            // [(force (builtin g)) N]: force step, builtin step
                            cpu += cStep[5]!; mem += mStep[5]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            cpu += cStep[7]!; mem += mStep[7]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            fv = forceNonDelay(builtinValue(A[b]!));
                            break;
                        }
                        default: { fk[sp] = FK.Arg; fa[sp] = a; fe[sp] = env; sp++; t = f; continue compute; }
                    }
                    // the function value is known: the argument, when it is an atom
                    const ak = K[a]!;
                    let av: Value;
                    switch (ak) {
                        case 0: {
                            cpu += cStep[0]!; mem += mStep[0]!;
                            if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                            let e = env, i = A[a]!;
                            if (i < 0) unbound();
                            while (i > 2 && e !== null) { e = e.s2; i -= 2; }
                            while (--i > 0 && e !== null) e = e.next;
                            if (e === null) unbound();
                            av = e!.v;
                            break;
                        }
                        case 4: cpu += cStep[4]!; mem += mStep[4]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = consts[A[a]!]!; break;
                        case 2: cpu += cStep[2]!; mem += mStep[2]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = new VLam(a + 1, env); break;
                        case 1: cpu += cStep[1]!; mem += mStep[1]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = new VDelay(a + 1, env); break;
                        case 7: cpu += cStep[7]!; mem += mStep[7]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = builtinValue(A[a]!); break;
                        default: { fk[sp] = FK.Fun; fa[sp] = fv; sp++; t = a; continue compute; }
                    }
                    // apply fv to av
                    if (fv instanceof VLam) { env = new Env(av, fv.env); t = fv.body; continue compute; }
                    if ((fv as VCon | VConstr | VBuiltin).kind === 4) {
                        const bu = fv as VBuiltin;
                        if (bu.forces > 0) throw new EvalFailure("builtin applied to a term before its forces");
                        if (bu.n + 1 < ARITY[bu.fn]!) { value = partialBuiltin(bu, av); break; }
                        ctx.cpu = cpu; ctx.mem = mem;
                        value = saturateBuiltin(ctx, bu, av);
                        cpu = ctx.cpu; mem = ctx.mem;
                        break;
                    }
                    throw new EvalFailure("application of a non-function");
                }
                case 7: value = builtinValue(A[t]!); break; // builtin
                case 6: throw new EvalFailure("error term evaluated");
                case 8: { // constr
                    const ct = ctrs[A[t]!]!, fields = ct.fields;
                    if (fields.length === 0) { value = new VConstr(ct.tag, []); break; }
                    if (sp === cap) { cap <<= 1; const nk = new Int32Array(cap); nk.set(fk); fk = nk; for (let i = fa.length; i < cap; i++) { fa.push(null); fe.push(null); } }
                    const fr: ConstrFrame = { tag: ct.tag, fields, i: 1, done: [] };
                    fk[sp] = FK.Constr; fa[sp] = fr; fe[sp] = env; sp++;
                    t = fields[0]!;
                    continue compute;
                }
                case 9: { // case
                    if (sp === cap) { cap <<= 1; const nk = new Int32Array(cap); nk.set(fk); fk = nk; for (let i = fa.length; i < cap; i++) { fa.push(null); fe.push(null); } }
                    fk[sp] = FK.Case; fa[sp] = cases[A[t]!]!; fe[sp] = env; sp++;
                    t = t + 1;
                    continue compute;
                }
                default: throw new EvalFailure(`unknown term kind ${k}`);
            }
            // ── return mode: value → the frame on top ──
            for (;;) {
                if (sp === 0) break compute;
                sp--;
                switch (fk[sp]) {
                    case FK.Arg: {
                        // the function is known; the argument node, when it is an atom, is evaluated here
                        const a: number = fa[sp], e: Env | null = fe[sp], ak = K[a]!;
                        let av: Value;
                        switch (ak) {
                            case 0: {
                                cpu += cStep[0]!; mem += mStep[0]!;
                                if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem);
                                let ee = e, i = A[a]!;
                                if (i < 0) unbound();
                                while (i > 2 && ee !== null) { ee = ee.s2; i -= 2; }
                                while (--i > 0 && ee !== null) ee = ee.next;
                                if (ee === null) unbound();
                                av = ee!.v;
                                break;
                            }
                            case 4: cpu += cStep[4]!; mem += mStep[4]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = consts[A[a]!]!; break;
                            case 2: cpu += cStep[2]!; mem += mStep[2]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = new VLam(a + 1, e); break;
                            case 1: cpu += cStep[1]!; mem += mStep[1]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = new VDelay(a + 1, e); break;
                            case 7: cpu += cStep[7]!; mem += mStep[7]!; if (cpu > maxCpu || mem > maxMem) throw new BudgetExceeded(cpu, mem); av = builtinValue(A[a]!); break;
                            default: { fk[sp] = FK.Fun; fa[sp] = value; sp++; t = a; env = e; continue compute; }
                        }
                        const fv = value;
                        if (fv instanceof VLam) { env = new Env(av, fv.env); t = fv.body; continue compute; }
                        if ((fv as VCon | VConstr | VBuiltin).kind === 4) {
                            const bu = fv as VBuiltin;
                            if (bu.forces > 0) throw new EvalFailure("builtin applied to a term before its forces");
                            if (bu.n + 1 < ARITY[bu.fn]!) { value = partialBuiltin(bu, av); continue; }
                            ctx.cpu = cpu; ctx.mem = mem;
                            value = saturateBuiltin(ctx, bu, av);
                            cpu = ctx.cpu; mem = ctx.mem;
                            continue;
                        }
                        throw new EvalFailure("application of a non-function");
                    }
                    case FK.LamArg: {
                        env = new Env(value, fe[sp]);
                        t = fa[sp];
                        continue compute;
                    }
                    case FK.Fun: case FK.ApplyTo: {
                        // Fun: the frame holds the function, `value` is the argument; ApplyTo (case
                        // branches): the frame holds the argument, `value` is the function.
                        let fv: Value, av: Value;
                        if (fk[sp] === FK.Fun) { fv = fa[sp]; av = value; } else { fv = value; av = fa[sp]; }
                        if (fv instanceof VLam) { env = new Env(av, fv.env); t = fv.body; continue compute; }
                        if ((fv as VCon | VConstr | VBuiltin).kind === 4) {
                            const bu = fv as VBuiltin;
                            if (bu.forces > 0) throw new EvalFailure("builtin applied to a term before its forces");
                            if (bu.n + 1 < ARITY[bu.fn]!) { value = partialBuiltin(bu, av); continue; }
                            ctx.cpu = cpu; ctx.mem = mem;
                            value = saturateBuiltin(ctx, bu, av);
                            cpu = ctx.cpu; mem = ctx.mem;
                            continue;
                        }
                        throw new EvalFailure("application of a non-function");
                    }
                    case FK.Force: {
                        if (value instanceof VDelay) { env = value.env; t = value.body; continue compute; }
                        value = forceNonDelay(value);
                        continue;
                    }
                    case FK.Constr: {
                        const fr = fa[sp] as ConstrFrame;
                        fr.done.push(value);
                        if (fr.i < fr.fields.length) { t = fr.fields[fr.i++]!; env = fe[sp]; sp++; continue compute; }
                        value = new VConstr(fr.tag, fr.done);
                        continue;
                    }
                    case FK.Case: {
                        const bs: readonly number[] = fa[sp], cenv: Env | null = fe[sp];
                        if (value instanceof VCon) {
                            // caseBuiltinDefault / caseBuiltinNoData (PlutusCore.Default.Universe)
                            if (pv < 11) throw new EvalFailure("case on a builtin constant is not available before protocol 11");
                            const v = value as VCon, n = bs.length;
                            let branch: number | undefined, spine: VCon[] = [];
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
                            if (branch === undefined) throw new EvalFailure("case on a builtin constant: out of bounds for the given branches");
                            for (let i = spine.length - 1; i >= 0; i--) {
                                if (sp === cap) { cap <<= 1; const nk = new Int32Array(cap); nk.set(fk); fk = nk; for (let j = fa.length; j < cap; j++) { fa.push(null); fe.push(null); } }
                                fk[sp] = FK.ApplyTo; fa[sp] = spine[i]; sp++;
                            }
                            t = branch; env = cenv;
                            continue compute;
                        }
                        if (!(value instanceof VConstr)) throw new EvalFailure("case on a non-constructor value");
                        const cv = value as VConstr;
                        if (cv.tag >= bs.length) throw new EvalFailure(`case: no branch for constructor ${cv.tag}`);
                        // the branch is applied to the fields in order (transferArgStack): first field on top
                        const fs = cv.fields;
                        for (let i = fs.length - 1; i >= 0; i--) {
                            if (sp === cap) { cap <<= 1; const nk = new Int32Array(cap); nk.set(fk); fk = nk; for (let j = fa.length; j < cap; j++) { fa.push(null); fe.push(null); } }
                            fk[sp] = FK.ApplyTo; fa[sp] = fs[i]; sp++;
                        }
                        t = bs[cv.tag]!; env = cenv;
                        continue compute;
                    }
                }
            }
        }
        if (shared) releaseShared(fk, fa, fe, cap);
        return { ok: true, cpu, mem, logs, result: value, code };
    } catch (e) {
        if (shared) releaseShared(fk, fa, fe, cap);
        // a builtin that charged and then failed: the counters it advanced are the ones consumed
        if (ctx.cpu > cpu || ctx.mem > mem) { cpu = ctx.cpu; mem = ctx.mem; }
        if (e instanceof BudgetExceeded) return { ok: false, cpu: e.cpu, mem: e.mem, error: "budget exceeded", budgetExceeded: true, logs };
        if (e instanceof EvalUnsupported) return { ok: false, cpu, mem, error: `evaluator limit: ${e.message}`, logs };
        if (e instanceof EvalFailure) return { ok: false, cpu, mem, error: e.message, logs };
        if (e instanceof RangeError) return { ok: false, cpu, mem, error: `evaluator limit: ${e.message}`, logs };
        throw e;
    }
}
