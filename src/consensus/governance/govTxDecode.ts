/**
 * The governance-relevant parts of a Conway transaction body, decoded from its CBOR bytes:
 * certificates, proposal procedures, voting procedures, withdrawals and the declared treasury
 * value. The GOV / GOVCERT / DELEG / POOL checks (govRules.ts) and the governance replay
 * (scripts/gov-replay.ts) both read this model, so the node and the replay judge the same bytes;
 * the ledger-ts objects are not consulted (their governance decoders were the cause of bugs 53
 * and 60, and the shapes vary between versions).
 *
 * Credentials are typed hex (db/stakeCred.ts): the 28-byte hash for a key credential, "01" + hash
 * for a script credential — the ledger keys DReps, committee members and accounts by
 * (type, hash).
 */
import { blake2b_256 } from "@harmoniclabs/crypto";

// ───────────────────────────── minimal CBOR reader ─────────────────────────────

export type Cbor =
    | { t: "u"; v: bigint }
    | { t: "n"; v: bigint }
    | { t: "b"; v: Uint8Array }
    | { t: "s"; v: string }
    | { t: "a"; v: Cbor[] }
    | { t: "m"; v: Array<[Cbor, Cbor]> }
    | { t: "tag"; tag: number; v: Cbor }
    | { t: "simple"; v: number | boolean | null | undefined }
    | { t: "f"; v: number };

function readHead(b: Uint8Array, p: number): { major: number; info: number; value: bigint; next: number } {
    const ib = b[p];
    if (ib === undefined) throw new Error("cbor: truncated");
    const major = ib >> 5, info = ib & 31;
    if (info < 24) return { major, info, value: BigInt(info), next: p + 1 };
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (info === 24) return { major, info, value: BigInt(b[p + 1]!), next: p + 2 };
    if (info === 25) return { major, info, value: BigInt(dv.getUint16(p + 1, false)), next: p + 3 };
    if (info === 26) return { major, info, value: BigInt(dv.getUint32(p + 1, false)), next: p + 5 };
    if (info === 27) return { major, info, value: dv.getBigUint64(p + 1, false), next: p + 9 };
    if (info === 31) return { major, info, value: -1n, next: p + 1 };
    throw new Error(`cbor: reserved additional info ${info}`);
}

export function decodeCbor(b: Uint8Array, p = 0): { v: Cbor; end: number } {
    const h = readHead(b, p);
    const indefinite = h.info === 31;
    switch (h.major) {
        case 0: return { v: { t: "u", v: h.value }, end: h.next };
        case 1: return { v: { t: "n", v: -1n - h.value }, end: h.next };
        case 2: case 3: {
            if (indefinite) {
                const parts: Uint8Array[] = [];
                let q = h.next;
                while (b[q] !== 0xff) { const c = decodeCbor(b, q); parts.push(c.v.t === "b" ? c.v.v : new TextEncoder().encode((c.v as any).v)); q = c.end; }
                let n = 0; for (const x of parts) n += x.length;
                const out = new Uint8Array(n); let i = 0; for (const x of parts) { out.set(x, i); i += x.length; }
                return h.major === 2 ? { v: { t: "b", v: out }, end: q + 1 } : { v: { t: "s", v: new TextDecoder().decode(out) }, end: q + 1 };
            }
            const len = Number(h.value), bytes = b.subarray(h.next, h.next + len);
            return h.major === 2 ? { v: { t: "b", v: bytes }, end: h.next + len } : { v: { t: "s", v: new TextDecoder().decode(bytes) }, end: h.next + len };
        }
        case 4: {
            const out: Cbor[] = [];
            let q = h.next;
            if (indefinite) { while (b[q] !== 0xff) { const c = decodeCbor(b, q); out.push(c.v); q = c.end; } return { v: { t: "a", v: out }, end: q + 1 }; }
            for (let i = 0n; i < h.value; i++) { const c = decodeCbor(b, q); out.push(c.v); q = c.end; }
            return { v: { t: "a", v: out }, end: q };
        }
        case 5: {
            const out: Array<[Cbor, Cbor]> = [];
            let q = h.next;
            const n = indefinite ? Infinity : Number(h.value);
            for (let i = 0; i < n; i++) {
                if (indefinite && b[q] === 0xff) { q++; break; }
                const k = decodeCbor(b, q); const v = decodeCbor(b, k.end);
                out.push([k.v, v.v]); q = v.end;
            }
            return { v: { t: "m", v: out }, end: q };
        }
        case 6: { const c = decodeCbor(b, h.next); return { v: { t: "tag", tag: Number(h.value), v: c.v }, end: c.end }; }
        default: {
            if (h.info === 20) return { v: { t: "simple", v: false }, end: h.next };
            if (h.info === 21) return { v: { t: "simple", v: true }, end: h.next };
            if (h.info === 22) return { v: { t: "simple", v: null }, end: h.next };
            if (h.info === 23) return { v: { t: "simple", v: undefined }, end: h.next };
            if (h.info === 25 || h.info === 26 || h.info === 27) return { v: { t: "f", v: Number(h.value) }, end: h.next };
            return { v: { t: "simple", v: Number(h.value) }, end: h.next };
        }
    }
}

const untag = (c: Cbor): Cbor => (c.t === "tag" && c.tag === 258 ? c.v : c);
const arr = (c: Cbor): Cbor[] => { const x = untag(c); if (x.t !== "a") throw new Error(`cbor: expected array, got ${x.t}`); return x.v; };
const uint = (c: Cbor): bigint => { if (c.t !== "u") throw new Error(`cbor: expected uint, got ${c.t}`); return c.v; };
const num = (c: Cbor): number => Number(uint(c));
const bytes = (c: Cbor): Uint8Array => { if (c.t !== "b") throw new Error(`cbor: expected bytes, got ${c.t}`); return c.v; };
const isNull = (c: Cbor | undefined): boolean => !c || (c.t === "simple" && (c.v === null || c.v === undefined));
const hexOf = (u: Uint8Array): string => Buffer.from(u).toString("hex");

// ───────────────────────────── model ─────────────────────────────

/** Typed credential hex: hash (key) or "01" + hash (script). */
export type TypedCred = string;
export const typedOf = (type: number, hashHex: string): TypedCred => (type === 1 ? `01${hashHex.toLowerCase()}` : hashHex.toLowerCase());
export const credHashOf = (c: TypedCred): string => (c.length === 58 && c.startsWith("01") ? c.slice(2) : c);
export const credIsScript = (c: TypedCred): boolean => c.length === 58 && c.startsWith("01");

export type DRepTarget = { kind: "cred"; cred: TypedCred } | { kind: "abstain" } | { kind: "noConfidence" };
export interface RewardAccountModel { network: number; cred: TypedCred }

export interface GovCertModel {
    index: number;
    type: number;
    /** Stake credential (types 0–2, 7–13) or DRep credential (16–18). */
    cred?: TypedCred;
    /** Deposit / refund field (7, 8, 11, 12, 13, 16, 17). */
    coin?: bigint;
    /** Pool key hash (2, 4, 10, 11, 13) or the operator of a registration (3). */
    pool?: string;
    drep?: DRepTarget;
    cold?: TypedCred;
    hot?: TypedCred;
    /** Retirement epoch (4). */
    epoch?: number;
    /** Pool registration (3). */
    poolReg?: { vrf: string; cost: bigint; rewardAccount: RewardAccountModel; metadataHashLen: number | null };
}

export type GovActionModel =
    | { type: 0; prev: string | null; update: Map<number, Cbor>; policy: string | null }
    | { type: 1; prev: string | null; major: number; minor: number }
    | { type: 2; withdrawals: Array<{ account: RewardAccountModel; amount: bigint }>; policy: string | null }
    | { type: 3; prev: string | null }
    | { type: 4; prev: string | null; remove: TypedCred[]; add: Array<{ cred: TypedCred; epoch: number }>; thrNum: bigint; thrDen: bigint }
    | { type: 5; prev: string | null; anchorHash: string; script: string | null }
    | { type: 6 };

export interface ProposalModel { index: number; deposit: bigint; returnAccount: RewardAccountModel; action: GovActionModel }
/** Voter kinds (CDDL `voter`): 0 CC hot key, 1 CC hot script, 2 DRep key, 3 DRep script, 4 pool. */
export interface VoteModel { voterKind: number; voterHash: string; actionId: string; vote: number }
export interface GovTxModel {
    txId: string;
    certs: GovCertModel[];
    proposals: ProposalModel[];
    votes: VoteModel[];
    withdrawals: Array<{ account: RewardAccountModel; amount: bigint }>;
    /** Body key 21 (`current_treasury_value`), null when absent. */
    treasuryValue: bigint | null;
}

export const GOV_ACTION_NAMES = ["ParameterChange", "InitHardFork", "TreasuryWithdrawals", "NoConfidence", "UpdateCommittee", "NewConstitution", "Info"] as const;

/** The voter's credential as the ledger keys it (CC hot / DRep credentials typed; pools by key hash). */
export function voterCred(kind: number, hashHex: string): TypedCred { return kind === 1 || kind === 3 ? typedOf(1, hashHex) : hashHex.toLowerCase(); }

function credential(c: Cbor): TypedCred { const f = arr(c); return typedOf(num(f[0]!), hexOf(bytes(f[1]!))); }
function drepTarget(c: Cbor): DRepTarget {
    const f = arr(c), t = num(f[0]!);
    if (t === 0 || t === 1) return { kind: "cred", cred: typedOf(t, hexOf(bytes(f[1]!))) };
    return t === 2 ? { kind: "abstain" } : { kind: "noConfidence" };
}
export function rewardAccountOf(b: Uint8Array): RewardAccountModel {
    const header = b[0] ?? 0;
    return { network: header & 0x0f, cred: typedOf((header >> 4) & 1, hexOf(b.subarray(1, 29))) };
}
function actionId(c: Cbor | undefined): string | null {
    if (isNull(c)) return null;
    const f = arr(c!);
    return `${hexOf(bytes(f[0]!))}:${num(f[1]!)}`;
}

function certOf(c: Cbor, index: number): GovCertModel {
    const f = arr(c), type = num(f[0]!);
    const m: GovCertModel = { index, type };
    switch (type) {
        case 0: case 1: m.cred = credential(f[1]!); break;
        case 2: m.cred = credential(f[1]!); m.pool = hexOf(bytes(f[2]!)); break;
        case 3: {
            // pool_params inline: operator, vrf, pledge, cost, margin, reward_account, owners, relays, metadata
            m.pool = hexOf(bytes(f[1]!));
            const md = f[9];
            m.poolReg = { vrf: hexOf(bytes(f[2]!)), cost: uint(f[4]!), rewardAccount: rewardAccountOf(bytes(f[6]!)), metadataHashLen: isNull(md) ? null : bytes(arr(md!)[1]!).length };
            break;
        }
        case 4: m.pool = hexOf(bytes(f[1]!)); m.epoch = num(f[2]!); break;
        case 7: case 8: m.cred = credential(f[1]!); m.coin = uint(f[2]!); break;
        case 9: m.cred = credential(f[1]!); m.drep = drepTarget(f[2]!); break;
        case 10: m.cred = credential(f[1]!); m.pool = hexOf(bytes(f[2]!)); m.drep = drepTarget(f[3]!); break;
        case 11: m.cred = credential(f[1]!); m.pool = hexOf(bytes(f[2]!)); m.coin = uint(f[3]!); break;
        case 12: m.cred = credential(f[1]!); m.drep = drepTarget(f[2]!); m.coin = uint(f[3]!); break;
        case 13: m.cred = credential(f[1]!); m.pool = hexOf(bytes(f[2]!)); m.drep = drepTarget(f[3]!); m.coin = uint(f[4]!); break;
        case 14: m.cold = credential(f[1]!); m.hot = credential(f[2]!); break;
        case 15: m.cold = credential(f[1]!); break;
        case 16: case 17: m.cred = credential(f[1]!); m.coin = uint(f[2]!); break;
        case 18: m.cred = credential(f[1]!); break;
        default: break; // 5, 6: not valid in Conway (the decoder of the chain rejects them)
    }
    return m;
}

function govActionOf(c: Cbor): GovActionModel {
    const f = arr(c), type = num(f[0]!);
    switch (type) {
        case 0: {
            const upd = f[2]!;
            const update = new Map<number, Cbor>();
            if (upd.t === "m") for (const [k, v] of upd.v) update.set(num(k), v);
            return { type: 0, prev: actionId(f[1]), update, policy: isNull(f[3]) ? null : hexOf(bytes(f[3]!)) };
        }
        case 1: { const pv = arr(f[2]!); return { type: 1, prev: actionId(f[1]), major: num(pv[0]!), minor: num(pv[1]!) }; }
        case 2: {
            const w = f[1]!;
            const withdrawals: Array<{ account: RewardAccountModel; amount: bigint }> = [];
            if (w.t === "m") for (const [k, v] of w.v) withdrawals.push({ account: rewardAccountOf(bytes(k)), amount: uint(v) });
            return { type: 2, withdrawals, policy: isNull(f[2]) ? null : hexOf(bytes(f[2]!)) };
        }
        case 3: return { type: 3, prev: actionId(f[1]) };
        case 4: {
            const remove = arr(f[2]!).map(credential);
            const addM = f[3]!;
            const add: Array<{ cred: TypedCred; epoch: number }> = [];
            if (addM.t === "m") for (const [k, v] of addM.v) add.push({ cred: credential(k), epoch: num(v) });
            let thr = f[4]!;
            if (thr.t === "tag") thr = thr.v;
            const q = arr(thr);
            return { type: 4, prev: actionId(f[1]), remove, add, thrNum: uint(q[0]!), thrDen: uint(q[1]!) };
        }
        case 5: {
            const cons = arr(f[2]!), anchor = arr(cons[0]!);
            return { type: 5, prev: actionId(f[1]), anchorHash: hexOf(bytes(anchor[1]!)), script: isNull(cons[1]) ? null : hexOf(bytes(cons[1]!)) };
        }
        default: return { type: 6 };
    }
}

/** True when the body map (CBOR bytes) may carry something the governance checks read (keys 4, 5, 19, 20, 21). */
export function bodyHasGovernance(body: Uint8Array): boolean {
    try {
        const h = readHead(body, 0);
        if (h.major !== 5) return false;
        let q = h.next;
        const n = h.info === 31 ? Infinity : Number(h.value);
        for (let i = 0; i < n; i++) {
            if (h.info === 31 && body[q] === 0xff) break;
            const k = decodeCbor(body, q);
            const key = k.v.t === "u" ? Number(k.v.v) : -1;
            if (key === 4 || key === 5 || key === 19 || key === 20 || key === 21) return true;
            q = skip(body, k.end);
        }
    } catch { return true; } // let the full decoder report it
    return false;
}

/** End offset of the CBOR item at `p` without building it. */
export function skip(b: Uint8Array, p: number): number {
    const h = readHead(b, p);
    const indefinite = h.info === 31;
    switch (h.major) {
        case 0: case 1: case 7: return h.next;
        case 2: case 3: {
            if (!indefinite) return h.next + Number(h.value);
            let q = h.next; while (b[q] !== 0xff) q = skip(b, q); return q + 1;
        }
        case 4: { let q = h.next; if (indefinite) { while (b[q] !== 0xff) q = skip(b, q); return q + 1; } for (let i = 0n; i < h.value; i++) q = skip(b, q); return q; }
        case 5: { let q = h.next; if (indefinite) { while (b[q] !== 0xff) q = skip(b, skip(b, q)); return q + 1; } for (let i = 0n; i < h.value; i++) q = skip(b, skip(b, q)); return q; }
        case 6: return skip(b, h.next);
        default: return h.next;
    }
}

/** Decode the governance model of one transaction body (the CBOR bytes of the body map). */
export function decodeGovTx(body: Uint8Array, txId?: string): GovTxModel {
    const top = decodeCbor(body, 0).v;
    if (top.t !== "m") throw new Error("transaction body is not a map");
    const out: GovTxModel = { txId: (txId ?? hexOf(blake2b_256(body))).toLowerCase(), certs: [], proposals: [], votes: [], withdrawals: [], treasuryValue: null };
    for (const [k, v] of top.v) {
        if (k.t !== "u") continue;
        switch (Number(k.v)) {
            case 4: arr(v).forEach((c, i) => out.certs.push(certOf(c, i))); break;
            case 5: if (v.t === "m") for (const [ra, amt] of v.v) out.withdrawals.push({ account: rewardAccountOf(bytes(ra)), amount: uint(amt) }); break;
            case 19:
                if (v.t === "m") for (const [voter, acts] of v.v) {
                    const vf = arr(voter), kind = num(vf[0]!), hash = hexOf(bytes(vf[1]!));
                    if (acts.t !== "m") continue;
                    for (const [gid, proc] of acts.v) out.votes.push({ voterKind: kind, voterHash: hash, actionId: actionId(gid)!, vote: num(arr(proc)[0]!) });
                }
                break;
            case 20:
                arr(v).forEach((p, index) => {
                    const f = arr(p);
                    out.proposals.push({ index, deposit: uint(f[0]!), returnAccount: rewardAccountOf(bytes(f[1]!)), action: govActionOf(f[2]!) });
                });
                break;
            case 21: out.treasuryValue = uint(v); break;
        }
    }
    return out;
}

/** Integer value of a parameter-update entry (null when it is not an unsigned integer). */
export function updateUint(update: Map<number, Cbor>, key: number): bigint | null {
    const v = update.get(key);
    return v && v.t === "u" ? v.v : null;
}

/** Start offsets of the items of the array (tag 258 allowed) at `p`, without decoding them. */
export function arrayItemOffsets(b: Uint8Array, p: number): number[] {
    let h = readHead(b, p);
    if (h.major === 6) { p = h.next; h = readHead(b, p); }
    if (h.major !== 4) throw new Error("cbor: expected array");
    const out: number[] = [];
    let q = h.next;
    if (h.info === 31) { while (b[q] !== 0xff) { out.push(q); q = skip(b, q); } return out; }
    for (let i = 0n; i < h.value; i++) { out.push(q); q = skip(b, q); }
    return out;
}

/** The transaction bodies (exact bytes) and phase-2-invalid indices of a stored Shelley+ block (`[era, block]`). */
export function blockTxBodies(entry: Uint8Array): { era: number; bodies: Uint8Array[]; invalid: Set<number> } {
    const top = arrayItemOffsets(entry, 0);
    const era = Number((decodeCbor(entry, top[0]!).v as { v: bigint }).v);
    if (era < 2) return { era, bodies: [], invalid: new Set() };
    const block = arrayItemOffsets(entry, top[1]!);
    const bodies = arrayItemOffsets(entry, block[1]!).map((s) => entry.subarray(s, skip(entry, s)));
    const invalid = new Set<number>();
    if (block.length >= 5) { const inv = decodeCbor(entry, block[4]!).v; if (inv.t === "a") for (const x of inv.v) if (x.t === "u") invalid.add(Number(x.v)); }
    return { era, bodies, invalid };
}

/** True when the body map has any of `keys` (top-level keys only). */
export function bodyHasKey(body: Uint8Array, keys: ReadonlySet<number>): boolean {
    const h = readHead(body, 0);
    if (h.major !== 5) return false;
    let q = h.next;
    const n = h.info === 31 ? Infinity : Number(h.value);
    for (let i = 0; i < n; i++) {
        if (h.info === 31 && body[q] === 0xff) break;
        const k = readHead(body, q);
        if (k.major === 0 && keys.has(Number(k.value))) return true;
        q = skip(body, skip(body, q));
    }
    return false;
}
