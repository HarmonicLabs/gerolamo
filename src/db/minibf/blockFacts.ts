/**
 * Everything the Blockfrost-compatible API reports about a block and its transactions, read
 * straight from the stored `[era, block]` bytes (CBOR walking, original bytes kept for hashes):
 * header facts (height, issuer, VRF key, operational certificate), and per transaction the
 * fee, validity, inputs (spent, collateral, reference), outputs, collateral return, certificates,
 * withdrawals, mint, required signers, votes, proposals, donation, metadata, scripts, datums and
 * redeemers. The explorer worker writes the history indexes from these facts; the API decodes a
 * single transaction's block on demand for the per-transaction endpoints. Pure (no database).
 */
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { sha3_256 } from "@noble/hashes/sha3";
import { addressStringOfRaw } from "./cardanoIds";
import { bytesAt, concat, encodeHead, entries, head, hex, intAt, isMap, isNull, items, numAt, rationalAt, setItems, slice, tagOf, textAt, untag } from "./cborWalk";

export type ScriptType = "timelock" | "plutusV1" | "plutusV2" | "plutusV3";
export interface ScriptFact { hash: string; type: ScriptType; /** native: the script CBOR; Plutus: the bytes inside the witness byte string. */ bytes: Uint8Array }
export interface AssetQty { policy: string; name: string; qty: bigint }
export interface OutRef { txHash: string; index: number }
export interface OutputFact {
    index: number;
    addressRaw: Uint8Array;
    address: string;
    lovelace: bigint;
    assets: AssetQty[];
    datumHash: string | null;
    inlineDatum: Uint8Array | null;
    scriptRef: ScriptFact | null;
}
export interface Credential { type: number; hash: string }
export interface Anchor { url: string; hash: string }
export type DRepTarget = { kind: "key" | "script"; hash: string } | { kind: "abstain" } | { kind: "no_confidence" };
export interface PoolParamsFact {
    operator: string; vrf: string; pledge: bigint; cost: bigint; margin: { num: bigint; den: bigint };
    rewardAccount: Uint8Array; owners: string[];
    relays: Array<{ ipv4: string | null; ipv6: string | null; dns: string | null; dns_srv: string | null; port: number | null }>;
    metadata: Anchor | null;
}
export interface CertFact {
    index: number;
    tag: number;
    /** Stake credential (typed hex: "01"+hash for a script) of registration / delegation certificates. */
    stake?: string;
    pool?: string;
    drep?: DRepTarget;
    /** Explicit coin of Conway certificates (deposit paid or refunded). */
    coin?: bigint;
    pool_params?: PoolParamsFact;
    retire_epoch?: number;
    mir?: { pot: "reserve" | "treasury"; to: Array<{ stake: string; amount: bigint }>; otherPot: bigint | null };
    drep_cred?: Credential;
    cc_cold?: Credential;
    cc_hot?: Credential;
    anchor?: Anchor | null;
    genesis?: { genesis: string; delegate: string; vrf: string };
}
export interface RedeemerFact { tag: number; index: number; data: Uint8Array; mem: bigint; steps: bigint }
export interface VoteFact { voterKind: number; voterHash: string; actionTx: string; actionIx: number; vote: number; anchor: Anchor | null; index: number }
export interface ProposalFact { index: number; deposit: bigint; returnAccount: Uint8Array; action: Uint8Array; actionTag: number; anchor: Anchor | null }
export interface TxFact {
    index: number;
    hash: string;
    valid: boolean;
    body: Uint8Array;
    witness: Uint8Array;
    aux: Uint8Array | null;
    /** Size of the transaction as serialised on its own (Blockfrost `size`). */
    size: number;
    byron: boolean;
    fee: bigint;
    ttl: bigint | null;
    validFrom: bigint | null;
    inputs: OutRef[];
    collateral: OutRef[];
    referenceInputs: OutRef[];
    outputs: OutputFact[];
    collateralReturn: OutputFact | null;
    totalCollateral: bigint | null;
    certs: CertFact[];
    withdrawals: Array<{ rewardAccount: Uint8Array; amount: bigint }>;
    mint: AssetQty[];
    requiredSigners: string[];
    donation: bigint;
    votes: VoteFact[];
    proposals: ProposalFact[];
    metadata: Array<{ label: bigint; value: Uint8Array }>;
    scripts: ScriptFact[];
    datums: Array<{ hash: string; bytes: Uint8Array }>;
    redeemers: RedeemerFact[];
}
export interface BlockFacts {
    era: number;
    blockNo: number | null;
    slot: number | null;
    prevHash: string | null;
    issuerVkey: string | null;
    /** Issuer key hash: the pool id (hex) for Shelley+, the Byron delegate key hash for Byron. */
    leader: string | null;
    vrfVkey: string | null;
    opCertHotVkey: string | null;
    opCertCounter: number | null;
    size: number;
    txs: TxFact[];
}

const SCRIPT_TYPES: ScriptType[] = ["timelock", "plutusV1", "plutusV2", "plutusV3"];
export const REDEEMER_PURPOSES = ["spend", "mint", "cert", "reward", "vote", "propose"] as const;

export function scriptHash(type: ScriptType, bytes: Uint8Array): string {
    return hex(blake2b_224(concat(Uint8Array.of(SCRIPT_TYPES.indexOf(type)), bytes)));
}
const datumHash = (bytes: Uint8Array): string => hex(blake2b_256(bytes));

function outRef(b: Uint8Array, p: number): OutRef {
    const f = items(b, p);
    return { txHash: hex(bytesAt(b, f[0]!)), index: numAt(b, f[1]!) };
}

function credAt(b: Uint8Array, p: number): Credential {
    const f = items(b, p);
    return { type: numAt(b, f[0]!), hash: hex(bytesAt(b, f[1]!)) };
}
const typed = (c: Credential): string => (c.type === 1 ? "01" : "") + c.hash;

function anchorAt(b: Uint8Array, p: number): Anchor | null {
    if (isNull(b, p)) return null;
    const f = items(b, p);
    return { url: textAt(b, f[0]!), hash: hex(bytesAt(b, f[1]!)) };
}

function drepAt(b: Uint8Array, p: number): DRepTarget {
    const f = items(b, p);
    const t = numAt(b, f[0]!);
    if (t === 2) return { kind: "abstain" };
    if (t === 3) return { kind: "no_confidence" };
    return { kind: t === 1 ? "script" : "key", hash: hex(bytesAt(b, f[1]!)) };
}

/** Multi-asset map `{ policy => { name => int } }`. */
function multiAsset(b: Uint8Array, p: number): AssetQty[] {
    const out: AssetQty[] = [];
    for (const [pk, pv] of entries(b, p)) {
        const policy = hex(bytesAt(b, pk));
        for (const [nk, nv] of entries(b, pv)) out.push({ policy, name: hex(bytesAt(b, nk)), qty: intAt(b, nv) });
    }
    return out;
}

function valueAt(b: Uint8Array, p: number): { lovelace: bigint; assets: AssetQty[] } {
    if ((b[p]! >> 5) === 0) return { lovelace: intAt(b, p), assets: [] };
    const f = items(b, p);
    return { lovelace: intAt(b, f[0]!), assets: f.length > 1 ? multiAsset(b, f[1]!) : [] };
}

/** `script = [0, native] / [1, bytes] / [2, bytes] / [3, bytes]` (a reference script). */
function scriptOf(b: Uint8Array, p: number): ScriptFact | null {
    const f = items(b, p);
    const t = numAt(b, f[0]!);
    const type = SCRIPT_TYPES[t];
    if (!type) return null;
    const bytes = t === 0 ? slice(b, f[1]!) : bytesAt(b, f[1]!);
    return { type, bytes, hash: scriptHash(type, bytes) };
}

/** Embedded CBOR `#6.24(bytes)` → the inner bytes. */
function embedded(b: Uint8Array, p: number): Uint8Array { return bytesAt(b, p); }

export function outputAt(b: Uint8Array, p: number, index: number): OutputFact {
    let addrRaw: Uint8Array, value: { lovelace: bigint; assets: AssetQty[] };
    let dh: string | null = null, inline: Uint8Array | null = null, sref: ScriptFact | null = null;
    if (isMap(b, p)) {
        let ap = -1, vp = -1;
        for (const [k, v] of entries(b, p)) {
            const key = numAt(b, k);
            if (key === 0) ap = v;
            else if (key === 1) vp = v;
            else if (key === 2) {
                const d = items(b, v);
                if (numAt(b, d[0]!) === 0) dh = hex(bytesAt(b, d[1]!));
                else { inline = embedded(b, d[1]!); dh = datumHash(inline); }
            } else if (key === 3) {
                try { sref = scriptOf(embedded(b, v), 0); } catch { sref = null; }
            }
        }
        addrRaw = bytesAt(b, ap);
        value = valueAt(b, vp);
    } else {
        const f = items(b, p);
        addrRaw = bytesAt(b, f[0]!);
        value = valueAt(b, f[1]!);
        if (f.length > 2) dh = hex(bytesAt(b, f[2]!));
    }
    return { index, addressRaw: addrRaw, address: addressStringOfRaw(addrRaw), lovelace: value.lovelace, assets: value.assets, datumHash: dh, inlineDatum: inline, scriptRef: sref };
}

function relayAt(b: Uint8Array, p: number): PoolParamsFact["relays"][number] {
    const f = items(b, p);
    const t = numAt(b, f[0]!);
    const port = (q: number) => (isNull(b, q) ? null : numAt(b, q));
    if (t === 0) {
        const ip4 = isNull(b, f[2]!) ? null : [...bytesAt(b, f[2]!)].join(".");
        let ip6: string | null = null;
        if (!isNull(b, f[3]!)) {
            const raw = bytesAt(b, f[3]!);
            // the ledger stores IPv6 as four little-endian 32-bit words
            const words: string[] = [];
            for (let w = 0; w < 4; w++) { const g = raw.subarray(w * 4, w * 4 + 4); const be = [g[3]!, g[2]!, g[1]!, g[0]!]; words.push(((be[0]! << 8) | be[1]!).toString(16), ((be[2]! << 8) | be[3]!).toString(16)); }
            ip6 = words.join(":");
        }
        return { ipv4: ip4, ipv6: ip6, dns: null, dns_srv: null, port: port(f[1]!) };
    }
    if (t === 1) return { ipv4: null, ipv6: null, dns: textAt(b, f[2]!), dns_srv: null, port: port(f[1]!) };
    return { ipv4: null, ipv6: null, dns: null, dns_srv: textAt(b, f[1]!), port: null };
}

function poolParamsAt(b: Uint8Array, f: number[], o: number): PoolParamsFact {
    return {
        operator: hex(bytesAt(b, f[o]!)),
        vrf: hex(bytesAt(b, f[o + 1]!)),
        pledge: intAt(b, f[o + 2]!),
        cost: intAt(b, f[o + 3]!),
        margin: rationalAt(b, f[o + 4]!),
        rewardAccount: bytesAt(b, f[o + 5]!),
        owners: setItems(b, f[o + 6]!).map((q) => hex(bytesAt(b, q))),
        relays: items(b, f[o + 7]!).map((q) => relayAt(b, q)),
        metadata: anchorAt(b, f[o + 8]!),
    };
}

export function certAt(b: Uint8Array, p: number, index: number): CertFact {
    const f = items(b, p);
    const tag = numAt(b, f[0]!);
    const c: CertFact = { index, tag };
    switch (tag) {
        case 0: case 1: c.stake = typed(credAt(b, f[1]!)); break;
        case 2: c.stake = typed(credAt(b, f[1]!)); c.pool = hex(bytesAt(b, f[2]!)); break;
        case 3: c.pool_params = poolParamsAt(b, f, 1); c.pool = c.pool_params.operator; break;
        case 4: c.pool = hex(bytesAt(b, f[1]!)); c.retire_epoch = numAt(b, f[2]!); break;
        case 5: c.genesis = { genesis: hex(bytesAt(b, f[1]!)), delegate: hex(bytesAt(b, f[2]!)), vrf: hex(bytesAt(b, f[3]!)) }; break;
        case 6: {
            const m = items(b, f[1]!);
            const pot = numAt(b, m[0]!) === 0 ? "reserve" : "treasury";
            if (isMap(b, m[1]!)) c.mir = { pot, to: entries(b, m[1]!).map(([k, v]) => ({ stake: typed(credAt(b, k)), amount: intAt(b, v) })), otherPot: null };
            else c.mir = { pot, to: [], otherPot: intAt(b, m[1]!) };
            break;
        }
        case 7: case 8: c.stake = typed(credAt(b, f[1]!)); c.coin = intAt(b, f[2]!); break;
        case 9: c.stake = typed(credAt(b, f[1]!)); c.drep = drepAt(b, f[2]!); break;
        case 10: c.stake = typed(credAt(b, f[1]!)); c.pool = hex(bytesAt(b, f[2]!)); c.drep = drepAt(b, f[3]!); break;
        case 11: c.stake = typed(credAt(b, f[1]!)); c.pool = hex(bytesAt(b, f[2]!)); c.coin = intAt(b, f[3]!); break;
        case 12: c.stake = typed(credAt(b, f[1]!)); c.drep = drepAt(b, f[2]!); c.coin = intAt(b, f[3]!); break;
        case 13: c.stake = typed(credAt(b, f[1]!)); c.pool = hex(bytesAt(b, f[2]!)); c.drep = drepAt(b, f[3]!); c.coin = intAt(b, f[4]!); break;
        case 14: c.cc_cold = credAt(b, f[1]!); c.cc_hot = credAt(b, f[2]!); break;
        case 15: c.cc_cold = credAt(b, f[1]!); c.anchor = anchorAt(b, f[2]!); break;
        case 16: c.drep_cred = credAt(b, f[1]!); c.coin = intAt(b, f[2]!); c.anchor = anchorAt(b, f[3]!); break;
        case 17: c.drep_cred = credAt(b, f[1]!); c.coin = intAt(b, f[2]!); break;
        case 18: c.drep_cred = credAt(b, f[1]!); c.anchor = anchorAt(b, f[2]!); break;
    }
    return c;
}

/** Certificate kinds Blockfrost counts. */
export const certRegisters = (t: number): boolean => t === 0 || t === 7 || t === 11 || t === 12 || t === 13;
export const certDeregisters = (t: number): boolean => t === 1 || t === 8;
export const certDelegatesPool = (t: number): boolean => t === 2 || t === 10 || t === 11 || t === 13;
export const certDelegatesVote = (t: number): boolean => t === 9 || t === 10 || t === 12 || t === 13;

function redeemersAt(b: Uint8Array, p: number): RedeemerFact[] {
    const out: RedeemerFact[] = [];
    if (isMap(b, p)) {
        for (const [k, v] of entries(b, p)) {
            const kk = items(b, k), vv = items(b, v), ex = items(b, vv[1]!);
            out.push({ tag: numAt(b, kk[0]!), index: numAt(b, kk[1]!), data: slice(b, vv[0]!), mem: intAt(b, ex[0]!), steps: intAt(b, ex[1]!) });
        }
    } else {
        for (const r of items(b, p)) {
            const f = items(b, r), ex = items(b, f[3]!);
            out.push({ tag: numAt(b, f[0]!), index: numAt(b, f[1]!), data: slice(b, f[2]!), mem: intAt(b, ex[0]!), steps: intAt(b, ex[1]!) });
        }
    }
    return out;
}

function auxFacts(b: Uint8Array, p: number, tx: TxFact): void {
    const addScripts = (type: ScriptType, q: number) => { for (const s of items(b, q)) { const bytes = type === "timelock" ? slice(b, s) : bytesAt(b, s); tx.scripts.push({ type, bytes, hash: scriptHash(type, bytes) }); } };
    const addMeta = (q: number) => { for (const [k, v] of entries(b, q)) tx.metadata.push({ label: intAt(b, k), value: slice(b, v) }); };
    const t = tagOf(b, p);
    if (t === 259n) {
        for (const [k, v] of entries(b, untag(b, p))) {
            const key = numAt(b, k);
            if (key === 0) addMeta(v);
            else if (key >= 1 && key <= 4) addScripts(SCRIPT_TYPES[key - 1]!, v);
        }
    } else if (isMap(b, p)) addMeta(p);
    else {
        const f = items(b, p);
        if (f[0] != null) addMeta(f[0]);
        if (f[1] != null) addScripts("timelock", f[1]);
    }
}

function witnessFacts(b: Uint8Array, p: number, tx: TxFact): void {
    for (const [k, v] of entries(b, p)) {
        const key = numAt(b, k);
        if (key === 1 || key === 3 || key === 6 || key === 7) {
            const type: ScriptType = key === 1 ? "timelock" : key === 3 ? "plutusV1" : key === 6 ? "plutusV2" : "plutusV3";
            for (const s of items(b, v)) { const bytes = type === "timelock" ? slice(b, s) : bytesAt(b, s); tx.scripts.push({ type, bytes, hash: scriptHash(type, bytes) }); }
        } else if (key === 4) {
            for (const d of items(b, v)) { const bytes = slice(b, d); tx.datums.push({ hash: datumHash(bytes), bytes }); }
        } else if (key === 5) {
            tx.redeemers = redeemersAt(b, v);
        }
    }
}

function emptyTx(index: number, body: Uint8Array, witness: Uint8Array, aux: Uint8Array | null, valid: boolean, byron: boolean): TxFact {
    return {
        index, hash: hex(blake2b_256(body)), valid, body, witness, aux, size: 0, byron,
        fee: 0n, ttl: null, validFrom: null, inputs: [], collateral: [], referenceInputs: [], outputs: [], collateralReturn: null, totalCollateral: null,
        certs: [], withdrawals: [], mint: [], requiredSigners: [], donation: 0n, votes: [], proposals: [], metadata: [], scripts: [], datums: [], redeemers: [],
    };
}

/** One Shelley-era transaction from its parts (body, witness set, auxiliary data or null). */
export function shelleyTxFacts(index: number, body: Uint8Array, witness: Uint8Array, aux: Uint8Array | null, valid: boolean, era: number): TxFact {
    const tx = emptyTx(index, body, witness, aux, valid, false);
    // Blockfrost size: the transaction as its own CBOR ([body, witnesses, (is_valid,) aux])
    tx.size = 1 + body.length + witness.length + (era >= 5 ? 1 : 0) + (aux ? aux.length : 1);
    for (const [k, v] of entries(body, 0)) {
        const key = numAt(body, k);
        switch (key) {
            case 0: tx.inputs = setItems(body, v).map((q) => outRef(body, q)); break;
            case 1: tx.outputs = items(body, v).map((q, i) => outputAt(body, q, i)); break;
            case 2: tx.fee = intAt(body, v); break;
            case 3: tx.ttl = intAt(body, v); break;
            case 4: tx.certs = setItems(body, v).map((q, i) => certAt(body, q, i)); break;
            case 5: tx.withdrawals = entries(body, v).map(([a, c]) => ({ rewardAccount: bytesAt(body, a), amount: intAt(body, c) })); break;
            case 8: tx.validFrom = intAt(body, v); break;
            case 9: tx.mint = multiAsset(body, v); break;
            case 13: tx.collateral = setItems(body, v).map((q) => outRef(body, q)); break;
            case 14: tx.requiredSigners = setItems(body, v).map((q) => hex(bytesAt(body, q))); break;
            case 16: tx.collateralReturn = { ...outputAt(body, v, 0) }; break;
            case 17: tx.totalCollateral = intAt(body, v); break;
            case 18: tx.referenceInputs = setItems(body, v).map((q) => outRef(body, q)); break;
            case 19: {
                let n = 0;
                for (const [vk, vv] of entries(body, v)) {
                    const voter = items(body, vk);
                    const voterKind = numAt(body, voter[0]!), voterHash = hex(bytesAt(body, voter[1]!));
                    for (const [ak, av] of entries(body, vv)) {
                        const a = items(body, ak), pr = items(body, av);
                        tx.votes.push({ voterKind, voterHash, actionTx: hex(bytesAt(body, a[0]!)), actionIx: numAt(body, a[1]!), vote: numAt(body, pr[0]!), anchor: anchorAt(body, pr[1]!), index: n++ });
                    }
                }
                break;
            }
            case 20: tx.proposals = setItems(body, v).map((q, i) => { const f = items(body, q); const action = slice(body, f[2]!); return { index: i, deposit: intAt(body, f[0]!), returnAccount: bytesAt(body, f[1]!), action, actionTag: numAt(action, items(action, 0)[0]!), anchor: anchorAt(body, f[3]!) }; }); break;
            case 22: tx.donation = intAt(body, v); break;
        }
    }
    if (tx.collateralReturn) tx.collateralReturn.index = tx.outputs.length;
    for (const o of [...tx.outputs, ...(tx.collateralReturn ? [tx.collateralReturn] : [])]) {
        if (o.inlineDatum) tx.datums.push({ hash: o.datumHash!, bytes: o.inlineDatum });
        if (o.scriptRef) tx.scripts.push(o.scriptRef);
    }
    try { witnessFacts(witness, 0, tx); } catch { /* malformed witnesses: no scripts / datums / redeemers */ }
    if (aux) { try { auxFacts(aux, 0, tx); } catch { /* malformed auxiliary data */ } }
    return tx;
}

/** A Byron transaction (`[inputs, outputs, attributes]`) with its witness list. */
function byronTxFacts(index: number, txBytes: Uint8Array, witness: Uint8Array): TxFact {
    const tx = emptyTx(index, txBytes, witness, null, true, true);
    tx.size = 1 + txBytes.length + witness.length;
    const f = items(txBytes, 0);
    tx.inputs = items(txBytes, f[0]!).map((q) => {
        const inp = items(txBytes, q);
        const inner = bytesAt(txBytes, inp[1]!);
        const r = items(inner, 0);
        return { txHash: hex(bytesAt(inner, r[0]!)), index: numAt(inner, r[1]!) };
    });
    tx.outputs = items(txBytes, f[1]!).map((q, i) => {
        const o = items(txBytes, q);
        const addrRaw = slice(txBytes, o[0]!);
        return { index: i, addressRaw: addrRaw, address: addressStringOfRaw(addrRaw), lovelace: intAt(txBytes, o[1]!), assets: [], datumHash: null, inlineDatum: null, scriptRef: null };
    });
    return tx;
}

/** Facts of a stored block (`[era, block]` as on the wire). */
export function blockFacts(entry: Uint8Array): BlockFacts {
    const top = items(entry, 0);
    const era = numAt(entry, top[0]!);
    const bp = top[1]!;
    const block = items(entry, bp);
    const out: BlockFacts = { era, blockNo: null, slot: null, prevHash: null, issuerVkey: null, leader: null, vrfVkey: null, opCertHotVkey: null, opCertCounter: null, size: entry.length, txs: [] };
    if (era === 0) return out; // Byron epoch-boundary block
    if (era === 1) {
        const hdr = items(entry, block[0]!);
        out.prevHash = hex(bytesAt(entry, hdr[1]!));
        const cons = items(entry, hdr[3]!);
        try {
            const xpub = bytesAt(entry, cons[1]!);
            out.issuerVkey = hex(xpub);
            if (xpub.length === 64) out.leader = hex(blake2b_224(sha3_256(concat(Uint8Array.of(0x58, 0x40), xpub))));
        } catch { /* no issuer */ }
        try { out.blockNo = Number(intAt(entry, items(entry, cons[2]!)[0]!)); } catch { /* difficulty */ }
        const body = items(entry, block[1]!);
        items(entry, body[0]!).forEach((q, i) => {
            const pair = items(entry, q);
            out.txs.push(byronTxFacts(i, slice(entry, pair[0]!), slice(entry, pair[1]!)));
        });
        return out;
    }
    const hdr = items(entry, block[0]!);
    const hb = items(entry, hdr[0]!);
    out.blockNo = numAt(entry, hb[0]!);
    out.slot = numAt(entry, hb[1]!);
    out.prevHash = isNull(entry, hb[2]!) ? null : hex(bytesAt(entry, hb[2]!));
    const issuer = bytesAt(entry, hb[3]!);
    out.issuerVkey = hex(issuer);
    out.leader = hex(blake2b_224(issuer));
    out.vrfVkey = hex(bytesAt(entry, hb[4]!));
    if (hb.length >= 15) { out.opCertHotVkey = hex(bytesAt(entry, hb[9]!)); out.opCertCounter = numAt(entry, hb[10]!); }
    else { const oc = items(entry, hb[8]!); out.opCertHotVkey = hex(bytesAt(entry, oc[0]!)); out.opCertCounter = numAt(entry, oc[1]!); }
    const bodies = items(entry, block[1]!);
    const wits = items(entry, block[2]!);
    const auxMap = new Map<number, Uint8Array>();
    if (block[3] != null && !isNull(entry, block[3])) for (const [k, v] of entries(entry, block[3])) if (!isNull(entry, v)) auxMap.set(numAt(entry, k), slice(entry, v));
    const invalid = new Set<number>();
    if (block.length >= 5) for (const s of items(entry, block[4]!)) invalid.add(numAt(entry, s));
    bodies.forEach((bq, i) => {
        out.txs.push(shelleyTxFacts(i, slice(entry, bq), slice(entry, wits[i]!), auxMap.get(i) ?? null, !invalid.has(i), era));
    });
    return out;
}

/** Facts of a whole transaction as submitted (`[body, witnesses, is_valid?, auxiliary_data]`). */
export function txFactsOfCbor(tx: Uint8Array, era = 7): TxFact {
    const f = items(tx, 0);
    const valid = f.length >= 4 ? tx[f[2]!] !== 0xf4 : true;
    const auxPos = f.length >= 4 ? f[3]! : f[2];
    const aux = auxPos != null && !isNull(tx, auxPos) ? slice(tx, auxPos) : null;
    return shelleyTxFacts(0, slice(tx, f[0]!), slice(tx, f[1]!), aux, valid, era);
}

/** The transaction's own CBOR (Blockfrost `/txs/{hash}/cbor`). */
export function txCbor(tx: TxFact, era: number): Uint8Array {
    if (tx.byron) return concat(encodeHead(4, 2), tx.body, tx.witness);
    const aux = tx.aux ?? Uint8Array.of(0xf6);
    if (era >= 5) return concat(encodeHead(4, 4), tx.body, tx.witness, Uint8Array.of(tx.valid ? 0xf5 : 0xf4), aux);
    return concat(encodeHead(4, 3), tx.body, tx.witness, aux);
}

/** Era of a stored block entry without decoding the rest. */
export function eraOf(entry: Uint8Array): number { return numAt(entry, items(entry, 0)[0]!); }

/** The header byte length marker (sanity for callers that only need counts). */
export function txCountOf(entry: Uint8Array): number {
    const top = items(entry, 0);
    const era = numAt(entry, top[0]!);
    if (era === 0) return 0;
    const block = items(entry, top[1]!);
    if (era === 1) { const body = items(entry, block[1]!); return items(entry, body[0]!).length; }
    return items(entry, block[1]!).length;
}
void head;
