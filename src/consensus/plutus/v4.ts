/**
 * Plutus V4 (Dijkstra, protocol 12; bug 433), from IntersectMBO/plutus master 2026-10-06:
 *   - ledger language tag 4 (`script = [4, plutus_v4_script]`, script hash prefix 0x04,
 *     witness set key 8, auxiliary data key 5, cost model key 3);
 *   - cost model parameters: `PlutusLedgerApi.V4.ParamName` is the V3 list verbatim (only the
 *     comments differ), so a V4 cost model is read with the V3 names;
 *   - builtins: batches 1..6 from protocol 12 (`builtinsIntroducedIn PlutusV4`), the same set
 *     V3 has from protocol 11; batch 7 only at `futurePV`;
 *   - semantics variant G at every protocol version (`DefaultFunSemanticsVariantG`): the
 *     bytestring bounds of variant E, no integer bounds, text costed by UTF-8 bytes, cost
 *     functions of variant E; `case` on builtin constants (Data included) is always allowed;
 *   - Plutus Core versions 1.0.0, 1.1.0 and 1.2.0 (1.2.0 adds no term form the decoder knows).
 * Protocol 12 also moves V1/V2 to variant F (D without integer bounds) and V3 to G.
 */
import { PARAM_NAMES_V3 } from "./paramNames";

export const PARAM_NAMES_V4: readonly string[] = PARAM_NAMES_V3;

/** A V4 cost model given as `{ name: value }` (genesis / JSON form) in parameter order; a list is taken as is. */
export function plutusV4CostModelArray(v: unknown): (number | bigint)[] {
    if (Array.isArray(v)) return v.map((x) => (typeof x === "bigint" ? x : Number(x)));
    if (!v || typeof v !== "object") throw new Error("PlutusV4 cost model: not a list or an object");
    const o = v as Record<string, unknown>;
    const out: (number | bigint)[] = [];
    for (const name of PARAM_NAMES_V4) {
        if (!(name in o)) break; // a prefix of the named list, like the on-chain lists
        const x = o[name];
        out.push(typeof x === "bigint" ? x : Number(x));
    }
    if (out.length === 0) throw new Error("PlutusV4 cost model: no known parameter names");
    return out;
}
