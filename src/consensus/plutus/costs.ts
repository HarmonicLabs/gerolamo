/**
 * Cost models per Plutus ledger language and protocol version, built exactly as the ledger's
 * evaluation context does:
 *
 * - parameter values: the language's cost-model list zipped with that language's `ParamName`
 *   enumeration (paramNames.ts) — extra values ignored, missing ones maxBound :: Int64
 *   (`tagWithParamNames`). V1 and V2 list their parameters in their own orders (V1 appended
 *   serialiseData, secp256k1, constr/case, bls, … after its 166 originals; V2 after its 175), so
 *   a list is never read with another language's names;
 * - cost-function shapes: the semantics variant's `builtinCostModel*.json` (costShapes.ts) —
 *   V1/V2 variant A before protocol 9 (multiplyInteger on added sizes, Ed25519 linear in the
 *   signature), B up to 10, D from 11 (division above/below the diagonal); V3 C, then E from 11.
 *
 * The functions are compiled to Number closures for the evaluator; a value leaving the exact
 * double range is recomputed with BigInt. Parameter names follow the JSON arguments:
 * `<builtin>-<cpu|memory>-arguments[-model-arguments]-<name>`.
 */
import { COST_SHAPES, type Shape } from "./costShapes";
import { PARAM_NAMES_V1, PARAM_NAMES_V2, PARAM_NAMES_V3 } from "./paramNames";

export type Lang = 1 | 2 | 3;
const MAX_INT64 = 9223372036854775807n;
const NAMES: Record<Lang, readonly string[]> = { 1: PARAM_NAMES_V1, 2: PARAM_NAMES_V2, 3: PARAM_NAMES_V3 };

/** The ledger's view of a cost-model list: `tagWithParamNames` (zip; missing → maxBound). */
export function namedParams(lang: Lang, values: ReadonlyArray<number | bigint | string>): Map<string, bigint> {
    const names = NAMES[lang];
    const out = new Map<string, bigint>();
    for (let i = 0; i < names.length; i++) out.set(names[i]!, i < values.length ? BigInt(values[i]!) : MAX_INT64);
    return out;
}

/** Semantics variant of a ledger language at a protocol version (PlutusLedgerApi.V*.EvaluationContext). */
export function semanticsVariant(lang: Lang, pv: number): "A" | "B" | "C" | "D" | "E" {
    if (lang === 3) return pv < 11 ? "C" : "E";
    return pv < 9 ? "A" : pv < 11 ? "B" : "D";
}

/** A cost function over argument sizes (x, y, z, u: arguments 1–4), as Numbers. `c` is set when it is constant. */
export interface CostFn { c: number | null; at: (x: number, y: number, z: number, u?: number) => number }
export interface BuiltinCost { cpu: CostFn; mem: CostFn }
export interface MachineStepCosts { startup: [number, number]; var: [number, number]; constant: [number, number]; lam: [number, number]; delay: [number, number]; force: [number, number]; apply: [number, number]; builtin: [number, number]; constr: [number, number]; case: [number, number] }
export interface CostTable { lang: Lang; variant: string; machine: MachineStepCosts; builtins: Array<BuiltinCost | undefined>; named: Map<string, bigint> }

/** maxBound :: Int64 (a missing parameter) as the largest exact Number: any use exceeds every budget either way. */
export function clampNum(v: bigint): number { return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v); }

/** Flat builtin tags (plutus-core `DefaultFun` order) → cost-model names. */
export const BUILTIN_NAMES: readonly string[] = [
    "addInteger", "subtractInteger", "multiplyInteger", "divideInteger", "quotientInteger", "remainderInteger", "modInteger",
    "equalsInteger", "lessThanInteger", "lessThanEqualsInteger", "appendByteString", "consByteString", "sliceByteString",
    "lengthOfByteString", "indexByteString", "equalsByteString", "lessThanByteString", "lessThanEqualsByteString", "sha2_256",
    "sha3_256", "blake2b_256", "verifyEd25519Signature", "appendString", "equalsString", "encodeUtf8", "decodeUtf8", "ifThenElse",
    "chooseUnit", "trace", "fstPair", "sndPair", "chooseList", "mkCons", "headList", "tailList", "nullList", "chooseData",
    "constrData", "mapData", "listData", "iData", "bData", "unConstrData", "unMapData", "unListData", "unIData", "unBData",
    "equalsData", "mkPairData", "mkNilData", "mkNilPairData", "serialiseData", "verifyEcdsaSecp256k1Signature",
    "verifySchnorrSecp256k1Signature", "bls12_381_G1_add", "bls12_381_G1_neg", "bls12_381_G1_scalarMul", "bls12_381_G1_equal",
    "bls12_381_G1_compress", "bls12_381_G1_uncompress", "bls12_381_G1_hashToGroup", "bls12_381_G2_add", "bls12_381_G2_neg",
    "bls12_381_G2_scalarMul", "bls12_381_G2_equal", "bls12_381_G2_compress", "bls12_381_G2_uncompress", "bls12_381_G2_hashToGroup",
    "bls12_381_millerLoop", "bls12_381_mulMlResult", "bls12_381_finalVerify", "keccak_256", "blake2b_224", "integerToByteString",
    "byteStringToInteger", "andByteString", "orByteString", "xorByteString", "complementByteString", "readBit", "writeBits",
    "replicateByte", "shiftByteString", "rotateByteString", "countSetBits", "findFirstSetBit", "ripemd_160",
    "expModInteger", "dropList", "lengthOfArray", "listToArray", "indexArray", "bls12_381_G1_multiScalarMul", "bls12_381_G2_multiScalarMul",
    "insertCoin", "lookupCoin", "unionValue", "valueContains", "valueData", "unValueData", "scaleValue", "multiIndexArray",
];

const SAFE = 2 ** 52;
/**
 * Compile one shape (plutus-core `CostingFun/Core.hs` semantics) over the named parameters at
 * `prefix` (`<builtin>-cpu-arguments`). Sizes x, y, z, u are the arguments' `ExMemoryUsage`.
 */
type Fn = (x: number, y: number, z: number, u: number) => bigint | number;
function compile(shape: Shape, prefix: string, named: Map<string, bigint>): { f: Fn; c: number | null } {
    const p = (k: string): bigint => { const v = named.get(k ? `${prefix}-${k}` : prefix); if (v == null) throw new Error(`cost model lacks ${prefix}-${k}`); return v; };
    const n = (k: string) => clampNum(p(k));
    switch (shape.t) {
        case "constant_cost": { const c = n(""); return { c, f: () => c }; }
        case "linear_in_x": { const i = n("intercept"), s = n("slope"); return { c: null, f: (x) => i + s * x }; }
        case "linear_in_y": case "linear_in_y2": { const i = n("intercept"), s = n("slope"); return { c: null, f: (_x, y) => i + s * y }; }
        case "linear_in_z": { const i = n("intercept"), s = n("slope"); return { c: null, f: (_x, _y, z) => i + s * z }; }
        // ModelFourArgumentsLinearInU (insertCoin)
        case "linear_in_u": { const i = n("intercept"), s = n("slope"); return { c: null, f: (_x, _y, _z, u) => i + s * u }; }
        case "added_sizes": { const i = n("intercept"), s = n("slope"); return { c: null, f: (x, y) => i + s * (x + y) }; }
        case "subtracted_sizes": { const i = n("intercept"), s = n("slope"), m = n("minimum"); return { c: null, f: (x, y) => i + s * Math.max(m, x - y) }; }
        case "multiplied_sizes": { const i = n("intercept"), s = n("slope"); return { c: null, f: (x, y) => i + s * (x * y) }; }
        case "min_size": { const i = n("intercept"), s = n("slope"); return { c: null, f: (x, y) => i + s * Math.min(x, y) }; }
        case "max_size": { const i = n("intercept"), s = n("slope"); return { c: null, f: (x, y) => i + s * Math.max(x, y) }; }
        case "linear_in_x_and_y": { const i = n("intercept"), s1 = n("slope1"), s2 = n("slope2"); return { c: null, f: (x, y) => i + s1 * x + s2 * y }; }
        case "linear_in_y_and_z": { const i = n("intercept"), s1 = n("slope1"), s2 = n("slope2"); return { c: null, f: (_x, y, z) => i + s1 * y + s2 * z }; }
        case "linear_in_max_yz": { const i = n("intercept"), s = n("slope"); return { c: null, f: (_x, y, z) => i + s * Math.max(y, z) }; }
        case "linear_on_diagonal": { const i = n("intercept"), s = n("slope"), c = n("constant"); return { c: null, f: (x, y) => (x === y ? i + s * x : c) }; }
        case "literal_in_y_or_linear_in_z": { const i = n("intercept"), s = n("slope"); return { c: null, f: (_x, y, z) => (y === 0 ? i + s * z : y) }; }
        case "quadratic_in_x": { const c0 = n("c0"), c1 = n("c1"), c2 = n("c2"); return { c: null, f: (x) => c0 + c1 * x + c2 * x * x }; }
        case "quadratic_in_y": { const c0 = n("c0"), c1 = n("c1"), c2 = n("c2"); return { c: null, f: (_x, y) => c0 + c1 * y + c2 * y * y }; }
        case "quadratic_in_z": { const c0 = n("c0"), c1 = n("c1"), c2 = n("c2"); return { c: null, f: (_x, _y, z) => c0 + c1 * z + c2 * z * z }; }
        case "quadratic_in_x_and_y": {
            const c00 = p("c00"), c10 = p("c10"), c01 = p("c01"), c20 = p("c20"), c11 = p("c11"), c02 = p("c02"), m = p("minimum");
            // BigInt: the coefficients may be negative and the squares large
            return { c: null, f: (x, y) => { const X = BigInt(x), Y = BigInt(y); const r = c00 + c10 * X + c01 * Y + c20 * X * X + c11 * X * Y + c02 * Y * Y; return r < m ? m : r; } };
        }
        case "exp_mod_cost": {
            // c00 + c11·e·m + c12·e·m², times 1.5 when the base is larger than the modulus (evaluateExpModCostingFunction)
            const c00 = p("coefficient00"), c11 = p("coefficient11"), c12 = p("coefficient12");
            return { c: null, f: (a, e, m) => { const E = BigInt(e), M = BigInt(m); const c0 = c00 + c11 * E * M + c12 * E * M * M; return a <= m ? c0 : c0 + c0 / 2n; } };
        }
        case "with_interaction_in_x_and_y": { const c00 = n("c00"), c10 = n("c10"), c01 = n("c01"), c11 = n("c11"); return { c: null, f: (x, y) => c00 + c10 * x + c01 * y + c11 * x * y }; }
        case "const_above_diagonal": {
            const c = n("constant"), inner = compile(shape.m!, `${prefix}-model-arguments`, named);
            return { c: null, f: (x, y, z, u) => (x < y ? c : inner.f(x, y, z, u)) };
        }
        case "above_and_below_diagonal": {
            const inner = compile(shape.m!, `${prefix}-model-arguments`, named);
            return { c: null, f: (x, y, z, u) => inner.f(Math.max(x, y), Math.min(x, y), z, u) };
        }
    }
    throw new Error(`unsupported cost function shape ${shape.t}`);
}
/** Numbers are exact below 2^53; beyond, the (budget-exceeding) value only needs to stay large. */
function toFn(g: { f: Fn; c: number | null }): CostFn {
    return {
        c: g.c,
        at: (x, y, z, u = 0) => {
            const r = g.f(x, y, z, u);
            if (typeof r === "bigint") return clampNum(r < 0n ? 0n : r);
            return r < SAFE ? r : Number.MAX_SAFE_INTEGER;
        },
    };
}

function stepCost(named: Map<string, bigint>, key: string): [number, number] {
    const cpu = named.get(`${key}-exBudgetCPU`), mem = named.get(`${key}-exBudgetMemory`);
    if (cpu == null || mem == null) throw new Error(`cost model lacks ${key}`);
    return [clampNum(cpu), clampNum(mem)];
}

const cache = new Map<string, CostTable>();

export function costTable(lang: Lang, values: ReadonlyArray<number | bigint | string>, pv = 9): CostTable {
    const variant = semanticsVariant(lang, pv);
    const key = `${lang}:${variant}:${values.join(",")}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const named = namedParams(lang, values);
    const shapes = COST_SHAPES[variant];
    const builtins: Array<BuiltinCost | undefined> = [];
    for (let t = 0; t < BUILTIN_NAMES.length; t++) {
        const name = BUILTIN_NAMES[t]!, s = shapes[name];
        if (!s) { builtins[t] = undefined; continue; }
        try { builtins[t] = { cpu: toFn(compile(s.cpu, `${name}-cpu-arguments`, named)), mem: toFn(compile(s.memory, `${name}-memory-arguments`, named)) }; }
        catch { builtins[t] = undefined; } // parameters this language does not have: the builtin is not available to it either
    }
    const has = (k: string) => named.has(`${k}-exBudgetCPU`);
    const never: [number, number] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
    const machine: MachineStepCosts = {
        startup: stepCost(named, "cekStartupCost"), var: stepCost(named, "cekVarCost"), constant: stepCost(named, "cekConstCost"),
        lam: stepCost(named, "cekLamCost"), delay: stepCost(named, "cekDelayCost"), force: stepCost(named, "cekForceCost"),
        apply: stepCost(named, "cekApplyCost"), builtin: stepCost(named, "cekBuiltinCost"),
        // no constr/case parameters: the terms are not available to the language (decoding rejects them)
        constr: has("cekConstrCost") ? stepCost(named, "cekConstrCost") : never,
        case: has("cekCaseCost") ? stepCost(named, "cekCaseCost") : never,
    };
    const tbl: CostTable = { lang, variant, machine, builtins, named };
    cache.set(key, tbl);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return tbl;
}
