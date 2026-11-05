/**
 * Plutus script contexts (TxInfo, ScriptPurpose, ScriptInfo) for V1, V2 and V3, built from the
 * transaction's own bytes and the resolved inputs, following cardano-ledger's translation
 * (`Cardano.Ledger.{Alonzo,Babbage,Conway}.TxInfo`, IntersectMBO/cardano-ledger master):
 *
 * - collections the ledger holds as `Set`/`Map` appear in the ledger's `Ord` order: inputs by
 *   (tx id, index); signatories, datums (by hash), policies and asset names by bytes; withdrawals
 *   and every credential-keyed map with script credentials before key credentials
 *   (`data Credential = ScriptHashObj … | KeyHashObj …`), then by hash; voters committee <
 *   DRep < pool; redeemers by (tag, index);
 * - translation failures are the ledger's `ContextError`s (Byron outputs, V1 with inline datums
 *   or reference scripts / inputs, V1/V2 with Conway certificates or governance fields, votes
 *   and proposals for V1/V2 purposes): the transaction is then invalid (collect error), which is
 *   not a script failure;
 * - Alonzo keeps its historical quirk of silently dropping Byron inputs and outputs from V1.
 */
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { arr, bytesOf, field, intOf, isNull, map, parseCbor, uintOf, type CNode } from "./cbor";
import { DBytes, DConstr, DInt, DK, DList, DMap, DPair, decodeData, encodeData, type Data } from "./data";
import type { ResolvedUtxo } from "../rules/resolvedUtxo";

export class ContextError extends Error {}
const cerr = (m: string): never => { throw new ContextError(m); };

// ── Data helpers ──
const C = (tag: number, fields: Data[] = []) => new DConstr(BigInt(tag), fields);
const I = (n: bigint | number) => new DInt(BigInt(n));
const B = (b: Uint8Array) => new DBytes(b);
const L = (xs: Data[]) => new DList(xs);
const M = (ps: Array<[Data, Data]>) => new DMap(ps.map(([k, v]) => new DPair(k, v)));
const NOTHING = C(1);
const Just = (d: Data) => C(0, [d]);
const EMPTY = new Uint8Array(0);

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
}
/** A ledger credential: script flag + 28-byte hash. Ord: script before key, then bytes. */
interface Cred { script: boolean; hash: Uint8Array }
const cmpCred = (a: Cred, b: Cred) => (a.script === b.script ? cmpBytes(a.hash, b.hash) : a.script ? -1 : 1);
const credData = (c: Cred) => C(c.script ? 1 : 0, [B(c.hash)]);
function credOf(n: CNode): Cred {
    const [k, h] = arr(n);
    return { script: uintOf(k) === 1n, hash: bytesOf(h) };
}
/** Reward account bytes (header + 28-byte hash) → credential. */
function rewardCred(b: Uint8Array): Cred { return { script: (b[0]! & 0x10) !== 0, hash: b.subarray(1, 29) }; }
/** Dijkstra guard item: a bare 28-byte key hash or a `[type, hash]` credential. */
function guardCred(n: CNode): Cred {
    if (n.t === "b" && n.v.length === 28) return { script: false, hash: n.v };
    return credOf(n);
}
function guardsOf(n: CNode | undefined): Cred[] {
    const out = arr(n).map(guardCred).sort(cmpCred);
    return out.filter((x, i) => i === 0 || cmpCred(x, out[i - 1]!) !== 0);
}
function datumMaybe(n: CNode | undefined): Data { return n === undefined || isNull(n) ? NOTHING : Just(decodeData(bytesOf(n))); }
/** `account_balance_interval` (Dijkstra CDDL): coin / [lower/nil, upper/nil], never both nil. */
function accountInterval(n: CNode): Data {
    if (n.t === "u" || n.t === "n") return C(3, [I(intOf(n))]);
    const [lo, hi] = arr(n);
    if (isNull(lo)) return C(1, [I(uintOf(hi))]);
    if (isNull(hi)) return C(0, [I(uintOf(lo))]);
    return C(2, [I(uintOf(lo)), I(uintOf(hi))]);
}
function accountIntervalMap(n: CNode | undefined): Array<[Data, Data]> {
    return map(n).map(([k, v]) => ({ cred: rewardCred(bytesOf(k)), v })).sort((a, b) => cmpCred(a.cred, b.cred))
        .map(({ cred, v }) => [credData(cred), accountInterval(v)] as [Data, Data]);
}
function requiredGuardMap(n: CNode | undefined): Array<[Data, Uint8Array | null]> {
    return map(n).map(([k, v]) => [guardCred(k), v === undefined || isNull(v) ? null : bytesOf(v)] as [Cred, Uint8Array | null])
        .sort((a, b) => cmpCred(a[0]!, b[0]!)).map(([c, d]) => [credData(c), d] as [Data, Uint8Array | null]);
}

/** Credential carried by a `Data` credential (Constr 0 key hash / Constr 1 script hash). */
function credFromData(d: Data): Cred {
    if (d.k !== DK.Constr) throw new Error("credential key is not a constructor");
    const f = (d as DConstr).fields;
    return { script: (d as DConstr).tag === 1n, hash: (f[0] as DBytes).v };
}
function dataEq(a: Data, b: Data): boolean { return cmpBytes(encodeData(a), encodeData(b)) === 0; }
function dMapPairs(d: Data): Array<[Data, Data]> { return d.k === DK.Map ? d.entries.map((e) => [e.fst, e.snd]) : []; }
function dListItems(d: Data): Data[] { return d.k === DK.List ? d.items : []; }
/** Union of credential-keyed quantity maps (withdrawals/direct deposits), summing duplicate credentials. */
function mergeCredMap(list: Array<Data | null | undefined>): Data {
    const m = new Map<string, [Data, bigint]>();
    for (const d of list) if (d) for (const [k, v] of dMapPairs(d)) {
        const q = (v as DInt).v, e = m.get(toHex(encodeData(k)));
        if (e) e[1] += q; else m.set(toHex(encodeData(k)), [k, q]);
    }
    return M([...m.values()].sort((a, b) => cmpBytes(encodeData(a[0]), encodeData(b[0]))).map(([k, q]) => [k, I(q)]));
}
/** Union of keyed maps; `laterWins` lets a later sub-transaction/top-level entry replace an earlier one. */
function mergeDataMap(list: Array<Data | null | undefined>, laterWins = false): Data {
    const m = new Map<string, [Data, Data]>();
    for (const d of list) if (d) for (const [k, v] of dMapPairs(d)) {
        const h = toHex(encodeData(k));
        if (!m.has(h) || laterWins) m.set(h, [k, v]);
    }
    return M([...m.values()].sort((a, b) => cmpBytes(encodeData(a[0]), encodeData(b[0]))));
}

function gcd(a: bigint, b: bigint): bigint { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; }
/** A CBOR rational (tag 30 [n, d]) reduced, as Haskell's `%` does. */
function rational(n: CNode): [bigint, bigint] {
    const inner = n.t === "tag" ? n.v : n;
    const [a, b] = arr(inner);
    let num = intOf(a), den = intOf(b);
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den) || 1n;
    return [num / g, den / g];
}

// ── addresses and values ──
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Bytes(s: string): Uint8Array {
    const data = s.slice(s.lastIndexOf("1") + 1, -6);
    const out: number[] = []; let acc = 0, bits = 0;
    for (const ch of data) { acc = ((acc << 5) | BECH.indexOf(ch)) & 0xffffff; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
    return Uint8Array.from(out);
}
/** Plutus V4 `Address`: constructor `[payment credential, maybe account id]`. */
function addressDataV4(raw: Uint8Array): Data | null {
    const type = raw[0]! >> 4;
    if (type > 7) return null;
    const pay: Cred = { script: (type & 1) === 1, hash: raw.subarray(1, 29) };
    let acc: Data = NOTHING;
    if (type <= 3) acc = Just(credData({ script: (type & 2) === 2, hash: raw.subarray(29, 57) }));
    else if (type <= 5) {
        // pointer addresses: Plutus V4 replaced the pointer by an AccountId; ledger-ts resolves none here
        const p = { i: 29 }; const s = varNat(raw, p), t = varNat(raw, p), c = varNat(raw, p);
        void s; void t; void c;
    }
    return C(0, [credData(pay), acc]);
}
/** Raw address bytes of a stored address string; null for Byron (base58) addresses. */
export function rawAddress(address: string): Uint8Array | null {
    if (!address.startsWith("addr")) return null;
    return bech32Bytes(address);
}
function varNat(b: Uint8Array, p: { i: number }): bigint {
    let v = 0n;
    for (;;) { const x = b[p.i++]; if (x === undefined) return v; v = (v << 7n) | BigInt(x & 0x7f); if ((x & 0x80) === 0) return v; }
}
/** Plutus `Address` of raw Shelley address bytes, or null for a Byron address. */
function addressData(raw: Uint8Array): Data | null {
    const type = raw[0]! >> 4;
    if (type > 7) return null;
    const pay: Cred = { script: (type & 1) === 1, hash: raw.subarray(1, 29) };
    let stake: Data = NOTHING;
    if (type <= 3) stake = Just(C(0, [credData({ script: (type & 2) === 2, hash: raw.subarray(29, 57) })]));
    else if (type <= 5) { const p = { i: 29 }; const s = varNat(raw, p), t = varNat(raw, p), c = varNat(raw, p); stake = Just(C(1, [I(s), I(t), I(c)])); }
    return C(0, [credData(pay), stake]);
}
/** Payment script hash of raw address bytes (hex), or null. */
export function paymentScriptHash(raw: Uint8Array | null): string | null {
    if (!raw) return null;
    const type = raw[0]! >> 4;
    return type <= 7 && (type & 1) === 1 ? toHex(raw.subarray(1, 29)) : null;
}
type Assets = Map<string, Map<string, bigint>>; // policy hex → asset hex → qty
/** Plutus `Value`: the ada entry first (when `withAda`), then policies and asset names by bytes. */
function valueData(coin: bigint | null, assets: Assets): Data {
    const ps: Array<[Data, Data]> = [];
    if (coin !== null) ps.push([B(EMPTY), M([[B(EMPTY), I(coin)]])]);
    const pols = [...assets.keys()].sort((a, b) => cmpBytes(hx(a), hx(b)));
    for (const p of pols) {
        const as = assets.get(p)!;
        const names = [...as.keys()].sort((a, b) => cmpBytes(hx(a), hx(b)));
        ps.push([B(hx(p)), M(names.map((n) => [B(hx(n)), I(as.get(n)!)]))]);
    }
    return M(ps);
}
const hx = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
/**
 * A multi-asset map as the ledger holds it: before Conway zero quantities were accepted on the
 * wire and pruned when decoding (a policy left empty disappears, also from the mint policies a
 * redeemer index counts); Conway rejects them. preview slot 880204: a zero-quantity asset in an
 * output put 18 memory units on four redeemers and every one ran out of budget.
 */
function multiAssetOf(n: CNode | undefined): Assets {
    const out: Assets = new Map();
    for (const [p, as] of map(n)) {
        const m = new Map<string, bigint>();
        for (const [a, q] of map(as)) { const v = intOf(q); if (v !== 0n) m.set(toHex(bytesOf(a)), v); }
        if (m.size) out.set(toHex(bytesOf(p)), m);
    }
    return out;
}

/** Sum the same asset across sub-transactions and the top level, keeping one sign (mints > 0, burns < 0). */
function mergeAssets(list: Assets[], positive: boolean): Assets {
    const sums = new Map<string, Map<string, bigint>>();
    for (const a of list) for (const [policy, tokens] of a) {
        let inner = sums.get(policy); if (!inner) { inner = new Map(); sums.set(policy, inner); }
        for (const [name, q] of tokens) inner.set(name, (inner.get(name) ?? 0n) + q);
    }
    const out: Assets = new Map();
    for (const [policy, tokens] of sums) {
        const m = new Map<string, bigint>();
        for (const [name, q] of tokens) if (q !== 0n && (positive ? q > 0n : q < 0n)) m.set(name, q);
        if (m.size) out.set(policy, m);
    }
    return out;
}
function valueOf(n: CNode): { coin: bigint; assets: Assets } {
    if (n.t === "u") return { coin: n.v, assets: new Map() };
    const [c, ma] = arr(n);
    return { coin: uintOf(c), assets: multiAssetOf(ma) };
}

/** An output as the translation needs it. */
interface OutView { raw: Uint8Array | null; coin: bigint; assets: Assets; datumHash: Uint8Array | null; inlineDatum: Uint8Array | null; refScriptHash: Uint8Array | null }
function outOfCbor(n: CNode, lang: (hashPrefix: number, bytes: Uint8Array) => Uint8Array): OutView {
    if (n.t === "a") {
        const [a, v, dh] = n.v;
        const val = valueOf(v!);
        const raw = bytesOf(a);
        return { raw: raw[0]! >> 4 === 8 ? null : raw, ...val, datumHash: dh ? bytesOf(dh) : null, inlineDatum: null, refScriptHash: null };
    }
    const m = map(n);
    const raw = bytesOf(field(m, 0));
    const val = valueOf(field(m, 1)!);
    let datumHash: Uint8Array | null = null, inlineDatum: Uint8Array | null = null, refScriptHash: Uint8Array | null = null;
    const d = field(m, 2);
    if (d) { const [k, v] = arr(d); if (uintOf(k) === 0n) datumHash = bytesOf(v); else inlineDatum = bytesOf((v as any).t === "tag" ? (v as any).v : v); }
    const sr = field(m, 3);
    if (sr) {
        const inner = parseCbor(bytesOf(sr.t === "tag" ? sr.v : sr));
        const [k, body] = arr(inner);
        const kind = Number(uintOf(k));
        // native scripts hash their CBOR; Plutus scripts the bytestring's content
        const bytes = kind === 0 ? (sr.t === "tag" ? bytesOf(sr.v) : bytesOf(sr)).subarray(body!.s - inner.s, body!.e - inner.s) : bytesOf(body);
        refScriptHash = lang(kind, bytes);
    }
    return { raw: raw[0]! >> 4 === 8 ? null : raw, ...val, datumHash, inlineDatum, refScriptHash };
}
function outOfResolved(u: ResolvedUtxo): OutView {
    const assets: Assets = new Map();
    let coin = 0n;
    for (const [unit, q] of u.value) {
        if (unit === "lovelace" || unit === "") { coin = q; continue; }
        if (q === 0n) continue; // pruned by the ledger (see multiAssetOf)
        const p = unit.slice(0, 56), a = unit.slice(56);
        if (!assets.has(p)) assets.set(p, new Map());
        assets.get(p)!.set(a, q);
    }
    return {
        raw: rawAddress(u.address), coin, assets,
        datumHash: u.inlineDatumCbor ? null : u.datumHash ? hx(u.datumHash) : null,
        inlineDatum: u.inlineDatumCbor ? hx(u.inlineDatumCbor) : null,
        refScriptHash: u.referenceScriptHash ? hx(u.referenceScriptHash) : u.referenceScriptCbor ? refHashOfCbor(u.referenceScriptCbor) : null,
    };
}
function refHashOfCbor(h: string): Uint8Array | null {
    try {
        const b = hx(h), n = parseCbor(b), [k, body] = arr(n), kind = Number(uintOf(k));
        const bytes = kind === 0 ? b.subarray(body!.s, body!.e) : bytesOf(body);
        const pre = new Uint8Array(bytes.length + 1); pre[0] = kind; pre.set(bytes, 1);
        return blake2b_224(pre);
    } catch { return null; }
}
const scriptHashOf = (kind: number, bytes: Uint8Array) => { const pre = new Uint8Array(bytes.length + 1); pre[0] = kind; pre.set(bytes, 1); return blake2b_224(pre); };

export type Purpose =
    | { tag: 0; ref: [Uint8Array, bigint]; key: string }
    | { tag: 1; policy: Uint8Array }
    | { tag: 2; ix: number; cert: CNode }
    | { tag: 3; cred: Cred }
    | { tag: 4; voterTag: number; cred: Cred }
    | { tag: 5; ix: number; proposal: CNode }
    | { tag: 6; ix: number; cred: Cred };
export interface Redeemer { tag: number; index: number; data: Data; mem: bigint; cpu: bigint }

export interface ContextInput {
    era: number;
    /** Major protocol version of the epoch. */
    pv: number;
    bodyBytes: Uint8Array;
    witnessSetBytes: Uint8Array;
    resolved: Map<string, ResolvedUtxo>;
    /** Slot → POSIX milliseconds (the network's era history). */
    slotToPosixMs: (slot: bigint) => bigint;
    /** Dijkstra sub-transaction index (key 23); undefined for the top-level transaction. */
    subTxIx?: number;
}

export class TxContext {
    readonly era: number; readonly pv: number;
    readonly txId: Uint8Array;
    readonly body: Array<[CNode, CNode]>;
    readonly wits: Array<[CNode, CNode]>;
    readonly redeemers: Redeemer[];
    readonly inputs: Array<[Uint8Array, bigint]>;
    readonly refInputs: Array<[Uint8Array, bigint]>;
    readonly policies: Uint8Array[];
    readonly certs: CNode[];
    readonly withdrawals: Array<{ cred: Cred; amount: bigint }>;
    readonly voters: Array<{ voterTag: number; cred: Cred; votes: Array<{ id: [Uint8Array, bigint]; vote: number }> }>;
    readonly proposals: CNode[];
    /** Dijkstra key 14: guards in the ledger's credential order (key hashes are key credentials). */
    readonly guards: Cred[];
    /** Dijkstra key 24: credential -> datum (nil absent). */
    readonly requiredGuards: Array<[Data, Uint8Array | null]>;
    /** The structured form of key 24, for the V4 guard datum map. */
    readonly requiredGuardCreds: Array<{ cred: Cred; datum: Uint8Array | null }>;
    /** Sub-transaction index when this context is a Dijkstra key-23 sub-transaction. */
    readonly subTxIx: number | undefined;
    readonly datums: Map<string, { hash: Uint8Array; data: Data }>;
    /** Witness-set Plutus scripts by hash (hex): language and the script bytes (CBOR-wrapped flat). */
    readonly witnessScripts = new Map<string, { lang: 1 | 2 | 3 | 4; bytes: Uint8Array }>();
    private readonly input: ContextInput;
    private infoCache = new Map<number, Data | ContextError>();

    constructor(input: ContextInput) {
        // private copies: every bytestring of the context is a view into these, never into the block
        input = { ...input, bodyBytes: Uint8Array.from(input.bodyBytes), witnessSetBytes: Uint8Array.from(input.witnessSetBytes) };
        this.input = input;
        this.era = input.era; this.pv = input.pv; this.subTxIx = input.subTxIx;
        this.txId = blake2b_256(input.bodyBytes);
        this.body = map(parseCbor(input.bodyBytes));
        this.wits = map(parseCbor(input.witnessSetBytes));
        const refs = (n: CNode | undefined): Array<[Uint8Array, bigint]> => {
            const out = arr(n).map((x) => { const [id, ix] = arr(x); return [bytesOf(id), uintOf(ix)] as [Uint8Array, bigint]; });
            out.sort((a, b) => cmpBytes(a[0], b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
            // a Set: repeated inputs collapse (Conway rejects them in phase 1)
            return out.filter((x, i) => i === 0 || cmpBytes(x[0], out[i - 1]![0]) !== 0 || x[1] !== out[i - 1]![1]);
        };
        this.inputs = refs(field(this.body, 0));
        this.refInputs = refs(field(this.body, 18));
        this.policies = [...multiAssetOf(field(this.body, 9)).keys()].map(hx).sort(cmpBytes);
        this.certs = arr(field(this.body, 4));
        this.withdrawals = map(field(this.body, 5)).map(([ra, amt]) => ({ cred: rewardCred(bytesOf(ra)), amount: uintOf(amt) })).sort((a, b) => cmpCred(a.cred, b.cred));
        this.voters = map(field(this.body, 19)).map(([v, ballots]) => {
            const [k, h] = arr(v);
            const kt = Number(uintOf(k));
            const voterTag = kt <= 1 ? 0 : kt <= 3 ? 1 : 2;
            const votes = map(ballots).map(([gid, proc]) => { const [id, ix] = arr(gid); return { id: [bytesOf(id), uintOf(ix)] as [Uint8Array, bigint], vote: Number(uintOf(arr(proc)[0])) }; })
                .sort((a, b) => cmpBytes(a.id[0], b.id[0]) || (a.id[1] < b.id[1] ? -1 : a.id[1] > b.id[1] ? 1 : 0));
            return { voterTag, cred: { script: kt === 1 || kt === 3, hash: bytesOf(h) }, votes };
        }).sort((a, b) => (a.voterTag - b.voterTag) || cmpCred(a.cred, b.cred));
        this.proposals = arr(field(this.body, 20));
        this.guards = guardsOf(field(this.body, 14));
        this.requiredGuards = requiredGuardMap(field(this.body, 24));
        this.requiredGuardCreds = this.requiredGuards.map(([k, d]) => ({ cred: credFromData(k), datum: d }));
        // witness datums by hash (hashed over their bytes as carried)
        this.datums = new Map();
        for (const d of arr(field(this.wits, 4))) {
            const bytes = input.witnessSetBytes.subarray(d.s, d.e);
            const hash = blake2b_256(bytes);
            this.datums.set(toHex(hash), { hash, data: decodeData(bytes) });
        }
        // Dijkstra adds witness key 8 (Plutus V4, script hash prefix 4; bug 433)
        const scriptKeys: ReadonlyArray<readonly [number, 1 | 2 | 3 | 4]> = this.era >= 8 ? [[3, 1], [6, 2], [7, 3], [8, 4]] : [[3, 1], [6, 2], [7, 3]];
        for (const [key, lang] of scriptKeys) {
            for (const s of arr(field(this.wits, key))) { const b = bytesOf(s); this.witnessScripts.set(toHex(scriptHashOf(lang, b)), { lang, bytes: b }); }
        }
        // effective redeemers: list form keeps the last per purpose (Map.fromList), sorted by pointer
        const rs = new Map<string, Redeemer>();
        const rn = field(this.wits, 5);
        if (rn && (rn.t === "a" || (rn.t === "tag" && rn.v.t === "a"))) {
            for (const r of arr(rn)) {
                const [t, ix, d, eu] = arr(r);
                const [m, c] = arr(eu);
                const bytes = input.witnessSetBytes.subarray(d!.s, d!.e);
                rs.set(`${uintOf(t)}:${uintOf(ix)}`, { tag: Number(uintOf(t)), index: Number(uintOf(ix)), data: decodeData(bytes), mem: uintOf(m), cpu: uintOf(c) });
            }
        } else if (rn) {
            for (const [k, v] of map(rn)) {
                const [t, ix] = arr(k), [d, eu] = arr(v), [m, c] = arr(eu);
                const bytes = input.witnessSetBytes.subarray(d!.s, d!.e);
                rs.set(`${uintOf(t)}:${uintOf(ix)}`, { tag: Number(uintOf(t)), index: Number(uintOf(ix)), data: decodeData(bytes), mem: uintOf(m), cpu: uintOf(c) });
            }
        }
        this.redeemers = [...rs.values()].sort((a, b) => (a.tag - b.tag) || (a.index - b.index));
    }

    resolvedOf(ref: [Uint8Array, bigint]): ResolvedUtxo | undefined { return this.input.resolved.get(`${toHex(ref[0])}:${ref[1]}`); }

    /** The item a redeemer points at (`redeemerPointerInverse`), or null. */
    purposeOf(r: { tag: number; index: number }): Purpose | null {
        switch (r.tag) {
            case 0: { const ref = this.inputs[r.index]; return ref ? { tag: 0, ref, key: `${toHex(ref[0])}:${ref[1]}` } : null; }
            case 1: { const p = this.policies[r.index]; return p ? { tag: 1, policy: p } : null; }
            case 2: { const c = this.certs[r.index]; return c ? { tag: 2, ix: r.index, cert: c } : null; }
            case 3: { const w = this.withdrawals[r.index]; return w ? { tag: 3, cred: w.cred } : null; }
            case 4: { const v = this.voters[r.index]; return v ? { tag: 4, voterTag: v.voterTag, cred: v.cred } : null; }
            case 5: { const p = this.proposals[r.index]; return p ? { tag: 5, ix: r.index, proposal: p } : null; }
            case 6: { const c = this.guards[r.index]; return c ? { tag: 6, ix: r.index, cred: c } : null; }
        }
        return null;
    }

    /** The script hash (hex) a purpose needs, or null when it is not script-locked. */
    scriptHashOf(p: Purpose): string | null {
        switch (p.tag) {
            case 0: { const u = this.resolvedOf(p.ref); return u ? paymentScriptHash(rawAddress(u.address)) : null; }
            case 1: return toHex(p.policy);
            case 2: { const c = certCredential(p.cert); return c?.script ? toHex(c.hash) : null; }
            case 3: return p.cred.script ? toHex(p.cred.hash) : null;
            case 4: return p.cred.script && p.voterTag !== 2 ? toHex(p.cred.hash) : null;
            case 5: { const g = proposalPolicy(p.proposal); return g ? toHex(g) : null; }
            case 6: return p.cred.script ? toHex(p.cred.hash) : null;
        }
    }

    /** The spending input's datum (inline, or by hash from the witness set), or null. */
    spendingDatum(p: Purpose): Data | null {
        if (p.tag !== 0) return null;
        const u = this.resolvedOf(p.ref);
        if (!u) return null;
        if (u.inlineDatumCbor) return decodeData(hx(u.inlineDatumCbor));
        if (u.datumHash) return this.datums.get(u.datumHash.toLowerCase())?.data ?? null;
        return null;
    }

    // ── translation ──
    private txOutRef(ref: [Uint8Array, bigint], lang: number): Data { return lang === 3 || lang === 4 ? C(0, [B(ref[0]), I(ref[1])]) : C(0, [C(0, [B(ref[0])]), I(ref[1])]); }
    private txOut(o: OutView, lang: number, source: string): Data | null {
        if (!o.raw) { if (this.era === 5 && lang === 1) return null; cerr(`ByronTxOutInContext (${source})`); }
        const addr = addressData(o.raw!)!;
        const value = valueData(o.coin, o.assets);
        if (lang === 1) {
            if (this.era === 6 && o.refScriptHash) cerr(`ReferenceScriptsNotSupported (${source})`);
            if (o.inlineDatum) cerr(`InlineDatumsNotSupported (${source})`);
            return C(0, [addr, value, o.datumHash ? Just(B(o.datumHash)) : NOTHING]);
        }
        const datum = o.inlineDatum ? C(2, [decodeData(o.inlineDatum)]) : o.datumHash ? C(1, [B(o.datumHash)]) : C(0);
        return C(0, [addr, value, datum, o.refScriptHash ? Just(B(o.refScriptHash)) : NOTHING]);
    }
    private txInInfo(ref: [Uint8Array, bigint], lang: number): Data | null {
        const u = this.resolvedOf(ref);
        if (!u) cerr(`TranslationLogicMissingInput ${toHex(ref[0])}#${ref[1]}`);
        if (lang === 4) {
            const out = this.txOutV4(outOfResolved(u!), `input ${toHex(ref[0]).slice(0, 12)}#${ref[1]}`);
            return L([this.txOutRef(ref, 4), out]);
        }
        const out = this.txOut(outOfResolved(u!), lang, `input ${toHex(ref[0]).slice(0, 12)}#${ref[1]}`);
        return out ? C(0, [this.txOutRef(ref, lang), out]) : null;
    }
    /** Plutus V4 `TxOut`: list `[address, value, datum, maybe reference script]`. */
    private txOutV4(o: OutView, source: string): Data {
        if (!o.raw) cerr(`ByronTxOutInContext (${source})`);
        const addr = addressDataV4(o.raw!);
        if (!addr) cerr(`ByronTxOutInContext (${source})`);
        const datum = o.inlineDatum ? C(2, [decodeData(o.inlineDatum)]) : o.datumHash ? C(1, [B(o.datumHash)]) : C(0);
        return L([addr!, valueData(o.coin, o.assets), datum, o.refScriptHash ? Just(B(o.refScriptHash)) : NOTHING]);
    }
    private posix(slot: bigint): bigint { return this.input.slotToPosixMs(slot); }
    private rangeData(lowerMs: bigint | undefined, upperMs: bigint | undefined): Data {
        // Lower bound inclusive. A finite upper bound is exclusive (`strictUpperBound`), except in
        // Alonzo/Babbage when it is the only bound (`PV1.to t`: inclusive); Conway always strict.
        const lower = lowerMs !== undefined ? C(0, [C(1, [I(lowerMs)]), C(1)]) : C(0, [C(0), C(1)]);
        const upperClosed = this.era < 7 && lowerMs === undefined;
        const upper = upperMs !== undefined ? C(0, [C(1, [I(upperMs)]), upperClosed ? C(1) : C(0)]) : C(0, [C(2), C(1)]);
        return C(0, [lower, upper]);
    }
    private validRange(): Data {
        const lo = field(this.body, 8), hi = field(this.body, 3);
        return this.rangeData(lo ? this.posix(uintOf(lo)) : undefined, hi ? this.posix(uintOf(hi)) : undefined);
    }
    /** V1/V2 `DCert` (Shelley certificates; Conway deposit-carrying (un)registrations map to the plain ones). */
    private dcert(c: CNode): Data {
        const f = arr(c), k = Number(uintOf(f[0]));
        const sc = () => C(0, [credData(credOf(f[1]!))]);
        switch (k) {
            case 0: case 7: return C(0, [sc()]);
            case 1: case 8: return C(1, [sc()]);
            case 2: return C(2, [sc(), B(bytesOf(f[2]))]);
            case 3: return C(3, [B(bytesOf(f[1])), B(bytesOf(f[2]))]);
            case 4: return C(4, [B(bytesOf(f[1])), I(uintOf(f[2]))]);
            case 5: if (this.era < 7) return C(5); break;
            case 6: if (this.era < 7) return C(6); break;
        }
        return cerr(`CertificateNotSupported (certificate type ${k})`);
    }
    /** V3 `TxCert`. */
    private txCertV3(c: CNode): Data {
        const f = arr(c), k = Number(uintOf(f[0]));
        const cred = (n: CNode) => credData(credOf(n));
        const pool = (n: CNode) => B(bytesOf(n));
        const bootstrap = this.pv === 9;
        switch (k) {
            case 0: return C(0, [cred(f[1]!), NOTHING]);
            case 1: return C(1, [cred(f[1]!), NOTHING]);
            case 2: return C(2, [cred(f[1]!), C(0, [pool(f[2]!)])]);
            case 3: return C(7, [pool(f[1]!), B(bytesOf(f[2]))]);
            case 4: return C(8, [pool(f[1]!), I(uintOf(f[2]))]);
            case 7: return C(0, [cred(f[1]!), bootstrap ? NOTHING : Just(I(uintOf(f[2])))]);
            case 8: return C(1, [cred(f[1]!), bootstrap ? NOTHING : Just(I(uintOf(f[2])))]);
            case 9: return C(2, [cred(f[1]!), C(1, [drep(f[2]!)])]);
            case 10: return C(2, [cred(f[1]!), C(2, [pool(f[2]!), drep(f[3]!)])]);
            case 11: return C(3, [cred(f[1]!), C(0, [pool(f[2]!)]), I(uintOf(f[3]))]);
            case 12: return C(3, [cred(f[1]!), C(1, [drep(f[2]!)]), I(uintOf(f[3]))]);
            case 13: return C(3, [cred(f[1]!), C(2, [pool(f[2]!), drep(f[3]!)]), I(uintOf(f[4]))]);
            case 14: return C(9, [cred(f[1]!), cred(f[2]!)]);
            case 15: return C(10, [cred(f[1]!)]);
            case 16: return C(4, [cred(f[1]!), I(uintOf(f[2]))]);
            case 17: return C(6, [cred(f[1]!), I(uintOf(f[2]))]);
            case 18: return C(5, [cred(f[1]!)]);
        }
        return cerr(`CertificateNotSupported (certificate type ${k})`);
    }
    /** V4 `TxCert` (PlutusLedgerApi.V4.Contexts tags 0–10). */
    private txCertV4(c: CNode): Data {
        const f = arr(c), k = Number(uintOf(f[0]));
        const acct = (n: CNode) => credData(credOf(n));
        const pool = (n: CNode) => B(bytesOf(n));
        const delegatee = (n: CNode) => { const d = arr(n); return C(Number(uintOf(d[0])), d[1] === undefined ? [] : d[1].t === "b" ? [pool(d[1])] : [drep(d[1])]); };
        switch (k) {
            case 0: return C(0, [acct(f[1]!), I(0)]); // reg account, no deposit
            case 1: return C(1, [acct(f[1]!), I(0)]);
            case 2: return C(2, [acct(f[1]!), delegatee(f[2]!)]);
            case 3: return C(7, [pool(f[1]!), pool(f[2]!)]); // pool register: operator, VRF key hash
            case 4: return C(8, [pool(f[1]!), I(uintOf(f[2]!))]);
            case 7: return C(0, [acct(f[1]!), I(uintOf(f[2]!))]);
            case 8: return C(1, [acct(f[1]!), I(uintOf(f[2]!))]);
            case 9: return C(2, [acct(f[1]!), delegatee(f[2]!)]);
            case 10: return C(3, [acct(f[1]!), delegatee(f[2]!), I(uintOf(f[3]!))]);
            case 11: return C(3, [acct(f[1]!), delegatee(f[2]!), I(uintOf(f[3]!))]);
            case 12: return C(3, [acct(f[1]!), delegatee(f[2]!), I(uintOf(f[3]!))]);
            case 13: return C(3, [acct(f[1]!), delegatee(f[2]!), I(uintOf(f[4]!))]);
            case 14: return C(9, [acct(f[1]!), acct(f[2]!)]);
            case 15: return C(10, [acct(f[1]!)]);
            case 16: return C(4, [acct(f[1]!), I(uintOf(f[2]!))]);
            case 17: return C(6, [acct(f[1]!), I(uintOf(f[2]!))]);
            case 18: return C(5, [acct(f[1]!)]);
        }
        return cerr(`CertificateNotSupported (certificate type ${k}) in Plutus V4`);
    }
    private voterData(v: { voterTag: number; cred: Cred }): Data { return v.voterTag === 2 ? C(2, [B(v.cred.hash)]) : C(v.voterTag, [credData(v.cred)]); }
    private proposalData(p: CNode): Data {
        const [dep, ra, ga] = arr(p);
        return C(0, [I(uintOf(dep)), credData(rewardCred(bytesOf(ra))), govActionData(ga!)]);
    }

    /** V4 `ScriptPurpose` / V3 / V1–V2 of a redeemer's item. */
    purposeData(p: Purpose, lang: number, scriptHash?: string | null): Data {
        if (lang === 4) {
            const sh = scriptHash ? B(hx(scriptHash)) : cerr("ScriptHashNotFoundForPurpose");
            switch (p.tag) {
                case 0: return C(1, [sh, this.txOutRef(p.ref, 4)]);        // Spending
                case 1: return C(0, [sh, B(p.policy)]);                     // Minting
                case 2: return C(3, [sh, I(p.ix), this.txCertV4(p.cert)]);  // Certifying
                case 3: return C(2, [sh, credData(p.cred)]);                // Withdrawing
                case 4: return C(4, [sh, this.voterData(p)]);
                case 5: return C(5, [sh, I(p.ix), this.proposalData(p.proposal)]);
                case 6: return C(6, [sh, I(p.ix)]);
            }
        }
        if (lang === 3) {
            switch (p.tag) {
                case 0: return C(1, [this.txOutRef(p.ref, 3)]);
                case 1: return C(0, [B(p.policy)]);
                case 2: return C(3, [I(p.ix), this.txCertV3(p.cert)]);
                case 3: return C(2, [credData(p.cred)]);
                case 4: return C(4, [this.voterData(p)]);
                case 5: return C(5, [I(p.ix), this.proposalData(p.proposal)]);
            }
        }
        switch (p.tag) {
            case 0: return C(1, [this.txOutRef(p.ref, lang)]);
            case 1: return C(0, [B(p.policy)]);
            case 2: return C(3, [this.dcert(p.cert)]);
            case 3: return C(2, [C(0, [credData(p.cred)])]);
        }
        return cerr(`PlutusPurposeNotSupported (tag ${p.tag}) in Plutus V${lang}`);
    }
    /** V4 `ScriptInfo` (tag 6 keeps the top-level aggregate absent for now); V3 keeps the V3 shape. */
    scriptInfoData(p: Purpose, lang: number = 3): Data {
        if (lang === 4) {
            switch (p.tag) {
                case 0: { const d = this.spendingDatum(p); return C(1, [this.txOutRef(p.ref, 4), d ? Just(d) : NOTHING]); } // SpendingScript
                case 1: return C(0, [B(p.policy)]);                                                                      // MintingScript
                case 2: return C(3, [I(p.ix), this.txCertV4(p.cert)]);                                                    // CertifyingScript
                case 3: return C(2, [credData(p.cred)]);                                                                  // WithdrawingScript
                case 4: return C(4, [this.voterData(p)]);
                case 5: return C(5, [I(p.ix), this.proposalData(p.proposal)]);
                case 6: {
                    const hash = p.cred.script ? toHex(p.cred.hash) : null;
                    const top = hash && this.subTxIx === undefined ? this.topTxInfo(hash) : null;
                    return C(6, [I(p.ix), top === null ? NOTHING : Just(top)]); // GuardingScript ix (Maybe TopTxInfo)
                }
            }
            return cerr("PlutusPurposeNotSupported in Plutus V4");
        }
        const sp = this.purposeData(p, 3) as DConstr;
        if (p.tag !== 0) return sp; // same constructors and fields as ScriptPurpose
        const d = this.spendingDatum(p);
        return C(1, [sp.fields[0]!, d ? Just(d) : NOTHING]);
    }

    /** TxInfo for a language; throws ContextError when the transaction cannot be translated. */
    txInfo(lang: 1 | 2 | 3 | 4): Data {
        const hit = this.infoCache.get(lang);
        if (hit instanceof ContextError) throw hit;
        if (hit) return hit;
        try {
            const d = lang === 4 ? this.buildTxInfoV4() : this.buildTxInfo(lang as 1 | 2 | 3);
            this.infoCache.set(lang, d);
            return d;
        } catch (e) {
            if (e instanceof ContextError) this.infoCache.set(lang, e);
            throw e;
        }
    }

    /** Plutus V4 `TxInfo` (PlutusLedgerApi.V4.Contexts, list-encoded fields in record order). */
    private buildTxInfoV4(): Data {
        if (this.era < 8) cerr("PlutusV4NotSupported");
        const range = this.validRange();
        const inputs = this.inputs.map((r) => this.txInInfo(r, 4)).filter((x): x is Data => x !== null);
        const refIns = this.refInputs.map((r) => this.txInInfo(r, 4)).filter((x): x is Data => x !== null);
        const outputs = arr(field(this.body, 1)).map((o, i) => this.txOutV4(outOfCbor(o, scriptHashOf), `output ${i}`));
        const certs = this.certs.map((c) => this.txCertV4(c));
        const mintAssets = multiAssetOf(field(this.body, 9));
        const datums = [...this.datums.values()].sort((a, b) => cmpBytes(a.hash, b.hash));
        const withdrawals = this.withdrawals.map((w) => [credData(w.cred), I(w.amount)] as [Data, Data]);
        const deposits = map(field(this.body, 25)).map(([k, v]) => ({ cred: rewardCred(bytesOf(k)), amount: uintOf(v) }))
            .sort((a, b) => cmpCred(a.cred, b.cred)).map(({ cred, amount }) => [credData(cred), I(amount)] as [Data, Data]);
        const intervals = accountIntervalMap(field(this.body, 26));
        const redeemers = M(this.redeemers.map((r) => {
            const p = this.purposeOf(r);
            if (!p) cerr(`RedeemerPointerPointsToNothing ${r.tag}:${r.index}`);
            const hash = this.scriptHashOf(p!);
            if (!hash) cerr(`ScriptHashNotFoundForPurpose ${r.tag}:${r.index}`);
            return [this.purposeData(p!, 4, hash), r.data];
        }));
        const treasury = field(this.body, 21), donation = field(this.body, 22);
        return L([
            B(this.txId), this.subTxIx === undefined ? NOTHING : Just(I(this.subTxIx)), L(inputs), L(refIns), L(outputs), valueData(null, mintAssets), L(certs),
            M(withdrawals), M(deposits), M(intervals), range, L(this.guards.map(credData)),
            M(this.requiredGuards.map(([c, d]) => [c, d === null ? NOTHING : Just(decodeData(d))] as [Data, Data])),
            redeemers, M(datums.map((d) => [B(d.hash), d.data])), 
            M(this.voters.map((v) => [this.voterData(v), M(v.votes.map((b) => [C(0, [B(b.id[0]), I(b.id[1])]), C(b.vote)]))])),
            L(this.proposals.map((p) => this.proposalData(p))),
            treasury ? Just(I(uintOf(treasury))) : NOTHING,
            I(donation ? uintOf(donation) : 0n),
        ]);
    }

    /** Dijkstra key-23 sub-transactions, in body order (each body/witness set is a slice of the top body bytes). */
    subContexts(): TxContext[] {
        const input = this.input;
        return arr(field(this.body, 23)).map((st, ix) => {
            const entry = arr(st), body = entry[0]!, wits = entry[1]!;
            return new TxContext({
                ...input,
                bodyBytes: input.bodyBytes.subarray(body.s, body.e),
                witnessSetBytes: input.bodyBytes.subarray(wits.s, wits.e),
                subTxIx: ix,
            });
        });
    }

    /**
     * V4 TopTxInfo for a guarding redeemer at the top level (CIP-118/CIP-0195): the sub-transaction
     * TxInfos in body order, the datum map from key 24 (looked up for this guard's script hash in
     * every sub-transaction and the top level), the top-level starting balance intervals (key 27),
     * and the aggregated TopTxInfoSimplified. Sub-transactions have no top-level guard info.
     */
    private topTxInfo(guardingScriptHash: string): Data {
        const sub = this.subContexts();
        const batch = [...sub, this];
        const guard: Cred = { script: true, hash: hx(guardingScriptHash) };
        const datumPairs: Array<[Uint8Array, Data]> = [];
        for (const c of batch) {
            const hit = c.requiredGuardCreds.find((g) => cmpCred(g.cred, guard) === 0);
            if (hit && hit.datum !== null) datumPairs.push([c.txId, decodeData(hit.datum)]);
        }
        datumPairs.sort((a, b) => cmpBytes(a[0], b[0]));
        const datumMap = M(datumPairs.map(([id, d]) => [B(id), d]));
        const startingIntervals = M(accountIntervalMap(field(this.body, 27)));
        const subInfos = sub.map((c) => c.txInfo(4));

        const ids = L([...sub.map((c) => B(c.txId)), B(this.txId)]);
        const inputs = L(batch.flatMap((c) => c.inputs.map((r) => c.txInInfo(r, 4)).filter((x): x is Data => x !== null)));
        const refIns = L(batch.flatMap((c) => c.refInputs.map((r) => c.txInInfo(r, 4)).filter((x): x is Data => x !== null)));
        const outputs = L(batch.flatMap((c) => arr(field(c.body, 1)).map((o, i) => c.txOutV4(outOfCbor(o, scriptHashOf), `output ${i}`))));
        const mints = valueData(null, mergeAssets(batch.map((c) => multiAssetOf(field(c.body, 9))), true));
        const burns = valueData(null, mergeAssets(batch.map((c) => multiAssetOf(field(c.body, 9))), false));
        const certs = L(batch.flatMap((c) => c.certs.map((cert) => c.txCertV4(cert))));
        const withdrawals = mergeCredMap(batch.map((c) => c.withdrawals.length ? M(c.withdrawals.map((w) => [credData(w.cred), I(w.amount)] as [Data, Data])) : null));
        const deposits = mergeCredMap(batch.map((c) => {
            const n = field(c.body, 25);
            return n ? M(map(n).map(([k, v]) => [credData(rewardCred(bytesOf(k))), I(uintOf(v))] as [Data, Data])) : null;
        }));
        let lower: bigint | undefined, upper: bigint | undefined;
        for (const c of batch) {
            const lo = field(c.body, 8), hi = field(c.body, 3);
            if (lo) { const v = c.posix(uintOf(lo)); if (lower === undefined || v > lower) lower = v; }
            if (hi) { const v = c.posix(uintOf(hi)); if (upper === undefined || v < upper) upper = v; }
        }
        const range = this.rangeData(lower, upper);
        const guards = L(batch.flatMap((c) => c.guards.map(credData)));
        const requiredCreds: Cred[] = [];
        for (const c of batch) for (const g of c.requiredGuardCreds) requiredCreds.push(g.cred);
        requiredCreds.sort(cmpCred);
        const requiredGuards = L(requiredCreds.filter((g, i) => i === 0 || cmpCred(g, requiredCreds[i - 1]!) !== 0).map(credData));
        const redeemerHashesMap = new Map<string, Uint8Array>();
        for (const c of batch) for (const r of c.redeemers) {
            const p = c.purposeOf(r);
            if (!p) continue;
            const h = c.scriptHashOf(p);
            if (h) redeemerHashesMap.set(h, hx(h));
        }
        const redeemerHashes = L([...redeemerHashesMap.values()].sort(cmpBytes).map((b) => B(b)));
        const datumByHash = new Map<string, { hash: Uint8Array; data: Data }>();
        for (const c of batch) for (const d of c.datums.values()) datumByHash.set(toHex(d.hash), d);
        const dataField = M([...datumByHash.values()].sort((a, b) => cmpBytes(a.hash, b.hash)).map((d) => [B(d.hash), d.data]));
        const voterMap = new Map<string, { voter: Data; actions: Map<string, { key: Data; vote: Data }> }>();
        for (const c of batch) for (const v of c.voters) {
            const vd = c.voterData(v), vk = toHex(encodeData(vd));
            let e = voterMap.get(vk);
            if (!e) { e = { voter: vd, actions: new Map() }; voterMap.set(vk, e); }
            for (const b of v.votes) {
                const key = C(0, [B(b.id[0]), I(b.id[1])]), kk = toHex(encodeData(key));
                e.actions.set(kk, { key, vote: C(b.vote) });
            }
        }
        const votes = M([...voterMap.entries()].sort((a, b) => cmpBytes(encodeData(a[1].voter), encodeData(b[1].voter))).map(([, e]) => [
            e.voter,
            M([...e.actions.entries()].sort((a, b) => cmpBytes(encodeData(a[1].key), encodeData(b[1].key))).map(([, a]) => [a.key, a.vote])),
        ] as [Data, Data]));
        const proposals = L(batch.flatMap((c) => c.proposals.map((p) => c.proposalData(p))));
        const treasuryNode = batch.find((c) => field(c.body, 21) !== undefined);
        const treasury = treasuryNode ? Just(I(uintOf(field(treasuryNode.body, 21)))) : NOTHING;
        let donation = 0n;
        for (const c of batch) { const d = field(c.body, 22); if (d) donation += uintOf(d); }
        const simplified = L([ids, inputs, refIns, outputs, mints, burns, certs, withdrawals, deposits, range, guards,
            requiredGuards, redeemerHashes, dataField, votes, proposals, treasury, I(donation)]);
        return L([L(subInfos), datumMap, startingIntervals, simplified]);
    }


    private buildTxInfo(lang: 1 | 2 | 3): Data {
        const conway = this.era >= 7;
        if (conway && lang !== 3) {
            if (this.voters.length) cerr("VotingProceduresFieldNotSupported");
            if (this.proposals.length) cerr("ProposalProceduresFieldNotSupported");
            const don = field(this.body, 22);
            if (don && uintOf(don) !== 0n) cerr("TreasuryDonationFieldNotSupported");
            if (field(this.body, 21)) cerr("CurrentTreasuryFieldNotSupported");
        }
        if (lang === 1 && this.era === 6 && this.refInputs.length) cerr("ReferenceInputsNotSupported");
        if (lang === 3 && this.pv >= 11) {
            const ins = new Set(this.inputs.map((r) => `${toHex(r[0])}:${r[1]}`));
            if (this.refInputs.some((r) => ins.has(`${toHex(r[0])}:${r[1]}`))) cerr("ReferenceInputsNotDisjointFromInputs");
        }
        const range = this.validRange();
        const inputs = this.inputs.map((r) => this.txInInfo(r, lang)).filter((x): x is Data => x !== null);
        const refIns = this.refInputs.map((r) => this.txInInfo(r, lang)).filter((x): x is Data => x !== null);
        const outputs = arr(field(this.body, 1)).map((o, i) => this.txOut(outOfCbor(o, scriptHashOf), lang, `output ${i}`)).filter((x): x is Data => x !== null);
        const fee = uintOf(field(this.body, 2));
        const mintAssets = multiAssetOf(field(this.body, 9));
        const certs = lang === 3 ? this.certs.map((c) => this.txCertV3(c)) : this.certs.map((c) => this.dcert(c));
        const sigs = arr(field(this.body, 14)).map(bytesOf).sort(cmpBytes)
            .filter((x, i, all) => i === 0 || cmpBytes(x, all[i - 1]!) !== 0).map(B);
        const datums = [...this.datums.values()].sort((a, b) => cmpBytes(a.hash, b.hash));
        const txId = lang === 3 ? B(this.txId) : C(0, [B(this.txId)]);
        if (lang === 1) {
            return C(0, [
                L(inputs), L(outputs), valueData(fee, new Map()), valueData(0n, mintAssets), L(certs),
                L(this.withdrawals.map((w) => C(0, [C(0, [credData(w.cred)]), I(w.amount)]))),
                range, L(sigs), L(datums.map((d) => C(0, [B(d.hash), d.data]))), txId,
            ]);
        }
        const redeemers = M(this.redeemers.map((r) => {
            const p = this.purposeOf(r);
            if (!p) cerr(`RedeemerPointerPointsToNothing ${r.tag}:${r.index}`);
            return [this.purposeData(p!, lang), r.data];
        }));
        if (lang === 2) {
            return C(0, [
                L(inputs), L(refIns), L(outputs), valueData(fee, new Map()), valueData(0n, mintAssets), L(certs),
                M(this.withdrawals.map((w) => [C(0, [credData(w.cred)]), I(w.amount)])),
                range, L(sigs), redeemers, M(datums.map((d) => [B(d.hash), d.data])), txId,
            ]);
        }
        const treasury = field(this.body, 21), donation = field(this.body, 22);
        return C(0, [
            L(inputs), L(refIns), L(outputs), I(fee), valueData(null, mintAssets), L(certs),
            M(this.withdrawals.map((w) => [credData(w.cred), I(w.amount)])),
            range, L(sigs), redeemers, M(datums.map((d) => [B(d.hash), d.data])), txId,
            M(this.voters.map((v) => [this.voterData(v), M(v.votes.map((b) => [C(0, [B(b.id[0]), I(b.id[1])]), C(b.vote)]))])),
            L(this.proposals.map((p) => this.proposalData(p))),
            treasury ? Just(I(uintOf(treasury))) : NOTHING,
            donation && uintOf(donation) !== 0n ? Just(I(uintOf(donation))) : NOTHING,
        ]);
    }
}

/** The credential that must witness a certificate (the stake / DRep / cold credential), if any. */
export function certCredential(c: CNode): Cred | null {
    const f = arr(c), k = Number(uintOf(f[0]));
    // stake registration without a deposit (0) needs no witness; pool certificates are key-witnessed
    if (k === 0 || k === 3 || k === 4 || k === 5 || k === 6) return null;
    return f[1] && f[1].t === "a" ? credOf(f[1]) : null;
}
function drep(n: CNode): Data {
    const f = arr(n), k = Number(uintOf(f[0]));
    if (k === 0) return C(0, [credData({ script: false, hash: bytesOf(f[1]) })]);
    if (k === 1) return C(0, [credData({ script: true, hash: bytesOf(f[1]) })]);
    return k === 2 ? C(1) : C(2);
}
/** Guardrail (policy) script hash of a proposal's ParameterChange / TreasuryWithdrawals, if any. */
export function proposalPolicy(p: CNode): Uint8Array | null {
    const ga = arr(arr(p)[2]);
    const k = Number(uintOf(ga[0]));
    const pol = k === 0 ? ga[3] : k === 2 ? ga[2] : undefined;
    return pol && !isNull(pol) ? bytesOf(pol) : null;
}
function gaid(n: CNode | undefined): Data {
    if (isNull(n)) return NOTHING;
    const [id, ix] = arr(n);
    return Just(C(0, [B(bytesOf(id)), I(uintOf(ix))]));
}
const maybeHash = (n: CNode | undefined) => (isNull(n) ? NOTHING : Just(B(bytesOf(n))));
function govActionData(n: CNode): Data {
    const f = arr(n), k = Number(uintOf(f[0]));
    switch (k) {
        case 0: return C(0, [gaid(f[1]), changedParams(f[2]!), maybeHash(f[3])]);
        case 1: { const [maj, min] = arr(f[2]); return C(1, [gaid(f[1]), C(0, [I(uintOf(maj)), I(uintOf(min))])]); }
        case 2: {
            const ws = map(f[1]).map(([ra, amt]) => ({ cred: rewardCred(bytesOf(ra)), amt: uintOf(amt) })).sort((a, b) => cmpCred(a.cred, b.cred));
            return C(2, [M(ws.map((w) => [credData(w.cred), I(w.amt)])), maybeHash(f[2])]);
        }
        case 3: return C(3, [gaid(f[1])]);
        case 4: {
            const removed = arr(f[2]).map(credOf).sort(cmpCred);
            const added = map(f[3]).map(([c, e]) => ({ cred: credOf(c), epoch: uintOf(e) })).sort((a, b) => cmpCred(a.cred, b.cred));
            const [num, den] = rational(f[4]!);
            return C(4, [gaid(f[1]), L(removed.map(credData)), M(added.map((a) => [credData(a.cred), I(a.epoch)])), C(0, [I(num), I(den)])]);
        }
        case 5: { const [, pol] = arr(f[2]); return C(5, [gaid(f[1]), C(0, [maybeHash(pol)])]); }
        case 6: return C(6);
    }
    return cerr(`unknown governance action ${k}`);
}
/**
 * `ChangedParameters`: the parameter update as the ledger's ToPlutusData (Conway PParams): a
 * map from parameter tag to value in tag order; rationals as `[num, den]` lists (reduced),
 * ex-units and prices as lists, cost models as a map from language to parameter list.
 */
function changedParams(n: CNode): Data {
    const RATIONAL = new Set([9, 10, 11, 33]);
    const THRESHOLDS = new Set([25, 26]);
    const entries = map(n).map(([k, v]) => [Number(uintOf(k)), v] as [number, CNode]).sort((a, b) => a[0] - b[0]);
    const rat = (x: CNode) => { const [a, b] = rational(x); return L([I(a), I(b)]); };
    return M(entries.map(([k, v]): [Data, Data] => {
        let d: Data;
        if (RATIONAL.has(k)) d = rat(v);
        else if (THRESHOLDS.has(k)) d = L(arr(v).map(rat));
        else if (k === 18) d = M(map(v).map(([l, ps]) => [I(uintOf(l)), L(arr(ps).map((p) => I(intOf(p))))] as [Data, Data]).sort((a, b) => Number((a[0] as DInt).v - (b[0] as DInt).v)));
        else if (k === 19) d = L(arr(v).map(rat));
        else if (k === 20 || k === 21) d = L(arr(v).map((x) => I(uintOf(x))));
        else if (k === 14) { const [maj, min] = arr(v); d = L([I(uintOf(maj)), I(uintOf(min))]); }
        else d = I(intOf(v));
        return [I(k), d];
    }));
}
