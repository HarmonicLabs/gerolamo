/** Multi-asset values as unit → quantity maps ("lovelace" or policyHex+assetNameHex). */
export type UnitMap = Map<string, bigint>;

export function unitsOf(value: any): UnitMap {
    const m: UnitMap = new Map();
    if (!value) return m;
    if (typeof value === "bigint" || typeof value === "number") {
        m.set("lovelace", BigInt(value));
        return m;
    }
    // ledger-ts Value: `map` = [{ policy, assets: [{ name, quantity }] }], the ADA entry
    // has an empty policy. (`toUnits()` mislabels that entry when the policy is a
    // Hash object rather than "", so read the map directly.)
    if (Array.isArray(value.map)) {
        for (const entry of value.map as any[]) {
            const policy = policyHex(entry?.policy);
            for (const a of (entry?.assets ?? []) as any[]) {
                const q = BigInt(a?.quantity ?? 0);
                if (q === 0n) continue;
                const name = a?.name instanceof Uint8Array ? Buffer.from(a.name).toString("hex") : String(a?.name ?? "");
                addUnit(m, policy === "" ? "lovelace" : (policy + name).toLowerCase(), q);
            }
        }
        return m;
    }
    if (typeof value.lovelaces === "bigint") m.set("lovelace", value.lovelaces);
    else if (value.amount != null) m.set("lovelace", BigInt(value.amount));
    return m;
}

/** Stored UTxO JSON: `{ amount, assets: { policyHex: { assetNameHex: qty } } }`. */
export function unitsFromStoredTxOut(json: any): UnitMap {
    const m: UnitMap = new Map();
    if (!json) return m;
    const lovelace = json.amount ?? json.lovelace;
    if (lovelace != null && /^\d+$/.test(String(lovelace))) m.set("lovelace", BigInt(String(lovelace)));
    const assets = json.assets;
    if (assets && typeof assets === "object") {
        for (const [policy, names] of Object.entries(assets as Record<string, Record<string, string>>)) {
            if (!names || typeof names !== "object") continue;
            // The apply path stores the ADA entry of a Value under the empty policy
            // as well as in `amount`; count it once.
            if (policy === "") continue;
            for (const [name, qty] of Object.entries(names)) {
                if (/^-?\d+$/.test(String(qty))) addUnit(m, (policy + name).toLowerCase(), BigInt(String(qty)));
            }
        }
    }
    return m;
}

function policyHex(p: any): string {
    if (p == null) return "";
    if (p instanceof Uint8Array) return Buffer.from(p).toString("hex");
    const s = String(p?.toString?.() ?? p);
    return s === "[object Object]" ? "" : s;
}

export function addUnit(m: UnitMap, unit: string, q: bigint): void {
    const next = (m.get(unit) ?? 0n) + q;
    if (next === 0n) m.delete(unit);
    else m.set(unit, next);
}

export function addAll(into: UnitMap, from: UnitMap, sign: 1n | -1n = 1n): void {
    for (const [u, q] of from) addUnit(into, u, q * sign);
}

export function unitsEqual(a: UnitMap, b: UnitMap): boolean {
    if (a.size !== b.size) return false;
    for (const [u, q] of a) if (b.get(u) !== q) return false;
    return true;
}

export function diffUnits(consumed: UnitMap, produced: UnitMap): string {
    const units = new Set([...consumed.keys(), ...produced.keys()]);
    const parts: string[] = [];
    for (const u of units) {
        const c = consumed.get(u) ?? 0n, p = produced.get(u) ?? 0n;
        if (c !== p) parts.push(`${u === "lovelace" ? "lovelace" : u.slice(0, 12) + "…"}: consumed ${c} ≠ produced ${p}`);
    }
    return parts.slice(0, 4).join("; ");
}

/**
 * `size(v)` of a multi-asset value in 8-byte words (cardano-ledger Mary/Alonzo
 * `utxoEntrySize`): 2 for ADA-only, else
 * 6 + ⌈(12·#assets + Σ|assetName| + 28·#policies) / 8⌉.
 */
export function valueSizeWords(units: UnitMap): number {
    let assets = 0, nameBytes = 0;
    const policies = new Set<string>();
    for (const unit of units.keys()) {
        if (unit === "lovelace") continue;
        assets++;
        policies.add(unit.slice(0, 56));
        nameBytes += Math.max(0, (unit.length - 56) / 2);
    }
    if (assets === 0) return 2;
    const bytes = 12 * assets + nameBytes + 28 * policies.size;
    return 6 + Math.floor((bytes + 7) / 8);
}

const UTXO_ENTRY_SIZE_WITHOUT_VAL = 27n;
const DATA_HASH_SIZE_WORDS = 10n;

/** Mary/Allegra `scaledMinDeposit`: ADA-only outputs need `minUTxOValue`, others scale with the value size. */
export function maryMinUtxo(units: UnitMap, minUtxoValue: bigint): bigint {
    const words = valueSizeWords(units);
    if (words === 2) return minUtxoValue;
    return bigMax(minUtxoValue, (UTXO_ENTRY_SIZE_WITHOUT_VAL + BigInt(words)) * (minUtxoValue / 27n));
}

/** Alonzo `utxoEntrySize · coinsPerUTxOWord` (datum hash adds 10 words). */
export function alonzoMinUtxo(units: UnitMap, coinsPerUtxoWord: bigint, hasDatumHash: boolean): bigint {
    const words = UTXO_ENTRY_SIZE_WITHOUT_VAL + BigInt(valueSizeWords(units)) + (hasDatumHash ? DATA_HASH_SIZE_WORDS : 0n);
    return words * coinsPerUtxoWord;
}

function bigMax(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
}
